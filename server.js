/* ────────────────────────────────────────────────────────────
   드로잉 스튜디오 – 학급 방 서버
   - 외부 패키지 없이 Node.js 내장 모듈만 사용합니다.
   - 실행:  node server.js   (기본 포트 3000)
   - 같은 와이파이의 학생들이 아래에 표시되는 주소로 접속합니다.
   ──────────────────────────────────────────────────────────── */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "rooms.json");
const MAX_BODY = 8 * 1024 * 1024;   // 8MB (이미지 포함)
const MAX_ITEMS_PER_ROOM = 300;

// ── 데이터 (메모리 + 파일 영속화) ──
let rooms = {};
try {
  if (fs.existsSync(DATA_FILE)) rooms = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) || {};
} catch (e) { console.warn("rooms.json 읽기 실패, 새로 시작합니다."); rooms = {}; }

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE, JSON.stringify(rooms), (e) => { if (e) console.warn("저장 실패:", e.message); });
  }, 1200);
}

// ── 유틸 ──
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 O0I1 제외
function makeCode(len = 4) {
  let c;
  do {
    c = "";
    for (let i = 0; i < len; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms[c]);
  return c;
}
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name]) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".ico": "image/x-icon" };
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.join(ROOT, path.normalize(rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("찾을 수 없습니다"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

// ── 라우팅 ──
const server = http.createServer(async (req, res) => {
  const url = req.url || "/";
  // API
  if (url.startsWith("/api/")) {
    try {
      // 헬스체크
      if (url === "/api/health" && req.method === "GET") {
        return sendJSON(res, 200, { ok: true, ips: lanIPs(), port: PORT, rooms: Object.keys(rooms).length });
      }
      // 방 생성
      if (url === "/api/rooms" && req.method === "POST") {
        const b = await readBody(req);
        const name = String(b.name || "우리 반").slice(0, 40);
        const code = makeCode(4);
        const manageKey = crypto.randomBytes(12).toString("hex");
        rooms[code] = { code, name, manageKey, created: Date.now(), items: [] };
        persist();
        return sendJSON(res, 200, { code, name, manageKey });
      }
      // /api/rooms/:code ...
      const m = url.match(/^\/api\/rooms\/([A-Za-z0-9]+)(\/items(?:\/([\w-]+))?)?(?:\?.*)?$/);
      if (m) {
        const code = m[1].toUpperCase();
        const room = rooms[code];
        if (!room) return sendJSON(res, 404, { error: "방을 찾을 수 없습니다" });

        // 방 정보
        if (!m[2] && req.method === "GET") {
          return sendJSON(res, 200, { code: room.code, name: room.name, count: room.items.length });
        }
        // 작품 제출
        if (m[2] === "/items" && req.method === "POST") {
          const b = await readBody(req);
          if (!b.image || typeof b.image !== "string" || b.image.length > MAX_BODY) return sendJSON(res, 400, { error: "이미지 오류" });
          const item = {
            id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
            name: String(b.name || "이름없음").slice(0, 30),
            number: String(b.number || "").slice(0, 10),
            message: String(b.message || "").slice(0, 200),
            image: b.image, ts: Date.now()
          };
          room.items.push(item);
          if (room.items.length > MAX_ITEMS_PER_ROOM) room.items.shift();
          persist();
          return sendJSON(res, 200, { id: item.id });
        }
        // 목록 (since 필터, meta=1이면 이미지 제외)
        if (m[2] === "/items" && req.method === "GET") {
          const q = new URLSearchParams(url.split("?")[1] || "");
          const since = Number(q.get("since") || 0);
          const meta = q.get("meta") === "1";
          const items = room.items.filter(it => it.ts > since).map(it => meta ? { id: it.id, name: it.name, number: it.number, message: it.message, ts: it.ts } : it);
          return sendJSON(res, 200, { name: room.name, count: room.items.length, items, now: Date.now() });
        }
        // 단일 이미지
        if (m[3] && !m[2].endsWith("/items") && false) { /* unused */ }
        // 삭제 (관리키 필요)
        if (m[2] && m[3] && req.method === "DELETE") {
          const key = req.headers["x-manage-key"];
          if (key !== room.manageKey) return sendJSON(res, 403, { error: "권한이 없습니다" });
          const before = room.items.length;
          room.items = room.items.filter(it => it.id !== m[3]);
          persist();
          return sendJSON(res, 200, { removed: before - room.items.length });
        }
      }
      return sendJSON(res, 404, { error: "알 수 없는 요청" });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message || "요청 오류" });
    }
  }
  // 정적 파일
  serveStatic(req, res, url);
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = lanIPs();
  console.log("\n  🎨 드로잉 스튜디오 – 학급 방 서버가 시작되었습니다.\n");
  console.log("  선생님 화면(이 컴퓨터):");
  console.log("    http://localhost:" + PORT + "\n");
  if (ips.length) {
    console.log("  학생 접속 주소(같은 와이파이):");
    ips.forEach(ip => console.log("    http://" + ip + ":" + PORT));
  } else {
    console.log("  (외부 네트워크 주소를 찾지 못했습니다. 같은 와이파이 연결을 확인하세요.)");
  }
  console.log("\n  종료하려면 이 창에서 Ctrl+C 를 누르세요.\n");
});
