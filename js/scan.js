// Штрих-коди, GS1 DataMatrix і зчитування дати з фото (OCR) — усе в браузері, без серверів.

/* ---------- GS1: (01) GTIN, (17) термін РРММДД, (10) серія ---------- */
export function parseGS1(raw){
  const out = { raw };
  let s = String(raw).replace(/^\](d2|C1|Q3|e0)/, "").replace(/^\x1d/, "");
  const take = (ai, v) => {
    if (ai === "01") out.gtin = v;
    if (ai === "17" && /^\d{6}$/.test(v)) {
      const y = 2000 + +v.slice(0, 2), mo = v.slice(2, 4), d = v.slice(4, 6);
      if (+mo >= 1 && +mo <= 12) out.expiry = d === "00" ? `${y}-${mo}` : `${y}-${mo}-${d}`;
    }
    if (ai === "10") out.batch = v;
  };
  if (/^\d{8}$|^\d{12,14}$/.test(s)) out.gtin = s;
  else if (s.startsWith("(")) { for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) take(m[1], m[2]); }
  else if (/^(01|17|10|21)/.test(s)) {
    let guard = 0;
    while (s.length && guard++ < 12) {
      const ai = s.slice(0, 2);
      if (ai === "01") { take("01", s.substr(2, 14)); s = s.slice(16); }
      else if (ai === "17" || ai === "11" || ai === "15") { take(ai, s.substr(2, 6)); s = s.slice(8); }
      else if (["10", "21", "91", "92"].includes(ai)) {
        const end = s.indexOf("\x1d"); take(ai, end < 0 ? s.slice(2) : s.slice(2, end));
        s = end < 0 ? "" : s.slice(end + 1);
      } else break;
    }
  }
  if (out.gtin && out.gtin.length === 14 && out.gtin.startsWith("0")) out.gtin = out.gtin.slice(1);
  return out;
}

/* ---------- бібліотеки з CDN, вантажаться лише коли потрібні ---------- */
const loaded = {};
function loadScript(src){
  if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src;
    s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error("load " + src)); };
    document.head.appendChild(s);
  });
  return loaded[src];
}
const ZXING = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

const FORMATS = ["data_matrix", "ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"];
async function nativeDetector(){
  if (!("BarcodeDetector" in window)) return null;
  try {
    const sup = await BarcodeDetector.getSupportedFormats();
    const f = FORMATS.filter(x => sup.includes(x));
    return f.length ? new BarcodeDetector({ formats: f }) : null;
  } catch { return null; }
}
function zxHints(Z){
  const h = new Map();
  h.set(Z.DecodeHintType.TRY_HARDER, true);
  h.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
    Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.QR_CODE]);
  return h;
}

/* ---------- сканування камерою наживо ---------- */
// Повертає функцію stop(). onResult(rawText) викликається один раз.
export async function startLiveScan(video, onResult, onError){
  let stopped = false, stream = null, zxReader = null, raf = 0;
  const stop = () => {
    stopped = true; cancelAnimationFrame(raf);
    if (zxReader) { try { zxReader.reset(); } catch {} }
    if (stream) stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  };
  const done = txt => { if (stopped) return; stop(); onResult(txt); };
  try {
    const det = await nativeDetector();
    if (det) {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return stop; }
      video.srcObject = stream; await video.play();
      let busy = false;
      const tick = async () => {
        if (stopped) return;
        if (!busy && video.readyState >= 2) {
          busy = true;
          try { const r = await det.detect(video); if (r && r.length) { const dm = r.find(x => x.format === "data_matrix"); done((dm || r[0]).rawValue); } } catch {}
          busy = false;
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    } else {
      await loadScript(ZXING);
      if (stopped) return stop;
      const Z = window.ZXing;
      zxReader = new Z.BrowserMultiFormatReader(zxHints(Z), 250);
      await zxReader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } }, video,
        (res) => { if (res) done(res.getText()); });
    }
  } catch (e) { stop(); onError && onError(e); }
  return stop;
}

/* ---------- штрих-код із фото ---------- */
export async function fileToImage(file){
  const url = URL.createObjectURL(file);
  const img = new Image(); img.src = url;
  try { await img.decode(); } catch { URL.revokeObjectURL(url); return null; }
  return { img, url };
}
function toCanvas(img, maxSide){
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c;
}
export async function decodeImage(img){
  const det = await nativeDetector();
  if (det) { try { const r = await det.detect(img); if (r && r.length) { const dm = r.find(x => x.format === "data_matrix"); return (dm || r[0]).rawValue; } } catch {} }
  try {
    await loadScript(ZXING);
    const Z = window.ZXing;
    for (const side of [1400, 900, 2000]) {
      try {
        const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(toCanvas(img, side))));
        const r = new Z.MultiFormatReader(); r.setHints(zxHints(Z));
        return r.decode(bmp).getText();
      } catch {}
    }
  } catch {}
  return null;
}

/* ---------- дата придатності з фото (OCR) ---------- */
// OCR часто плутає 0↔O, 1↔I/l, 5↔S, 8↔B поруч із цифрами — виправляємо лише в «цифрових» місцях.
export function cleanOcr(text){
  let t = String(text || "").toUpperCase();
  const fix = { "O": "0", "О": "0", "D": "0", "Q": "0", "U": "0", "I": "1", "L": "1", "|": "1", "!": "1", "S": "5", "B": "8", "З": "3", "Z": "2" };
  const near = /[0-9][OОDQUIL|!SBЗZ]|[OОDQUIL|!SBЗZ][0-9]/;
  for (let i = 0; i < 3 && near.test(t); i++)
    t = t.replace(/([0-9])([OОDQUIL|!SBЗZ])/g, (m, a, b) => a + fix[b]).replace(/([OОDQUIL|!SBЗZ])([0-9])/g, (m, a, b) => fix[a] + b);
  // «03 . 2027», «03 /27» → «03.2027», «03/27»
  t = t.replace(/(\d)\s*([.\/\-,])\s*(\d)/g, "$1$2$3").replace(/(\d),(\d)/g, "$1.$2");
  return t.replace(/\s+/g, " ");
}
// Шукає дати у тексті й обирає найімовірніший термін придатності.
export function pickExpiry(text){
  const t = cleanOcr(text);
  const found = [];
  const push = (y, mo, d, idx) => {
    y = +y; mo = +mo; d = d ? +d : null;
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || y < 2015 || y > 2045 || (d !== null && (d < 1 || d > 31))) return;
    const before = t.slice(Math.max(0, idx - 22), idx);
    let score = 0;
    if (/EXP|ЕХР|ЕХP|ПРИДАТ|ПРИД|ДО\b|ДО:|ДО\.|ГОДЕН|BEST|USE BY|ТЕРМ|ВЕ5Т/.test(before)) score += 5;
    if (/MFG|MFD|MAN|ВИГОТ|ВИРОБ|ВИГ\.|ДАТА В|PROD|ИЗГ/.test(before)) score -= 6;
    found.push({ v: d ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : `${y}-${String(mo).padStart(2, "0")}`, y, mo, score });
  };
  let m;
  const r1 = /(?<!\d)(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{4}|\d{2})(?!\d)/g;     // ДД.ММ.РРРР
  while ((m = r1.exec(t))) push(m[3], m[2], m[1], m.index);
  const r2 = /(?<![\d.\/\-])(\d{1,2})[.\/\- ](20\d{2}|\d{2})(?![\d.\/\-])/g;     // ММ.РРРР, ММ/РР
  while ((m = r2.exec(t))) push(m[2], m[1], null, m.index);
  const r3 = /(?<!\d)(20\d{2})[.\/\-](\d{1,2})(?![\d])/g;                       // РРРР-ММ
  while ((m = r3.exec(t))) push(m[1], m[2], null, m.index);
  const r4 = /(?:EXP|ЕХР|ДО)[^0-9]{0,4}(\d{2})(\d{2})(\d{2})?(?!\d)/g;          // EXP 0327 / EXP 270331
  while ((m = r4.exec(t))) { if (m[3]) push(m[1], m[2], m[3], m.index + 3); else push(m[2], m[1], null, m.index + 3); }
  if (!found.length) return null;
  // найвищий бал; при рівності — пізніша дата (термін придатності пізніше за дату виробництва)
  found.sort((a, b) => b.score - a.score || (b.y * 12 + b.mo) - (a.y * 12 + a.mo));
  return found[0].v;
}

// Підготовка фото: зменшити/збільшити до зручного розміру, сірий, розтягнути контраст, повернути.
function prepCanvas(img, rot){
  const W = img.naturalWidth, H = img.naturalHeight;
  const k = Math.min(2.5, 2000 / Math.max(W, H));
  const w = Math.round(W * k), h = Math.round(H * k);
  const c = document.createElement("canvas");
  const swap = rot === 90 || rot === 270;
  c.width = swap ? h : w; c.height = swap ? w : h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate(rot * Math.PI / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height), px = d.data;
  const hist = new Uint32Array(256), n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) { const g = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8; px[i] = g; hist[g]++; }
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
  acc = 0; for (; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) { const v = Math.max(0, Math.min(255, (px[i] - lo) * 255 / span)); px[i] = px[i + 1] = px[i + 2] = v; }
  ctx.putImageData(d, 0, 0);
  return c;
}

let worker = null, workerP = null, progressCb = null;
async function getWorker(){
  if (worker) return worker;
  if (!workerP) workerP = (async () => {
    await loadScript(TESS);
    const w = await window.Tesseract.createWorker("ukr+eng", 1, {
      logger: m => { if (progressCb && m.status === "recognizing text") progressCb(m.progress); }
    });
    worker = w; return w;
  })().catch(e => { workerP = null; throw e; });
  return workerP;
}

// Розпізнати фото упаковки/блістера: DataMatrix + текст кількома проходами (повороти, режими).
// enough(allText) → true, коли вже знайдено достатньо, щоб не робити зайвих проходів.
// Повертає { dm: parseGS1(...) | null, text }.
export async function ocrPhoto(file, onProgress, enough){
  const r = await fileToImage(file);
  if (!r) throw new Error("image");
  try {
    let dm = null;
    const raw = await decodeImage(r.img);
    if (raw) dm = parseGS1(raw);
    onProgress && onProgress(0, "Завантажую розпізнавання…");
    const w = await getWorker();
    const passes = [[0, "11"], [90, "11"], [270, "11"], [0, "6"], [180, "11"]];
    const texts = [];
    for (let i = 0; i < passes.length; i++) {
      const [rot, psm] = passes[i];
      progressCb = p => onProgress && onProgress(Math.round(((i + p) / passes.length) * 100), "Читаю текст…");
      await w.setParameters({ tessedit_pageseg_mode: psm });
      const res = await w.recognize(prepCanvas(r.img, rot));
      texts.push(res && res.data ? res.data.text : "");
      if (enough && enough(texts.join("\n"), dm)) break;
    }
    return { dm, text: texts.join("\n") };
  } finally { progressCb = null; URL.revokeObjectURL(r.url); }
}
