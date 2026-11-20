// Робота з даними. Уся взаємодія з Firebase — лише тут, щоб базу можна було замінити.
import { firebaseConfig } from "./firebase-config.js";

const V = "11.0.2";
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

/* ---------- запам'ятовані штрих-коди ---------- */
export async function getCode(hid, code){
  try { const s = await fb.getDoc(fb.doc(db, "households", hid, "barcodes", code)); return s.exists() ? s.data() : null; }
  catch { return null; }
}
export function setCode(hid, code, prod){
  return fb.setDoc(fb.doc(db, "households", hid, "barcodes", code), prod).catch(() => {});
}
