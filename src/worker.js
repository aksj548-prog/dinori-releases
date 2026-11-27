// 다이노리 커뮤니티 — 실시간 채팅 · 공략글 · 스크린샷
// Cloudflare Worker + Durable Object(SQLite) 하나에 모두 저장. 추가 설정(D1·R2) 없이 동작.
import { DurableObject } from "cloudflare:workers";
export { Accounts } from "./accounts.js";

const LIMITS = {
  nick: 12, title: 60, body: 6000, comment: 500, chat: 300,
  image: 1_800_000,                 // 스크린샷 최대 1.8MB (브라우저에서 줄여서 올림)
  chatGap: 1.2, postGap: 45, commentGap: 8, likeGap: 1, reportGap: 10,   // 초 단위 도배 방지
  chatKeep: 500,
};
const TYPES = ["guide", "shot", "free"];
// 온라인 대결 — 하루 도전 10번 · 팀 5마리 · 30일 넘게 안 올린 팀은 상대 목록에서 빠짐
const PVP = { daily: 10, teamMax: 5, statMax: 50_000_000, staleDays: 30, sameOpp: 3, joinGap: 20, teamGap: 5, resultGap: 3 };

// ── 발굴 기지(시·도) · 판게아 컵 (예전 이름: 천하통일 리그) ──
const REGIONS = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];
const SEL_DAYS = 3;                  // 매월 말일 포함 마지막 3일 = 지역 대표 선발전
function kst(now = Date.now()) {
  const d = new Date(now + 9 * 3600e3);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate();
  const days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, "0");
  const pm = mo === 0 ? `${y - 1}-12` : `${y}-${pad(mo)}`;
  return { month: `${y}-${pad(mo + 1)}`, prev: pm, day, days, selFrom: days - SEL_DAYS + 1, sel: day >= days - SEL_DAYS + 1 };
}
// 보상: 대표 · 천하통일 지역 소속
const LEAGUE_REWARD = {
  champ_rep: { ammo: 8000, amber: 100, token: 4, title: "판게아 컵 우승 대표" },
  rep: { ammo: 3000, amber: 50, token: 1, title: "기지 대표 연구팀" },
  member: { ammo: 2500, amber: 30, token: 1 },
};
const anonNick = (uid) => `익명연구원${String(uid).slice(0, 4).toUpperCase()}`;   // 계정 연동 · 닉네임이 없을 때
function leagueReward(d, uid, region) {
  const champRep = d.reps.find(x => x.region === d.champion);
  if (champRep && champRep.uid === uid) return { kind: "champ_rep", ...LEAGUE_REWARD.champ_rep };
  if (d.reps.some(x => x.uid === uid)) {
    const out = { kind: "rep", ...LEAGUE_REWARD.rep };
    if (region && region === d.champion) { out.ammo += LEAGUE_REWARD.member.ammo; out.amber += LEAGUE_REWARD.member.amber; out.token += LEAGUE_REWARD.member.token; }
    return out;
  }
  if (region && region === d.champion) return { kind: "member", ...LEAGUE_REWARD.member };
  return null;
}
// 결정적(같은 씨앗 → 같은 결과) 자동 전투 — 게임의 전투 규칙을 줄인 것 (평타 · 치명타 · 탱커 어그로 · 90초 판정)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const AGG = { tank: 6, bal: 2.5, dps: 1 };
function simBattle(A, B, seed) {
  const R = rng(seed);
  const mk = (t, side) => t.map((d, i) => ({ side, i, mx: d.hp, hp: d.hp, atk: d.atk, df: d.df, role: d.role || "bal", cd: 0.4 + R() * 0.6 }));
  const S = [mk(A, 0), mk(B, 1)];
  let t = 0;
  const live = (s) => S[s].filter(u => u.hp > 0);
  while (t < 90 && live(0).length && live(1).length) {
    t += 0.1;
    for (const u of [...S[0], ...S[1]]) {
      if (u.hp <= 0) continue;
      u.cd -= 0.1;
      if (u.cd > 0) continue;
      const foes = live(1 - u.side);
      if (!foes.length) break;
      let tg;
      const soft = foes.filter(f => f.role !== "tank"), weak = soft.filter(f => f.hp < f.mx * 0.7);
      if (R() >= 0.75 && (weak.length || (soft.length && R() < 0.4))) tg = (weak.length ? weak : soft).reduce((a, b) => (a.hp / a.mx <= b.hp / b.mx ? a : b));
      else { const w = foes.map(f => AGG[f.role] || 1), sum = w.reduce((a, b) => a + b, 0); let x = R() * sum; tg = foes[foes.length - 1]; for (let k = 0; k < foes.length; k++) { x -= w[k]; if (x <= 0) { tg = foes[k]; break; } } }
      let dmg = u.atk * u.atk / (u.atk + tg.df) * (0.98 + R() * 0.04);
      if (R() < 0.08) dmg *= 1.6;
      tg.hp -= Math.max(1, Math.floor(dmg));
      u.cd = 1.1 + R() * 0.4;
    }
  }
  const rate = (s) => S[s].reduce((a, u) => a + Math.max(0, u.hp), 0) / Math.max(1, S[s].reduce((a, u) => a + u.mx, 0));
  const ra = rate(0), rb = rate(1);
  return { win: ra > rb || (ra === rb && R() < 0.5) ? 0 : 1, hpA: Math.round(ra * 100), hpB: Math.round(rb * 100), time: Math.round(t) };
}
// 점수 변화 (Elo, K=32) — win: 이겼을 때 얻는 점수 / 졌을 때 잃는 점수
function elo(me, opp, win) {
  const ex = 1 / (1 + Math.pow(10, (opp - me) / 400));
  return Math.max(1, Math.round(32 * (win ? 1 - ex : ex)));
}

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
    if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/acct/"))     // 계정 연동 · 클라우드 저장
      return env.ACCOUNTS.get(env.ACCOUNTS.idFromName("main")).fetch(req);
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
      CREATE TABLE IF NOT EXISTS pvp_players(uid TEXT PRIMARY KEY, keyhash TEXT, nick TEXT, ip TEXT,
        rating INTEGER DEFAULT 1000, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0,
        dwins INTEGER DEFAULT 0, dlosses INTEGER DEFAULT 0, team TEXT, power INTEGER DEFAULT 0,
        created INTEGER, updated INTEGER, day TEXT, attacks INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pvp_log(id INTEGER PRIMARY KEY AUTOINCREMENT, atk TEXT, def TEXT, win INTEGER,
        datk INTEGER, ddef INTEGER, created INTEGER);
      CREATE INDEX IF NOT EXISTS pvp_rating ON pvp_players(rating);
      CREATE TABLE IF NOT EXISTS pvp_sel(month TEXT, uid TEXT, region TEXT, pts INTEGER DEFAULT 0, wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0, team TEXT, nick TEXT, PRIMARY KEY(month, uid));
      CREATE TABLE IF NOT EXISTS pvp_region(month TEXT, region TEXT, wins INTEGER DEFAULT 0, PRIMARY KEY(month, region));
      CREATE TABLE IF NOT EXISTS pvp_league(month TEXT PRIMARY KEY, data TEXT, champion TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS pvp_claim(month TEXT, uid TEXT, PRIMARY KEY(month, uid));
      CREATE TABLE IF NOT EXISTS pvp_member(month TEXT, uid TEXT, region TEXT, PRIMARY KEY(month, uid));
      CREATE INDEX IF NOT EXISTS pvp_log_def ON pvp_log(def, id);
      CREATE INDEX IF NOT EXISTS pvp_log_atk ON pvp_log(atk, id);
    `);
  }

  pvpMigrate() {
    if (this._pvpm) return;
    this._pvpm = true;
    for (const c of ["region TEXT", "region_month TEXT", "aid TEXT"]) {
      try { this.sql.exec(`ALTER TABLE pvp_players ADD COLUMN ${c}`); } catch (e) { /* 이미 있음 */ }
    }
    try { this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS pvp_aid ON pvp_players(aid) WHERE aid IS NOT NULL"); } catch (e) { /* */ }
    // 한 번만: 예전엔 처음 고른 지역도 «이번 달 바꾸기»로 셌음 → 그때 고른 사람들도 이번 달에 한 번 옮길 수 있게
    this.sql.exec("CREATE TABLE IF NOT EXISTS pvp_mig(k TEXT PRIMARY KEY)");
    if (!this.sql.exec("SELECT 1 FROM pvp_mig WHERE k='free_first_pick'").toArray().length) {
      this.sql.exec("UPDATE pvp_players SET region_month=NULL");
      this.sql.exec("INSERT INTO pvp_mig(k) VALUES('free_first_pick')");
    }
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
      if (p.startsWith("/pvp/")) return this.pvp(req, ip, p.slice(5), m, url);
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
  // ── 온라인 대결 (비동기 랭킹전) ──
  // 게임이 방어 팀(최종 능력치)을 올려 두고, 다른 사람 팀을 받아 자기 컴퓨터에서 자동 전투 → 결과만 보냄
  async pvp(req, ip, p, m, url) {
    if (this.banned(ip)) return json({ error: "이용이 제한됐어요" }, 403);
    this.pvpMigrate();
    const P = PVP;
    const K = kst(this.env.TEST_NOW ? +this.env.TEST_NOW : Date.now());   // TEST_NOW: 로컬 시험용 (실서버엔 없음)
    this.leagueRun(K);
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 한국 날짜
    const body = m === "POST" ? await req.json().catch(() => ({})) : {};
    const q = (k) => (m === "POST" ? body[k] : url.searchParams.get(k));
    const me = async () => {
      const uid = String(q("uid") || ""), key = String(q("key") || "");
      if (!uid || !key) return null;
      const r = this.sql.exec("SELECT * FROM pvp_players WHERE uid=?", uid).toArray()[0];
      return r && r.keyhash === (await sha256(key)) ? r : null;
    };
    const pub = (r) => ({ uid: r.uid, nick: r.nick, rating: r.rating, wins: (r.wins | 0) + (r.dwins | 0), losses: (r.losses | 0) + (r.dlosses | 0),   // 전적 = 공격 + 방어
      awins: r.wins | 0, alosses: r.losses | 0, power: r.power, region: r.region || null });
    if (p === "join" && m === "POST") {               // 온라인 대결 참가 — 연동된 계정마다 기록 하나 (끄고 다시 켜도 같은 기록)
      const ac = await this.acctInfo(body);
      if (!ac.ok) return json({ error: "온라인 대결은 계정 연동 후 참가할 수 있어요 (연구원 수첩 › 저장 · 복구)", need_acct: true }, 403);
      if (!ac.nick) return json({ error: "먼저 온라인 닉네임을 정해 주세요 (연구원 수첩 › 저장 · 복구)", need_nick: true }, 403);
      const key = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const now = Date.now();
      const old = this.sql.exec("SELECT * FROM pvp_players WHERE aid=?", ac.aid).toArray()[0];
      if (old) {                                       // 예전 기록 되살리기 (점수 · 전적 · 지역 그대로, 새 열쇠)
        this.sql.exec("UPDATE pvp_players SET keyhash=?, hidden=0, nick=?, updated=? WHERE uid=?", await sha256(key), ac.nick, now, old.uid);
        return json({ uid: old.uid, key, rating: old.rating, region: old.region, restored: true });
      }
      let w; if ((w = this.tooFast(ip, "pvpjoin", P.joinGap))) return json({ error: `${w}초 뒤에 다시 해 주세요` }, 429);
      const region = REGIONS.includes(body.region) ? body.region : null;
      const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      this.sql.exec("INSERT INTO pvp_players(uid,keyhash,nick,ip,created,updated,day,region,region_month,aid) VALUES(?,?,?,?,?,?,?,?,?,?)",
        uid, await sha256(key), ac.nick, ip, now, now, today, region, null, ac.aid);     // 처음 고른 지역은 «바꾸기 1회»에 안 셈
      return json({ uid, key, rating: 1000, region });
    }
    if (p === "leave" && m === "POST") {               // 온라인 대결 끄기 — 랭킹 · 상대 목록에서 빠짐 (기록은 계정에 남아 다시 켜면 이어짐)
      const r = await me();
      if (!r) return json({ error: "로그인 정보가 맞지 않아요", relogin: true }, 401);
      this.sql.exec("UPDATE pvp_players SET hidden=1 WHERE uid=?", r.uid);
      return json({ ok: true });
    }
    if (p === "rank" && m === "GET") {
      const reg = REGIONS.includes(url.searchParams.get("region")) ? url.searchParams.get("region") : null;
      const W = reg ? " AND region=?" : "", A = reg ? [reg] : [];
      const top = this.sql.exec(`SELECT * FROM pvp_players WHERE hidden=0 AND aid IS NOT NULL AND team IS NOT NULL${W} ORDER BY rating DESC, wins DESC LIMIT 50`, ...A).toArray().map(pub);
      const total = this.sql.exec(`SELECT COUNT(*) n FROM pvp_players WHERE hidden=0 AND aid IS NOT NULL AND team IS NOT NULL${W}`, ...A).one().n;
      const r = await me();
      const mine = r ? { ...pub(r), rank: this.sql.exec(`SELECT COUNT(*) n FROM pvp_players WHERE hidden=0 AND aid IS NOT NULL AND team IS NOT NULL AND rating>?${W}`, r.rating, ...A).one().n + 1 } : null;
      return json({ top, total, me: mine, region: reg });
    }
    if (p === "sel" && m === "GET") {                  // 이번 달 지역 선발전 순위
      const reg = REGIONS.includes(url.searchParams.get("region")) ? url.searchParams.get("region") : null;
      if (!reg) return json({ error: "소속 발굴 기지를 골라 주세요" }, 400);
      const list = this.sql.exec("SELECT uid, nick, pts, wins, losses FROM pvp_sel WHERE month=? AND region=? ORDER BY pts DESC, wins DESC LIMIT 30", K.month, reg).toArray();
      return json({ month: K.month, region: reg, list, sel: K.sel, sel_from: K.selFrom, last_day: K.days });
    }
    if (p === "regions" && m === "GET") {            // 이번 달 지역 대항 (승수 합계 · 인원)
      const wins = Object.fromEntries(this.sql.exec("SELECT region, wins FROM pvp_region WHERE month=?", K.month).toArray().map(x => [x.region, x.wins]));
      const cnt = Object.fromEntries(this.sql.exec("SELECT region, COUNT(*) n FROM pvp_players WHERE hidden=0 AND aid IS NOT NULL AND team IS NOT NULL AND region IS NOT NULL GROUP BY region").toArray().map(x => [x.region, x.n]));
      const list = REGIONS.map(g => ({ region: g, wins: wins[g] || 0, players: cnt[g] || 0 })).sort((a, b) => b.wins - a.wins);
      const lg = this.sql.exec("SELECT champion FROM pvp_league WHERE month=?", K.prev).toArray()[0];
      return json({ month: K.month, list, champion: lg ? lg.champion : null, sel: K.sel, sel_from: K.selFrom, last_day: K.days });
    }
    const r = await me();
    if (!r) return json({ error: "온라인 대결 등록 정보가 맞지 않아요 — 다시 등록해 주세요", relogin: true }, 401);
    const left = () => P.daily - (r.day === today ? r.attacks : 0);
    if (!r.aid && ["opponents", "result", "region", "claim"].includes(p))        // 연동 전 기록: 방어 팀을 다시 올리면(계정 정보와 함께) 계정에 묶여요
      return json({ error: "온라인 대결 기록은 연동된 계정에 묶여요 — 계정 연동 · 닉네임을 정한 뒤 «지금 출전 팀으로 다시 올리기»를 눌러 주세요", need_acct: true }, 403);
    if (p === "me" && m === "GET") {
      const log = this.sql.exec(`SELECT l.win, l.ddef, l.created, p.nick, p.rating FROM pvp_log l JOIN pvp_players p ON p.uid=l.atk
        WHERE l.def=? ORDER BY l.id DESC LIMIT 10`, r.uid).toArray();
      const sel = this.sql.exec("SELECT pts, wins, losses FROM pvp_sel WHERE month=? AND uid=?", K.month, r.uid).toArray()[0] || null;
      let srank = null;
      if (sel && r.region) srank = this.sql.exec("SELECT COUNT(*) n FROM pvp_sel WHERE month=? AND region=? AND pts>?", K.month, r.region, sel.pts).one().n + 1;
      return json({ ...pub(r), dwins: r.dwins, dlosses: r.dlosses, left: left(), has_team: !!r.team, defense: log,
        region_month: r.region_month, can_move: r.region_month !== K.month, sel_wait: r.region_month === K.month, month: K.month, sel_on: K.sel, sel_from: K.selFrom, last_day: K.days,
        sel, sel_rank: srank });
    }
    if (p === "region" && m === "POST") {              // 지역 고르기 · 바꾸기 (한 달에 한 번)
      const g = String(body.region || "");
      if (!REGIONS.includes(g)) return json({ error: "없는 발굴 기지예요" }, 400);
      if (r.region && r.region_month === K.month && r.region !== g) return json({ error: "발굴 기지는 한 달에 한 번만 옮길 수 있어요 (다음 달 1일부터)" }, 429);
      if (K.sel && r.region && r.region !== g) return json({ error: "선발전 기간에는 기지를 옮길 수 없어요" }, 429);
      const moved = r.region && r.region !== g;        // 처음 고르기는 무료, 다른 지역으로 옮길 때만 이번 달 1회 사용
      this.sql.exec("UPDATE pvp_players SET region=?, region_month=? WHERE uid=?", g, moved ? K.month : r.region_month, r.uid);
      return json({ ok: true, region: g });
    }
    if (p === "league" && m === "GET") {               // 지난달 천하통일 리그 결과 + 내 보상
      const mon = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : K.prev;
      const lg = this.sql.exec("SELECT * FROM pvp_league WHERE month=?", mon).toArray()[0];
      const d = lg ? JSON.parse(lg.data) : null;
      if (!d || !d.reps.length) return json({ month: mon, none: true });
      const mem = this.sql.exec("SELECT region FROM pvp_member WHERE month=? AND uid=?", mon, r.uid).toArray()[0];
      const reward = leagueReward(d, r.uid, mem ? mem.region : null);
      const claimed = this.sql.exec("SELECT 1 FROM pvp_claim WHERE month=? AND uid=?", mon, r.uid).toArray().length > 0;
      return json({ month: mon, ...d, champion: lg.champion, my_region: mem ? mem.region : null, reward, claimed });
    }
    if (p === "claim" && m === "POST") {
      const mon = String(body.month || "");
      const lg = this.sql.exec("SELECT * FROM pvp_league WHERE month=?", mon).toArray()[0];
      if (!lg) return json({ error: "결과가 없어요" }, 404);
      if (this.sql.exec("SELECT 1 FROM pvp_claim WHERE month=? AND uid=?", mon, r.uid).toArray().length) return json({ error: "이미 받았어요" }, 409);
      const mem = this.sql.exec("SELECT region FROM pvp_member WHERE month=? AND uid=?", mon, r.uid).toArray()[0];
      const reward = leagueReward(JSON.parse(lg.data), r.uid, mem ? mem.region : null);
      if (!reward) return json({ error: "받을 보상이 없어요" }, 404);
      let wallet = null;
      if (reward.token > 0) {                        // 멸종 결정은 연동된 계정 지갑으로 (PC 세이브엔 안 넣음)
        if (!body.aid || !body.token) return json({ error: "멸종 결정 보상은 계정 연동을 해야 받을 수 있어요 (연구원 수첩 › 저장 · 복구)", need_acct: true }, 403);
        const res = await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("main")).fetch(new Request("https://internal/internal/credit", {
          method: "POST", body: JSON.stringify({ aid: body.aid, token: body.token, coin: "crystal", n: reward.token, reason: `league:${mon}`, ref: `league:${mon}:${r.uid}` }) }));
        wallet = await res.json();
        if (!res.ok) return json({ error: wallet.error || "계정 지갑에 넣지 못했어요", relogin_acct: !!wallet.relogin }, res.status);
      }
      this.sql.exec("INSERT INTO pvp_claim(month,uid) VALUES(?,?)", mon, r.uid);
      return json({ ok: true, reward, wallet });
    }
    if (p === "team" && m === "POST") {
      let w; if ((w = this.tooFast(ip, "pvpteam", P.teamGap))) return json({ error: `${w}초 뒤에 다시 올려 주세요` }, 429);
      const team = (Array.isArray(body.team) ? body.team : []).slice(0, P.teamMax).map(d => ({
        kind: clean(d.kind, 40), name: clean(d.name, LIMITS.nick), level: Math.max(1, Math.min(999, d.level | 0)),
        grade: ["C", "B", "A", "S", "SS"].includes(d.grade) ? d.grade : "C", shiny: !!d.shiny,
        hp: Math.max(1, Math.min(P.statMax, d.hp | 0)), atk: Math.max(1, Math.min(P.statMax, d.atk | 0)),
        df: Math.max(1, Math.min(P.statMax, d.df | 0)), role: ["tank", "bal", "dps"].includes(d.role) ? d.role : "bal",
      })).filter(d => /^[a-z0-9_]+$/.test(d.kind));
      if (!team.length) return json({ error: "올릴 공룡이 없어요" }, 400);
      const power = team.reduce((a, d) => a + Math.floor(d.hp * 0.5 + d.atk * 3 + d.df * 2), 0);
      const ac = await this.acctInfo(body);
      if (ac.ok && !r.aid && !this.sql.exec("SELECT 1 FROM pvp_players WHERE aid=?", ac.aid).toArray().length) {
        this.sql.exec("UPDATE pvp_players SET aid=? WHERE uid=?", ac.aid, r.uid);      // 예전(연동 전) 기록을 계정에 묶음
        r.aid = ac.aid;
      }
      const nick = (ac.ok && ac.aid === r.aid && ac.nick) || anonNick(r.uid);
      this.sql.exec("UPDATE pvp_players SET team=?, power=?, nick=?, ip=?, updated=? WHERE uid=?",
        JSON.stringify(team), power, nick, ip, Date.now(), r.uid);
      if (r.region) {
        this.sql.exec("INSERT OR REPLACE INTO pvp_member(month,uid,region) VALUES(?,?,?)", K.month, r.uid, r.region);
        this.sql.exec("UPDATE pvp_sel SET team=?, nick=? WHERE month=? AND uid=?", JSON.stringify(team), nick, K.month, r.uid);
      }
      return json({ ok: true, power });
    }
    if (p === "opponents" && m === "GET") {
      const live = Date.now() - P.staleDays * 86400e3;
      const selMode = K.sel && !!r.region;                // 선발전 기간: 같은 지역 사람끼리만
      const RW = selMode ? " AND region=?" : "", RA = selMode ? [r.region] : [];
      const pick = (lo, hi) => this.sql.exec(`SELECT * FROM pvp_players WHERE hidden=0 AND aid IS NOT NULL AND team IS NOT NULL AND uid<>? AND updated>?
        AND rating BETWEEN ? AND ?${RW} ORDER BY RANDOM() LIMIT 3`, r.uid, live, lo, hi, ...RA).toArray();
      let rows = pick(r.rating - 150, r.rating + 150);
      if (rows.length < 3) rows = pick(r.rating - 500, r.rating + 500);
      if (rows.length < 3) rows = pick(-1e9, 1e9);
      rows.sort((a, b) => a.rating - b.rating);
      return json({ left: left(), sel: selMode, list: rows.map(o => ({ ...pub(o), team: JSON.parse(o.team), gain: elo(r.rating, o.rating, true), loss: elo(r.rating, o.rating, false) })) });
    }
    if (p === "result" && m === "POST") {
      if (left() <= 0) return json({ error: "오늘 도전 횟수를 다 썼어요 (내일 다시)" }, 429);
      let w; if ((w = this.tooFast(r.uid, "pvpres", P.resultGap))) return json({ error: `${w}초 뒤에 다시 해 주세요` }, 429);
      const o = this.sql.exec("SELECT * FROM pvp_players WHERE uid=? AND hidden=0", String(body.opp || "")).toArray()[0];
      if (!o || o.uid === r.uid) return json({ error: "없는 상대예요" }, 404);
      const same = this.sql.exec("SELECT COUNT(*) n FROM pvp_log WHERE atk=? AND def=? AND created>?", r.uid, o.uid, Date.now() - 86400e3).one().n;
      if (same >= P.sameOpp) return json({ error: "같은 상대에게는 하루 3번까지 도전해요" }, 429);
      const win = !!body.win;
      const da = win ? elo(r.rating, o.rating, true) : -elo(r.rating, o.rating, false);
      const dd = Math.round(-da / 2);
      const att = r.day === today ? r.attacks + 1 : 1;
      this.sql.exec(`UPDATE pvp_players SET rating=MAX(0,rating+?), wins=wins+?, losses=losses+?, day=?, attacks=? WHERE uid=?`,
        da, win ? 1 : 0, win ? 0 : 1, today, att, r.uid);
      this.sql.exec(`UPDATE pvp_players SET rating=MAX(0,rating+?), dwins=dwins+?, dlosses=dlosses+? WHERE uid=?`,
        dd, win ? 0 : 1, win ? 1 : 0, o.uid);
      this.sql.exec("INSERT INTO pvp_log(atk,def,win,datk,ddef,created) VALUES(?,?,?,?,?,?)", r.uid, o.uid, win ? 1 : 0, da, dd, Date.now());
      let selDelta = null;
      if (win && r.region) this.sql.exec("INSERT INTO pvp_region(month,region,wins) VALUES(?,?,1) ON CONFLICT(month,region) DO UPDATE SET wins=wins+1", K.month, r.region);
      if (K.sel && r.region && o.region === r.region && r.region_month !== K.month) {   // 선발전 점수 (같은 지역 상대에게 이긴/진 만큼 · 이번 달에 옮겨 온 사람은 다음 달부터)
        selDelta = da;
        this.sql.exec(`INSERT INTO pvp_sel(month,uid,region,pts,wins,losses,team,nick) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(month,uid) DO UPDATE SET pts=pts+excluded.pts, wins=wins+excluded.wins, losses=losses+excluded.losses, region=excluded.region, team=excluded.team, nick=excluded.nick`,
          K.month, r.uid, r.region, da, win ? 1 : 0, win ? 0 : 1, r.team, r.nick);
      }
      const nr = this.sql.exec("SELECT rating FROM pvp_players WHERE uid=?", r.uid).one().rating;
      return json({ ok: true, delta: da, rating: nr, left: P.daily - att, sel_delta: selDelta });
    }
    return json({ error: "없는 주소예요" }, 404);
  }

  async acctInfo(body) {          // 연동된 계정 확인 → {ok, aid, nick}
    if (!body.aid || !body.token) return { ok: false };
    try {
      const res = await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("main")).fetch(new Request("https://internal/internal/nick", {
        method: "POST", body: JSON.stringify({ aid: body.aid, token: body.token }) }));
      return await res.json();
    } catch (e) { return { ok: false }; }
  }

  // 달이 바뀐 뒤 첫 요청 때: 지난달 선발전 1위 = 지역 대표 → 천하통일 토너먼트를 서버에서 자동으로 치름 (한 번만)
  leagueRun(K) {
    const mon = K.prev;
    if (this._leagueDone === mon) return;
    if (this.sql.exec("SELECT 1 FROM pvp_league WHERE month=?", mon).toArray().length) { this._leagueDone = mon; return; }
    const reps = [];
    for (const g of REGIONS) {
      const r = this.sql.exec("SELECT * FROM pvp_sel WHERE month=? AND region=? AND team IS NOT NULL ORDER BY pts DESC, wins DESC, losses ASC LIMIT 1", mon, g).toArray()[0];
      if (r && r.wins + r.losses > 0) reps.push({ region: g, uid: r.uid, nick: r.nick, pts: r.pts, team: JSON.parse(r.team) });
    }
    const data = { reps: reps.map(({ team, ...x }) => ({ ...x, team: team.map(d => ({ kind: d.kind, name: d.name, level: d.level, grade: d.grade, shiny: d.shiny })) })), rounds: [], champion: null };
    let seed = 0;
    for (const ch of mon) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    let field = [...reps].sort((a, b) => b.pts - a.pts);
    if (field.length === 1) data.champion = field[0].region;
    while (field.length > 1) {                       // 짝이 없는 지역은 부전승
      const next = [], round = [];
      const half = Math.ceil(field.length / 2);
      for (let i = 0; i < half; i++) {
        const a = field[i], b = field[field.length - 1 - i];
        if (!b || a === b) { next.push(a); round.push({ a: a.region, b: null, w: a.region }); continue; }
        const res = simBattle(a.team, b.team, seed + data.rounds.length * 97 + i);
        const w = res.win === 0 ? a : b;
        next.push(w);
        round.push({ a: a.region, b: b.region, w: w.region, hpA: res.hpA, hpB: res.hpB, time: res.time });
      }
      data.rounds.push(round);
      field = next;
    }
    if (field.length === 1) data.champion = field[0].region;
    this.sql.exec("INSERT OR IGNORE INTO pvp_league(month,data,champion,created) VALUES(?,?,?,?)", mon, JSON.stringify(data), data.champion, Date.now());
    this._leagueDone = mon;
  }

}
