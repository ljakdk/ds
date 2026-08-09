/* ────────────────────────────────────────────────────────────
   초경량 QR 코드 생성기 (바이트 모드, 버전 1~6, 오류정정 레벨 M)
   외부 라이브러리 없이 동작. window.QRCode.make(text) → {size, modules[][]}
   QRCode.draw(canvas, text, opts) 로 캔버스에 렌더.
   교실 접속용 URL(수십 글자)에 충분합니다.
   ──────────────────────────────────────────────────────────── */
(function (global) {
  "use strict";

  // GF(256) 로그/역로그 테이블 (원시다항식 0x11d)
  const EXP = new Array(512), LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  // RS 생성다항식
  function rsPoly(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= gmul(poly[j], 1);
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }
  function reedSolomon(data, ecLen) {
    const gen = rsPoly(ecLen);            // 길이 ecLen+1
    const res = new Array(data.length + ecLen).fill(0);
    for (let i = 0; i < data.length; i++) res[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const coef = res[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], coef);
      }
    }
    return res.slice(data.length); // 마지막 ecLen 개가 오류정정 코드워드
  }

  // 버전별 (레벨 M) 정보: 총 데이터 코드워드, EC 코드워드/블록, 블록 수 (버전 1~6은 블록 균일)
  // [dataCodewords, ecPerBlock, numBlocks]
  const VER_M = {
    1: [16, 10, 1],
    2: [28, 16, 1],
    3: [44, 26, 1],
    4: [64, 18, 2],
    5: [86, 24, 2],
    6: [108, 16, 4],
  };
  // 정렬 패턴 중심(버전 2~6은 1개: (p,p), p=4v+10)
  function alignPos(v) { return v === 1 ? [] : [4 * v + 10]; }

  function pickVersion(byteLen) {
    // 바이트모드 오버헤드: 모드(4비트)+글자수(8비트)+종료(4비트) ≈ 2바이트
    for (let v = 1; v <= 6; v++) {
      const cap = VER_M[v][0];
      if (byteLen + 2 <= cap) return v;
    }
    throw new Error("내용이 너무 깁니다(QR 버전 6 초과).");
  }

  function toBytes(str) {
    // UTF-8 인코딩
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff) { // 서로게이트
        const c2 = str.charCodeAt(++i);
        c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }

  function buildData(bytes, version) {
    const [dataCW, ecPer, blocks] = VER_M[version];
    const totalDataBits = dataCW * 8;
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(0b0100, 4);            // 바이트 모드
    put(bytes.length, 8);      // 글자 수 (버전 1~9 바이트모드는 8비트)
    for (const b of bytes) put(b, 8);
    // 종료 패턴
    let term = Math.min(4, totalDataBits - bits.length);
    put(0, term);
    // 바이트 경계 채우기
    while (bits.length % 8 !== 0) bits.push(0);
    // 패드 바이트
    const pads = [0xec, 0x11]; let pi = 0;
    while (bits.length < totalDataBits) { put(pads[pi % 2], 8); pi++; }
    // 코드워드 배열
    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; dataCodewords.push(v); }

    // 블록 분할 (버전 1~6 균일)
    const perBlock = dataCW / blocks;
    const dataBlocks = [], ecBlocks = [];
    for (let b = 0; b < blocks; b++) {
      const blk = dataCodewords.slice(b * perBlock, (b + 1) * perBlock);
      dataBlocks.push(blk);
      ecBlocks.push(reedSolomon(blk, ecPer));
    }
    // 인터리브
    const result = [];
    for (let i = 0; i < perBlock; i++) for (let b = 0; b < blocks; b++) result.push(dataBlocks[b][i]);
    for (let i = 0; i < ecPer; i++) for (let b = 0; b < blocks; b++) result.push(ecBlocks[b][i]);
    return result; // 최종 코드워드
  }

  // 매트릭스 구성
  function makeMatrix(version) {
    const size = version * 4 + 17;
    const m = []; const reserved = [];
    for (let r = 0; r < size; r++) { m.push(new Array(size).fill(null)); reserved.push(new Array(size).fill(false)); }
    const setF = (r, c, v) => { m[r][c] = v; reserved[r][c] = true; };

    // 파인더 + 분리자
    function finder(r, c) {
      for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6)) || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
        setF(rr, cc, on ? 1 : 0);
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // 타이밍 패턴
    for (let i = 8; i < size - 8; i++) { const b = i % 2 === 0 ? 1 : 0; setF(6, i, b); setF(i, 6, b); }

    // 정렬 패턴
    const pos = alignPos(version);
    for (const pr of pos) for (const pc of pos) {
      if ((pr === 6 && pc === 6) || (pr === 6 && pc === size - 7) || (pr === size - 7 && pc === 6)) continue;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const on = Math.max(Math.abs(i), Math.abs(j)) !== 1;
        setF(pr + i, pc + j, on ? 1 : 0);
      }
    }

    // 다크 모듈
    setF(4 * version + 9, 8, 1);

    // 포맷 정보 영역 예약(값은 나중에)
    for (let i = 0; i < 9; i++) { if (!reserved[8][i]) { m[8][i] = 0; reserved[8][i] = true; } if (!reserved[i][8]) { m[i][8] = 0; reserved[i][8] = true; } }
    for (let i = 0; i < 8; i++) { if (!reserved[size - 1 - i][8]) { m[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; } if (!reserved[8][size - 1 - i]) { m[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; } }

    return { m, reserved, size };
  }

  // 데이터 비트 배치 (지그재그)
  function placeData(m, reserved, size, codewords) {
    const bits = [];
    for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
    let idx = 0, up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // 타이밍 열 건너뜀
      for (let k = 0; k < size; k++) {
        const row = up ? size - 1 - k : k;
        for (let c = 0; c < 2; c++) {
          const cc = col - c;
          if (!reserved[row][cc]) { m[row][cc] = idx < bits.length ? bits[idx] : 0; idx++; }
        }
      }
      up = !up;
    }
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];

  // 포맷 정보 (레벨 M = 00) + 마스크
  function formatBits(mask) {
    const data = (0b00 << 3) | mask; // EC(M=00) + mask(3)
    let d = data << 10;
    const g = 0b10100110111;
    for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= g << (i - 10);
    const bits = ((data << 10) | d) ^ 0b101010000010010;
    return bits; // 15비트
  }
  function applyFormat(m, size, mask) {
    const bits = formatBits(mask);
    const get = (i) => (bits >> i) & 1;
    // 좌상단 세로/가로 + 우상단/좌하단
    for (let i = 0; i <= 5; i++) m[8][i] = get(i);
    m[8][7] = get(6); m[8][8] = get(7); m[7][8] = get(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = get(i);
    for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = get(i);
    for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = get(i);
    m[size - 8][8] = 1; // 다크(이미 설정되지만 안전)
  }

  function penalty(m, size) {
    let p = 0;
    // 규칙1: 연속 동일
    for (let r = 0; r < size; r++) for (let dir = 0; dir < 2; dir++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        const a = dir ? m[c][r] : m[r][c], b = dir ? m[c - 1][r] : m[r][c - 1];
        if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; } else run = 1;
      }
    }
    // 규칙2: 2x2
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
    return p;
  }

  function make(text) {
    const bytes = toBytes(String(text));
    const version = pickVersion(bytes.length);
    const codewords = buildData(bytes, version);
    const size = version * 4 + 17;

    let best = null, bestScore = Infinity, bestMask = 0;
    for (let mask = 0; mask < 8; mask++) {
      const built = makeMatrix(version);
      placeData(built.m, built.reserved, built.size, codewords);
      // 마스크 적용 (데이터/EC 영역만)
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        if (!built.reserved[r][c] && MASKS[mask](r, c)) built.m[r][c] ^= 1;
      }
      applyFormat(built.m, size, mask);
      const score = penalty(built.m, size);
      if (score < bestScore) { bestScore = score; best = built.m; bestMask = mask; }
    }
    return { size, modules: best, version, mask: bestMask };
  }

  function draw(canvas, text, opts) {
    opts = opts || {};
    const qr = make(text);
    const quiet = opts.quiet != null ? opts.quiet : 4;
    const total = qr.size + quiet * 2;
    const scale = Math.max(1, Math.floor((opts.size || 240) / total));
    const px = total * scale;
    canvas.width = px; canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = opts.light || "#ffffff"; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = opts.dark || "#000000";
    for (let r = 0; r < qr.size; r++) for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
    return qr;
  }

  global.QRCode = { make, draw };
})(typeof window !== "undefined" ? window : this);
