/* Wishlist — iPhone app. The list lives in a private GitHub repo (data/wishlist.json);
   this page reads and writes it with the user's own token, and asks the cloud checker
   (GitHub Actions) to read new links. Merge rules are shared with the Mac app (merge.js). */
"use strict";

const DEFAULT_REPO = "mehmeterenkeles527-cmd/wishlist-veri";
const DATA_PATH = "data/wishlist.json";
const CONFIG_PATH = "data/config.json";
const LS = { token: "wl.token", repo: "wl.repo", doc: "wl.doc", dirty: "wl.dirty", view: "wl.view", outbox: "wl.outbox", push: "wl.push", pushKey: "wl.pushKey" };
const TRACKING = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "yclid",
  "msclkid", "ref", "ref_", "tag", "boutiqueId", "merchantId", "sav", "_gl", "igshid", "si"]);

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const nowIso = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

const S = {
  token: lsGet(LS.token, ""), repo: lsGet(LS.repo, DEFAULT_REPO),
  doc: lsGet(LS.doc, { version: 2, products: [], categories: [], deleted: {} }),
  dirty: lsGet(LS.dirty, false), outbox: lsGet(LS.outbox, []),
  view: Object.assign({ tab: "list", filter: "all", cat: null, q: "" }, lsGet(LS.view, {})),
  syncing: false, again: false, lastSync: 0, error: "", cfg: null, pollUntil: 0, openId: null,
};

/* ------------------------------------------------------------------ money & product helpers (same as the Mac app) */
const SYM = { TRY: "₺", USD: "$", EUR: "€", GBP: "£" };
function money(v, cur = "TRY") {
  if (v == null) return "Fiyat yok";
  let t = v.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (t.endsWith(",00")) t = t.slice(0, -3);
  const s = SYM[(cur || "TRY").toUpperCase()] || cur + " ";
  return s === "₺" ? `${t} ₺` : `${s}${t}`;
}
const hist = (p) => (p.price_history || []).filter((h) => h && h.price);
const currentPrice = (p) => { const h = hist(p); return h.length ? [h[h.length - 1].price, h[h.length - 1].currency || "TRY"] : [null, "TRY"]; };
const firstPrice = (p) => { const h = hist(p); return h.length ? [h[0].price, h[0].currency || "TRY"] : [null, "TRY"]; };
function listPrice(p) { const [now] = currentPrice(p); return p.list_price && now && p.list_price > now * 1.005 ? p.list_price : null; }
function shopDiscount(p) { const lp = listPrice(p), [now] = currentPrice(p); return lp && now ? (lp - now) / lp * 100 : null; }
function refPrice(p) { const [f] = firstPrice(p); return Math.max(f || 0, listPrice(p) || 0) || null; }
function isDrop(p) { const [f] = firstPrice(p), [n] = currentPrice(p); return !!(listPrice(p) || (f && n && n < f - 0.004)); }
function effectiveTarget(p) {
  if (p.target_price) return p.target_price;
  const [f] = firstPrice(p);
  return p.target_pct && f ? Math.round(f * (1 - p.target_pct / 100) * 100) / 100 : null;
}
function targetReached(p) { const [n] = currentPrice(p), t = effectiveTarget(p); return !!(t && n && n <= t + 0.004); }
function allTimeLow(p) { const ps = hist(p).map((h) => h.price), [n] = currentPrice(p);
  return !!(n && new Set(ps).size > 1 && n <= Math.min(...ps) + 0.004 && Math.max(...ps) > n + 0.004); }
const active = () => S.doc.products.filter((p) => !p.bought);
const prefs = () => (S.doc.prefs = S.doc.prefs || {});
function setPref(fn, msg) { const p = prefs(); fn(p); p.u = Date.now(); commit(msg); }
const DAY = 86400000;
const daysSince = (iso) => { const d = new Date(iso); return isNaN(d) ? 0 : Math.floor((Date.now() - d) / DAY); };

/* ---- return window after buying ---- */
const RETURN_DAYS = { "trendyol.com": 15, "hepsiburada.com": 15, "amazon.com.tr": 30 };
function returnDaysLeft(p) {
  if (!p.bought) return null;
  const left = (p.return_days || RETURN_DAYS[p.store] || 14) - daysSince(p.bought.at);
  return left >= 0 ? left : null;
}

/* ---- Turkish sale calendar ---- */
function saleCalendar(now = new Date()) {
  const y = now.getFullYear(), D = (yy, m, d) => new Date(yy, m - 1, d);
  const list = [];
  for (const yy of [y - 1, y, y + 1]) {
    list.push({ name: "Kış sezon sonu indirimleri", start: D(yy, 12, 26), end: D(yy + 1, 1, 31), typical: 50 });
    list.push({ name: "Yaz sezon sonu indirimleri", start: D(yy, 6, 20), end: D(yy, 7, 31), typical: 50 });
    list.push({ name: "Efsane Kasım / Black Friday", start: D(yy, 11, 1), end: D(yy, 11, 30), typical: 40 });
    list.push({ name: "Sevgililer Günü indirimleri", start: D(yy, 2, 7), end: D(yy, 2, 14), typical: 20 });
  }
  return list.sort((a, b) => a.start - b.start);
}
function currentSale(now = new Date()) { return saleCalendar(now).find((s) => s.start <= now && now <= new Date(s.end.getTime() + DAY)); }
function nextSale(now = new Date()) { return saleCalendar(now).find((s) => s.start > now && s.typical >= 40); }

/* ---- "is this discount real?" ---- */
function fakeDiscount(p) {
  const h = hist(p), [now] = currentPrice(p);
  if (!now || h.length < 2) return null;
  const recent = h.filter((x) => daysSince(x.t) <= 45).slice(0, -1);
  const lp = listPrice(p);
  const cheaper = recent.filter((x) => x.price <= now - 0.5);
  if ((lp || isDrop(p)) && cheaper.length) {
    const c = cheaper.reduce((a, b) => (a.price <= b.price ? a : b));
    return `Bu "indirim" şüpheli: ${daysSince(c.t)} gün önce zaten ${money(c.price)} idi.`;
  }
  // a price hike just before the "sale": a → b (≥ +10%) → c (≈ a)
  for (let i = h.length - 1; i >= 2; i--) {
    const a = h[i - 2].price, b = h[i - 1].price, c = h[i].price;
    if (daysSince(h[i - 2].t) <= 60 && b >= a * 1.1 && c >= a * 0.97 && c < b) {
      return `Dikkat: önce ${money(a)} → ${money(b)} zam yapılıp sonra "indirim" gösterilmiş. Gerçek indirim %${Math.max(0, Math.round((a - c) / a * 100))}.`;
    }
  }
  if (lp && h.every((x) => x.price < lp * 0.97) && h.length >= 3 && daysSince(h[0].t) >= 21) {
    return `Mağaza ${money(lp)} "eski fiyat" diyor ama ${daysSince(h[0].t)} gündür hiç o fiyatta görmedim.`;
  }
  return null;
}

/* ---- buy now or wait? ---- */
function buyOrWait(p) {
  if (p.bought) return null;
  const [now] = currentPrice(p); if (!now) return null;
  const ps = hist(p).map((x) => x.price), avg = ps.reduce((a, b) => a + b, 0) / ps.length;
  const sale = currentSale(), next = nextSale(), fake = fakeDiscount(p);
  if (p.in_stock === false) return { v: "izle", t: "Tükendi. Stoğa girince haber vereceğim." };
  if (targetReached(p)) return { v: "al", t: "Hedef fiyatına indi. Almak için iyi an." };
  if (fake) return { v: "bekle", t: "İndirim şüpheli görünüyor, acele etme." };
  if (allTimeLow(p)) return { v: "al", t: `Şimdiye kadar gördüğüm en düşük fiyat (ortalama ${money(avg)}).` };
  if (sale && isDrop(p)) return { v: "al", t: `${sale.name} sürüyor ve ürün indirimde.` };
  if (next) {
    const days = Math.ceil((next.start - new Date()) / DAY);
    if (days <= 40 && !isDrop(p)) return { v: "bekle", t: `${next.name} başlamasına ${days} gün var; bu dönemde genelde %${next.typical}'e varan indirim olur.` };
  }
  const last = hist(p).slice(-2);
  if (last.length === 2 && last[1].price > last[0].price + 0.5 && daysSince(last[1].t) <= 14) return { v: "bekle", t: "Fiyat yakın zamanda arttı; çoğu zaman geri iner." };
  if (isDrop(p)) return { v: "al", t: `İndirimde: ${money(refPrice(p))} yerine ${money(now)}.` };
  return { v: "izle", t: "Fiyat normal seviyesinde. Takipteyim, düşerse haber veririm." };
}

/* ---- free shipping per shop ---- */
function shippingInfo(store) {
  const items = active().filter((p) => p.store === store);
  const thr = Math.max(0, ...items.map((p) => p.free_ship_over || 0));
  if (!thr) return null;
  const total = items.reduce((a, p) => a + Math.min(p.basket_price || Infinity, currentPrice(p)[0] || Infinity) % Infinity || 0, 0);
  return { thr, total, missing: Math.max(0, thr - total), count: items.length };
}
const PRIORITIES = [["acil", "Acil"], ["birgun", "Bir gün"], ["hayal", "Hayal"]];
const prioRank = (p) => ({ acil: 0, birgun: 1, hayal: 2 }[p.priority] ?? 3);
const stillWantDue = (p) => !p.bought && daysSince(p.added_at) >= 30 && (!p.still_want_at || daysSince(p.still_want_at) >= 30);
const cat = (id) => S.doc.categories.find((c) => c.id === id);
const children = (pid) => S.doc.categories.filter((c) => (c.parent_id || null) === (pid || null)).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, "tr"));
function descendants(id) { const out = new Set([id]); let grew = true; while (grew) { grew = false; for (const c of S.doc.categories) if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) { out.add(c.id); grew = true; } } return out; }
function path(id) { const out = []; let c = cat(id), g = 0; while (c && g++ < 50) { out.unshift(c); c = cat(c.parent_id); } return out; }
const pathText = (id) => path(id).map((c) => c.name).join(" › ") || "Kategorisiz";
function normalizeUrl(u) {
  try { const x = new URL(u.trim()); x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (TRACKING.has(k)) x.searchParams.delete(k);
    const host = x.host.toLowerCase().replace(/^www\./, ""), pth = x.pathname.replace(/\/+$/, "");
    const q = x.searchParams.toString();
    return `${x.protocol.toLowerCase().replace(":", "")}://${host}${pth}${q ? "?" + q : ""}`;
  } catch { return (u || "").trim(); }
}
const niceDate = (iso) => { if (!iso) return "—"; const d = new Date(iso); if (isNaN(d)) return "—";
  return d.toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" }); };
function ago(ms) { if (!ms) return ""; const s = (Date.now() - ms) / 1000;
  if (s < 50) return "az önce"; if (s < 3600) return `${Math.round(s / 60)} dk önce`; if (s < 86400) return `${Math.round(s / 3600)} sa önce`;
  return `${Math.round(s / 86400)} gün önce`; }

/* ------------------------------------------------------------------ GitHub */
class GhError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function gh(p, opts = {}) {
  let r;
  try {
    // no trailing slash: GitHub answers 404 to ".../repos/owner/name/"
    const url = `https://api.github.com/repos/${S.repo}` + (p ? `/${p}` : "");
    r = await fetch(url, Object.assign({ cache: "no-store" }, opts, {
      headers: Object.assign({ Authorization: `Bearer ${S.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28" }, opts.headers || {}) }));
  } catch { throw new GhError(0, "offline"); }
  if (!r.ok) { let m = ""; try { m = (await r.json()).message || ""; } catch {} throw new GhError(r.status, m); }
  return r.status === 204 ? null : r.json();
}
function b64ToText(b64) { const bin = atob(b64.replace(/\s/g, "")); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0)); return new TextDecoder().decode(bytes); }
function textToB64(t) { const bytes = new TextEncoder().encode(t); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); }
async function readFile(p) {
  try {
    const f = await gh(`contents/${p}?ref=main&_=${Date.now()}`);
    let text = f.content ? b64ToText(f.content) : "";
    if (!text && f.encoding === "none") text = b64ToText((await gh(`git/blobs/${f.sha}`)).content);  // over 1 MB
    return { data: JSON.parse(text || "{}"), sha: f.sha };
  } catch (e) { if (e.status === 404) return { data: null, sha: null }; throw e; }
}
async function writeFile(p, data, sha, message) {
  const body = { message, content: textToB64(JSON.stringify(data, null, 1)), branch: "main" };
  if (sha) body.sha = sha;
  const r = await gh(`contents/${p}`, { method: "PUT", body: JSON.stringify(body) });
  return r.content.sha;
}
/* ------------------------------------------------------------------ app notifications (Web Push) */
const PUSH_PATH = "data/push.json";
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const deviceName = () => /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Mac/.test(navigator.userAgent) ? "Mac" : "Cihaz";
function keyBytes(b64) { const s = (b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function swReg() { return navigator.serviceWorker.ready; }
async function savePushSub(sub, remove = false) {
  const j = sub.toJSON ? sub.toJSON() : sub;
  for (let i = 0; i < 4; i++) {
    const { data, sha } = await readFile(PUSH_PATH);
    const subs = ((data && data.subs) || []).filter((x) => x.endpoint !== j.endpoint);
    if (!remove) subs.push({ endpoint: j.endpoint, keys: j.keys, device: deviceName(), added: nowIso() });
    try { await writeFile(PUSH_PATH, { subs }, sha, remove ? "Bildirimler kapatıldı" : `Bildirimler açıldı: ${deviceName()}`); lsSet(LS.push, remove ? "" : j.endpoint); return; }
    catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
  }
  throw new Error("kaydedilemedi");
}
async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (isIOS && !standalone()) return "safari";
  if (Notification.permission === "denied") return "denied";
  try { const sub = await (await swReg()).pushManager.getSubscription(); return sub && Notification.permission === "granted" ? "on" : "off"; } catch { return "off"; }
}
async function enablePush() {
  const perm = await Notification.requestPermission();   // first: iOS only asks right after a tap
  if (perm !== "granted") { toast("İzin verilmedi — iPhone Ayarlar › Bildirimler › Wishlist'ten açabilirsin"); renderSettings(); return; }
  try {
    if (!(S.cfg || {}).vapid_public) S.cfg = (await readFile(CONFIG_PATH)).data || {};
    const key = (S.cfg || {}).vapid_public;
    if (!key) { dispatch("push_test", {}).catch(() => {}); toast("Bildirim anahtarı hazırlanıyor, 2 dakika sonra tekrar dokun"); renderSettings(); return; }
    const reg = await swReg();
    let sub = await reg.pushManager.getSubscription();
    if (sub && lsGet(LS.pushKey, "") !== key) { await sub.unsubscribe(); sub = null; }
    sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    lsSet(LS.pushKey, key);
    await savePushSub(sub);
    await dispatch("push_test", {});
    toast("Açıldı ✓ Test bildirimi 1 dakika içinde gelir");
  } catch (e) { toast("Açılamadı: " + (e.message || e)); }
  renderSettings();
}
async function disablePush() {
  try { const sub = await (await swReg()).pushManager.getSubscription(); if (sub) { await savePushSub(sub, true); await sub.unsubscribe(); } toast("Bu cihazda bildirimler kapandı"); }
  catch (e) { toast("Kapatılamadı: " + (e.message || e)); }
  renderSettings();
}
async function refreshPushSub() {   // the browser can renew a subscription; keep the cloud's copy current
  try {
    if (!pushSupported() || Notification.permission !== "granted") return;
    const sub = await (await swReg()).pushManager.getSubscription();
    if (sub && sub.endpoint !== lsGet(LS.push, "")) await savePushSub(sub);
  } catch {}
}

const dispatch = (event_type, client_payload) => gh("dispatches", { method: "POST", body: JSON.stringify({ event_type, client_payload }) });

/* ------------------------------------------------------------------ sync */
function saveLocal() { lsSet(LS.doc, S.doc); lsSet(LS.dirty, S.dirty); lsSet(LS.outbox, S.outbox); }
let syncTimer = null;
function commit(msg) { S.dirty = true; saveLocal(); render(); clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), 600); if (msg) toast(msg); }

async function sync({ manual = false } = {}) {
  if (!S.token) return;
  if (S.syncing) { S.again = true; return; }
  S.syncing = true; S.error = ""; renderSync();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: remote, sha } = await readFile(DATA_PATH);
      const merged = WishMerge.merge(S.doc, remote || {});
      S.doc = merged;
      if (S.dirty) {
        const changed = JSON.stringify(merged) !== JSON.stringify(WishMerge.merge({}, remote || {}));
        if (changed || !remote) {
          try { await writeFile(DATA_PATH, merged, sha, "iPhone'dan güncellendi"); }
          catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
        }
        S.dirty = false;
      }
      break;
    }
    // ask the cloud to read links only after they are saved, so it finds the placeholder
    while (S.outbox.length) {
      const job = S.outbox[0];
      await dispatch(job.event, job.payload);
      S.outbox.shift();
      S.pollUntil = Date.now() + 4 * 60 * 1000;
    }
    S.lastSync = Date.now();
    if (!S.cfg) readFile(CONFIG_PATH).then((r) => { S.cfg = r.data || {}; if (S.view.tab === "settings") render(); }).catch(() => {});
  } catch (e) {
    S.error = e.status === 401 ? "Anahtar geçersiz ya da süresi dolmuş — Ayarlar'dan yenile"
      : e.status === 404 ? "Depo bulunamadı ya da anahtarın bu depoya izni yok"
      : e.status === 403 ? "GitHub izin vermedi: " + (e.message || "anahtar izinlerini kontrol et")
      : e.status === 0 ? "Çevrimdışı — değişikliklerin telefonda duruyor, bağlanınca gönderilecek"
      : "Eşitlenemedi: " + (e.message || e.status);
    if (manual) toast(S.error);
  } finally {
    S.syncing = false; saveLocal(); render();
    if (S.again) { S.again = false; setTimeout(() => sync(), 300); }
  }
}
// while the cloud is reading new links, look again every 15 s
setInterval(() => {
  const loading = S.doc.products.some((p) => p.status === "loading");
  if (document.visibilityState === "visible" && S.token && (loading || Date.now() < S.pollUntil)) sync();
}, 15000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - S.lastSync > 20000) sync(); });
window.addEventListener("online", () => sync());

/* ------------------------------------------------------------------ actions */
function product(id) { return S.doc.products.find((p) => p.id === id); }
function edit(id, fn, msg) { const p = product(id); if (!p) return; fn(p); p.u = Date.now(); commit(msg); }

function addLink(raw, categoryId, bulk = false) {
  const m = String(raw || "").match(/https?:\/\/[^\s<>"']+/i);
  if (!m) { toast("Bu bir link gibi görünmüyor"); return false; }
  const url = m[0].replace(/[).,;]+$/, ""), key = normalizeUrl(url);
  const existing = S.doc.products.find((p) => p.key === key || normalizeUrl(p.url) === key);
  if (existing && bulk) return false;
  if (existing) { if (existing.bought) { existing.bought = null; existing.u = Date.now(); commit("Aldıklarım'dan listeye geri alındı"); } else toast("Bu ürün zaten listende"); openDetail(existing.id); return true; }
  const host = (() => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return "Yeni ürün"; } })();
  const t = Date.now();
  S.doc.products.unshift({ id: newId(), url, key, title: host, store: host, image_urls: [], category_id: categoryId || null,
    favorite: false, notes: "", added_at: nowIso(), last_checked: "", status: "loading", error: "", price_history: [],
    list_price: null, target_price: null, target_notified: false, in_stock: null, bought: null, u: t, c: 0 });
  S.outbox.push({ event: "add", payload: { url, category_id: categoryId || null } });
  commit("Ekleniyor… fiyat ve fotoğraflar 1-2 dakikada gelir");
  return true;
}
function removeProduct(id) {
  const i = S.doc.products.findIndex((p) => p.id === id); if (i < 0) return;
  const [p] = S.doc.products.splice(i, 1);
  S.doc.deleted = S.doc.deleted || {}; S.doc.deleted[id] = Date.now();
  closeSheets(); commit();
  toast("Ürün kaldırıldı", "Geri al", () => {
    p.u = Date.now() + 1; delete S.doc.deleted[id];
    S.doc.products.splice(Math.min(i, S.doc.products.length), 0, p); commit("Geri geldi");
  });
}
function checkNow(ids) {
  S.outbox.push({ event: "check", payload: ids && ids.length ? { ids } : {} });
  saveLocal(); sync();
  toast(ids && ids.length ? "Fiyat kontrol ediliyor… 1-2 dakika" : "Tüm fiyatlar kontrol ediliyor… birkaç dakika sürebilir");
}
function newCategory(parentId) {
  const name = (prompt(parentId ? `“${cat(parentId)?.name}” içine yeni kategori:` : "Yeni kategori adı:") || "").trim();
  if (!name) return null;
  const c = { id: newId(), name: name.slice(0, 60), parent_id: parentId || null, order: children(parentId).length, u: Date.now() };
  S.doc.categories.push(c); commit(`“${c.name}” oluşturuldu`);
  return c.id;
}
function askNumber(label, start) {
  const v = prompt(label, start != null ? String(start).replace(".", ",") : "");
  if (v === null) return undefined;
  const n = parseFloat(v.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""));
  return isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ toast */
let toastTimer;
function toast(text, actionLabel, action) {
  const el = $("#toast"); el.innerHTML = `<span>${esc(text)}</span>` + (actionLabel ? `<button>${esc(actionLabel)}</button>` : "");
  el.hidden = false;
  if (actionLabel) $("button", el).onclick = () => { el.hidden = true; action(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), actionLabel ? 5000 : 2800);
}

/* ------------------------------------------------------------------ rendering: list */
const FILTERS = [["all", "Tümü"], ["sale", "İndirimde"], ["fav", "Favoriler"], ["target", "Hedefte"], ["bought", "Aldıklarım"]];
const SORTS = [["new", "En yeni"], ["old", "En eski"], ["cheap", "Fiyat: artan"], ["dear", "Fiyat: azalan"], ["disc", "En çok indirim"],
  ["prio", "Önceliğe göre"], ["name", "İsim (A–Z)"]];
function filtered() {
  const v = S.view;
  let items = v.filter === "bought" ? S.doc.products.filter((p) => p.bought) : active();
  if (v.filter === "sale") items = items.filter(isDrop);
  if (v.filter === "fav") items = items.filter((p) => p.favorite);
  if (v.filter === "target") items = items.filter((p) => p.target_price || p.target_pct);
  if (v.filter === "acil") items = items.filter((p) => p.priority === "acil");
  if (v.cat && cat(v.cat)) { const ids = descendants(v.cat); items = items.filter((p) => ids.has(p.category_id)); }
  const q = v.q.trim().toLocaleLowerCase("tr");
  if (q) items = items.filter((p) => `${p.title} ${p.store} ${p.notes}`.toLocaleLowerCase("tr").includes(q));
  const price = (p) => (p.bought && p.bought.price) || currentPrice(p)[0];
  const disc = (p) => { const r = refPrice(p), n = currentPrice(p)[0]; return r && n ? (r - n) / r : 0; };
  const sort = v.sort || (v.filter === "sale" ? "disc" : v.filter === "bought" ? "bought" : "new");
  const by = {
    new: (a, b) => String(b.added_at).localeCompare(String(a.added_at)),
    old: (a, b) => String(a.added_at).localeCompare(String(b.added_at)),
    cheap: (a, b) => (price(a) ?? 1e12) - (price(b) ?? 1e12),
    dear: (a, b) => (price(b) ?? -1) - (price(a) ?? -1),
    disc: (a, b) => disc(b) - disc(a),
    prio: (a, b) => prioRank(a) - prioRank(b) || String(b.added_at).localeCompare(String(a.added_at)),
    name: (a, b) => a.title.localeCompare(b.title, "tr"),
    bought: (a, b) => String(b.bought.at).localeCompare(String(a.bought.at)),
  }[sort] || ((a, b) => 0);
  return items.sort(by);
}
function badgesFor(p) {
  const b = [], [f] = firstPrice(p), [n] = currentPrice(p), sale = shopDiscount(p);
  if (p.bought) {
    b.push(["b-bought", "✓ ALINDI"]);
    const left = returnDaysLeft(p);
    if (left !== null && n && p.bought.price && n < p.bought.price - 1) b.push(["b-sale", "UCUZLADI · İADE"]);
    else if (left !== null) b.push(["b-out", `İADE ${left} GÜN`]);
    return b;
  }
  if (p.in_stock === false) b.push(["b-out", "TÜKENDİ"]);
  if (p.track_size && p.sizes) {
    const s = p.sizes.find((x) => String(x.name).toLowerCase() === String(p.track_size).toLowerCase());
    if (s && s.in_stock === false) b.push(["b-out", `${p.track_size} YOK`]);
  }
  if (fakeDiscount(p)) b.push(["b-rise", "⚠︎ ŞÜPHELİ"]);
  if (sale >= 1) b.push(["b-sale", `%${Math.round(sale)} İNDİRİM`]);
  if (targetReached(p)) b.push(["b-target", "HEDEFTE"]); else if (allTimeLow(p)) b.push(["b-low", "EN DÜŞÜK"]);
  if (f && n && Math.abs(f - n) > 0.004) b.push([n < f ? "b-drop" : "b-rise", `${n < f ? "↓" : "↑"} %${Math.round(Math.abs(n - f) / f * 100)}`]);
  return b.slice(0, 3);
}
function imgUrl(p) { return (p.image_urls || [])[0]; }
function cardHtml(p) {
  const [now, cur] = currentPrice(p), [first] = firstPrice(p), lp = listPrice(p);
  let price = now, old = lp || (first && now && now < first - 0.004 ? first : null), cls = lp ? "sale" : old ? "drop" : "";
  if (p.bought && p.bought.price) { price = p.bought.price; old = p.bought.ref_price > price ? p.bought.ref_price : null; cls = old ? "drop" : ""; }
  const img = imgUrl(p), prio = { acil: "ACİL", hayal: "HAYAL" }[p.priority];
  const fx = cur !== "TRY" && price && (S.doc.meta || {}).rates && S.doc.meta.rates[cur] ? ` <span class="fx">≈ ${money(price * S.doc.meta.rates[cur])}</span>` : "";
  return `<button class="card ${p.in_stock === false && !p.bought ? "out" : ""}" data-open="${p.id}">
    <div class="ph ${p.status === "loading" ? "loading-shimmer" : ""}">
      ${img ? `<img src="${esc(img)}" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.remove()">` : ""}
      ${!img ? `<div class="none">${p.status === "loading" ? "Okunuyor…" : "Görsel yok"}</div>` : ""}
      ${prio ? `<span class="prio p-${p.priority}">${prio}</span>` : ""}
      <span class="star ${p.favorite ? "on" : ""}" data-fav="${p.id}" role="button" aria-label="Favori"><svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg></span>
      <div class="badges">${badgesFor(p).map(([c, t]) => `<span class="badge ${c}">${t}</span>`).join("")}</div>
    </div>
    <div class="meta">
      <div class="store">${esc(p.store || "")}${p.track_size ? ` · ${esc(p.track_size)}` : ""}</div>
      <div class="ttl">${esc(p.title)}</div>
      <div class="prices">${price ? `<span class="price ${cls}">${money(price, cur)}</span>` : `<span class="price none">${p.status === "loading" ? "Okunuyor…" : "Fiyat yok"}</span>`}
        ${old ? `<span class="old">${money(old, cur)}</span>` : ""}${fx}${p.status === "error" && !p.bought ? `<i class="dot-err" title="${esc(p.error)}"></i>` : ""}</div>
      ${p.basket_price && !p.bought && p.basket_price < (now || Infinity) - 0.004 ? `<div class="basket">Sepette ${money(p.basket_price, cur)}</div>` : ""}
    </div></button>`;
}
function renderList() {
  const v = S.view, base = v.filter === "bought" ? S.doc.products.filter((p) => p.bought) : active();
  const counts = { all: active().length, sale: active().filter(isDrop).length, fav: active().filter((p) => p.favorite).length,
    target: active().filter((p) => p.target_price || p.target_pct).length, acil: active().filter((p) => p.priority === "acil").length,
    bought: S.doc.products.filter((p) => p.bought).length };
  const filters = [["all", "Tümü"], ["sale", "İndirimde"], ["fav", "Favoriler"], ["acil", "Acil"], ["target", "Hedefte"], ["bought", "Aldıklarım"]];
  $("#filters").innerHTML = filters.filter(([k]) => k !== "acil" || counts.acil).map(([k, t]) =>
    `<button class="chip ${v.filter === k ? "on" : ""}" data-filter="${k}">${t}${counts[k] ? `<span class="n">${counts[k]}</span>` : ""}</button>`).join("");
  if (v.cat && !cat(v.cat)) v.cat = null;
  $("#crumbs").innerHTML = v.cat ? `<button data-cat="">Tüm kategoriler</button>` + path(v.cat).map((c, i, a) => ` › ${i === a.length - 1 ? `<b>${esc(c.name)}</b>` : `<button data-cat="${c.id}">${esc(c.name)}</button>`}`).join("")
    + ` <button class="cat-menu" data-catmenu="${v.cat}" aria-label="Kategoriyi düzenle">⋯ Düzenle</button>` : "";
  const kids = children(v.cat);
  const countIn = (id) => { const ids = descendants(id); return base.filter((p) => ids.has(p.category_id)).length; };
  $("#cats").innerHTML = kids.map((c) => `<button class="chip" data-cat="${c.id}">📁 ${esc(c.name)}<span class="n">${countIn(c.id) || ""}</span></button>`).join("")
    + `<button class="chip add" data-newcat="${v.cat || ""}">+ ${v.cat ? "Alt kategori" : "Kategori"}</button>`;
  const items = filtered();
  let sum = "";
  if (v.filter === "bought") {
    const paid = items.reduce((a, p) => a + (p.bought.price || 0), 0);
    const saved = items.reduce((a, p) => a + Math.max(0, (p.bought.ref_price || 0) - (p.bought.price || 0)), 0);
    sum = `${items.length} ürün aldın${paid ? ` · ${money(paid)} ödedin` : ""}${saved >= 1 ? ` · ${money(saved)} tasarruf 🎉` : ""}`;
  } else {
    const total = items.reduce((a, p) => a + (currentPrice(p)[0] || 0), 0), sale = items.filter(isDrop).length;
    sum = items.length ? `${items.length} ürün · toplam ${money(total)}${sale ? ` · ${sale} tanesi indirimde` : ""}` : "";
  }
  const sortName = (SORTS.find(([k]) => k === v.sort) || [0, v.filter === "sale" ? "En çok indirim" : "En yeni"])[1];
  $("#summary").innerHTML = `<span>${esc(sum)}</span><span class="tools"><button class="tool" data-sortmenu>⇅ ${esc(sortName)}</button>
    <button class="tool" data-board aria-label="Görünüm">${v.board ? "▦ Kart" : "▤ Pano"}</button></span>`;
  // 30-day rule
  const due = active().filter(stillWantDue);
  const banner = due.length && v.filter !== "bought" && !S.dismissedReview ? `<div class="review-banner"><b>${due.length} ürün 30 günü geçti.</b> Hâlâ istiyor musun?
    <span><button class="tool on" data-review>Bak</button><button class="tool" data-dismissreview>Sonra</button></span></div>` : "";
  $("#grid").className = v.board ? "grid board" : "grid";
  $("#grid").innerHTML = banner + items.map(cardHtml).join("");
  const empty = $("#empty");
  empty.hidden = items.length > 0;
  if (!items.length) {
    const msg = v.q ? ["Sonuç yok", "Aramayı değiştirmeyi dene."]
      : v.filter === "sale" ? ["İndirimde ürün yok", "Mağazada indirime giren ya da eklediğinden beri ucuzlayan ürünler burada görünür."]
      : v.filter === "fav" ? ["Henüz favori yok", "Bir ürünün yıldızına dokun."]
      : v.filter === "target" ? ["Hedef fiyat koyduğun ürün yok", "Ürünü aç, “Hedef fiyat”a dokun. O fiyata inince bildirim gelir."]
      : v.filter === "bought" ? ["Henüz bir şey almadın", "Ürünü aldığında “Aldım”a dokun, ne kadar tasarruf ettiğin burada görünür."]
      : ["Liste boş", "Sağ alttaki + ile link ekle, ya da mağaza uygulamasında Paylaş › Wishlist'e ekle."];
    empty.innerHTML = `<h2>${msg[0]}</h2><p>${msg[1]}</p>`;
  }
}

/* ------------------------------------------------------------------ small sheet helper */
function smallSheet(html, onClick) {
  const el = $("#add");
  el.innerHTML = `<div class="grabber"></div><div class="sheet-pad">${html}</div>`;
  el.hidden = false; $("#scrim").hidden = false; el.scrollTop = 0;
  el.onclick = (e) => { if (e.target.closest("[data-closeadd]")) { closeSmall(); return; } if (onClick) onClick(e); };
  return el;
}
function closeSmall() { $("#add").hidden = true; if ($("#detail").hidden) $("#scrim").hidden = true; }
const thumb = (p, cls = "") => (p.image_urls || [])[0]
  ? `<img class="${cls}" src="${esc(p.image_urls[0])}" referrerpolicy="no-referrer" alt="" onerror="this.style.visibility='hidden'">` : `<span class="noimg ${cls}"></span>`;
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
function spentThisMonth() {
  const k = monthKey();
  return S.doc.products.filter((p) => p.bought && String(p.bought.at || "").startsWith(k)).reduce((a, p) => a + (p.bought.price || 0), 0);
}
function toTry(v, cur) { const r = (S.doc.meta || {}).rates || {}; return cur && cur !== "TRY" && r[cur] ? v * r[cur] : v; }

/* ------------------------------------------------------------------ rendering: dashboard */
function renderDash() {
  const act = active(), bought = S.doc.products.filter((p) => p.bought), price = (p) => { const [v, c] = currentPrice(p); return v ? toTry(v, c) : 0; };
  const onSale = act.filter(isDrop), saving = onSale.reduce((a, p) => a + Math.max(0, (refPrice(p) || 0) - (currentPrice(p)[0] || 0)), 0);
  const targets = act.filter((p) => effectiveTarget(p)), hit = targets.filter(targetReached);
  const saved = bought.reduce((a, p) => a + Math.max(0, (p.bought.ref_price || 0) - (p.bought.price || 0)), 0);
  const disc = (p) => { const r = refPrice(p), n = currentPrice(p)[0]; return r && n ? (r - n) / r : 0; };
  const deals = act.filter((p) => disc(p) > 0.004 || targetReached(p)).sort((a, b) => disc(b) - disc(a)).slice(0, 6);
  const moves = [];
  for (const p of S.doc.products) { const h = hist(p); for (let i = 1; i < h.length; i++) moves.push([h[i].t, p, h[i - 1].price, h[i].price]); }
  moves.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  const row = (p, right) => `<button class="row" data-open="${p.id}">${thumb(p)}
    <span class="t"><div>${esc(p.title)}</div><small>${esc(p.store || "")}</small></span><span class="r">${right}</span></button>`;
  const cats = children(null).map((c) => { const ids = descendants(c.id), ps = act.filter((p) => ids.has(p.category_id)); return [c, ps.reduce((a, p) => a + price(p), 0), ps.length]; }).filter((x) => x[2]);
  const unc = act.filter((p) => !p.category_id); if (unc.length) cats.push([{ id: "", name: "Kategorisiz" }, unc.reduce((a, p) => a + price(p), 0), unc.length]);
  cats.sort((a, b) => b[1] - a[1]); const top = Math.max(1, ...cats.map((c) => c[1]));
  const meta = S.doc.meta || {}, budget = prefs().budget || 0, spent = spentThisMonth();
  const sale = currentSale(), next = nextSale();
  const saleLine = sale ? `<b>${esc(sale.name)} sürüyor</b><small>Bitmesine ${Math.max(0, Math.ceil((sale.end - new Date()) / DAY))} gün · genelde %${sale.typical}'e varan indirim</small>`
    : next ? `<b>${Math.ceil((next.start - new Date()) / DAY)} gün</b><small>${esc(next.name)} başlamasına · genelde %${next.typical}'e varan indirim</small>` : "";
  const stores = [...new Set(act.map((p) => p.store).filter(Boolean))].map((s) => [s, shippingInfo(s)]).filter((x) => x[1]);
  const fakes = act.filter(fakeDiscount);
  const pct = budget ? Math.min(100, spent / budget * 100) : 0;
  $("#view-dash").innerHTML = `
    <div class="tiles">
      <div class="tile"><span>Listenin toplamı</span><b>${money(act.reduce((a, p) => a + price(p), 0))}</b><small>${act.length} ürün takipte</small></div>
      <div class="tile"><span>Şu an indirimde</span><b>${onSale.length} ürün</b><small>${saving >= 1 ? `Şimdi alsan ${money(saving)} cebinde` : "Fiyat düşünce burada"}</small></div>
      <div class="tile"><span>Hedefe ulaşan</span><b>${targets.length ? `${hit.length} / ${targets.length}` : "—"}</b><small>${targets.length ? "Ulaşınca bildirim gelir" : "Üründe “Hedef fiyat”"}</small></div>
      <div class="tile"><span>Aldıklarında tasarruf</span><b>${saved >= 1 ? money(saved) : "—"}</b><small>${bought.length ? `${bought.length} ürün aldın` : "“Aldım” dedikçe birikir"}</small></div>
      <button class="tile budget" data-budget><span>Bu ayki harcama</span><b>${money(spent)}</b>
        ${budget ? `<span class="meter"><i style="width:${pct}%" class="${spent > budget ? "over" : ""}"></i></span><small>${spent > budget ? `Bütçeyi ${money(spent - budget)} aştın` : `${money(budget - spent)} kaldı · bütçe ${money(budget)}`}</small>`
          : `<small>Aylık bütçe koymak için dokun</small>`}</button>
      ${saleLine ? `<div class="tile sale-tile"><span>${sale ? "İndirim dönemi" : "Sonraki büyük indirim"}</span>${saleLine}</div>` : ""}
    </div>
    <button class="chrome-btn wide wrapped-btn" data-wrapped>✦ Wishlist Wrapped ${new Date().getFullYear()}</button>
    ${fakes.length ? `<div class="sec-title">Şüpheli indirimler</div><div class="panel rows">${fakes.slice(0, 5).map((p) => row(p, `<b class="warn">⚠︎</b>`)).join("")}
      <p class="mut" style="font-size:12px;margin:6px 0 0">Fiyat geçmişine göre bu “indirimler” gerçek değil gibi.</p></div>` : ""}
    <div class="sec-title">En iyi fırsatlar</div>
    <div class="panel rows">${deals.length ? deals.map((p) => { const r = refPrice(p), n = currentPrice(p)[0];
      return row(p, `<b>${targetReached(p) ? "🎯 " : ""}${money(n)}</b><br>${r && r > n ? `<span class="old">${money(r)}</span> <b class="ok">−%${Math.round(disc(p) * 100)}</b>` : ""}`); }).join("")
      : `<p class="mut">Şu an indirimde ürün yok.</p>`}</div>
    ${stores.length ? `<div class="sec-title">Kargo bedava sınırı</div><div class="panel rows">${stores.map(([s, i]) =>
      `<div class="row ship"><span class="t"><div>${esc(s)}</div><small>${i.count} ürün · ${money(i.total)} · sınır ${money(i.thr)}</small>
        <span class="meter"><i style="width:${Math.min(100, i.total / i.thr * 100)}%" class="${i.missing ? "" : "full"}"></i></span></span>
        <span class="r">${i.missing ? `<b>${money(i.missing)}</b><br><small class="mut">daha ekle</small>` : `<b class="ok">Kargo<br>bedava ✓</b>`}</span></div>`).join("")}</div>` : ""}
    <div class="sec-title">Son fiyat hareketleri</div>
    <div class="panel rows">${moves.length ? moves.slice(0, 7).map(([t, p, a, b]) =>
      row(p, `<b class="${b < a ? "ok" : "warn"}">${b < a ? "↓" : "↑"} %${Math.round(Math.abs(b - a) / a * 100)}</b><br><small class="mut">${money(a)} → ${money(b)}<br>${niceDate(t)}</small>`)).join("")
      : `<p class="mut">Henüz fiyat değişikliği yok.</p>`}</div>
    ${cats.length ? `<div class="sec-title">Kategorilere göre</div><div class="panel bars">${cats.map(([c, v, n]) =>
      `<button class="bar" data-gocat="${c.id}"><span>${esc(c.name)}</span><span class="track"><i class="fill" style="width:${Math.max(4, v / top * 100) * 0.62}%"></i>${money(v)} · ${n}</span></button>`).join("")}</div>` : ""}
    <p class="mut" style="font-size:12px;margin:16px 4px">Bulut son kontrol: ${meta.last_cloud_check ? niceDate(meta.last_cloud_check) + " " + meta.last_cloud_check.slice(11, 16) : "henüz yok"}${meta.errors ? ` · ${meta.errors} ürün okunamadı (${esc((meta.error_stores || []).join(", "))})` : ""}${meta.rates && meta.rates.USD ? ` · 1$ = ${money(meta.rates.USD)}, 1€ = ${money(meta.rates.EUR)}` : ""}</p>`;
}

/* ------------------------------------------------------------------ rendering: outfits */
const outfits = () => (S.doc.outfits = S.doc.outfits || []);
function outfitStats(o) {
  const ps = o.items.map(product).filter(Boolean);
  const total = ps.reduce((a, p) => a + toTry(currentPrice(p)[0] || 0, currentPrice(p)[1]), 0);
  const ref = ps.reduce((a, p) => a + (refPrice(p) || currentPrice(p)[0] || 0), 0);
  return { ps, total, ref, saved: Math.max(0, ref - total) };
}
function collage(ps) {
  const imgs = ps.map((p) => (p.image_urls || [])[0]).filter(Boolean).slice(0, 4);
  return `<div class="collage n${imgs.length}">${imgs.map((u) => `<img src="${esc(u)}" referrerpolicy="no-referrer" alt="" onerror="this.style.visibility='hidden'">`).join("") || `<span class="none">Boş kombin</span>`}</div>`;
}
function renderOutfits() {
  const list = outfits();
  $("#view-outfits").innerHTML = `<p class="mut" style="margin:2px 4px 12px;font-size:13.5px">Birlikte giyeceğin parçaları bir araya getir; toplam fiyatı ve indirimi hep güncel.</p>
    <div class="grid">${list.map((o) => { const s = outfitStats(o);
      return `<button class="card outfit" data-outfit="${o.id}">${collage(s.ps)}<div class="meta"><div class="ttl" style="min-height:0">${esc(o.name)}</div>
        <div class="store">${s.ps.length} parça</div><div class="prices"><span class="price ${s.saved >= 1 ? "drop" : ""}">${money(s.total)}</span>${s.saved >= 1 ? `<span class="old">${money(s.ref)}</span>` : ""}</div></div></button>`; }).join("")}
      <button class="card new-outfit" data-newoutfit><span>+</span><b>Yeni kombin</b></button></div>`;
}
function newOutfit(withItem) {
  const name = (prompt("Kombinin adı (ör. Düğün, Kış sabahı):") || "").trim(); if (!name) return null;
  const o = { id: newId(), name: name.slice(0, 60), items: withItem ? [withItem] : [], u: Date.now() };
  outfits().push(o); commit(`“${o.name}” kombini oluşturuldu`); return o;
}
function editOutfit(id, fn, msg) { const o = outfits().find((x) => x.id === id); if (!o) return; fn(o); o.u = Date.now(); commit(msg); }
function openOutfit(id) {
  const o = outfits().find((x) => x.id === id); if (!o) return;
  const s = outfitStats(o);
  smallSheet(`<h2>${esc(o.name)}</h2>${collage(s.ps)}
    <div class="d-prices"><span class="d-price ${s.saved >= 1 ? "sale" : ""}">${money(s.total)}</span>${s.saved >= 1 ? `<span class="d-old">${money(s.ref)}</span><span class="d-chip">${money(s.saved)} indirim</span>` : ""}</div>
    <div class="panel rows">${s.ps.map((p) => `<div class="row">${thumb(p)}<span class="t"><div>${esc(p.title)}</div><small>${esc(p.store || "")} · ${money(currentPrice(p)[0], currentPrice(p)[1])}</small></span>
      <span class="r"><button class="mini" data-oopen="${p.id}">Aç</button> <button class="mini danger" data-oremove="${p.id}">Çıkar</button></span></div>`).join("") || `<p class="mut">Henüz parça yok.</p>`}</div>
    <div class="actions" style="margin-top:12px"><button class="act" data-oadd>+ Parça ekle</button><button class="act" data-orename>Adını değiştir</button>
      <button class="act danger" data-odel>Kombini sil</button><button class="act" data-closeadd>Kapat</button></div>`, (e) => {
    const t = e.target.closest("button"); if (!t) return; const d = t.dataset;
    if (d.oopen) { closeSmall(); openDetail(d.oopen); }
    if (d.oremove) { editOutfit(id, (x) => (x.items = x.items.filter((i) => i !== d.oremove))); openOutfit(id); }
    if (d.oadd !== undefined) pickProducts(o.items, (items) => { editOutfit(id, (x) => (x.items = items), "Kombin güncellendi"); openOutfit(id); });
    if (d.orename !== undefined) { const v = (prompt("Kombinin adı:", o.name) || "").trim(); if (v) { editOutfit(id, (x) => (x.name = v.slice(0, 60))); openOutfit(id); } }
    if (d.odel !== undefined && confirm(`“${o.name}” kombini silinsin mi? (Ürünler listende kalır)`)) {
      S.doc.outfits = outfits().filter((x) => x.id !== id); S.doc.deleted = S.doc.deleted || {}; S.doc.deleted[id] = Date.now(); closeSmall(); commit("Kombin silindi"); }
  });
}
function pickProducts(selected, onDone) {
  const sel = new Set(selected);
  const draw = () => smallSheet(`<h2>Parça seç</h2><div class="panel rows pick">${active().map((p) => `<button class="row ${sel.has(p.id) ? "on" : ""}" data-pk="${p.id}">${thumb(p)}
      <span class="t"><div>${esc(p.title)}</div><small>${esc(p.store || "")} · ${money(currentPrice(p)[0], currentPrice(p)[1])}</small></span><span class="r check">${sel.has(p.id) ? "✓" : ""}</span></button>`).join("")}</div>
    <button class="chrome-btn wide" data-pkdone style="margin-top:14px">Tamam (${sel.size})</button>`, (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.pk) { const y = $("#add").scrollTop; sel.has(t.dataset.pk) ? sel.delete(t.dataset.pk) : sel.add(t.dataset.pk); draw(); $("#add").scrollTop = y; }
    if (t.dataset.pkdone !== undefined) onDone([...sel]);
  });
  draw();
}

/* ------------------------------------------------------------------ rendering: settings */
function renderSettings() {
  const cfg = S.cfg || {}, topic = cfg.ntfy_topic || "", pr = prefs();
  const api = `https://api.github.com/repos/${S.repo}/dispatches`;
  const stores = [...new Set(S.doc.products.map((p) => p.store).filter(Boolean))].sort();
  $("#view-settings").innerHTML = `
    <div class="sec-title" style="margin-top:4px">Bağlantı</div>
    <div class="set-group">
      <div class="set-row"><span>Depo</span><span class="v">${esc(S.repo)}</span></div>
      <div class="set-row"><span>Son eşitleme</span><span class="v">${S.lastSync ? ago(S.lastSync) : "—"}</span></div>
      <button class="set-row" id="s-check"><span>Tüm fiyatları şimdi kontrol et<small>Bulutta çalışır, birkaç dakika sürer</small></span><span class="v">›</span></button>
    </div>
    <div class="sec-title">Bildirimler</div>
    <div class="set-group" id="push-box"><div class="set-row mut">Kontrol ediliyor…</div></div>
    <details class="set-group old-ntfy"><summary class="set-row"><span>Eski yöntem: ntfy uygulaması<small>Uygulama bildirimleri açıksa ntfy'a artık gönderilmez</small></span><span class="v">›</span></summary>
      <div class="set-row" style="display:block">
      ${topic ? `<div class="howto"><ol>
        <li>App Store'dan <b>ntfy</b> uygulamasını aç.</li>
        <li><b>+</b> ya da <b>Subscribe to topic</b>'e dokun, aşağıdaki adı yapıştır, <b>Subscribe</b>.</li></ol>
        <div class="copy-box" id="topic">${esc(topic)}</div>
        <button class="act" data-copy="${esc(topic)}" style="width:100%;margin-top:6px">Adı kopyala</button></div>`
        : `<span class="mut">Yükleniyor…</span>`}
    </div></details>
    <div class="sec-title">Tercihler</div>
    <div class="set-group">
      <button class="set-row" data-budget><span>Aylık bütçe<small>Özet'te bu ay ne kadar harcadığını gösterir</small></span><span class="v">${pr.budget ? money(pr.budget) : "Yok"} ›</span></button>
      <button class="set-row" data-weekly><span>Pazar akşamı haftalık özet<small>Bildirim olarak gelir</small></span><span class="v">${pr.weekly === false ? "Kapalı" : "Açık"}</span></button>
    </div>
    <div class="sec-title">Mağazaya göre bedenin</div>
    <div class="set-group">${stores.length ? stores.map((s) => `<button class="set-row" data-sizenote="${esc(s)}"><span>${esc(s)}</span><span class="v">${esc((pr.sizes || {})[s] || "—")} ›</span></button>`).join("")
      : `<div class="set-row mut">Ürün ekledikçe mağazalar burada görünür.</div>`}</div>
    <div class="sec-title">Paylaş menüsüne ekle</div>
    <div class="set-group"><div class="set-row" style="display:block"><div class="howto">
      <p>Trendyol, Zara ya da Safari'de <b>Paylaş › Wishlist'e ekle</b> için bir kere bir Kestirme kur:</p><ol>
      <li><b>Kestirmeler</b> uygulaması › sağ üst <b>+</b> › adını <b>Wishlist'e ekle</b> yap.</li>
      <li>Alttaki <b>ⓘ</b> › <b>Paylaşım Sayfasında Göster</b>'i aç.</li>
      <li>Eylem ekle: <b>URL'nin İçeriğini Al</b>. URL kutusuna şunu yapıştır:
        <div class="copy-box">${esc(api)}</div><button class="act" data-copy="${esc(api)}">URL'yi kopyala</button></li>
      <li>Aynı eylemde <b>Yöntem: POST</b>. <b>Başlıklar</b>'a iki satır ekle:<br>
        <b>Authorization</b> → <button class="act" data-copy="Bearer ${esc(S.token)}" style="display:inline-flex;margin:4px 0">anahtarı kopyala</button><br>
        <b>Accept</b> → <span class="copy-box" style="display:inline-block">application/vnd.github+json</span></li>
      <li><b>İstek Gövdesi: JSON</b>. İki alan ekle:<br>
        <b>event_type</b> (Metin) → <span class="copy-box" style="display:inline-block">add</span><br>
        <b>client_payload</b> (Sözlük) → içine <b>url</b> (Metin) ekle, değerine <b>Kestirme Girdisi</b>'ni seç.</li>
      <li>Bir eylem daha: <b>Bildirim Göster</b> → “Listeye ekleniyor ✓”.</li></ol>
      <p class="mut" style="font-size:12px">Anahtar sadece senin telefonunda ve kestirmende durur.</p></div></div></div>
    <div class="sec-title">Bu telefon</div>
    <div class="set-group">
      <button class="set-row" id="s-token"><span>Anahtarı değiştir</span><span class="v">›</span></button>
      <button class="set-row danger" id="s-logout">Bu telefonda oturumu kapat</button>
    </div>
    <p class="mut" style="font-size:12px;text-align:center">Eren's Wishlist · iPhone</p>`;
  renderPushBox();
}
async function renderPushBox() {
  const st = await pushState(), el = $("#push-box"); if (!el) return;
  const msg = {
    on: `<div class="set-row"><span><b class="ok">● Bu ${deviceName()} bildirim alıyor</b><small>Bildirime dokununca direkt bu uygulama açılır</small></span></div>
      <button class="set-row" data-pushtest><span>Test bildirimi gönder<small>1 dakika içinde gelir</small></span><span class="v">›</span></button>
      <button class="set-row danger" data-pushoff>Bu cihazda bildirimleri kapat</button>`,
    off: `<div class="set-row" style="display:block"><p style="margin:0 0 10px">Fiyat düşünce, hedefe inince, bedenin stoğa girince <b>bu uygulama</b> haber versin. Bildirime dokununca Safari değil direkt uygulama açılır.</p>
      <button class="chrome-btn wide" data-pushon>🔔 Bildirimleri aç</button></div>`,
    safari: `<div class="set-row" style="display:block">Şu an Safari'desin. Bildirimleri açmak için bu sayfayı <b>ana ekrandaki Wishlist</b> uygulamasından aç, Ayarlar › Bildirimler.</div>`,
    denied: `<div class="set-row" style="display:block">Bildirim izni kapalı. <b>iPhone Ayarlar › Bildirimler › Wishlist</b>'ten aç, sonra buraya dön.</div>`,
    unsupported: `<div class="set-row" style="display:block">Bu tarayıcı uygulama bildirimlerini desteklemiyor. iPhone'da iOS 16.4 ve üstü gerekir; aşağıdaki ntfy yöntemi çalışır.</div>`,
  }[st];
  el.innerHTML = msg;
}

/* ------------------------------------------------------------------ detail sheet */
function chartSvg(p) {
  const h = hist(p).map((x) => [new Date(x.t).getTime() || 0, x.price]);
  if (!h.length) return `<p class="mut">Henüz fiyat kaydı yok.</p>`;
  const W = 340, H = 150, L = 8, R = W - 8, T = 22, B = H - 20;
  const ps = h.map((x) => x[1]); let lo = Math.min(...ps), hi = Math.max(...ps);
  const tg = effectiveTarget(p); if (tg) { lo = Math.min(lo, tg); hi = Math.max(hi, tg); }
  if (hi - lo < 0.01) { lo *= 0.9; hi *= 1.1; } const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  const X = (i) => h.length > 1 ? L + (R - L) * i / (h.length - 1) : (L + R) / 2, Y = (v) => B - (v - lo) / (hi - lo) * (B - T);
  let d = `M${X(0)},${Y(h[0][1])}`; if (h.length === 1) d = `M${L},${Y(h[0][1])} L${R},${Y(h[0][1])}`;
  for (let i = 1; i < h.length; i++) d += ` L${X(i)},${Y(h[i - 1][1])} L${X(i)},${Y(h[i][1])}`;
  const first = h[0][1], last = h[h.length - 1][1];
  const col = last < first ? "var(--drop)" : last > first ? "var(--rise)" : "var(--ink)";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Fiyat geçmişi">
    ${tg ? `<line x1="${L}" x2="${R}" y1="${Y(tg)}" y2="${Y(tg)}" stroke="var(--target)" stroke-dasharray="4 4" stroke-width="1.4"/><text x="${R}" y="${Y(tg) - 4}" text-anchor="end" style="fill:var(--target)">hedef ${money(tg)}</text>` : ""}
    <path d="${d} L${h.length > 1 ? X(h.length - 1) : R},${B} L${h.length > 1 ? X(0) : L},${B} Z" fill="${col}" opacity=".1"/>
    <path d="${d}" stroke="${col}" stroke-width="2.2" fill="none"/>
    ${h.map((x, i) => `<circle cx="${h.length > 1 ? X(i) : W / 2}" cy="${Y(x[1])}" r="3.5" fill="${col}"><title>${money(x[1])}</title></circle>`).join("")}
    <text x="${L}" y="${H - 4}">${niceDate(hist(p)[0].t)}</text><text x="${R}" y="${H - 4}" text-anchor="end">${money(last)}</text></svg>`;
}
function openDetail(id) {
  const p = product(id); if (!p) return;
  S.openId = id; location.hash = "p=" + id;
  const el = $("#detail"), [now, cur] = currentPrice(p), lp = listPrice(p), [first] = firstPrice(p), sale = shopDiscount(p);
  const imgs = p.image_urls || [], ps = hist(p).map((h) => h.price), tg = effectiveTarget(p);
  const lines = [];
  if (p.status === "loading") lines.push(`<span class="mut">Bulut sayfayı okuyor… 1-2 dakika</span>`);
  if (p.status === "error" && p.error && !p.bought) lines.push(`<span class="bad">⚠︎ ${esc(p.error)}</span>`);
  if (p.in_stock === true) lines.push(`<span class="ok">● Stokta</span>`);
  if (p.in_stock === false) lines.push(`<span class="bad">● Tükendi — stoğa girince haber vereceğim</span>`);
  if (p.basket_price && !p.bought && p.basket_price < (now || Infinity) - 0.004) lines.push(`<span class="ok">🛒 Sepette ${money(p.basket_price, cur)}</span>`);
  if (cur !== "TRY" && now && (S.doc.meta || {}).rates?.[cur]) lines.push(`<span class="mut">≈ ${money(toTry(now, cur))} (bugünkü kurla)</span>`);
  if (allTimeLow(p)) lines.push(`<span class="ok">★ Şimdiye kadarki en düşük fiyat</span>`);
  if (first && now && Math.abs(first - now) > 0.004) lines.push(`<span class="${now < first ? "ok" : "warn"}">Eklediğinden beri ${now < first ? "↓" : "↑"} %${(Math.abs(now - first) / first * 100).toFixed(1)} (${money(first, cur)} → ${money(now, cur)})</span>`);
  if (tg) lines.push(targetReached(p) ? `<span class="tgt">🎯 Hedefe ulaştı (${money(tg, cur)})</span>`
    : `<span class="tgt">🎯 Hedef ${money(tg, cur)}${p.target_pct && !p.target_price ? ` (%${p.target_pct} düşüş)` : ""}${now ? ` · %${Math.round((now - tg) / now * 100)} daha düşmeli` : ""}</span>`);
  const b = p.bought, verdict = buyOrWait(p), fake = !b && fakeDiscount(p), ship = !b && p.store && shippingInfo(p.store);
  const left = returnDaysLeft(p), sizeNote = (prefs().sizes || {})[p.store];
  const sizes = Array.isArray(p.sizes) ? p.sizes : [];
  el.innerHTML = `<div class="grabber"></div>
    <div class="sheet-head"><button class="icon-btn" data-close aria-label="Kapat"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <button class="icon-btn star-btn" data-favd="${p.id}" aria-label="Favori"><svg viewBox="0 0 24 24" style="${p.favorite ? "fill:#FFB800;stroke:#FFB800" : ""}"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg></button></div>
    <div class="gallery" id="gal">${imgs.length ? imgs.map((u, i) => `<img src="${esc(u)}" data-zoom="${i}" referrerpolicy="no-referrer" alt="" onerror="this.remove()">`).join("") : `<div class="none">Görsel yok</div>`}</div>
    ${imgs.length > 1 ? `<div class="dots">${imgs.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div>` : ""}
    <div class="sheet-pad">
      <div class="d-store">${esc(p.store || "")} · ${esc(pathText(p.category_id))}</div>
      <div class="d-title"><button data-rename="${p.id}">${esc(p.title)} <span class="mut" style="font-size:13px">✎</span></button></div>
      <div class="d-prices">
        <span class="d-price ${lp ? "sale" : ""}">${b && b.price ? money(b.price, cur) : now ? money(now, cur) : "Fiyat yok"}</span>
        ${lp && !b ? `<span class="d-old">${money(lp, cur)}</span><span class="d-chip">%${Math.round(sale)} İNDİRİM</span>` : ""}
      </div>
      <div class="d-lines">${lines.join("")}</div>
      ${fake ? `<div class="panel warn-box">⚠︎ ${esc(fake)}</div>` : ""}
      ${verdict ? `<div class="panel verdict v-${verdict.v}"><span class="pill">${{ al: "AL", bekle: "BEKLE", izle: "İZLE" }[verdict.v]}</span><span>${esc(verdict.t)}</span></div>` : ""}
      ${!b && stillWantDue(p) ? `<div class="panel still"><b>${daysSince(p.added_at)} gündür listende.</b> Hâlâ istiyor musun?
        <div class="actions" style="margin-top:8px"><button class="act" data-keep="${p.id}">Evet, istiyorum</button><button class="act danger" data-del="${p.id}">Hayır, kaldır</button></div></div>` : ""}
      ${b ? `<div class="panel bought-box"><b>✓ ${niceDate(b.at)} tarihinde aldın</b>${b.price ? ` — ${money(b.price, cur)} ödedin` : ""}
        ${b.price && b.ref_price && b.ref_price - b.price >= 1 ? `<div class="ok" style="font-weight:700;margin-top:4px">${money(b.ref_price - b.price, cur)} tasarruf ettin 🎉</div>` : ""}
        ${left !== null ? `<div style="margin-top:6px">↩︎ İade için <b>${left} gün</b> kaldı${now && b.price && now < b.price - 1 ? ` — <b class="bad">şu an ${money(now, cur)}, ${money(b.price - now, cur)} ucuzladı!</b> İade edip yeniden alabilirsin.` : ". Ucuzlarsa haber vereceğim."}</div>` : ""}
        ${left !== null ? `<button class="mini" data-retdays="${p.id}" style="margin-top:8px">İade süresini değiştir</button>` : ""}</div>` : ""}
      <a class="chrome-btn go" href="${esc(p.url)}" target="_blank" rel="noopener">Ürün sayfasına git ↗</a>
      ${sizes.length || sizeNote ? `<div class="panel"><h3>Beden ${p.track_size ? `<span class="mut">· ${esc(p.track_size)} takipte</span>` : ""}</h3>
        ${sizes.length ? `<div class="sizes">${sizes.map((s) => `<button class="size ${s.in_stock === false ? "out" : ""} ${p.track_size && String(p.track_size).toLowerCase() === String(s.name).toLowerCase() ? "on" : ""}" data-size="${esc(s.name)}">${esc(s.name)}</button>`).join("")}</div>
        <p class="mut" style="font-size:12px;margin:8px 0 0">Bedenine dokun: tükenmişse stoğa girince haber veririm.</p>` : ""}
        ${sizeNote ? `<p style="font-size:13px;margin:8px 0 0">📏 ${esc(p.store)}'da bedenin: <b>${esc(sizeNote)}</b></p>` : ""}</div>` : ""}
      ${ship ? `<div class="panel ship-box">🚚 ${esc(p.store)}: ${money(ship.thr)} üzeri kargo bedava. ${ship.missing ? `Listendeki ${ship.count} ürün ${money(ship.total)}; <b>${money(ship.missing)}</b> daha eklersen kargo bedava.` : `Listendeki ürünlerle sınırı geçiyorsun ✓`}</div>` : ""}
      ${!b ? `<div class="prio-row">${PRIORITIES.map(([k, t]) => `<button class="seg ${p.priority === k ? "on" : ""}" data-prio="${k}">${t}</button>`).join("")}</div>` : ""}
      <div class="actions">
        <button class="act" data-target="${p.id}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>${tg ? "Hedefi değiştir" : "Hedef fiyat"}</button>
        <button class="act" data-move="${p.id}"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4.5l2 2.2H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>Kategori</button>
        <button class="act" data-check="${p.id}"><svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4.5V8h-3.5"/></svg>Fiyatı kontrol et</button>
        ${b ? `<button class="act" data-unbuy="${p.id}">Listeye geri al</button>` : `<button class="act" data-buy="${p.id}"><svg viewBox="0 0 24 24"><rect x="4.5" y="8" width="15" height="12" rx="2.5"/><path d="M8.5 12V7.5a3.5 3.5 0 0 1 7 0V12M9 14.2l2.2 2.2 4.3-4.4"/></svg>Aldım</button>`}
        <button class="act" data-manual="${p.id}"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>Fiyatı elle gir</button>
        <button class="act" data-vs="${p.id}"><svg viewBox="0 0 24 24"><path d="M4 6h7v12H4zM13 6h7v12h-7z"/></svg>Karşılaştır</button>
        <button class="act" data-tooutfit="${p.id}"><svg viewBox="0 0 24 24"><path d="M8 4l4 2 4-2 4 4-3 3v9H7v-9L4 8z"/></svg>Kombine ekle</button>
        <button class="act" data-compare="${p.id}"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>Başka yerde ara</button>
        <button class="act danger" data-del="${p.id}" style="grid-column:1/-1"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7l.5-2.5h5L15 7M6 7l1 13h10l1-13"/></svg>Kaldır</button>
      </div>
      <div class="panel"><h3>Fiyat geçmişi</h3>${chartSvg(p)}
        <div class="stats" style="margin-top:8px">
          <div><b>${money(first, cur)}</b><span>Eklediğinde</span></div>
          <div><b>${ps.length ? money(Math.min(...ps), cur) : "—"}</b><span>En düşük</span></div>
          <div><b>${ps.length ? money(Math.max(...ps), cur) : "—"}</b><span>En yüksek</span></div>
          <div><b>${niceDate(p.added_at)}</b><span>Eklenme</span></div>
          <div><b>${p.last_checked ? niceDate(p.last_checked) : "—"}</b><span>Son kontrol</span></div>
          <div><b>${p.in_stock === false ? "Tükendi" : p.in_stock ? "Var" : "—"}</b><span>Stok</span></div>
        </div></div>
      <div class="panel"><h3>Notlar</h3><textarea class="field" id="notes" placeholder="Beden, renk, hatırlatma…">${esc(p.notes || "")}</textarea></div>
    </div>`;
  el.hidden = false; $("#scrim").hidden = false; el.scrollTop = 0;
  const gal = $("#gal");
  gal.addEventListener("scroll", () => { const i = Math.round(gal.scrollLeft / gal.clientWidth); el.querySelectorAll(".dots i").forEach((d, k) => d.classList.toggle("on", k === i)); }, { passive: true });
  gal.addEventListener("click", (e) => { const im = e.target.closest("img[data-zoom]"); if (im) lightbox(imgs, +im.dataset.zoom); });
  $("#notes").addEventListener("change", (e) => edit(p.id, (x) => (x.notes = e.target.value), "Not kaydedildi"));
}
function lightbox(urls, start = 0) {
  const lb = document.createElement("div"); lb.className = "lightbox";
  lb.innerHTML = `<button class="icon-btn lb-close" aria-label="Kapat"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <div class="lb-track">${urls.map((u) => `<div class="lb-cell"><img src="${esc(u)}" referrerpolicy="no-referrer" alt=""></div>`).join("")}</div>`;
  document.body.appendChild(lb);
  const tr = $(".lb-track", lb); requestAnimationFrame(() => (tr.scrollLeft = start * tr.clientWidth));
  lb.addEventListener("click", (e) => { if (e.target.closest(".lb-close") || !e.target.closest("img")) lb.remove(); });
}
function compareSheet(a, b) {
  const col = (p) => { const [n, c] = currentPrice(p), ps = hist(p).map((h) => h.price), v = buyOrWait(p), [f] = firstPrice(p);
    return { img: thumb(p, "vs-img"), title: esc(p.title), store: esc(p.store || "—"), price: n ? money(n, c) : "—", n: n ? toTry(n, c) : null,
      old: listPrice(p) ? money(listPrice(p), c) : "—", low: ps.length ? money(Math.min(...ps), c) : "—",
      change: f && n ? `${n < f ? "↓" : n > f ? "↑" : ""} %${Math.round(Math.abs(n - f) / f * 100)}` : "—",
      stock: p.in_stock === false ? "Tükendi" : p.in_stock ? "Var" : "—", ship: p.free_ship_over ? `${money(p.free_ship_over)} üzeri` : "—",
      verdict: v ? { al: "AL", bekle: "BEKLE", izle: "İZLE" }[v.v] : "—", fake: fakeDiscount(p) ? "Şüpheli" : "Temiz" }; };
  const A = col(a), B = col(b), win = A.n && B.n ? (A.n < B.n ? 0 : B.n < A.n ? 1 : -1) : -1;
  const rows = [["Fiyat", "price"], ["Mağaza fiyatı", "old"], ["En düşük", "low"], ["Eklenmeden beri", "change"], ["Stok", "stock"], ["Kargo bedava", "ship"], ["İndirim", "fake"], ["Tavsiye", "verdict"]];
  smallSheet(`<h2>Karşılaştır</h2><div class="vs">
      <div class="vs-col ${win === 0 ? "win" : ""}">${A.img}<b>${A.title}</b><small>${A.store}</small></div>
      <div class="vs-col ${win === 1 ? "win" : ""}">${B.img}<b>${B.title}</b><small>${B.store}</small></div></div>
    <div class="panel vs-table">${rows.map(([l, k]) => `<div class="vs-row"><span>${A[k]}</span><small>${l}</small><span>${B[k]}</span></div>`).join("")}</div>
    ${win >= 0 ? `<p class="ok" style="font-weight:700;text-align:center">${[A, B][win].title.slice(0, 40)} ${money(Math.abs(A.n - B.n))} daha ucuz</p>` : ""}
    <button class="act wide" data-closeadd style="margin-top:8px">Kapat</button>`);
}
function chooseProduct(title, exclude, onPick) {
  smallSheet(`<h2>${esc(title)}</h2><div class="panel rows">${active().filter((p) => p.id !== exclude).map((p) => `<button class="row" data-choose="${p.id}">${thumb(p)}
    <span class="t"><div>${esc(p.title)}</div><small>${esc(p.store || "")} · ${money(currentPrice(p)[0], currentPrice(p)[1])}</small></span></button>`).join("") || `<p class="mut">Başka ürün yok.</p>`}</div>
    <button class="act wide" data-closeadd style="margin-top:8px">Vazgeç</button>`, (e) => { const t = e.target.closest("[data-choose]"); if (t) onPick(product(t.dataset.choose)); });
}
function reviewSheet() {
  const due = active().filter(stillWantDue);
  if (!due.length) { closeSmall(); toast("Hepsini gözden geçirdin 👍"); return; }
  smallSheet(`<h2>Hâlâ istiyor musun?</h2><p class="mut" style="margin-top:-6px;font-size:13px">30 günü geçen ürünler. İstemediklerini kaldırmak listeyi hafifletir.</p>
    <div class="panel rows">${due.map((p) => `<div class="row">${thumb(p)}<span class="t"><div>${esc(p.title)}</div><small>${daysSince(p.added_at)} gün · ${money(currentPrice(p)[0], currentPrice(p)[1])}</small></span>
      <span class="r"><button class="mini" data-rkeep="${p.id}">İstiyorum</button><br><button class="mini danger" data-rdrop="${p.id}" style="margin-top:4px">Kaldır</button></span></div>`).join("")}</div>
    <button class="act wide" data-closeadd style="margin-top:8px">Sonra</button>`, (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.rkeep) { edit(t.dataset.rkeep, (x) => (x.still_want_at = nowIso())); reviewSheet(); }
    if (t.dataset.rdrop) { const i = S.doc.products.findIndex((x) => x.id === t.dataset.rdrop); if (i >= 0) { S.doc.products.splice(i, 1); S.doc.deleted = S.doc.deleted || {}; S.doc.deleted[t.dataset.rdrop] = Date.now(); commit(); } reviewSheet(); }
  });
}
function categoryMenu(id) {
  const c = cat(id); if (!c) return;
  smallSheet(`<h2>📁 ${esc(c.name)}</h2><div class="set-group">
      <button class="set-row" data-crename><span>Adını değiştir</span><span class="v">›</span></button>
      <button class="set-row" data-cmove><span>Başka kategorinin içine taşı</span><span class="v">${esc(path(c.parent_id).map((x) => x.name).join(" › ") || "En üstte")} ›</span></button>
      <button class="set-row danger" data-cdel>Kategoriyi sil<small style="color:var(--muted);font-weight:400">Ürünler ve alt kategoriler bir üste taşınır</small></button>
    </div><button class="act wide" data-closeadd>Kapat</button>`, (e) => {
    const t = e.target.closest("button"); if (!t) return; const d = t.dataset, touch = (x) => (x.u = Date.now());
    if (d.crename !== undefined) { const v = (prompt("Kategori adı:", c.name) || "").trim(); if (v) { c.name = v.slice(0, 60); touch(c); commit("Kategori adı değişti"); categoryMenu(id); } }
    if (d.cmove !== undefined) categoryPicker(c.parent_id, (pid) => {
      if (pid && descendants(id).has(pid)) { toast("Kendi içine taşıyamazsın"); return; }
      c.parent_id = pid; touch(c); commit(`→ ${pid ? pathText(pid) : "En üst"}`); }, "Nereye taşıyalım?");
    if (d.cdel !== undefined && confirm(`“${c.name}” silinsin mi? İçindeki ürünler silinmez, bir üst kategoriye geçer.`)) {
      const up = c.parent_id || null, t0 = Date.now();
      for (const p of S.doc.products) if (p.category_id === id) { p.category_id = up; p.u = t0; }
      for (const k of S.doc.categories) if (k.parent_id === id) { k.parent_id = up; k.u = t0; }
      S.doc.categories = S.doc.categories.filter((k) => k.id !== id); S.doc.deleted = S.doc.deleted || {}; S.doc.deleted[id] = t0;
      S.view.cat = up; closeSmall(); commit("Kategori silindi");
    }
  });
}

/* ------------------------------------------------------------------ Wishlist Wrapped */
async function wrapped() {
  const y = new Date().getFullYear(), yr = String(y), all = S.doc.products;
  const added = all.filter((p) => String(p.added_at).startsWith(yr)), bought = all.filter((p) => p.bought && String(p.bought.at).startsWith(yr));
  const paid = bought.reduce((a, p) => a + (p.bought.price || 0), 0);
  const saved = bought.reduce((a, p) => a + Math.max(0, (p.bought.ref_price || 0) - (p.bought.price || 0)), 0);
  const count = (arr) => { const m = {}; for (const x of arr) if (x) m[x] = (m[x] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1])[0]; };
  const topStore = count(added.map((p) => p.store)), topCat = count(added.map((p) => p.category_id && path(p.category_id)[0]?.name));
  let drop = null; for (const p of all) { const [f] = firstPrice(p), [n] = currentPrice(p); if (f && n && n < f) { const r = (f - n) / f; if (!drop || r > drop[1]) drop = [p, r]; } }
  const checks = all.reduce((a, p) => a + hist(p).length, 0);
  const W = 1080, H = 1920, c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
  try { await document.fonts.load("800 80px Unbounded"); await document.fonts.load("600 40px Unbounded"); } catch {}
  g.fillStyle = "#0B0B0C"; g.fillRect(0, 0, W, H);
  const img = g.createImageData(W, H); for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 40; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 60; }
  const noise = document.createElement("canvas"); noise.width = W; noise.height = H; noise.getContext("2d").putImageData(img, 0, 0); g.drawImage(noise, 0, 0);
  const chrome = (y0, y1) => { const gr = g.createLinearGradient(0, y0, 0, y1); [["0", "#FFFFFF"], [".25", "#C9CBD1"], [".48", "#6E7078"], [".58", "#2A2B30"], [".78", "#9C9EA6"], ["1", "#F2F3F5"]].forEach(([o, col]) => gr.addColorStop(+o, col)); return gr; };
  const logo = new Image(); logo.src = "icon-512.png"; await new Promise((r) => { logo.onload = r; logo.onerror = r; });
  if (logo.naturalWidth) { g.save(); g.beginPath(); g.roundRect(90, 110, 150, 150, 34); g.clip(); g.drawImage(logo, 90, 110, 150, 150); g.restore(); }
  g.fillStyle = "#9C9CA4"; g.font = "600 34px Unbounded, sans-serif"; g.fillText("ERENS WISHLIST", 270, 175); g.fillText("WRAPPED", 270, 225);
  g.font = "800 230px Unbounded, sans-serif"; g.fillStyle = chrome(330, 560); g.fillText(yr, 80, 540);
  const stat = (yy, big, small) => { g.font = "800 92px Unbounded, sans-serif"; g.fillStyle = chrome(yy - 90, yy + 10); g.fillText(big, 90, yy);
    g.font = "500 38px -apple-system, system-ui, sans-serif"; g.fillStyle = "#C9CBD1"; g.fillText(small, 92, yy + 58); };
  let yy = 760;
  stat(yy, String(added.length), "ürünü listene ekledin"); yy += 210;
  stat(yy, String(bought.length), `tanesini aldın${paid ? ` · ${money(paid)}` : ""}`); yy += 210;
  stat(yy, saved >= 1 ? money(saved) : "₺0", "indirimi bekleyerek cebinde kaldı"); yy += 210;
  if (topStore) { stat(yy, topStore[0].length > 14 ? topStore[0].slice(0, 13) + "…" : topStore[0], `favori mağazan · ${topStore[1]} ürün`); yy += 210; }
  if (drop) { stat(yy, `−%${Math.round(drop[1] * 100)}`, `en büyük düşüş: ${drop[0].title.slice(0, 34)}`); yy += 210; }
  else if (topCat) { stat(yy, topCat[0].slice(0, 14), "en çok eklediğin kategori"); yy += 210; }
  g.font = "500 30px -apple-system, system-ui, sans-serif"; g.fillStyle = "#6B6B72"; g.fillText(`${checks} fiyat kaydı · bulut her saat baktı`, 92, H - 110);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const file = new File([blob], `wishlist-wrapped-${yr}.png`, { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: `Wishlist Wrapped ${yr}` }); return; } catch (e) { if (e.name === "AbortError") return; } }
  const url = URL.createObjectURL(blob);
  smallSheet(`<h2>Wrapped ${yr}</h2><img src="${url}" class="wrapped-img" alt="Wishlist Wrapped"><p class="mut" style="font-size:12.5px">Resme basılı tut › Fotoğraflara Kaydet.</p>
    <a class="chrome-btn wide go" href="${url}" download="wishlist-wrapped-${yr}.png">İndir</a><button class="act wide" data-closeadd>Kapat</button>`);
}

function closeSheets() {
  $("#detail").hidden = true; $("#add").hidden = true; $("#scrim").hidden = true; S.openId = null;
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}
function categoryPicker(current, onPick, title) {
  const el = $("#add");
  const rows = []; const walk = (pid, depth) => { for (const c of children(pid)) { rows.push([c, depth]); walk(c.id, depth + 1); } }; walk(null, 0);
  el.innerHTML = `<div class="grabber"></div><div class="sheet-pad"><h2>${esc(title || "Kategori seç")}</h2>
    <div class="set-group">
      <button class="set-row" data-pick=""><span>Kategorisiz</span><span class="v">${!current ? "✓" : ""}</span></button>
      ${rows.map(([c, d]) => `<button class="set-row" data-pick="${c.id}" style="padding-left:${15 + d * 18}px"><span>📁 ${esc(c.name)}</span><span class="v">${current === c.id ? "✓" : ""}</span></button>`).join("")}
      <button class="set-row" data-pick="__new"><span>+ Yeni kategori</span></button>
    </div><button class="act wide" data-closeadd style="margin-top:6px">Vazgeç</button></div>`;
  el.hidden = false; $("#scrim").hidden = false;
  el.onclick = (e) => {
    const b = e.target.closest("[data-pick]"); if (e.target.closest("[data-closeadd]")) { el.hidden = true; if ($("#detail").hidden) $("#scrim").hidden = true; return; }
    if (!b) return; let id = b.dataset.pick;
    if (id === "__new") { id = newCategory(current || null); if (!id) return; }
    el.hidden = true; if ($("#detail").hidden) $("#scrim").hidden = true; onPick(id || null);
  };
}
function openAdd(prefill = "") {
  const el = $("#add"); let chosen = S.view.cat || null;
  el.innerHTML = `<div class="grabber"></div><div class="sheet-pad"><h2>Ürün ekle</h2>
    <label class="field-label" for="add-url">Ürün linki <span style="text-transform:none;font-weight:500">— birden fazla link de yapıştırabilirsin</span></label>
    <textarea id="add-url" class="field url-box" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…">${esc(prefill)}</textarea>
    <div class="actions" style="margin-top:8px"><button class="act" id="paste-btn">Panodan yapıştır</button>
      <a class="act" href="https://lens.google.com/" target="_blank" rel="noopener" style="text-decoration:none">📷 Fotoğraftan bul</a></div>
    <label class="field-label">Kategori</label>
    <button class="act wide" id="add-cat" style="justify-content:flex-start">📁 <span>${esc(pathText(chosen))}</span></button>
    <button class="chrome-btn wide" id="add-go" style="margin-top:18px">Listeye ekle</button>
    <p class="mut" style="font-size:12.5px;margin-top:12px">İpucu: Mağaza uygulamasında <b>Paylaş › Wishlist'e ekle</b> daha hızlı. Kurulumu Ayarlar'da.
      Sokakta beğendiğin bir şeyin fotoğrafını Google Lens'le arayıp linkini buraya atabilirsin.</p></div>`;
  el.hidden = false; $("#scrim").hidden = false; el.onclick = null;
  $("#paste-btn").onclick = async () => { try { const t = (await navigator.clipboard.readText()).trim(); const f = $("#add-url"); f.value = f.value.trim() ? f.value.trim() + "\n" + t : t; } catch { toast("Pano okunamadı — linki elle yapıştır"); } };
  $("#add-cat").onclick = () => categoryPicker(chosen, (id) => { chosen = id; openAdd($("#add-url")?.value || prefill); }, "Hangi kategoriye?");
  $("#add-go").onclick = () => {
    const urls = [...new Set(($("#add-url").value.match(/https?:\/\/[^\s<>"']+/gi) || []))];
    if (urls.length <= 1) { if (addLink($("#add-url").value, chosen)) closeSheets(); return; }
    let n = 0; for (const u of urls) { const before = S.doc.products.length; addLink(u, chosen, true); if (S.doc.products.length > before) n++; }
    closeSheets(); toast(n ? `${n} ürün ekleniyor… 1-2 dakikada gelir` : "Hepsi zaten listende");
  };
  setTimeout(() => { if (!prefill) $("#add-url").focus(); }, 250);
}

/* ------------------------------------------------------------------ confetti 🎉 */
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas"); c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
  Object.assign(c.style, { position: "fixed", inset: 0, width: "100vw", height: "100vh", zIndex: 30, pointerEvents: "none" });
  document.body.appendChild(c); const g = c.getContext("2d"); g.scale(devicePixelRatio, devicePixelRatio);
  const cols = ["#FF375F", "#FF9F0A", "#FFD60A", "#30D158", "#0A84FF", "#BF5AF2", "#C9CBD1"];
  const parts = Array.from({ length: 140 }, () => { const left = Math.random() < .5, a = left ? -1.2 + Math.random() * .8 : -2.8 + Math.random() * .8, s = 9 + Math.random() * 9;
    return { x: innerWidth * (left ? .15 : .85), y: innerHeight * .7, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: Math.random() * 6, vr: (Math.random() - .5) * .4,
      w: 6 + Math.random() * 5, h: 10 + Math.random() * 6, c: cols[(Math.random() * cols.length) | 0] }; });
  let f = 0; (function tick() { g.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) { p.vy += .36; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr; g.save(); g.translate(p.x, p.y); g.rotate(p.r);
      g.globalAlpha = Math.max(0, 1 - f / 140); g.fillStyle = p.c; g.fillRect(-p.w / 2 * Math.abs(Math.cos(p.r * 2)), -p.h / 2, p.w * Math.abs(Math.cos(p.r * 2)) + 1, p.h); g.restore(); }
    if (++f < 150) requestAnimationFrame(tick); else c.remove(); })();
}

/* ------------------------------------------------------------------ events */
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, [role=button], a"); if (!t) return;
  const d = t.dataset;
  if (d.fav) { e.stopPropagation(); edit(d.fav, (p) => (p.favorite = !p.favorite)); return; }
  if (d.open) { openDetail(d.open); return; }
  if (d.filter) { S.view.filter = d.filter; lsSet(LS.view, S.view); render(); scrollTo(0, 0); return; }
  if (d.cat !== undefined && t.closest("#cats, #crumbs")) { S.view.cat = d.cat || null; lsSet(LS.view, S.view); render(); return; }
  if (d.newcat !== undefined) { const id = newCategory(d.newcat || null); if (id) { S.view.cat = id; render(); } return; }
  if (d.gocat !== undefined) { S.view.cat = d.gocat || null; S.view.filter = "all"; switchTab("list"); return; }
  if (d.tab) { switchTab(d.tab); return; }
  if (d.close !== undefined) { closeSheets(); return; }
  if (d.favd) { edit(d.favd, (p) => (p.favorite = !p.favorite)); openDetail(d.favd); return; }
  if (d.rename) { const p = product(d.rename); const v = prompt("Ürün adı:", p.title); if (v && v.trim()) { edit(p.id, (x) => (x.title = v.trim().slice(0, 300))); openDetail(p.id); } return; }
  if (d.target) { const p = product(d.target), [n] = currentPrice(p);
    const start = p.target_pct && !p.target_price ? `%${p.target_pct}` : p.target_price ? String(p.target_price).replace(".", ",") : n ? String(Math.round(n * 0.85)) : "";
    const raw = prompt("Hedef fiyat (₺) ya da yüzde (ör. %20 düşünce). Kaldırmak için 0:", start); if (raw === null) return;
    if (/%/.test(raw)) { const pct = Math.min(90, Math.max(0, parseFloat(raw.replace(",", ".").replace(/[^\d.]/g, "")) || 0));
      edit(p.id, (x) => { x.target_pct = pct || null; x.target_price = null; }, pct ? `%${pct} düşünce haber vereceğim` : "Hedef kaldırıldı"); openDetail(p.id); return; }
    const v = parseFloat(raw.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, "")) || 0;
    edit(p.id, (x) => { x.target_price = v > 0 ? v : null; x.target_pct = null; },
      v > 0 ? (n && n <= v ? "Zaten hedefin altında 🎯" : `Hedef ${money(v)} — inince haber vereceğim`) : "Hedef kaldırıldı"); openDetail(p.id); return; }
  if (d.move) { const p = product(d.move); categoryPicker(p.category_id, (id) => { edit(p.id, (x) => (x.category_id = id), `→ ${pathText(id)}`); openDetail(p.id); }); return; }
  if (d.check) { checkNow([d.check]); return; }
  if (d.buy) { const p = product(d.buy), [n] = currentPrice(p); const v = askNumber("Kaça aldın? (₺)", n); if (v === undefined) return;
    const ref = refPrice(p); edit(p.id, (x) => (x.bought = { at: nowIso(), price: v || null, ref_price: ref }));
    confetti(); const bud = prefs().budget, sp = spentThisMonth();
    toast(bud && sp > bud ? `Hayırlı olsun! Bu ay bütçeyi ${money(sp - bud)} aştın 👀` : ref && v && ref - v >= 1 ? `Hayırlı olsun! ${money(ref - v)} tasarruf ettin 🎉` : "Hayırlı olsun! 🎉"); openDetail(p.id); return; }
  if (d.unbuy) { edit(d.unbuy, (x) => (x.bought = null), "Tekrar takip listende"); openDetail(d.unbuy); return; }
  if (d.del) { removeProduct(d.del); return; }
  if (d.compare) { const p = product(d.compare), q = encodeURIComponent(p.title.slice(0, 90)); const el = $("#add");
    el.innerHTML = `<div class="grabber"></div><div class="sheet-pad"><h2>Başka yerde ara</h2><div class="set-group">${[["Akakçe", `https://www.akakce.com/arama/?q=${q}`], ["Cimri", `https://www.cimri.com/arama?q=${q}`],
      ["Google Alışveriş", `https://www.google.com/search?tbm=shop&q=${q}`], ["Trendyol", `https://www.trendyol.com/sr?q=${q}`]].map(([n, u]) => `<a class="set-row" href="${u}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${n}<span class="v">↗</span></a>`).join("")}</div>
      <button class="act wide" data-closeadd>Vazgeç</button></div>`;
    el.hidden = false; el.onclick = (ev) => { if (ev.target.closest("[data-closeadd]")) el.hidden = true; }; return; }
  if (d.prio) { const p = product(S.openId); if (p) { edit(p.id, (x) => (x.priority = x.priority === d.prio ? null : d.prio)); } return; }
  if (d.size) { const p = product(S.openId); if (!p) return; const same = p.track_size && p.track_size.toLowerCase() === d.size.toLowerCase();
    const s = (p.sizes || []).find((x) => x.name === d.size);
    edit(p.id, (x) => (x.track_size = same ? null : d.size), same ? "Beden takibi kapandı" : s && s.in_stock === false ? `${d.size} stoğa girince haber vereceğim` : `${d.size} bedenin kaydedildi`); return; }
  if (d.keep) { edit(d.keep, (x) => (x.still_want_at = nowIso()), "Tamam, 30 gün sonra tekrar sorarım"); return; }
  if (d.manual) { const p = product(d.manual), [n, c] = currentPrice(p);
    const v = askNumber("Mağazada gördüğün fiyat (₺):", n); if (!v) return;
    const t = Date.now(); p.price_history = p.price_history || []; p.price_history.push({ t: nowIso(), price: v, currency: c || "TRY", manual: true });
    p.last_checked = nowIso(); if (p.status !== "ok") { p.status = "ok"; p.error = ""; } p.c = t; edit(p.id, () => {}, `Fiyat ${money(v)} olarak kaydedildi`); return; }
  if (d.retdays) { const p = product(d.retdays); const v = askNumber("Bu mağazada kaç gün içinde iade edebiliyorsun?", p.return_days || RETURN_DAYS[p.store] || 14);
    if (v) edit(p.id, (x) => (x.return_days = Math.round(v)), "İade süresi güncellendi"); return; }
  if (d.vs) { const a = product(d.vs); chooseProduct("Neyle karşılaştıralım?", a.id, (b) => compareSheet(a, b)); return; }
  if (d.tooutfit) { const pid = d.tooutfit;
    smallSheet(`<h2>Kombine ekle</h2><div class="set-group">${outfits().map((o) => `<button class="set-row" data-pickoutfit="${o.id}"><span>${esc(o.name)}</span><span class="v">${o.items.includes(pid) ? "✓" : `${o.items.length} parça`}</span></button>`).join("")}
      <button class="set-row" data-pickoutfit="__new"><span>+ Yeni kombin</span></button></div><button class="act wide" data-closeadd>Vazgeç</button>`, (e) => {
      const t = e.target.closest("[data-pickoutfit]"); if (!t) return; closeSmall();
      if (t.dataset.pickoutfit === "__new") { newOutfit(pid); return; }
      editOutfit(t.dataset.pickoutfit, (o) => { if (!o.items.includes(pid)) o.items.push(pid); }, "Kombine eklendi"); });
    return; }
  if (d.outfit) { openOutfit(d.outfit); return; }
  if (d.newoutfit !== undefined) { const o = newOutfit(); if (o) pickProducts([], (items) => { editOutfit(o.id, (x) => (x.items = items)); openOutfit(o.id); }); return; }
  if (d.sortmenu !== undefined) { const cur = S.view.sort || "";
    smallSheet(`<h2>Sırala</h2><div class="set-group">${SORTS.map(([k, t]) => `<button class="set-row" data-sort="${k}"><span>${t}</span><span class="v">${cur === k ? "✓" : ""}</span></button>`).join("")}</div>
      <button class="act wide" data-closeadd>Kapat</button>`, (e) => { const t = e.target.closest("[data-sort]"); if (!t) return;
      S.view.sort = t.dataset.sort; lsSet(LS.view, S.view); closeSmall(); renderList(); }); return; }
  if (d.board !== undefined) { S.view.board = !S.view.board; lsSet(LS.view, S.view); renderList(); return; }
  if (d.catmenu) { categoryMenu(d.catmenu); return; }
  if (d.review !== undefined) { reviewSheet(); return; }
  if (d.dismissreview !== undefined) { S.dismissedReview = true; renderList(); return; }
  if (d.budget !== undefined) { const v = askNumber("Aylık alışveriş bütçen (₺). Kaldırmak için 0:", prefs().budget || ""); if (v === undefined) return;
    setPref((x) => (x.budget = v > 0 ? v : null), v > 0 ? `Bütçe ${money(v)}` : "Bütçe kaldırıldı"); return; }
  if (d.weekly !== undefined) { setPref((x) => (x.weekly = x.weekly === false), prefs().weekly === false ? "Haftalık özet kapandı" : "Haftalık özet açık"); return; }
  if (d.sizenote) { const st = d.sizenote, cur = (prefs().sizes || {})[st] || "";
    const v = prompt(`${st}'da hangi bedeni giyiyorsun? (ör. M, 32/32, 43)`, cur); if (v === null) return;
    setPref((x) => { x.sizes = x.sizes || {}; if (v.trim()) x.sizes[st] = v.trim().slice(0, 30); else delete x.sizes[st]; }, "Kaydedildi"); return; }
  if (d.wrapped !== undefined) { toast("Hazırlanıyor…"); wrapped().catch(() => toast("Resim oluşturulamadı")); return; }
  if (d.pushon !== undefined) { t.disabled = true; t.textContent = "Açılıyor…"; enablePush(); return; }
  if (d.pushoff !== undefined) { disablePush(); return; }
  if (d.pushtest !== undefined) { dispatch("push_test", {}).then(() => toast("Gönderildi, 1 dakika içinde gelir"), () => toast("Gönderilemedi — internet?")); return; }
  if (d.copy !== undefined) { navigator.clipboard.writeText(d.copy).then(() => toast("Kopyalandı"), () => toast("Kopyalanamadı — basılı tutup kopyala")); return; }
});
$("#scrim").addEventListener("click", closeSheets);
$("#fab").addEventListener("click", () => openAdd());
$("#refresh-btn").addEventListener("click", () => sync({ manual: true }));
$("#search").addEventListener("input", (e) => { S.view.q = e.target.value; renderList(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });
window.addEventListener("hashchange", () => { const m = location.hash.match(/p=([\w-]+)/); if (m && m[1] !== S.openId) openDetail(m[1]); if (!m && S.openId) closeSheets(); });
document.addEventListener("click", (e) => {
  if (e.target.closest("#s-check")) checkNow();
  if (e.target.closest("#s-token")) showSetup();
  if (e.target.closest("#s-logout") && confirm("Bu telefondaki anahtar ve listenin kopyası silinsin mi? (GitHub'daki listen kalır)")) {
    for (const k of Object.values(LS)) localStorage.removeItem(k); location.reload(); }
});

function switchTab(tab) {
  S.view.tab = tab; lsSet(LS.view, S.view);
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  render(); scrollTo(0, 0);
}

/* ------------------------------------------------------------------ top-level render */
function renderSync() {
  const el = $("#sync-line"), loading = S.doc.products.filter((p) => p.status === "loading").length;
  $("#refresh-btn").classList.toggle("spin", S.syncing);
  el.classList.toggle("bad", !!S.error);
  el.textContent = S.error || (S.syncing ? "Eşitleniyor…" : loading ? `${loading} ürün bulutta okunuyor…`
    : S.outbox.length ? "Bulut kontrolü sırada…" : S.lastSync ? `Güncel · ${ago(S.lastSync)}` : "");
}
function render() {
  if (!S.token) return;
  const tab = S.view.tab;
  for (const v of ["list", "dash", "outfits", "settings"]) $("#view-" + v).hidden = tab !== v;
  $("#fab").hidden = tab !== "list";
  if (tab === "list") renderList(); else if (tab === "dash") renderDash(); else if (tab === "outfits") renderOutfits(); else renderSettings();
  renderSync();
  if (S.openId && !$("#detail").hidden) { const y = $("#detail").scrollTop; openDetail(S.openId); $("#detail").scrollTop = y; }
}

/* ------------------------------------------------------------------ setup / start */
function showSetup() {
  $("#app").hidden = true; $("#setup").hidden = false;
  const owner = (S.repo || DEFAULT_REPO).split("/")[0];
  $("#token-link").href = "https://github.com/settings/personal-access-tokens/new?" + new URLSearchParams({
    name: "Wishlist iPhone", description: "Wishlist uygulaması: wishlist-veri deposunu okur/yazar ve fiyat kontrolünü başlatır.",
    target_name: owner, expires_in: "none", contents: "write", actions: "write" });
  $("#token-input").value = S.token || ""; $("#repo-input").value = S.repo || DEFAULT_REPO;
}
$("#connect-btn").addEventListener("click", async () => {
  const token = $("#token-input").value.trim(), repo = $("#repo-input").value.trim().replace(/^https?:\/\/github.com\//, "").replace(/\/+$/, "");
  const err = $("#setup-error"); err.hidden = true;
  if (!token) { err.textContent = "Önce anahtarı yapıştır."; err.hidden = false; return; }
  const btn = $("#connect-btn"); btn.textContent = "Bağlanıyor…"; btn.disabled = true;
  const prev = [S.token, S.repo]; S.token = token; S.repo = repo || DEFAULT_REPO;
  try {
    await gh("");  // can we see the repo?
    lsSet(LS.token, S.token); lsSet(LS.repo, S.repo);
    $("#setup").hidden = true; $("#app").hidden = false; render(); await sync({ manual: true });
    toast("Bağlandı ✓");
  } catch (e) {
    [S.token, S.repo] = prev;
    err.textContent = e.status === 401 ? "Bu anahtar geçersiz. Tamamını kopyaladığından emin ol."
      : e.status === 404 ? "Depo görünmüyor. Anahtarı oluştururken “Only select repositories” altında wishlist-veri'yi seçtin mi?"
      : e.status === 0 ? "İnternet bağlantısı yok gibi." : "Bağlanamadı: " + (e.message || e.status);
    err.hidden = false;
  } finally { btn.textContent = "Bağlan"; btn.disabled = false; }
});

(function start() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    // a tapped notification while the app is already open
    navigator.serviceWorker.addEventListener("message", (e) => { const id = e.data && e.data.open; if (id && S.token) { switchTab("list"); sync(); setTimeout(() => openDetail(id), 50); } });
  }
  const params = new URLSearchParams(location.search);
  if (!S.token) { showSetup(); return; }
  $("#app").hidden = false;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === S.view.tab));
  $("#search").value = S.view.q || "";
  render();
  sync();
  refreshPushSub();
  if (params.get("add")) { openAdd(params.get("add")); history.replaceState(null, "", location.pathname); }
  const m = location.hash.match(/p=([\w-]+)/); if (m) setTimeout(() => openDetail(m[1]), 50);
})();
