// 다이노리 커뮤니티 — 실시간 채팅 · 공략글 · 스크린샷
// Cloudflare Worker + Durable Object(SQLite) 하나에 모두 저장. 추가 설정(D1·R2) 없이 동작.
import { DurableObject } from "cloudflare:workers";

const LIMITS = {
  nick: 12, title: 60, body: 6000, comment: 500, chat: 300,
  image: 1_800_000,                 // 스크린샷 최대 1.8MB (브라우저에서 줄여서 올림)
  chatGap: 1.2, postGap: 45, commentGap: 8, likeGap: 1, reportGap: 10,   // 초 단위 도배 방지
  chatKeep: 500,
};
const TYPES = ["guide", "shot", "free"];

const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‏‪-‮]/g, "").trim().slice(0, n);
async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const stub = env.COMMUNITY.get(env.COMMUNITY.idFromName("main"));
    const h = new Headers(req.headers);
    h.set("x-ip", req.headers.get("CF-Connecting-IP") || "0.0.0.0");
    return stub.fetch(new Request(req, { headers: h }));
  },
};

export class Community extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.hits = new Map();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, title TEXT, body TEXT,
        nick TEXT, ip TEXT, created INTEGER, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
        has_img INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, reports INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS images(post_id INTEGER PRIMARY KEY, mime TEXT, data BLOB);
      CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, nick TEXT,
        body TEXT, ip TEXT, created INTEGER, hidden INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT, body TEXT, ip TEXT,
        created INTEGER, hidden INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS likes(post_id INTEGER, ip TEXT, PRIMARY KEY(post_id, ip));
      CREATE TABLE IF NOT EXISTS bans(ip TEXT PRIMARY KEY, created INTEGER);
      CREATE INDEX IF NOT EXISTS posts_type ON posts(type, id);
      CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, id);
    `);
  }

  // ── 도배 방지 ──
  tooFast(ip, kind, gap) {
    const k = ip + ":" + kind, now = Date.now() / 1000, last = this.hits.get(k) || 0;
    if (now - last < gap) return Math.ceil(gap - (now - last));
    this.hits.set(k, now);
    if (this.hits.size > 5000) this.hits.clear();
    return 0;
  }
  banned(ip) { return this.sql.exec("SELECT 1 FROM bans WHERE ip=?", ip).toArray().length > 0; }
  async isAdmin(req) {
    const key = req.headers.get("x-admin") || "";
    return !!key && !!this.env.ADMIN_HASH && (await sha256(key)) === this.env.ADMIN_HASH;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const ip = req.headers.get("x-ip") || "0.0.0.0";
    const p = url.pathname.replace(/^\/api/, "");
    const m = req.method;
    try {
      if (p === "/chat/ws") return this.openSocket(req, ip);
      if (p === "/stats" && m === "GET") return this.stats();
      if (p === "/posts" && m === "GET") return this.listPosts(url);
      if (p === "/posts" && m === "POST") return this.createPost(req, ip);
      let r;
      if ((r = p.match(/^\/posts\/(\d+)$/))) {
        if (m === "GET") return this.getPost(+r[1]);
        if (m === "DELETE") return this.hidePost(req, +r[1]);
      }
      if ((r = p.match(/^\/posts\/(\d+)\/comments$/)) && m === "POST") return this.addComment(req, ip, +r[1]);
      if ((r = p.match(/^\/posts\/(\d+)\/like$/)) && m === "POST") return this.like(ip, +r[1]);
      if ((r = p.match(/^\/img\/(\d+)$/)) && m === "GET") return this.image(+r[1]);
      if (p === "/report" && m === "POST") return this.report(req, ip);
      if (p === "/admin" && m === "POST") return this.admin(req);
      return json({ error: "없는 주소예요" }, 404);
    } catch (e) {
      return json({ error: "서버 오류: " + String(e.message || e).slice(0, 120) }, 500);
    }
  }

  stats() {
    const one = (q) => this.sql.exec(q).one().n;
    return json({
      online: this.ctx.getWebSockets().length,
      guides: one("SELECT COUNT(*) n FROM posts WHERE type='guide' AND hidden=0"),
      shots: one("SELECT COUNT(*) n FROM posts WHERE type='shot' AND hidden=0"),
      free: one("SELECT COUNT(*) n FROM posts WHERE type='free' AND hidden=0"),
    });
  }

  listPosts(url) {
    const type = TYPES.includes(url.searchParams.get("type")) ? url.searchParams.get("type") : "guide";
    const before = parseInt(url.searchParams.get("before") || "0") || 2 ** 52;
    const sort = url.searchParams.get("sort") === "likes" ? "likes DESC, id DESC" : "id DESC";
    const where = sort.startsWith("likes") ? "type=? AND hidden=0" : "type=? AND hidden=0 AND id<?";
    const args = sort.startsWith("likes") ? [type] : [type, before];
    const rows = this.sql.exec(
      `SELECT id,type,title,substr(body,1,140) AS excerpt,nick,created,likes,comments,has_img FROM posts WHERE ${where} ORDER BY ${sort} LIMIT 24`,
      ...args).toArray();
    return json({ posts: rows });
  }

  getPost(id) {
    const post = this.sql.exec("SELECT id,type,title,body,nick,created,likes,comments,has_img FROM posts WHERE id=? AND hidden=0", id).toArray()[0];
    if (!post) return json({ error: "지워졌거나 없는 글이에요" }, 404);
    const comments = this.sql.exec("SELECT id,nick,body,created FROM comments WHERE post_id=? AND hidden=0 ORDER BY id LIMIT 300", id).toArray();
    return json({ post, comments });
  }

  async createPost(req, ip) {
    if (this.banned(ip)) return json({ error: "글을 쓸 수 없어요" }, 403);
    const d = await req.json();
    const type = TYPES.includes(d.type) ? d.type : "free";
    const nick = clean(d.nick, LIMITS.nick) || "익명 박사";
    const title = clean(d.title, LIMITS.title);
    const body = clean(d.body, LIMITS.body);
    let img = null, mime = null;
    if (d.image) {
      const mm = String(d.image).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!mm) return json({ error: "그림 형식이 올바르지 않아요 (jpg·png·webp)" }, 400);
      mime = mm[1];
      img = Uint8Array.from(atob(mm[2]), c => c.charCodeAt(0));
      if (img.byteLength > LIMITS.image) return json({ error: "그림이 너무 커요 (1.8MB 이하)" }, 400);
    }
    if (!title) return json({ error: "제목을 써 주세요" }, 400);
    if (type === "shot" && !img) return json({ error: "스크린샷을 골라 주세요" }, 400);
    if (type !== "shot" && body.length < 5) return json({ error: "내용을 조금 더 써 주세요" }, 400);
    const wait = this.tooFast(ip, "post", LIMITS.postGap);
    if (wait) return json({ error: `${wait}초 뒤에 다시 올릴 수 있어요` }, 429);
    const id = this.sql.exec("INSERT INTO posts(type,title,body,nick,ip,created,has_img) VALUES(?,?,?,?,?,?,?) RETURNING id",
      type, title, body, nick, ip, Date.now(), img ? 1 : 0).one().id;
    if (img) this.sql.exec("INSERT INTO images(post_id,mime,data) VALUES(?,?,?)", id, mime, img);
    this.broadcast({ t: "post", post: { id, type, title, nick } });
    return json({ id });
  }

  async addComment(req, ip, id) {
    if (this.banned(ip)) return json({ error: "댓글을 쓸 수 없어요" }, 403);
    const d = await req.json();
    const body = clean(d.body, LIMITS.comment);
    const nick = clean(d.nick, LIMITS.nick) || "익명 박사";
    if (!body) return json({ error: "댓글을 써 주세요" }, 400);
    if (!this.sql.exec("SELECT 1 FROM posts WHERE id=? AND hidden=0", id).toArray().length) return json({ error: "없는 글이에요" }, 404);
    const wait = this.tooFast(ip, "comment", LIMITS.commentGap);
    if (wait) return json({ error: `${wait}초 뒤에 다시 쓸 수 있어요` }, 429);
    const created = Date.now();
    const cid = this.sql.exec("INSERT INTO comments(post_id,nick,body,ip,created) VALUES(?,?,?,?,?) RETURNING id", id, nick, body, ip, created).one().id;
    this.sql.exec("UPDATE posts SET comments=comments+1 WHERE id=?", id);
    return json({ comment: { id: cid, nick, body, created } });
  }

  like(ip, id) {
    if (this.tooFast(ip, "like", LIMITS.likeGap)) return json({ error: "천천히요!" }, 429);
    const had = this.sql.exec("SELECT 1 FROM likes WHERE post_id=? AND ip=?", id, ip).toArray().length;
    if (had) {
      this.sql.exec("DELETE FROM likes WHERE post_id=? AND ip=?", id, ip);
      this.sql.exec("UPDATE posts SET likes=MAX(0,likes-1) WHERE id=?", id);
    } else {
      this.sql.exec("INSERT INTO likes(post_id,ip) VALUES(?,?)", id, ip);
      this.sql.exec("UPDATE posts SET likes=likes+1 WHERE id=?", id);
    }
    const r = this.sql.exec("SELECT likes FROM posts WHERE id=?", id).toArray()[0];
    return json({ likes: r ? r.likes : 0, liked: !had });
  }

  image(id) {
    const r = this.sql.exec("SELECT i.mime, i.data FROM images i JOIN posts p ON p.id=i.post_id WHERE i.post_id=? AND p.hidden=0", id).toArray()[0];
    if (!r) return new Response("없음", { status: 404 });
    return new Response(r.data, { headers: { "content-type": r.mime, "cache-control": "public, max-age=86400" } });
  }

  async report(req, ip) {
    const d = await req.json();
    if (this.tooFast(ip, "report", LIMITS.reportGap)) return json({ ok: true });
    if (d.kind === "post") {
      this.sql.exec("UPDATE posts SET reports=reports+1 WHERE id=?", +d.id);
      this.sql.exec("UPDATE posts SET hidden=1 WHERE id=? AND reports>=5", +d.id);   // 신고 5번이면 자동으로 숨김
    }
    return json({ ok: true });
  }

  async hidePost(req, id) {
    if (!(await this.isAdmin(req))) return json({ error: "관리자만 지울 수 있어요" }, 403);
    this.sql.exec("UPDATE posts SET hidden=1 WHERE id=?", id);
    return json({ ok: true });
  }

  // 관리자: {action: "hide_comment"|"hide_chat"|"ban"|"unhide_post", id}
  async admin(req) {
    if (!(await this.isAdmin(req))) return json({ error: "관리자 비밀번호가 틀렸어요" }, 403);
    const d = await req.json();
    if (d.action === "check") return json({ ok: true });
    if (d.action === "hide_comment") {
      const r = this.sql.exec("SELECT post_id FROM comments WHERE id=?", +d.id).toArray()[0];
      this.sql.exec("UPDATE comments SET hidden=1 WHERE id=?", +d.id);
      if (r) this.sql.exec("UPDATE posts SET comments=MAX(0,comments-1) WHERE id=?", r.post_id);
    } else if (d.action === "hide_chat") {
      this.sql.exec("UPDATE chat SET hidden=1 WHERE id=?", +d.id);
      this.broadcast({ t: "hide", id: +d.id });
    } else if (d.action === "unhide_post") {
      this.sql.exec("UPDATE posts SET hidden=0, reports=0 WHERE id=?", +d.id);
    } else if (d.action === "ban") {
      // 글·댓글·채팅 번호로 작성자 IP 를 찾아 차단
      const t = { post: "posts", comment: "comments", chat: "chat" }[d.kind] || "posts";
      const r = this.sql.exec(`SELECT ip FROM ${t} WHERE id=?`, +d.id).toArray()[0];
      if (r) this.sql.exec("INSERT OR IGNORE INTO bans(ip,created) VALUES(?,?)", r.ip, Date.now());
    }
    return json({ ok: true });
  }

  // ── 실시간 채팅 (WebSocket · 쉬는 동안 비용 없는 hibernation) ──
  openSocket(req, ip) {
    if (req.headers.get("Upgrade") !== "websocket") return json({ error: "websocket 필요" }, 426);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ ip });
    const hist = this.sql.exec("SELECT id,nick,body,created FROM chat WHERE hidden=0 ORDER BY id DESC LIMIT 60").toArray().reverse();
    pair[1].send(JSON.stringify({ t: "hist", msgs: hist, online: this.ctx.getWebSockets().length }));
    this.broadcast({ t: "online", n: this.ctx.getWebSockets().length });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (d.t === "ping") return ws.send(JSON.stringify({ t: "pong" }));
    if (d.t !== "say") return;
    const { ip } = ws.deserializeAttachment() || { ip: "0.0.0.0" };
    if (this.banned(ip)) return ws.send(JSON.stringify({ t: "err", msg: "채팅을 할 수 없어요" }));
    const body = clean(d.body, LIMITS.chat);
    const nick = clean(d.nick, LIMITS.nick) || "익명 박사";
    if (!body) return;
    const wait = this.tooFast(ip, "chat", LIMITS.chatGap);
    if (wait) return ws.send(JSON.stringify({ t: "err", msg: "조금 천천히 말해 주세요" }));
    const created = Date.now();
    const id = this.sql.exec("INSERT INTO chat(nick,body,ip,created) VALUES(?,?,?,?) RETURNING id", nick, body, ip, created).one().id;
    if (id % 50 === 0) this.sql.exec("DELETE FROM chat WHERE id <= ?", id - LIMITS.chatKeep);
    this.broadcast({ t: "msg", msg: { id, nick, body, created } });
  }

  webSocketClose() { this.broadcast({ t: "online", n: Math.max(0, this.ctx.getWebSockets().length - 1) }); }
  webSocketError() {}

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const w of this.ctx.getWebSockets()) { try { w.send(s); } catch {} }
  }
}
