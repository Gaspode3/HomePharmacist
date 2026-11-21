import * as store from "./store.js";
import { parseGS1, startLiveScan, fileToImage, decodeImage, ocrExpiry } from "./scan.js";
import { DRUGS, findDrug, norm, BRAND_LIST } from "./drugs.js";

/* ============ helpers ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toList = v => Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean)
  : String(v ?? "").split(/[,;+]/).map(s => s.trim()).filter(Boolean);
let toastT;
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2600); }
function show(id){
  ["s-loading", "s-setup", "s-login", "s-join", "s-app"].forEach(s => { $("#" + s).hidden = s !== id; });
  $("#tabs").hidden = id !== "s-app";
}

const state = { user: null, hh: null, meds: [], loaded: false, filter: "all", q: "", tab: "list",
  editingId: null, formLatin: null, formExtra: null, unsub: [] };

/* ============ термін придатності ============ */
function parseExpiry(input){
  if (!input) return null;
  let s = String(input).toLowerCase().replace(/exp\.?|до|придатн\S*|термін\S*|:/g, " ").trim();
  let y, mo, d, m;
  if ((m = s.match(/^(\d{4})[-.\/](\d{1,2})(?:[-.\/](\d{1,2}))?$/))) { y = +m[1]; mo = +m[2]; d = m[3] ? +m[3] : null; }
  else if ((m = s.match(/^(\d{1,2})[.\/\-\s]+(\d{1,2})[.\/\-\s]+(\d{2}|\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[.\/\-\s]+(\d{2}|\d{4})$/))) { mo = +m[1]; y = +m[2]; d = null; }
  else return null;
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || y < 2000 || y > 2100) return null;
  if (d !== null && (d < 1 || d > 31)) return null;
  const p = n => String(n).padStart(2, "0");
  return d ? `${y}-${p(mo)}-${p(d)}` : `${y}-${p(mo)}`;
}
function expiryDate(e){
  if (!e) return null;
  const [y, mo, d] = e.split("-").map(Number);
  if (!y || !mo) return null;
  return d ? new Date(y, mo - 1, d) : new Date(y, mo, 0);
}
function fmtExpiry(e){ if (!e) return "—"; const [y, mo, d] = e.split("-"); return d ? `${d}.${mo}.${y}` : `${mo}.${y}`; }
function statusOf(med){
  const d = expiryDate(med.expiry);
  if (!d) return { k: "unknown", days: null };
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const days = Math.round((d - t) / 864e5);
  return { k: days < 0 ? "expired" : days <= 30 ? "soon" : days <= 90 ? "warn" : "ok", days };
}
function spanText(days){
  const a = Math.abs(days);
  if (a < 31) return `${a} дн.`;
  const m = Math.round(a / 30.4);
  if (m < 12) return `${m} міс.`;
  const y = Math.floor(m / 12), r = m % 12;
  return r ? `${y} р. ${r} міс.` : `${y} р.`;
}
function badgeText(st){
  if (st.k === "unknown") return "термін не вказано";
  if (st.k === "expired") return `прострочено ${spanText(st.days)} тому`;
  if (st.days === 0) return "спливає сьогодні";
  return `ще ${spanText(st.days)}`;
}

/* ============ старт ============ */
async function boot(){
  bindUI();
  initExpSelects();
  $("#brands").innerHTML = BRAND_LIST.map(b => `<option>${esc(b)}</option>`).join("");
  if (!store.configured()) { show("s-setup"); return; }
  try { await store.init(); }
  catch { show("s-login"); $("#loginErr").textContent = "Не вдалося завантажити додаток. Перевірте інтернет і оновіть сторінку."; return; }
  store.onUser(async user => {
    state.user = user;
    stopWatching();
    if (!user) { show("s-login"); return; }
    show("s-loading");
    await openHousehold();
  });
}
function stopWatching(){ state.unsub.forEach(u => { try { u(); } catch {} }); state.unsub = []; state.hh = null; state.meds = []; state.loaded = false; }

async function openHousehold(){
  const email = store.emailOf(state.user);
  let hh = null;
  try { hh = await store.findHousehold(email); }
  catch (e) {
    if (e && e.code === "unavailable") { show("s-join"); $("#joinEmail").textContent = email; toast("Немає з'єднання з базою"); return; }
  }
  if (!hh) { $("#joinEmail").textContent = email; show("s-join"); return; }
  state.hh = hh;
  show("s-app"); render();
  state.unsub.push(store.watchHousehold(hh.id, h => {
    if (!h) return;
    if (!(h.members || []).includes(email)) { toast("Вас видалили з цієї аптечки"); stopWatching(); $("#joinEmail").textContent = email; show("s-join"); return; }
    state.hh = h; $("#hhName").textContent = h.name || "Домашня аптечка";
  }));
  const timer = setTimeout(() => { if (!state.loaded) $("#banner").textContent = "Не вдалося зв'язатися з базою — показую збережене на телефоні."; }, 10000);
  state.unsub.push(store.watchMeds(hh.id, (meds, fromCache) => {
    state.meds = meds; state.loaded = true;
    if (!fromCache) { clearTimeout(timer); $("#banner").textContent = ""; }
    render();
  }, e => { clearTimeout(timer); state.loaded = true; $("#banner").textContent = "Помилка доступу до даних (" + (e.code || "?") + ")."; render(); }));
}

/* ============ збереження ============ */
const isOwner = () => state.hh && state.user && state.hh.owner === state.user.uid;
async function saveMed(med){
  const hid = state.hh.id;
  const id = med.id || store.newMedId(hid);
  const body = { ...med }; delete body.id;
  const now = new Date().toISOString();
  body.updatedAt = now; body.updatedBy = store.emailOf(state.user);
  if (!body.addedAt) { body.addedAt = now; body.addedBy = body.updatedBy; }
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
  try { await store.saveMed(hid, id, body); }
  catch { toast("Не вдалося зберегти"); return false; }
  const code = codeKey(body.barcode);
  if (code.length >= 6) store.setCode(hid, code, { name: body.name, inn: body.inn || [], innLatin: body.innLatin || [], strength: body.strength || "", form: body.form || "", category: body.category || "" });
  return true;
}
const codeKey = c => String(c || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 40);
async function lookupCode(code){
  const k = codeKey(code); if (k.length < 6) return null;
  const own = state.meds.find(m => codeKey(m.barcode) === k);
  if (own) return { name: own.name, inn: own.inn, innLatin: own.innLatin, strength: own.strength, form: own.form, category: own.category };
  return store.getCode(state.hh.id, k);
}

/* ============ список ============ */
function sorted(meds){
  const rank = { expired: 0, soon: 1, warn: 2, ok: 3, unknown: 4 };
  return meds.map(m => ({ m, st: statusOf(m) })).sort((a, b) =>
    rank[a.st.k] - rank[b.st.k] || (a.st.days ?? 1e9) - (b.st.days ?? 1e9) || String(a.m.name).localeCompare(String(b.m.name), "uk"));
}
function matchesQ(m, q){
  if (!q) return true;
  const hay = [m.name, ...(m.inn || []), ...(m.innLatin || []), m.category, m.form, m.notes, m.location].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}
function render(){
  const all = sorted(state.meds);
  const cnt = { all: all.length, expired: 0, soon: 0, unknown: 0 };
  all.forEach(({ st }) => { if (st.k === "expired") cnt.expired++; if (st.k === "soon" || st.k === "warn") cnt.soon++; if (st.k === "unknown") cnt.unknown++; });
  $("#stTotal").textContent = state.loaded ? cnt.all : "–";
  $("#stExpired").textContent = state.loaded ? cnt.expired : "–";
  $("#stSoon").textContent = state.loaded ? cnt.soon : "–";
  const chips = [["all", "Усі", cnt.all], ["expired", "Протерміновані", cnt.expired], ["soon", "Скоро спливають", cnt.soon], ["unknown", "Без терміну", cnt.unknown]];
  $("#chips").innerHTML = chips.map(([k, l, n]) => `<button class="chip ${state.filter === k ? "on" : ""}" data-f="${k}">${l} · ${n}</button>`).join("");
  $("#locs").innerHTML = [...new Set(state.meds.map(m => m.location).filter(Boolean))].map(l => `<option>${esc(l)}</option>`).join("");
  if (!state.loaded) return;
  const rows = all.filter(({ m, st }) =>
    (state.filter === "all" || (state.filter === "expired" && st.k === "expired") ||
     (state.filter === "soon" && (st.k === "soon" || st.k === "warn")) || (state.filter === "unknown" && st.k === "unknown"))
    && matchesQ(m, state.q));
  const list = $("#list");
  if (!state.meds.length) {
    list.innerHTML = `<div class="empty"><b>Аптечка порожня</b>Додайте перші ліки — відскануйте штрих-код або впишіть вручну.<br><br><button class="btn" style="max-width:240px" data-tab-go="add">Додати ліки</button></div>`;
    return;
  }
  if (!rows.length) { list.innerHTML = `<div class="empty">Нічого не знайдено</div>`; return; }
  list.innerHTML = rows.map(({ m, st }) => `
    <button class="card s-${st.k}" data-id="${esc(m.id)}">
      <div class="ctop"><div class="cname">${esc(m.name)} ${m.strength ? `<small>${esc(m.strength)}</small>` : ""}</div>
        <span class="badge b-${st.k}">${esc(badgeText(st))}</span></div>
      <div class="cinn">${esc([(m.inn || []).join(" + "), m.form].filter(Boolean).join(" · ") || "діюча речовина не вказана")}</div>
      <div class="cmeta">${esc([m.expiry ? "до " + fmtExpiry(m.expiry) : "", m.qty, m.category, m.location].filter(Boolean).join(" · "))}</div>
    </button>`).join("");
}

/* ============ аркуші (деталі, меню) ============ */
function openSheet(html){ $("#sheet").innerHTML = html; $("#overlay").hidden = false; }
function closeSheet(){ $("#overlay").hidden = true; $("#sheet").innerHTML = ""; }
const shortEmail = e => String(e || "").split("@")[0];
function showMed(id){
  const m = state.meds.find(x => x.id === id); if (!m) return;
  const st = statusOf(m);
  const same = sameInn(m).filter(x => x.id !== m.id);
  openSheet(`
    <h3>${esc(m.name)} ${m.strength ? `<small style="color:var(--muted)">${esc(m.strength)}</small>` : ""}</h3>
    <span class="badge b-${st.k}">${esc(badgeText(st))}</span>
    <dl class="kv">
      <dt>Діюча речовина</dt><dd>${esc((m.inn || []).join(" + ") || "—")}${m.innLatin && m.innLatin.length ? ` <span style="color:var(--muted)">(${esc(m.innLatin.join(" + "))})</span>` : ""}</dd>
      <dt>Форма</dt><dd>${esc(m.form || "—")}</dd>
      <dt>Придатний до</dt><dd>${esc(fmtExpiry(m.expiry))}</dd>
      <dt>Кількість</dt><dd>${esc(m.qty || "—")}</dd>
      <dt>Для чого</dt><dd>${esc(m.category || "—")}</dd>
      <dt>Де лежить</dt><dd>${esc(m.location || "—")}</dd>
      ${m.notes ? `<dt>Нотатки</dt><dd>${esc(m.notes)}</dd>` : ""}
      ${m.barcode ? `<dt>Штрих-код</dt><dd>${esc(m.barcode)}</dd>` : ""}
      ${same.length ? `<dt>Аналоги вдома</dt><dd>${same.map(x => esc(x.name + (x.strength ? " " + x.strength : "") + " (до " + fmtExpiry(x.expiry) + ")")).join("<br>")}</dd>` : ""}
      ${m.addedBy ? `<dt>Додав(ла)</dt><dd>${esc(shortEmail(m.addedBy))}${m.addedAt ? ", " + esc(new Date(m.addedAt).toLocaleDateString("uk-UA")) : ""}</dd>` : ""}
    </dl>
    ${st.k === "expired" ? `<div class="warnbox" style="margin:0 0 14px">Протерміновані ліки не варто приймати. Утилізуйте їх окремо від побутового сміття — деякі аптеки приймають прострочені препарати.</div>` : ""}
    <div class="btnrow"><button class="btn ghost" data-act="del" data-id="${esc(m.id)}">Видалити</button>
      <button class="btn" data-act="edit" data-id="${esc(m.id)}">Редагувати</button></div>
    <button class="btn ghost" style="margin-top:10px" data-act="close">Закрити</button>`);
}
function confirmDelete(id){
  const m = state.meds.find(x => x.id === id); if (!m) return;
  openSheet(`<h3>Видалити «${esc(m.name)}»?</h3><p style="color:var(--muted)">Ліки зникнуть з аптечки в усієї родини.</p>
    <div class="btnrow"><button class="btn ghost" data-act="close">Скасувати</button><button class="btn danger" data-act="del-yes" data-id="${esc(id)}">Видалити</button></div>`);
}
function openMenu(){
  const hh = state.hh, me = store.emailOf(state.user), owner = isOwner();
  const members = (hh.members || []).map(e => `<div class="member"><span>${esc(e)}${e === hh.ownerEmail ? " · власник" : ""}${e === me ? " (ви)" : ""}</span>
      ${owner && e !== hh.ownerEmail ? `<button data-act="rm-member" data-email="${esc(e)}">Прибрати</button>` : ""}</div>`).join("");
  openSheet(`<h3>Сім'я</h3>
    <p class="muted">Усі, хто в списку, входять через Google зі своєю адресою і бачать ту саму аптечку.</p>
    ${members}
    ${owner ? `<div class="inrow" style="margin-top:12px"><input id="newMember" type="email" placeholder="адреса Gmail" autocomplete="off"><button class="btn" data-act="add-member">Додати</button></div>
      <p class="muted">Після додавання надішліть людині посилання: <span class="mono">${esc(location.origin + location.pathname)}</span></p>`
      : `<p class="muted" style="margin-top:12px">Додавати людей може власник аптечки.</p>`}
    <h3 style="margin-top:22px">Дані</h3>
    <p class="muted">Резервна копія всіх ліків у JSON. Імпорт приймає і файл, експортований з версії в Claude.</p>
    <div class="btnrow"><button class="btn ghost" data-act="export">Завантажити копію</button><button class="btn ghost" data-act="import-open">Імпорт</button></div>
    <h3 style="margin-top:22px">Акаунт</h3>
    <p class="muted" style="margin-top:0">${esc(me)}</p>
    <div class="btnrow"><button class="btn ghost" data-act="logout">Вийти</button><button class="btn" data-act="close">Закрити</button></div>`);
}
function openImport(){
  openSheet(`<h3>Імпорт</h3><p class="muted">Вставте JSON або виберіть файл. Однакові записи (назва + дозування + термін) не дублюються.</p>
    <input type="file" id="importFile" accept=".json,application/json" style="margin-bottom:10px">
    <textarea id="importBox" placeholder='{"meds":[...]}'></textarea>
    <div class="btnrow" style="margin-top:10px"><button class="btn ghost" data-act="close">Скасувати</button><button class="btn" data-act="import">Імпортувати</button></div>`);
  $("#importFile").onchange = async e => { const f = e.target.files[0]; if (f) $("#importBox").value = await f.text(); };
}
function exportData(){
  const meds = state.meds.map(m => { const { id, ...rest } = m; return rest; });
  const blob = new Blob([JSON.stringify({ app: "home-pharmacist", version: 1, exportedAt: new Date().toISOString(), meds }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `aptechka-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function doImport(){
  let data; try { data = JSON.parse($("#importBox").value); } catch { toast("Це не схоже на JSON"); return; }
  const meds = Array.isArray(data) ? data : data && data.meds;
  if (!Array.isArray(meds)) { toast("Не знайшов списку ліків"); return; }
  const have = new Set(state.meds.map(m => [m.name, m.strength, m.expiry].join("|")));
  let n = 0;
  for (const raw of meds) {
    if (!raw || !raw.name) continue;
    const m = { name: String(raw.name), inn: toList(raw.inn), innLatin: toList(raw.innLatin), strength: String(raw.strength || ""), form: String(raw.form || ""),
      expiry: parseExpiry(raw.expiry) || "", qty: String(raw.qty || ""), category: String(raw.category || ""), location: String(raw.location || ""),
      notes: String(raw.notes || ""), barcode: String(raw.barcode || "") };
    const key = [m.name, m.strength, m.expiry].join("|");
    if (have.has(key)) continue;
    have.add(key);
    if (await saveMed(m)) n++;
  }
  closeSheet(); toast(`Імпортовано: ${n}`);
}

/* ============ форма ============ */
const F = id => $("#f-" + id);
function fillForm(m, onlyEmpty){
  const set = (id, v) => { if (v == null || v === "" || (Array.isArray(v) && !v.length)) return; if (onlyEmpty && F(id).value.trim()) return; F(id).value = Array.isArray(v) ? v.join(", ") : v; };
  set("name", m.name); set("inn", m.inn); set("strength", m.strength); set("form", m.form);
  set("qty", m.qty); set("category", m.category); set("location", m.location); set("notes", m.notes); set("barcode", m.barcode);
  if (m.expiry) set("expiry", fmtExpiry(m.expiry));
  if (m.innLatin && m.innLatin.length) state.formLatin = m.innLatin;
  updateDup(); updateExpHint();
}
function clearForm(){
  $("#medForm").reset(); state.editingId = null; state.formLatin = null; state.formExtra = null;
  setStatus(""); $("#addTitle").textContent = "Додати ліки"; $("#btnSave").textContent = "Зберегти";
  updateDup(); updateExpHint();
}
function editMed(id){
  const m = state.meds.find(x => x.id === id); if (!m) return;
  clearForm(); state.editingId = id; state.formExtra = { addedAt: m.addedAt, addedBy: m.addedBy };
  fillForm(m, false);
  $("#addTitle").textContent = "Редагувати"; $("#btnSave").textContent = "Зберегти зміни";
  closeSheet(); switchTab("add");
}
const MONTHS = ["01 · січень", "02 · лютий", "03 · березень", "04 · квітень", "05 · травень", "06 · червень", "07 · липень", "08 · серпень", "09 · вересень", "10 · жовтень", "11 · листопад", "12 · грудень"];
function initExpSelects(){
  const y0 = new Date().getFullYear();
  $("#f-exp-m").innerHTML = `<option value="">місяць</option>` + MONTHS.map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}">${m}</option>`).join("");
  let ys = `<option value="">рік</option>`;
  for (let y = y0 - 3; y <= y0 + 8; y++) ys += `<option value="${y}">${y}</option>`;
  $("#f-exp-y").innerHTML = ys;
  const fromSelects = () => {
    const m = $("#f-exp-m").value, y = $("#f-exp-y").value;
    if (m && y) { F("expiry").value = `${m}.${y}`; updateExpHint(); }
  };
  $("#f-exp-m").onchange = () => { fromSelects(); if (!$("#f-exp-y").value) $("#f-exp-y").focus(); };
  $("#f-exp-y").onchange = fromSelects;
}
function syncExpSelects(){
  const e = parseExpiry(F("expiry").value.trim());
  const [y, m] = e ? e.split("-") : ["", ""];
  if (y && ![...$("#f-exp-y").options].some(o => o.value === y)) $("#f-exp-y").insertAdjacentHTML("beforeend", `<option value="${y}">${y}</option>`);
  $("#f-exp-m").value = m || ""; $("#f-exp-y").value = y || "";
}
function updateExpHint(){
  syncExpSelects();
  const v = F("expiry").value.trim(), h = $("#expHint");
  if (!v) { h.textContent = "ММ.РРРР або ДД.ММ.РРРР"; h.style.color = ""; return; }
  const e = parseExpiry(v);
  if (!e) { h.textContent = "Не розумію дату — напр. 03.2027"; h.style.color = "var(--red)"; return; }
  const st = statusOf({ expiry: e }); h.textContent = badgeText(st); h.style.color = st.k === "expired" ? "var(--red)" : "";
}
const innKeys = m => [...(m.inn || []), ...(m.innLatin || [])].map(norm).filter(k => k.length > 3);
function sameInn(m){
  const keys = innKeys(m); if (!keys.length) return [];
  return state.meds.filter(x => innKeys(x).some(k => keys.includes(k)));
}
function updateDup(){
  const hits = sameInn({ inn: toList(F("inn").value), innLatin: state.formLatin || [] }).filter(x => x.id !== state.editingId);
  $("#dupHint").textContent = hits.length ? "Вдома вже є з цією речовиною: " + hits.map(x => `${x.name}${x.strength ? " " + x.strength : ""} (до ${fmtExpiry(x.expiry)})`).join("; ") : "";
}
function onNameChange(){
  const d = findDrug(F("name").value);
  if (!d) return;
  if (!F("inn").value.trim()) { F("inn").value = d.i.join(", "); state.formLatin = d.l; }
  if (!F("category").value.trim()) F("category").value = d.c;
  updateDup();
}
async function onSubmit(ev){
  ev.preventDefault();
  const name = F("name").value.trim();
  if (!name) { F("name").focus(); return; }
  const expRaw = F("expiry").value.trim(), expiry = parseExpiry(expRaw);
  if (expRaw && !expiry) { toast("Перевірте дату придатності"); F("expiry").focus(); return; }
  const inn = toList(F("inn").value);
  let innLatin = state.formLatin || [];
  if (!innLatin.length && inn.length) { const d = findDrug(inn.join(" ")); if (d) innLatin = d.l; }
  const med = { ...(state.formExtra || {}), id: state.editingId || undefined, name, inn, innLatin,
    strength: F("strength").value.trim(), form: F("form").value.trim(), expiry: expiry || "",
    qty: F("qty").value.trim(), category: F("category").value.trim(), location: F("location").value.trim(),
    notes: F("notes").value.trim(), barcode: F("barcode").value.trim() };
  $("#btnSave").disabled = true;
  const ok = await saveMed(med);
  $("#btnSave").disabled = false;
  if (ok) { toast(state.editingId ? "Зміни збережено" : "Додано в аптечку"); clearForm(); switchTab("list"); }
}

/* ============ сканування ============ */
function setStatus(html, err){ const el = $("#capStatus"); el.innerHTML = html || ""; el.classList.toggle("err", !!err); }
let stopScan = null;
async function openScanner(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $("#inCodePhoto").click(); return; }
  $("#scanner").hidden = false; $("#scanHint").textContent = "Наведіть на штрих-код або DataMatrix";
  stopScan = await startLiveScan($("#scanVideo"), async raw => {
    if (navigator.vibrate) navigator.vibrate(60);
    closeScanner(); await applyCode(raw);
  }, () => {
    closeScanner();
    setStatus("Немає доступу до камери. Дозвольте камеру в налаштуваннях браузера або скористайтеся «Код із фото».", true);
  });
}
function closeScanner(){ if (stopScan) { stopScan(); stopScan = null; } $("#scanner").hidden = true; }
async function applyCode(raw){
  const g = parseGS1(raw), code = g.gtin || raw;
  F("barcode").value = code;
  if (g.expiry) { F("expiry").value = fmtExpiry(g.expiry); updateExpHint(); }
  const known = await lookupCode(code);
  const parts = [];
  if (known) { fillForm(known, true); parts.push(`Знайдено: <b>${esc(known.name)}</b>`); }
  else parts.push(`Код ${esc(code)} — новий, впишіть назву (наступного разу заповниться сам)`);
  if (g.expiry) parts.push(`термін із DataMatrix: <b>${esc(fmtExpiry(g.expiry))}</b>`);
  else if (!F("expiry").value) parts.push("термін додайте вручну або кнопкою «Дата з фото»");
  setStatus(parts.join(" · ") + ".");
  if (!known) F("name").focus();
}
async function codeFromPhoto(file){
  setStatus(`<span class="spin"></span>Шукаю код на фото…`);
  const r = await fileToImage(file);
  if (!r) { setStatus("Не вдалося відкрити фото.", true); return; }
  const raw = await decodeImage(r.img); URL.revokeObjectURL(r.url);
  if (raw) await applyCode(raw);
  else setStatus("Код не знайдено. Сфотографуйте ближче, рівно і при доброму світлі.", true);
}
async function dateFromPhoto(file){
  setStatus(`<span class="spin"></span>Шукаю дату… (перший раз довше — завантажується розпізнавання)`);
  try {
    const r = await ocrExpiry(file, (p, label) => setStatus(`<span class="spin"></span>${esc(label || "Читаю дату…")} ${p ? p + "%" : ""}`));
    if (r.expiry) {
      F("expiry").value = fmtExpiry(r.expiry); updateExpHint();
      if (r.source === "datamatrix") { await applyCode(r.text); return; }
      setStatus(`Знайдено дату: <b>${esc(fmtExpiry(r.expiry))}</b> — перевірте, що це саме термін придатності.`);
    } else {
      setStatus(`Дату не розпізнано. Рельєфні (вибиті) дати на фользі блістера телефон прочитати не може — оберіть <b>місяць і рік</b> у полі «Придатний до». Друковану дату на коробці сфотографуйте ближче й рівно.
        <details class="ocrraw"><summary>Що вдалося прочитати</summary><pre>${esc((r.text || "").trim().slice(0, 1500) || "—")}</pre></details>`, true);
      $("#f-exp-m").focus();
    }
  } catch { setStatus("Не вдалося завантажити розпізнавання — перевірте інтернет або оберіть дату вручну.", true); }
}

/* ============ призначення лікаря (без ШІ) ============ */
const nums = s => (String(s || "").match(/\d+(?:[.,]\d+)?/g) || []).map(x => +x.replace(",", "."));
function analyzeLine(line){
  const d = findDrug(line);
  const nl = norm(line);
  const byName = state.meds.filter(m => norm(m.name).length >= 4 && nl.includes(norm(m.name)));
  let inn = d ? d.i : [];
  let innL = d ? d.l : [];
  if (!inn.length && byName.length) { inn = byName[0].inn || []; innL = byName[0].innLatin || []; }
  const pKeys = [...inn, ...innL].map(norm).filter(k => k.length > 3);
  const pInn = inn.map(norm);
  const doseMatch = line.match(/(\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?)\s*(мг|mg|мкг|г|мл|%|од)/i);
  const rxDose = doseMatch ? nums(doseMatch[1]) : [];
  const matches = [];
  for (const m of state.meds) {
    const mKeys = innKeys(m), mInn = (m.inn || []).map(norm);
    let type = null;
    if (pKeys.length && mKeys.some(k => pKeys.includes(k))) {
      const overlap = pInn.filter(x => mInn.includes(x)).length;
      if (mInn.length && pInn.length && overlap === pInn.length && mInn.length === pInn.length) {
        const md = nums(m.strength);
        type = !rxDose.length || !md.length || rxDose.every(x => md.includes(x)) ? "same" : "dose";
      } else if (mInn.length > pInn.length && overlap === pInn.length) type = "combo";
      else type = "part";
    } else if (byName.includes(m)) type = "same";
    if (type) {
      let note = "";
      if (type === "dose" && rxDose.length === 1) {
        const md = nums(m.strength)[0];
        if (md) { const k = rxDose[0] / md; note = Number.isInteger(k) && k > 1 ? `${rxDose[0]} = ${k} × ${md} (якщо форму можна ділити/поєднувати — уточніть у лікаря)` : `призначено ${rxDose[0]}, удома ${m.strength}`; }
      }
      if (type === "combo") note = "діюча речовина у складі комбінованого препарату — інші компоненти можуть бути зайві";
      matches.push({ m, type, st: statusOf(m), note });
    }
  }
  const usable = t => matches.some(x => x.type === t && x.st.k !== "expired");
  let verdict;
  if (usable("same")) verdict = "have";
  else if (usable("dose")) verdict = "have_other_dose";
  else if (matches.some(x => (x.type === "same" || x.type === "dose") && x.st.k === "expired")) verdict = "only_expired";
  else if (!d && !matches.length) verdict = "unknown";
  else verdict = "need_buy";
  return { line, drug: d, inn, rxDose, matches, verdict };
}
const VERDICT = { have: ["Є вдома", "b-ok"], have_other_dose: ["Є, інше дозування", "b-warn"], only_expired: ["Лише протермінований", "b-expired"],
  need_buy: ["Треба купити", "b-soon"], unknown: ["Не знайдено в довіднику", "b-unknown"] };
const MTYPE = { same: "та сама речовина", dose: "інше дозування", combo: "у складі комбінованого", part: "частково збігається склад" };
function medLine(m){
  const st = statusOf(m);
  return `<b>${esc(m.name)}</b> ${esc(m.strength || "")}${m.form ? " · " + esc(m.form) : ""} <span class="badge b-${st.k}" style="margin-left:4px">${esc(badgeText(st))}</span>${m.location || m.qty ? `<div style="color:var(--muted);font-size:13px">${esc([m.location, m.qty].filter(Boolean).join(" · "))}</div>` : ""}`;
}
function analyzeRx(){
  const text = $("#rx-text").value.trim();
  if (!text) { toast("Впишіть призначення"); return; }
  const lines = text.split(/\n|;/).map(s => s.trim()).filter(Boolean);
  const res = lines.map(analyzeLine);
  // попередження: одна речовина в кількох призначеннях; комбіновані засоби вдома з тією ж речовиною
  const warnings = [];
  const seen = {};
  res.forEach(r => r.inn.forEach(i => { (seen[norm(i)] = seen[norm(i)] || { name: i, lines: [] }).lines.push(r.line); }));
  Object.values(seen).filter(x => x.lines.length > 1).forEach(x => warnings.push(`«${x.name}» є в кількох призначеннях (${x.lines.join("; ")}) — не перевищуйте добову дозу, уточніть у лікаря.`));
  res.forEach(r => r.matches.filter(x => x.type === "combo" && x.st.k !== "expired").forEach(x =>
    warnings.push(`${x.m.name} теж містить ${r.inn.join(", ")} — не приймайте одночасно з ${r.line.split(/\s/)[0]}.`)));
  let html = `<div class="panel"><h2>Результат</h2>`;
  for (const r of res) {
    const v = VERDICT[r.verdict];
    html += `<div class="rxitem"><div class="rxhead"><b>${esc(r.line)}</b><span class="badge ${v[1]}">${v[0]}</span></div>
      <div class="cinn">${r.inn.length ? esc(r.inn.join(" + ")) : "діючу речовину не визначено — впишіть міжнародну назву (МНН)"}</div>
      ${r.matches.map(x => `<div class="rxmatch"><div class="mt">${esc(MTYPE[x.type])}</div>${medLine(x.m)}${x.note ? `<div style="margin-top:4px">${esc(x.note)}</div>` : ""}</div>`).join("")}
      ${r.verdict === "need_buy" || r.verdict === "only_expired" ? `<div class="rxmatch"><div class="mt">купити</div>${esc(r.inn.length ? r.inn.join(" + ") : r.line)}${r.rxDose.length ? " " + esc(r.rxDose.join("/")) : ""} — будь-який препарат з цією діючою речовиною й дозуванням (генерик дешевший)</div>` : ""}
    </div>`;
  }
  if (warnings.length) html += `<div class="warnbox"><b>Зверніть увагу</b><ul>${warnings.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  html += `<div class="disclaimer">Це підказка, а не призначення. Довідник неповний; заміну препарату чи дозування погоджуйте з лікарем або фармацевтом.</div></div>`;
  $("#rxResult").innerHTML = html;
}

/* ============ навігація і події ============ */
function switchTab(t){
  state.tab = t;
  ["list", "add", "rx"].forEach(k => { $("#view-" + k).hidden = k !== t; });
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  window.scrollTo(0, 0);
}
function bindUI(){
  $("#btnLogin").onclick = async () => {
    $("#loginErr").textContent = "";
    try { await store.signIn(); }
    catch (e) { $("#loginErr").textContent = e && e.code === "auth/unauthorized-domain" ? "Цей домен не дозволено у Firebase (Authentication → Settings → Authorized domains)." : "Не вдалося увійти. Спробуйте ще раз."; }
  };
  $("#btnRecheck").onclick = () => { show("s-loading"); openHousehold(); };
  $("#btnCreate").onclick = async () => {
    $("#btnCreate").disabled = true;
    try { await store.createHousehold(state.user, "Домашня аптечка"); await openHousehold(); }
    catch { toast("Не вдалося створити — перевірте інтернет"); }
    $("#btnCreate").disabled = false;
  };
  $("#btnLogout1").onclick = () => store.signOut();

  document.querySelectorAll(".tab").forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  document.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => { state.filter = b.dataset.goto; switchTab("list"); render(); });
  $("#q").oninput = e => { state.q = e.target.value.trim(); render(); };
  $("#chips").onclick = e => { const b = e.target.closest("[data-f]"); if (b) { state.filter = b.dataset.f; render(); } };
  $("#list").onclick = e => {
    const go = e.target.closest("[data-tab-go]"); if (go) { switchTab(go.dataset.tabGo); return; }
    const c = e.target.closest(".card"); if (c) showMed(c.dataset.id);
  };
  $("#overlay").onclick = e => { if (e.target.id === "overlay") closeSheet(); };
  $("#sheet").onclick = async e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const a = b.dataset.act, id = b.dataset.id;
    if (a === "close") closeSheet();
    if (a === "edit") editMed(id);
    if (a === "del") confirmDelete(id);
    if (a === "del-yes") { b.disabled = true; try { await store.deleteMed(state.hh.id, id); closeSheet(); toast("Видалено"); } catch { toast("Не вдалося видалити"); b.disabled = false; } }
    if (a === "add-member") {
      const em = String($("#newMember").value || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { toast("Перевірте адресу"); return; }
      if ((state.hh.members || []).includes(em)) { toast("Вже в списку"); return; }
      b.disabled = true;
      try { await store.addMember(state.hh.id, store.emailOf(state.user), em); state.hh.members = [...(state.hh.members || []), em]; toast("Додано"); openMenu(); }
      catch { toast("Не вдалося додати — можливо, ця адреса вже в іншій аптечці"); b.disabled = false; }
    }
    if (a === "rm-member") {
      const em = b.dataset.email; b.disabled = true;
      try { await store.removeMember(state.hh.id, em); state.hh.members = (state.hh.members || []).filter(x => x !== em); openMenu(); }
      catch { toast("Не вдалося прибрати"); b.disabled = false; }
    }
    if (a === "export") exportData();
    if (a === "import-open") openImport();
    if (a === "import") doImport();
    if (a === "logout") { closeSheet(); store.signOut(); }
  };
  $("#menuBtn").onclick = openMenu;

  $("#btnScan").onclick = openScanner;
  $("#scanClose").onclick = closeScanner;
  $("#btnCodePhoto").onclick = () => $("#inCodePhoto").click();
  $("#inCodePhoto").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) codeFromPhoto(f); };
  $("#btnOcr").onclick = () => $("#inOcr").click();
  $("#inOcr").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) dateFromPhoto(f); };
  $("#medForm").onsubmit = onSubmit;
  $("#btnClear").onclick = clearForm;
  F("name").onchange = onNameChange;
  F("inn").oninput = () => { state.formLatin = null; updateDup(); };
  F("expiry").oninput = updateExpHint;
  $("#btnAnalyze").onclick = analyzeRx;
}
boot();
