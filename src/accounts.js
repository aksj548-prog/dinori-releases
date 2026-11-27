// 다이노리 계정 연동 + 클라우드 저장
// · 스팀(OpenID — 키 없이 됨) · 구글 · 네이버(OAuth — Cloudflare 비밀값 GOOGLE_ID/GOOGLE_SECRET, NAVER_ID/NAVER_SECRET 필요)
// · 게임: 세션 번호를 만들어 브라우저로 /api/auth/start 를 열고 → /api/auth/poll 로 결과(계정 번호·토큰)를 받아감
// · 저장: /api/acct/save (게임이 zlib+base64 로 압축한 세이브) — 계정마다 최신 1개 + 직전 1개
import { DurableObject } from "cloudflare:workers";

const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const page = (title, msg, ok = true) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>다이노리 · ${title}</title><body style="font-family:sans-serif;background:#f4eedc;color:#333;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="background:#fffbee;border:2px solid ${ok ? "#3a6e4e" : "#b55"};border-radius:12px;padding:32px 40px;text-align:center;max-width:420px">
<h2 style="color:${ok ? "#3a6e4e" : "#b55"};margin-top:0">${title}</h2><p>${msg}</p><p style="color:#888;font-size:13px">이 창은 닫아도 돼요.</p></div></body>`,
  { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const rid = (n = 32) => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, "0")).join("");
const PROV = { steam: "스팀", google: "구글", naver: "네이버" };
const SAVE_MAX = 1_900_000;          // 압축한 세이브 최대 약 1.9MB
const SAVE_GAP = 20;                  // 초 — 너무 자주 올리지 않게
// 유료 재화 지갑 — 결정(crystal) · 특수 호박(sp_amber)은 PC 세이브가 아니라 계정에 보관 (세이브를 고쳐도 늘지 않음)
// 상품 → 지급량 (게임 iap.PACKS 와 같게 유지)
const PACKS = {
  crystal_3: { crystal: 30 }, crystal_11: { crystal: 110 }, crystal_35: { crystal: 350 }, crystal_120: { crystal: 1200 }, crystal_390: { crystal: 3900 },   // 11/23 지급량 10배 (가격 그대로)
  starter_pack: { crystal: 200, once: true },
  sp_amber_3: { sp_amber: 30 }, sp_amber_11: { sp_amber: 110 }, sp_amber_36: { sp_amber: 360 },   // 11/25 지급량 10배 (가격 그대로)
  enh_stone_5: { enh_stone: 50 }, enh_stone_16: { enh_stone: 160 }, enh_stone_55: { enh_stone: 550 },   // 지급량 10배 (가격 그대로)
};
const COINS = ["crystal", "sp_amber", "enh_stone"];
// 대륙 원정 최종 난이도(멸종) 승리 → 멸종 결정 드랍 — 확률 · 하루 횟수 · 간격을 서버가 정해요 (게임 challenges.CONT_TOKEN_* 와 같게)
const DROP = { cont: { n: 3, chance: [0.2, 0.5], day: 10, gap: 40 } };
// 온라인 닉네임 — 계정마다 하나, 서로 겹치지 않게 (대소문자 구분 없이)
const NICK_RE = /^[가-힣A-Za-z0-9_]{2,10}$/;
const NICK_BAN = ["익명", "운영자", "관리자", "운영진", "다이노리", "admin", "gm", "dinori", "system", "시스템", "공식"];
function nickBad(n) {
  if (!NICK_RE.test(n)) return "닉네임은 한글 · 영문 · 숫자 · _ 로 2~10글자예요";
  if (/[ㄱ-ㅎㅏ-ㅣ]/.test(n)) return "자음 · 모음만 따로 쓸 수 없어요";
  const low = n.toLowerCase();
  if (NICK_BAN.some(w => low.includes(w))) return "쓸 수 없는 단어가 들어 있어요";
  return null;
}
const MIGRATE_CAP = { crystal: 3000, sp_amber: 300, enh_stone: 0 };   // 강화석은 옮기지 않음 (게임에서 얻은 건 세이브에 그대로)     // 예전 세이브에서 옮겨 오는 양 상한 (고친 세이브 대비)

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS acct(aid TEXT PRIMARY KEY, tokhash TEXT, name TEXT, created INTEGER, seen INTEGER);
      CREATE TABLE IF NOT EXISTS ident(provider TEXT, pid TEXT, aid TEXT, name TEXT, created INTEGER, PRIMARY KEY(provider, pid));
      CREATE TABLE IF NOT EXISTS sess(s TEXT PRIMARY KEY, created INTEGER, link_aid TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS saves(aid TEXT, slot INTEGER, data TEXT, meta TEXT, created INTEGER, PRIMARY KEY(aid, slot));
      CREATE INDEX IF NOT EXISTS ident_aid ON ident(aid);
      CREATE TABLE IF NOT EXISTS wallet(aid TEXT PRIMARY KEY, crystal INTEGER DEFAULT 0, sp_amber INTEGER DEFAULT 0, migrated INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS wlog(ref TEXT PRIMARY KEY, aid TEXT, coin TEXT, delta INTEGER, reason TEXT, created INTEGER);
      CREATE INDEX IF NOT EXISTS wlog_aid ON wlog(aid, created);
      CREATE TABLE IF NOT EXISTS nicks(low TEXT PRIMARY KEY, aid TEXT UNIQUE, nick TEXT, created INTEGER);
    `);
    try { this.sql.exec("ALTER TABLE wallet ADD COLUMN enh_stone INTEGER DEFAULT 0"); } catch (e) { /* 이미 있음 */ }
    this.last = new Map();
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/^\/api/, "");
    try {
      if (p === "/auth/start") return this.start(url);
      let r;
      if ((r = p.match(/^\/auth\/cb\/(steam|google|naver)$/))) return this.callback(r[1], url, req);
      if (p === "/auth/poll") return this.poll(url);
      if (p === "/auth/test" && this.env.TEST_AUTH) {    // 로컬 시험 전용 (실서버엔 TEST_AUTH 없음)
        const s = url.searchParams.get("s"), ss = this.sql.exec("SELECT * FROM sess WHERE s=?", s).toArray()[0];
        return this.finish("steam", url.searchParams.get("pid"), "스팀", ss, s);
      }
      if (p === "/internal/credit" && req.method === "POST") {   // 다른 서버 코드(천하통일 리그 보상)만 부름 — 밖에서는 이 주소로 못 들어옴
        const b = await req.json().catch(() => ({}));
        const a = await this.auth(b);
        if (!a) return json({ error: "계정 정보가 맞지 않아요", relogin: true }, 401);
        return this.credit(a.aid, b.coin, b.n | 0, String(b.reason || "reward"), String(b.ref || ""));
      }
      if (p === "/internal/nick" && req.method === "POST") {     // 온라인 대결 서버가 닉네임을 물을 때
        const b = await req.json().catch(() => ({}));
        const a = await this.auth(b);
        if (!a) return json({ ok: false, nick: null });
        const r = this.sql.exec("SELECT nick FROM nicks WHERE aid=?", a.aid).toArray()[0];
        return json({ ok: true, aid: a.aid, nick: r ? r.nick : null });
      }
      if (p === "/auth/providers") return json({ steam: true, google: !!(this.env.GOOGLE_ID && this.env.GOOGLE_SECRET), naver: !!(this.env.NAVER_ID && this.env.NAVER_SECRET) });
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      const a = await this.auth(req.method === "POST" ? body : Object.fromEntries(url.searchParams));
      if (!a) return json({ error: "계정 정보가 맞지 않아요 — 다시 연동해 주세요", relogin: true }, 401);
      this.sql.exec("UPDATE acct SET seen=? WHERE aid=?", Date.now(), a.aid);
      if (p === "/acct/me") return this.me(a);
      if (p === "/acct/save" && req.method === "POST") return this.putSave(a, body);
      if (p === "/acct/save" && req.method === "GET") return this.getSave(a, url);
      if (p === "/acct/unlink" && req.method === "POST") {
        const n = this.sql.exec("SELECT COUNT(*) n FROM ident WHERE aid=?", a.aid).one().n;
        if (n <= 1) return json({ error: "연동된 계정이 하나뿐이라 끊을 수 없어요 (계정 삭제를 쓰세요)" }, 400);
        this.sql.exec("DELETE FROM ident WHERE aid=? AND provider=?", a.aid, String(body.provider || ""));
        return this.me(a);
      }
      if (p === "/acct/nick/check" && req.method === "GET") {
        const n = String(url.searchParams.get("nick") || "").trim(), bad = nickBad(n);
        if (bad) return json({ ok: false, error: bad });
        const r = this.sql.exec("SELECT aid FROM nicks WHERE low=?", n.toLowerCase()).toArray()[0];
        return json({ ok: !r || r.aid === a.aid, error: r && r.aid !== a.aid ? "이미 다른 연구원이 쓰는 닉네임이에요" : null });
      }
      if (p === "/acct/nick" && req.method === "POST") {
        const n = String(body.nick || "").trim(), bad = nickBad(n);
        if (bad) return json({ error: bad }, 400);
        const r = this.sql.exec("SELECT aid FROM nicks WHERE low=?", n.toLowerCase()).toArray()[0];
        if (r && r.aid !== a.aid) return json({ error: "이미 다른 연구원이 쓰는 닉네임이에요 — 다른 닉네임을 골라 주세요", taken: true }, 409);
        this.sql.exec("DELETE FROM nicks WHERE aid=?", a.aid);
        this.sql.exec("INSERT INTO nicks(low,aid,nick,created) VALUES(?,?,?,?)", n.toLowerCase(), a.aid, n, Date.now());
        return this.me(a);
      }
      if (p === "/acct/wallet" && req.method === "GET") return json(this.wallet(a.aid));
      if (p === "/acct/wallet/migrate" && req.method === "POST") return this.migrate(a.aid, body);
      if (p === "/acct/wallet/spend" && req.method === "POST") return this.spend(a.aid, body);
      if (p === "/acct/wallet/purchase" && req.method === "POST") return this.purchase(a.aid, body);
      if (p === "/acct/wallet/drop" && req.method === "POST") return this.drop(a.aid, body);
      if (p === "/acct/delete" && req.method === "POST") {      // 계정 · 클라우드 저장 전부 삭제
        for (const t of ["ident", "saves", "acct", "wallet", "nicks"]) this.sql.exec(`DELETE FROM ${t} WHERE aid=?`, a.aid);
        return json({ ok: true });
      }
      return json({ error: "없는 주소예요" }, 404);
    } catch (e) {
      return json({ error: "서버 오류: " + String(e.message || e).slice(0, 120) }, 500);
    }
  }

  async auth(q) {
    const aid = String(q.aid || ""), tok = String(q.token || "");
    if (!aid || !tok) return null;
    const r = this.sql.exec("SELECT * FROM acct WHERE aid=?", aid).toArray()[0];
    return r && r.tokhash === (await sha256(tok)) ? r : null;
  }

  // 게임이 연 브라우저 → 각 회사 로그인 화면으로
  async start(url) {
    const prov = url.searchParams.get("p"), s = url.searchParams.get("s") || "";
    if (!PROV[prov] || !/^[a-f0-9]{32,64}$/.test(s)) return page("잘못된 요청", "게임에서 다시 «계정 연동»을 눌러 주세요.", false);
    this.sql.exec("DELETE FROM sess WHERE created<?", Date.now() - 15 * 60e3);
    let link = null;
    const la = url.searchParams.get("aid"), lt = url.searchParams.get("token");
    if (la && lt) { const a = await this.auth({ aid: la, token: lt }); if (a) link = a.aid; }   // 이미 있는 계정에 다른 로그인 추가
    this.sql.exec("INSERT OR REPLACE INTO sess(s,created,link_aid,result) VALUES(?,?,?,NULL)", s, Date.now(), link);
    const cb = `${url.origin}/api/auth/cb/${prov}`;
    if (prov === "steam") {
      const q = new URLSearchParams({
        "openid.ns": "http://specs.openid.net/auth/2.0", "openid.mode": "checkid_setup",
        "openid.return_to": `${cb}?s=${s}`, "openid.realm": url.origin,
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
      });
      return Response.redirect("https://steamcommunity.com/openid/login?" + q, 302);
    }
    if (prov === "google") {
      if (!this.env.GOOGLE_ID) return page("준비 중", "구글 연동은 아직 준비 중이에요. 스팀으로 연동해 주세요.", false);
      const q = new URLSearchParams({ client_id: this.env.GOOGLE_ID, redirect_uri: cb, response_type: "code", scope: "openid", state: s, prompt: "select_account" });
      return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q, 302);
    }
    if (!this.env.NAVER_ID) return page("준비 중", "네이버 연동은 아직 준비 중이에요. 스팀으로 연동해 주세요.", false);
    const q = new URLSearchParams({ response_type: "code", client_id: this.env.NAVER_ID, redirect_uri: cb, state: s });
    return Response.redirect("https://nid.naver.com/oauth2.0/authorize?" + q, 302);
  }

  // 각 회사에서 돌아옴 → 진짜인지 확인 → 계정 찾기/만들기 → 세션에 결과 남김
  async callback(prov, url) {
    const s = prov === "steam" ? url.searchParams.get("s") : url.searchParams.get("state");
    const ss = this.sql.exec("SELECT * FROM sess WHERE s=?", String(s || "")).toArray()[0];
    if (!ss || Date.now() - ss.created > 15 * 60e3) return page("시간이 지났어요", "게임에서 다시 «계정 연동»을 눌러 주세요.", false);
    let pid = null, pname = PROV[prov];
    if (prov === "steam") {
      const params = new URLSearchParams(url.search);
      params.delete("s");
      params.set("openid.mode", "check_authentication");
      const v = await fetch("https://steamcommunity.com/openid/login", { method: "POST", body: params, headers: { "content-type": "application/x-www-form-urlencoded" } });
      const txt = await v.text();
      const cid = url.searchParams.get("openid.claimed_id") || "";
      const m = cid.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{10,20})$/);
      if (!/is_valid\s*:\s*true/.test(txt) || !m) return page("확인 실패", "스팀 로그인을 확인하지 못했어요. 다시 해 주세요.", false);
      pid = m[1];
    } else if (prov === "google") {
      const code = url.searchParams.get("code");
      if (!code) return page("취소됨", "구글 로그인을 취소했어요.", false);
      const t = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: this.env.GOOGLE_ID, client_secret: this.env.GOOGLE_SECRET, redirect_uri: `${url.origin}/api/auth/cb/google`, grant_type: "authorization_code" }),
      }).then(r => r.json());
      if (!t.id_token) return page("확인 실패", "구글 로그인을 확인하지 못했어요.", false);
      const claims = JSON.parse(atob(t.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));   // 구글에서 직접 받은 토큰
      if (claims.aud !== this.env.GOOGLE_ID || !claims.sub) return page("확인 실패", "구글 로그인을 확인하지 못했어요.", false);
      pid = claims.sub;
    } else {
      const code = url.searchParams.get("code");
      if (!code) return page("취소됨", "네이버 로그인을 취소했어요.", false);
      const t = await fetch("https://nid.naver.com/oauth2.0/token?" + new URLSearchParams({ grant_type: "authorization_code", client_id: this.env.NAVER_ID, client_secret: this.env.NAVER_SECRET, code, state: s })).then(r => r.json());
      if (!t.access_token) return page("확인 실패", "네이버 로그인을 확인하지 못했어요.", false);
      const me = await fetch("https://openapi.naver.com/v1/nid/me", { headers: { authorization: "Bearer " + t.access_token } }).then(r => r.json());
      if (!me.response || !me.response.id) return page("확인 실패", "네이버 로그인을 확인하지 못했어요.", false);
      pid = me.response.id;
    }
    return this.finish(prov, pid, pname, ss, s);
  }

  async finish(prov, pid, pname, ss, s) {
    const now = Date.now();
    const had = this.sql.exec("SELECT aid FROM ident WHERE provider=? AND pid=?", prov, pid).toArray()[0];
    let aid;
    if (ss.link_aid) {                                   // 다른 로그인 추가
      if (had && had.aid !== ss.link_aid) return page("이미 다른 계정", `이 ${PROV[prov]} 계정은 이미 다른 다이노리 계정에 연동돼 있어요.`, false);
      aid = ss.link_aid;
      if (!had) this.sql.exec("INSERT INTO ident(provider,pid,aid,name,created) VALUES(?,?,?,?,?)", prov, pid, aid, pname, now);
    } else if (had) {
      aid = had.aid;
    } else {
      aid = rid(8);
      this.sql.exec("INSERT INTO acct(aid,tokhash,name,created,seen) VALUES(?,?,?,?,?)", aid, "", pname, now, now);
      this.sql.exec("INSERT INTO ident(provider,pid,aid,name,created) VALUES(?,?,?,?,?)", prov, pid, aid, pname, now);
    }
    const token = rid(32);                               // 이 PC 용 새 토큰 (예전 토큰은 무효)
    this.sql.exec("UPDATE acct SET tokhash=?, seen=? WHERE aid=?", await sha256(token), now, aid);
    this.sql.exec("UPDATE sess SET result=? WHERE s=?", JSON.stringify({ aid, token, provider: prov, created: !had && !ss.link_aid }), s);
    return page("연동 완료!", `${PROV[prov]} 계정으로 다이노리에 연결했어요. 게임으로 돌아가 주세요.`);
  }

  poll(url) {
    const s = String(url.searchParams.get("s") || "");
    const ss = this.sql.exec("SELECT * FROM sess WHERE s=?", s).toArray()[0];
    if (!ss) return json({ error: "없는 세션이에요", gone: true }, 404);
    if (!ss.result) return json({ wait: true });
    this.sql.exec("DELETE FROM sess WHERE s=?", s);       // 한 번만 받아감
    return json({ ok: true, ...JSON.parse(ss.result) });
  }

  me(a) {
    const ids = this.sql.exec("SELECT provider, created FROM ident WHERE aid=?", a.aid).toArray();
    const sv = this.sql.exec("SELECT slot, meta, created, LENGTH(data) n FROM saves WHERE aid=? ORDER BY slot", a.aid).toArray()
      .map(x => ({ slot: x.slot, meta: JSON.parse(x.meta || "{}"), created: x.created, size: x.n }));
    const nk = this.sql.exec("SELECT nick FROM nicks WHERE aid=?", a.aid).toArray()[0];
    return json({ aid: a.aid, providers: ids.map(x => x.provider), saves: sv, nick: nk ? nk.nick : null });
  }

  putSave(a, body) {
    const now = Date.now() / 1000, last = this.last.get(a.aid) || 0;
    if (now - last < SAVE_GAP) return json({ error: `${Math.ceil(SAVE_GAP - (now - last))}초 뒤에 다시 저장해 주세요` }, 429);
    const data = String(body.data || "");
    if (!data || data.length > SAVE_MAX || !/^[A-Za-z0-9+/=]+$/.test(data)) return json({ error: "세이브가 비었거나 너무 커요" }, 400);
    const meta = { ver: String(body.ver || "").slice(0, 16), player: String(body.player || "").slice(0, 24), dinos: body.dinos | 0, power: body.power | 0, pc: String(body.pc || "").slice(0, 24) };
    this.last.set(a.aid, now);
    const cur = this.sql.exec("SELECT * FROM saves WHERE aid=? AND slot=0", a.aid).toArray()[0];
    if (cur) this.sql.exec("INSERT OR REPLACE INTO saves(aid,slot,data,meta,created) VALUES(?,1,?,?,?)", a.aid, cur.data, cur.meta, cur.created);   // 직전 판 보관
    this.sql.exec("INSERT OR REPLACE INTO saves(aid,slot,data,meta,created) VALUES(?,0,?,?,?)", a.aid, data, JSON.stringify(meta), Date.now());
    return json({ ok: true, created: Date.now(), size: data.length });
  }

  // ── 지갑 ──
  wallet(aid) {
    this.sql.exec("INSERT OR IGNORE INTO wallet(aid) VALUES(?)", aid);
    const w = this.sql.exec("SELECT crystal, sp_amber, enh_stone, migrated FROM wallet WHERE aid=?", aid).one();
    const once = this.sql.exec("SELECT ref FROM wlog WHERE aid=? AND reason LIKE 'buy:%'", aid).toArray()
      .map(x => x.ref.split(":")[1]).filter(pid => PACKS[pid] && PACKS[pid].once);
    return { crystal: w.crystal, sp_amber: w.sp_amber, enh_stone: w.enh_stone | 0, migrated: !!w.migrated, bought_once: [...new Set(once)] };
  }

  credit(aid, coin, n, reason, ref) {
    if (!COINS.includes(coin) || n <= 0 || n > 100000) return json({ error: "잘못된 지급" }, 400);
    if (ref && this.sql.exec("SELECT 1 FROM wlog WHERE ref=?", ref).toArray().length) return json({ ok: true, again: true, ...this.wallet(aid) });
    this.wallet(aid);
    this.sql.exec(`UPDATE wallet SET ${coin}=${coin}+? WHERE aid=?`, n, aid);
    this.sql.exec("INSERT INTO wlog(ref,aid,coin,delta,reason,created) VALUES(?,?,?,?,?,?)", ref || rid(12), aid, coin, n, reason.slice(0, 40), Date.now());
    return json({ ok: true, ...this.wallet(aid) });
  }

  migrate(aid, body) {          // 예전(PC 세이브)에 있던 결정 · 특수 호박을 계정으로 한 번만 옮김
    const w = this.wallet(aid);
    if (w.migrated) return json({ ok: true, again: true, moved: { crystal: 0, sp_amber: 0 }, ...w });
    const moved = {};
    for (const c of COINS) {
      const n = Math.max(0, Math.min(MIGRATE_CAP[c], body[c] | 0));
      moved[c] = n;
      if (n) {
        this.sql.exec(`UPDATE wallet SET ${c}=${c}+? WHERE aid=?`, n, aid);
        this.sql.exec("INSERT INTO wlog(ref,aid,coin,delta,reason,created) VALUES(?,?,?,?,?,?)", rid(12), aid, c, n, "migrate", Date.now());
      }
    }
    this.sql.exec("UPDATE wallet SET migrated=1 WHERE aid=?", aid);
    return json({ ok: true, moved, ...this.wallet(aid) });
  }

  spend(aid, body) {            // 소환 · 특수종 DNA 조합 — 서버에서 먼저 빼고, 성공하면 게임이 결과를 만듦
    const coin = String(body.coin || ""), n = body.n | 0, ref = String(body.ref || "");
    if (!COINS.includes(coin) || n <= 0 || n > 10000 || !/^[a-f0-9]{16,64}$/.test(ref)) return json({ error: "잘못된 요청" }, 400);
    if (this.sql.exec("SELECT 1 FROM wlog WHERE ref=?", ref).toArray().length) return json({ ok: true, again: true, ...this.wallet(aid) });   // 같은 요청 다시 (통신 끊김 뒤)
    const w = this.wallet(aid);
    if (w[coin] < n) return json({ error: { crystal: "멸종 결정이 모자라요", sp_amber: "특수 호박이 모자라요", enh_stone: "강화석이 모자라요" }[coin], short: true, ...w }, 409);
    this.sql.exec(`UPDATE wallet SET ${coin}=${coin}-? WHERE aid=? AND ${coin}>=?`, n, aid, n);
    this.sql.exec("INSERT INTO wlog(ref,aid,coin,delta,reason,created) VALUES(?,?,?,?,?,?)", ref, aid, coin, -n, String(body.reason || "spend").slice(0, 40), Date.now());
    return json({ ok: true, ...this.wallet(aid) });
  }

  drop(aid, body) {             // 대륙 원정 «멸종» 난이도 승리 — 서버가 확률을 굴려 결정을 줌 (하루 횟수 · 간격 제한)
    const src = String(body.src || ""), cfg = DROP[src], ref = String(body.ref || "");
    if (!cfg || !/^[a-f0-9]{16,64}$/.test(ref)) return json({ error: "잘못된 요청" }, 400);
    if (this.sql.exec("SELECT 1 FROM wlog WHERE ref=?", "drop:" + ref).toArray().length) return json({ ok: true, again: true, n: 0, ...this.wallet(aid) });
    const now = Date.now();
    const rows = this.sql.exec("SELECT created, delta FROM wlog WHERE aid=? AND reason=? AND created>? ORDER BY created DESC", aid, "drop:" + src, now - 86400000).toArray();
    const last = rows.length ? rows[0].created : 0;
    const won = rows.filter(r => r.delta > 0).length;
    let n = 0, why = null;
    if (won >= cfg.day) why = "day";
    else if (now - last < cfg.gap * 1000) why = "gap";
    else if (Math.random() < cfg.chance[body.boss ? 1 : 0]) n = cfg.n;
    this.wallet(aid);
    if (n) this.sql.exec("UPDATE wallet SET crystal=crystal+? WHERE aid=?", n, aid);
    if (!why) this.sql.exec("INSERT INTO wlog(ref,aid,coin,delta,reason,created) VALUES(?,?,?,?,?,?)", "drop:" + ref, aid, "crystal", n, "drop:" + src, now);
    return json({ ok: true, n, why, left: Math.max(0, cfg.day - won - (n ? 1 : 0)), ...this.wallet(aid) });
  }

  purchase(aid, body) {         // 스토어 결제 지급 — 거래 번호(tx)마다 한 번만
    const pid = String(body.pid || ""), tx = String(body.tx || "");
    const pk = PACKS[pid];
    if (!pk || !/^[a-f0-9]{16,64}$/.test(tx)) return json({ error: "잘못된 구매 정보" }, 400);
    const ref = `buy:${pid}:${tx}`;
    if (this.sql.exec("SELECT 1 FROM wlog WHERE ref LIKE ?", `buy:${pid}:${tx}%`).toArray().length) return json({ ok: true, again: true, ...this.wallet(aid) });
    if (pk.once && this.wallet(aid).bought_once.includes(pid)) return json({ ok: true, again: true, once_used: true, ...this.wallet(aid) });
    this.wallet(aid);
    let i = 0;
    for (const c of COINS) {
      if (!pk[c]) continue;
      this.sql.exec(`UPDATE wallet SET ${c}=${c}+? WHERE aid=?`, pk[c], aid);
      this.sql.exec("INSERT INTO wlog(ref,aid,coin,delta,reason,created) VALUES(?,?,?,?,?,?)", i++ ? `${ref}:${c}` : ref, aid, c, pk[c], `buy:${pid}`, Date.now());
    }
    return json({ ok: true, ...this.wallet(aid) });
  }

  getSave(a, url) {
    const slot = url.searchParams.get("slot") === "1" ? 1 : 0;
    const r = this.sql.exec("SELECT data, meta, created FROM saves WHERE aid=? AND slot=?", a.aid, slot).toArray()[0];
    if (!r) return json({ error: "클라우드에 저장된 게 없어요" }, 404);
    return json({ data: r.data, meta: JSON.parse(r.meta || "{}"), created: r.created });
  }
}
