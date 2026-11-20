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
// Шукає дати у тексті й обирає найімовірніший термін придатності.
export function pickExpiry(text){
  const t = String(text || "").toUpperCase().replace(/[OО]/g, m => m).replace(/\s+/g, " ");
  const found = [];
  const push = (y, mo, d, idx) => {
    y = +y; mo = +mo; d = d ? +d : null;
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || y < 2015 || y > 2045 || (d !== null && (d < 1 || d > 31))) return;
    const before = t.slice(Math.max(0, idx - 18), idx);
    let score = 0;
    if (/EXP|ПРИДАТН|ДО\b|ДО:|ГОДЕН|BEST|USE BY|ТЕРМ/.test(before)) score += 5;
    if (/MFG|MFD|ВИГОТ|ВИРОБ|ДАТА ВИР|PROD/.test(before)) score -= 6;
    found.push({ v: d ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : `${y}-${String(mo).padStart(2, "0")}`, y, mo, score });
  };
  let m;
  const r1 = /(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{2,4})/g;            // ДД.ММ.РРРР
  while ((m = r1.exec(t))) push(m[3], m[2], m[1], m.index);
  const r2 = /(?<![\d.\/\-])(\d{1,2})[.\/\- ](20\d{2}|\d{2})(?![\d.\/\-])/g; // ММ.РРРР, ММ/РР
  while ((m = r2.exec(t))) push(m[2], m[1], null, m.index);
  const r3 = /(20\d{2})[.\/\-](\d{1,2})(?![\d])/g;                     // РРРР-ММ
  while ((m = r3.exec(t))) push(m[1], m[2], null, m.index);
  if (!found.length) return null;
  // найвищий бал; при рівності — пізніша дата (термін придатності пізніше за дату виробництва)
  found.sort((a, b) => b.score - a.score || (b.y * 12 + b.mo) - (a.y * 12 + a.mo));
  return found[0].v;
}
export async function ocrExpiry(file, onProgress){
  await loadScript(TESS);
  const r = await window.Tesseract.recognize(file, "eng", { logger: m => { if (m.status === "recognizing text" && onProgress) onProgress(Math.round(m.progress * 100)); } });
  const text = r && r.data ? r.data.text : "";
  return { expiry: pickExpiry(text), text };
}
