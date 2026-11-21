// Робота з даними. Уся взаємодія з Firebase — лише тут, щоб базу можна було замінити.
import { firebaseConfig } from "./firebase-config.js";

const V = "12.9.0";
let fb = null;          // модулі Firebase
let app, auth, db;

export const configured = () => !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

export async function init(){
  const [a, au, fs] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`)
  ]);
  fb = { ...a, ...au, ...fs };
  app = fb.initializeApp(firebaseConfig);
  auth = fb.getAuth(app);
  try {
    db = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) });
  } catch {
    db = fb.getFirestore(app);
  }
}

/* ---------- вхід ---------- */
export function onUser(cb){ return fb.onAuthStateChanged(auth, cb); }
export async function signIn(){
  const p = new fb.GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account" });
  try { await fb.signInWithPopup(auth, p); }
  catch (e) {
    if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) await fb.signInWithRedirect(auth, p);
    else if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") throw e;
  }
}
export const signOut = () => fb.signOut(auth);
export const emailOf = u => String(u && u.email || "").toLowerCase();

/* ---------- домогосподарство (спільна аптечка) ---------- */
// invites/{email} → { hid } — до якої аптечки має доступ ця адреса
export async function findHousehold(email){
  const s = await fb.getDoc(fb.doc(db, "invites", email));
  if (!s.exists()) return null;
  const hid = s.data().hid;
  const h = await fb.getDoc(fb.doc(db, "households", hid));
  return h.exists() ? { id: hid, ...h.data() } : null;
}
export async function createHousehold(user, name){
  const email = emailOf(user);
  const ref = fb.doc(fb.collection(db, "households"));
  const b = fb.writeBatch(db);
  b.set(ref, { name: name || "Домашня аптечка", owner: user.uid, ownerEmail: email, members: [email], createdAt: fb.serverTimestamp() });
  b.set(fb.doc(db, "invites", email), { hid: ref.id, by: email });
  await b.commit();
  return { id: ref.id, name, owner: user.uid, ownerEmail: email, members: [email] };
}
export function watchHousehold(hid, cb){
  return fb.onSnapshot(fb.doc(db, "households", hid), s => cb(s.exists() ? { id: s.id, ...s.data() } : null), () => cb(null));
}
export async function addMember(hid, ownerEmail, email){
  const b = fb.writeBatch(db);
  b.update(fb.doc(db, "households", hid), { members: fb.arrayUnion(email) });
  b.set(fb.doc(db, "invites", email), { hid, by: ownerEmail });
  await b.commit();
}
export async function removeMember(hid, email){
  const b = fb.writeBatch(db);
  b.update(fb.doc(db, "households", hid), { members: fb.arrayRemove(email) });
  b.delete(fb.doc(db, "invites", email));
  await b.commit();
}

/* ---------- ліки ---------- */
export function watchMeds(hid, cb, onErr){
  return fb.onSnapshot(fb.collection(db, "households", hid, "meds"), { includeMetadataChanges: false },
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() })), snap.metadata.fromCache),
    e => onErr && onErr(e));
}
export const newMedId = hid => fb.doc(fb.collection(db, "households", hid, "meds")).id;
export function saveMed(hid, id, body){
  // Не чекаємо підтвердження сервера: в офлайні запис ляже в чергу і відправиться пізніше.
  const p = fb.setDoc(fb.doc(db, "households", hid, "meds", id), body);
  return Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
}
export function deleteMed(hid, id){
  const p = fb.deleteDoc(fb.doc(db, "households", hid, "meds", id));
  return Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
}

/* ---------- аптечки (велика, мала…) ---------- */
export function watchKits(hid, cb, onErr){
  return fb.onSnapshot(fb.collection(db, "households", hid, "kits"),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), e => onErr && onErr(e));
}
export const newKitId = hid => fb.doc(fb.collection(db, "households", hid, "kits")).id;
export function saveKit(hid, id, body){
  const p = fb.setDoc(fb.doc(db, "households", hid, "kits", id), body);
  return Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
}
export function deleteKit(hid, id){
  const p = fb.deleteDoc(fb.doc(db, "households", hid, "kits", id));
  return Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
}

/* ---------- запам'ятовані штрих-коди ---------- */
export async function getCode(hid, code){
  try { const s = await fb.getDoc(fb.doc(db, "households", hid, "barcodes", code)); return s.exists() ? s.data() : null; }
  catch { return null; }
}
export function setCode(hid, code, prod){
  return fb.setDoc(fb.doc(db, "households", hid, "barcodes", code), prod).catch(() => {});
}

/* ---------- розпізнавання фото через Gemini (Firebase AI Logic, безкоштовний рівень) ---------- */
// Моделі по черзі: якщо одна недоступна/перевантажена — пробуємо наступну.
// lite — швидка й стабільна на безкоштовному рівні; повна flash часто перевантажена, тому остання.
export const AI_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-flash-latest"];
let aiMod = null, aiInst = null;
let appCheckOn = false;
// App Check вмикаємо лише перед першим запитом до ШІ — щоб проблеми з reCAPTCHA не заважали відкривати сайт.
async function ensureAppCheck(){
  if (appCheckOn || !firebaseConfig.recaptchaSiteKey) return;
  const ac = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app-check.js`);
  ac.initializeAppCheck(app, { provider: new ac.ReCaptchaEnterpriseProvider(firebaseConfig.recaptchaSiteKey), isTokenAutoRefreshEnabled: false });
  appCheckOn = true;
}
async function getAI(){
  await ensureAppCheck();
  if (!aiMod) aiMod = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-ai.js`);
  if (!aiInst) aiInst = aiMod.getAI(app, { backend: new aiMod.GoogleAIBackend() });
  return { m: aiMod, ai: aiInst };
}
// Зменшити фото до ~1600 px і JPEG — менше трафіку й квоти, якість для тексту достатня.
async function toJpegB64(file, max = 1600){
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.88).split(",")[1];
  } finally { URL.revokeObjectURL(url); }
}
// prompt — інструкція; files — фото. Повертає розібраний JSON.
export async function aiJson(prompt, files){
  const { m, ai } = await getAI();
  const images = await Promise.all([...files].slice(0, 4).map(toJpegB64));
  const parts = [prompt, ...images.map(data => ({ inlineData: { data, mimeType: "image/jpeg" } }))];
  let lastErr;
  for (const name of AI_MODELS) {
    try {
      const model = m.getGenerativeModel(ai, { model: name, generationConfig: { responseMimeType: "application/json", temperature: 0.1 } });
      const res = await Promise.race([model.generateContent(parts),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + name)), 25000))]);
      const text = res.response.text();
      return JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim());
    } catch (e) {
      lastErr = e;
      const msg = String(e && (e.message || e.code) || "");
      // квота / ключ / App Check — інша модель не допоможе
      if (/app-check|appcheck|API key|permission|PERMISSION_DENIED|unauth/i.test(msg)) break;
    }
  }
  throw lastErr || new Error("ai");
}
