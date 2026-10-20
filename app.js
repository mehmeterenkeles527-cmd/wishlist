/* Wishlist — iPhone app. The list lives in a private GitHub repo (data/wishlist.json);
   this page reads and writes it with the user's own token, and asks the cloud checker
   (GitHub Actions) to read new links. Merge rules are shared with the Mac app (merge.js). */
"use strict";

const DEFAULT_REPO = "mehmeterenkeles527-cmd/wishlist-veri";
const DATA_PATH = "data/wishlist.json";
const CONFIG_PATH = "data/config.json";
const LS = { token: "wl.token", repo: "wl.repo", doc: "wl.doc", dirty: "wl.dirty", view: "wl.view", outbox: "wl.outbox" };
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
function targetReached(p) { const [n] = currentPrice(p); return !!(p.target_price && n && n <= p.target_price + 0.004); }
function allTimeLow(p) { const ps = hist(p).map((h) => h.price), [n] = currentPrice(p);
  return !!(n && new Set(ps).size > 1 && n <= Math.min(...ps) + 0.004 && Math.max(...ps) > n + 0.004); }
const active = () => S.doc.products.filter((p) => !p.bought);
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
    r = await fetch(`https://api.github.com/repos/${S.repo}/${p}`, Object.assign({ cache: "no-store" }, opts, {
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

function addLink(raw, categoryId) {
  const m = String(raw || "").match(/https?:\/\/[^\s<>"']+/i);
  if (!m) { toast("Bu bir link gibi görünmüyor"); return false; }
  const url = m[0].replace(/[).,;]+$/, ""), key = normalizeUrl(url);
  const existing = S.doc.products.find((p) => p.key === key || normalizeUrl(p.url) === key);
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
function filtered() {
  const v = S.view;
  let items = v.filter === "bought" ? S.doc.products.filter((p) => p.bought) : active();
  if (v.filter === "sale") items = items.filter(isDrop);
  if (v.filter === "fav") items = items.filter((p) => p.favorite);
  if (v.filter === "target") items = items.filter((p) => p.target_price);
  if (v.cat && cat(v.cat)) { const ids = descendants(v.cat); items = items.filter((p) => ids.has(p.category_id)); }
  const q = v.q.trim().toLocaleLowerCase("tr");
  if (q) items = items.filter((p) => `${p.title} ${p.store} ${p.notes}`.toLocaleLowerCase("tr").includes(q));
  if (v.filter === "sale") items.sort((a, b) => (currentPrice(a)[0] / (refPrice(a) || 1)) - (currentPrice(b)[0] / (refPrice(b) || 1)));
  else if (v.filter === "bought") items.sort((a, b) => String(b.bought.at).localeCompare(String(a.bought.at)));
  else items.sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)));
  return items;
}
function badgesFor(p) {
  const b = [], [f] = firstPrice(p), [n] = currentPrice(p), sale = shopDiscount(p);
  if (p.bought) b.push(["b-bought", "✓ ALINDI"]);
  else if (p.in_stock === false) b.push(["b-out", "TÜKENDİ"]);
  if (!p.bought) {
    if (sale >= 1) b.push(["b-sale", `%${Math.round(sale)} İNDİRİM`]);
    if (targetReached(p)) b.push(["b-target", "HEDEFTE"]); else if (allTimeLow(p)) b.push(["b-low", "EN DÜŞÜK"]);
    if (f && n && Math.abs(f - n) > 0.004) b.push([n < f ? "b-drop" : "b-rise", `${n < f ? "↓" : "↑"} %${Math.round(Math.abs(n - f) / f * 100)}`]);
  }
  return b.slice(0, 3);
}
function cardHtml(p) {
  const [now, cur] = currentPrice(p), [first] = firstPrice(p), lp = listPrice(p);
  let price = now, old = lp || (first && now && now < first - 0.004 ? first : null), cls = lp ? "sale" : old ? "drop" : "";
  if (p.bought && p.bought.price) { price = p.bought.price; old = p.bought.ref_price > price ? p.bought.ref_price : null; cls = old ? "drop" : ""; }
  const img = (p.image_urls || [])[0];
  return `<button class="card ${p.in_stock === false && !p.bought ? "out" : ""}" data-open="${p.id}">
    <div class="ph ${p.status === "loading" ? "loading-shimmer" : ""}">
      ${img ? `<img src="${esc(img)}" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.remove()">` : ""}
      ${!img ? `<div class="none">${p.status === "loading" ? "Okunuyor…" : "Görsel yok"}</div>` : ""}
      <span class="star ${p.favorite ? "on" : ""}" data-fav="${p.id}" role="button" aria-label="Favori"><svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg></span>
      <div class="badges">${badgesFor(p).map(([c, t]) => `<span class="badge ${c}">${t}</span>`).join("")}</div>
    </div>
    <div class="meta">
      <div class="store">${esc(p.store || "")}</div>
      <div class="ttl">${esc(p.title)}</div>
      <div class="prices">${price ? `<span class="price ${cls}">${money(price, cur)}</span>` : `<span class="price none">${p.status === "loading" ? "Okunuyor…" : "Fiyat yok"}</span>`}
        ${old ? `<span class="old">${money(old, cur)}</span>` : ""}${p.status === "error" && !p.bought ? `<i class="dot-err" title="${esc(p.error)}"></i>` : ""}</div>
    </div></button>`;
}
function renderList() {
  const v = S.view, base = v.filter === "bought" ? S.doc.products.filter((p) => p.bought) : active();
  const counts = { all: active().length, sale: active().filter(isDrop).length, fav: active().filter((p) => p.favorite).length,
    target: active().filter((p) => p.target_price).length, bought: S.doc.products.filter((p) => p.bought).length };
  $("#filters").innerHTML = FILTERS.map(([k, t]) => `<button class="chip ${v.filter === k ? "on" : ""}" data-filter="${k}">${t}${counts[k] ? `<span class="n">${counts[k]}</span>` : ""}</button>`).join("");
  if (v.cat && !cat(v.cat)) v.cat = null;
  $("#crumbs").innerHTML = v.cat ? `<button data-cat="">Tüm kategoriler</button>` + path(v.cat).map((c, i, a) => ` › ${i === a.length - 1 ? `<b>${esc(c.name)}</b>` : `<button data-cat="${c.id}">${esc(c.name)}</button>`}`).join("") : "";
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
  $("#summary").textContent = sum;
  $("#grid").innerHTML = items.map(cardHtml).join("");
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

/* ------------------------------------------------------------------ rendering: dashboard */
function renderDash() {
  const act = active(), bought = S.doc.products.filter((p) => p.bought), price = (p) => currentPrice(p)[0] || 0;
  const onSale = act.filter(isDrop), saving = onSale.reduce((a, p) => a + Math.max(0, (refPrice(p) || 0) - price(p)), 0);
  const targets = act.filter((p) => p.target_price), hit = targets.filter(targetReached);
  const saved = bought.reduce((a, p) => a + Math.max(0, (p.bought.ref_price || 0) - (p.bought.price || 0)), 0);
  const disc = (p) => { const r = refPrice(p); return r && price(p) ? (r - price(p)) / r : 0; };
  const deals = act.filter((p) => disc(p) > 0.004 || targetReached(p)).sort((a, b) => disc(b) - disc(a)).slice(0, 6);
  const moves = [];
  for (const p of S.doc.products) { const h = hist(p); for (let i = 1; i < h.length; i++) moves.push([h[i].t, p, h[i - 1].price, h[i].price]); }
  moves.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  const row = (p, right) => `<button class="row" data-open="${p.id}">${(p.image_urls || [])[0] ? `<img src="${esc(p.image_urls[0])}" referrerpolicy="no-referrer" alt="" onerror="this.style.visibility='hidden'">` : `<span class="noimg"></span>`}
    <span class="t"><div>${esc(p.title)}</div><small>${esc(p.store || "")}</small></span><span class="r">${right}</span></button>`;
  const cats = children(null).map((c) => { const ids = descendants(c.id), ps = act.filter((p) => ids.has(p.category_id)); return [c, ps.reduce((a, p) => a + price(p), 0), ps.length]; }).filter((x) => x[2]);
  const unc = act.filter((p) => !p.category_id); if (unc.length) cats.push([{ id: "", name: "Kategorisiz" }, unc.reduce((a, p) => a + price(p), 0), unc.length]);
  cats.sort((a, b) => b[1] - a[1]); const top = Math.max(1, ...cats.map((c) => c[1]));
  const meta = S.doc.meta || {};
  $("#view-dash").innerHTML = `
    <div class="tiles">
      <div class="tile"><span>Listenin toplamı</span><b>${money(act.reduce((a, p) => a + price(p), 0))}</b><small>${act.length} ürün takipte</small></div>
      <div class="tile"><span>Şu an indirimde</span><b>${onSale.length} ürün</b><small>${saving >= 1 ? `Şimdi alsan ${money(saving)} cebinde` : "Fiyat düşünce burada"}</small></div>
      <div class="tile"><span>Hedefe ulaşan</span><b>${targets.length ? `${hit.length} / ${targets.length}` : "—"}</b><small>${targets.length ? "Ulaşınca bildirim gelir" : "Üründe “Hedef fiyat”"}</small></div>
      <div class="tile"><span>Aldıklarında tasarruf</span><b>${saved >= 1 ? money(saved) : "—"}</b><small>${bought.length ? `${bought.length} ürün aldın` : "“Aldım” dedikçe birikir"}</small></div>
    </div>
    <div class="sec-title">En iyi fırsatlar</div>
    <div class="panel rows">${deals.length ? deals.map((p) => { const r = refPrice(p), n = price(p);
      return row(p, `<b>${targetReached(p) ? "🎯 " : ""}${money(n)}</b><br>${r && r > n ? `<span class="old">${money(r)}</span> <b class="ok">−%${Math.round(disc(p) * 100)}</b>` : ""}`); }).join("")
      : `<p class="mut">Şu an indirimde ürün yok.</p>`}</div>
    <div class="sec-title">Son fiyat hareketleri</div>
    <div class="panel rows">${moves.length ? moves.slice(0, 7).map(([t, p, a, b]) =>
      row(p, `<b class="${b < a ? "ok" : "warn"}">${b < a ? "↓" : "↑"} %${Math.round(Math.abs(b - a) / a * 100)}</b><br><small class="mut">${money(a)} → ${money(b)}<br>${niceDate(t)}</small>`)).join("")
      : `<p class="mut">Henüz fiyat değişikliği yok.</p>`}</div>
    ${cats.length ? `<div class="sec-title">Kategorilere göre</div><div class="panel bars">${cats.map(([c, v, n]) =>
      `<button class="bar" data-gocat="${c.id}"><span>${esc(c.name)}</span><span class="track"><i class="fill" style="width:${Math.max(4, v / top * 100) * 0.62}%"></i>${money(v)} · ${n}</span></button>`).join("")}</div>` : ""}
    <p class="mut" style="font-size:12px;margin:16px 4px">Bulut son kontrol: ${meta.last_cloud_check ? niceDate(meta.last_cloud_check) + " " + meta.last_cloud_check.slice(11, 16) : "henüz yok"}${meta.errors ? ` · ${meta.errors} ürün okunamadı (${esc((meta.error_stores || []).join(", "))})` : ""}</p>`;
}

/* ------------------------------------------------------------------ rendering: settings */
function renderSettings() {
  const cfg = S.cfg || {}, topic = cfg.ntfy_topic || "";
  const api = `https://api.github.com/repos/${S.repo}/dispatches`;
  $("#view-settings").innerHTML = `
    <div class="sec-title" style="margin-top:4px">Bağlantı</div>
    <div class="set-group">
      <div class="set-row"><span>Depo</span><span class="v">${esc(S.repo)}</span></div>
      <div class="set-row"><span>Son eşitleme</span><span class="v">${S.lastSync ? ago(S.lastSync) : "—"}</span></div>
      <button class="set-row" id="s-check"><span>Tüm fiyatları şimdi kontrol et<small>Bulutta çalışır, birkaç dakika sürer</small></span><span class="v">›</span></button>
    </div>
    <div class="sec-title">Bildirimler</div>
    <div class="set-group"><div class="set-row" style="display:block">
      ${topic ? `<div class="howto"><ol>
        <li>App Store'dan <b>ntfy</b> uygulamasını aç.</li>
        <li><b>+</b> ya da <b>Subscribe to topic</b>'e dokun, aşağıdaki adı yapıştır, <b>Subscribe</b>.</li>
        <li>Bildirim izni sorarsa <b>İzin Ver</b>.</li></ol>
        <div class="copy-box" id="topic">${esc(topic)}</div>
        <button class="act" data-copy="${esc(topic)}" style="width:100%;margin-top:6px">Adı kopyala</button>
        <p class="mut" style="font-size:12px">Fiyat düşünce, hedefe inince, stoğa girince ve yeni ürün eklenince haber verir.</p></div>`
        : `<span class="mut">Bildirim ayarı yükleniyor…</span>`}
    </div></div>
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
}

/* ------------------------------------------------------------------ detail sheet */
function chartSvg(p) {
  const h = hist(p).map((x) => [new Date(x.t).getTime() || 0, x.price]);
  if (!h.length) return `<p class="mut">Henüz fiyat kaydı yok.</p>`;
  const W = 340, H = 150, L = 8, R = W - 8, T = 22, B = H - 20;
  const ps = h.map((x) => x[1]); let lo = Math.min(...ps), hi = Math.max(...ps);
  if (hi - lo < 0.01) { lo *= 0.9; hi *= 1.1; } const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  const X = (i) => h.length > 1 ? L + (R - L) * i / (h.length - 1) : (L + R) / 2, Y = (v) => B - (v - lo) / (hi - lo) * (B - T);
  let d = `M${X(0)},${Y(h[0][1])}`; if (h.length === 1) d = `M${L},${Y(h[0][1])} L${R},${Y(h[0][1])}`;
  for (let i = 1; i < h.length; i++) d += ` L${X(i)},${Y(h[i - 1][1])} L${X(i)},${Y(h[i][1])}`;
  const first = h[0][1], last = h[h.length - 1][1];
  const col = last < first ? "var(--drop)" : last > first ? "var(--rise)" : "var(--ink)";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Fiyat geçmişi">
    <path d="${d} L${h.length > 1 ? X(h.length - 1) : R},${B} L${h.length > 1 ? X(0) : L},${B} Z" fill="${col}" opacity=".1"/>
    <path d="${d}" stroke="${col}" stroke-width="2.2" fill="none"/>
    ${h.map((x, i) => `<circle cx="${h.length > 1 ? X(i) : W / 2}" cy="${Y(x[1])}" r="3.5" fill="${col}"><title>${money(x[1])}</title></circle>`).join("")}
    <text x="${L}" y="${H - 4}">${niceDate(hist(p)[0].t)}</text><text x="${R}" y="${H - 4}" text-anchor="end">${money(last)}</text></svg>`;
}
function openDetail(id) {
  const p = product(id); if (!p) return;
  S.openId = id; location.hash = "p=" + id;
  const el = $("#detail"), [now, cur] = currentPrice(p), lp = listPrice(p), [first] = firstPrice(p), sale = shopDiscount(p);
  const imgs = p.image_urls || [], ps = hist(p).map((h) => h.price);
  const lines = [];
  if (p.status === "loading") lines.push(`<span class="mut">Bulut sayfayı okuyor… 1-2 dakika</span>`);
  if (p.status === "error" && p.error && !p.bought) lines.push(`<span class="bad">⚠︎ ${esc(p.error)}</span>`);
  if (p.in_stock === true) lines.push(`<span class="ok">● Stokta</span>`);
  if (p.in_stock === false) lines.push(`<span class="bad">● Tükendi — stoğa girince haber vereceğim</span>`);
  if (allTimeLow(p)) lines.push(`<span class="ok">★ Şimdiye kadarki en düşük fiyat</span>`);
  if (first && now && Math.abs(first - now) > 0.004) lines.push(`<span class="${now < first ? "ok" : "warn"}">Eklediğinden beri ${now < first ? "↓" : "↑"} %${(Math.abs(now - first) / first * 100).toFixed(1)} (${money(first, cur)} → ${money(now, cur)})</span>`);
  if (p.target_price) lines.push(targetReached(p) ? `<span class="tgt">🎯 Hedefe ulaştı (${money(p.target_price, cur)})</span>`
    : `<span class="tgt">🎯 Hedef ${money(p.target_price, cur)}${now ? ` · %${Math.round((now - p.target_price) / now * 100)} daha düşmeli` : ""}</span>`);
  const b = p.bought;
  el.innerHTML = `<div class="grabber"></div>
    <div class="sheet-head"><button class="icon-btn" data-close aria-label="Kapat"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <button class="icon-btn star-btn" data-favd="${p.id}" aria-label="Favori"><svg viewBox="0 0 24 24" style="${p.favorite ? "fill:#FFB800;stroke:#FFB800" : ""}"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg></button></div>
    <div class="gallery" id="gal">${imgs.length ? imgs.map((u) => `<img src="${esc(u)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()">`).join("") : `<div class="none">Görsel yok</div>`}</div>
    ${imgs.length > 1 ? `<div class="dots">${imgs.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div>` : ""}
    <div class="sheet-pad">
      <div class="d-store">${esc(p.store || "")} · ${esc(pathText(p.category_id))}</div>
      <div class="d-title"><button data-rename="${p.id}">${esc(p.title)} <span class="mut" style="font-size:13px">✎</span></button></div>
      <div class="d-prices">
        <span class="d-price ${lp ? "sale" : ""}">${b && b.price ? money(b.price, cur) : now ? money(now, cur) : "Fiyat yok"}</span>
        ${lp && !b ? `<span class="d-old">${money(lp, cur)}</span><span class="d-chip">%${Math.round(sale)} İNDİRİM</span>` : ""}
      </div>
      <div class="d-lines">${lines.join("")}</div>
      ${b ? `<div class="panel bought-box"><b>✓ ${niceDate(b.at)} tarihinde aldın</b>${b.price ? ` — ${money(b.price, cur)} ödedin` : ""}
        ${b.price && b.ref_price && b.ref_price - b.price >= 1 ? `<div class="ok" style="font-weight:700;margin-top:4px">${money(b.ref_price - b.price, cur)} tasarruf ettin 🎉</div>` : ""}</div>` : ""}
      <a class="chrome-btn go" href="${esc(p.url)}" target="_blank" rel="noopener">Ürün sayfasına git ↗</a>
      <div class="actions">
        <button class="act" data-target="${p.id}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>${p.target_price ? "Hedefi değiştir" : "Hedef fiyat"}</button>
        <button class="act" data-move="${p.id}"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4.5l2 2.2H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>Kategori</button>
        <button class="act" data-check="${p.id}"><svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4.5V8h-3.5"/></svg>Fiyatı kontrol et</button>
        ${b ? `<button class="act" data-unbuy="${p.id}">Listeye geri al</button>` : `<button class="act" data-buy="${p.id}"><svg viewBox="0 0 24 24"><rect x="4.5" y="8" width="15" height="12" rx="2.5"/><path d="M8.5 12V7.5a3.5 3.5 0 0 1 7 0V12M9 14.2l2.2 2.2 4.3-4.4"/></svg>Aldım</button>`}
        <button class="act" data-compare="${p.id}"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>Başka yerde ara</button>
        <button class="act danger" data-del="${p.id}"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7l.5-2.5h5L15 7M6 7l1 13h10l1-13"/></svg>Kaldır</button>
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
  $("#notes").addEventListener("change", (e) => edit(p.id, (x) => (x.notes = e.target.value), "Not kaydedildi"));
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
    <label class="field-label" for="add-url">Ürün linki</label>
    <input id="add-url" class="field" type="url" inputmode="url" autocomplete="off" autocapitalize="off" placeholder="https://…" value="${esc(prefill)}">
    <button class="act wide" id="paste-btn" style="margin-top:8px">Panodan yapıştır</button>
    <label class="field-label">Kategori</label>
    <button class="act wide" id="add-cat" style="justify-content:flex-start">📁 <span>${esc(pathText(chosen))}</span></button>
    <button class="chrome-btn wide" id="add-go" style="margin-top:18px">Listeye ekle</button>
    <p class="mut" style="font-size:12.5px;margin-top:12px">İpucu: Mağaza uygulamasında <b>Paylaş › Wishlist'e ekle</b> daha hızlı. Kurulumu Ayarlar'da.</p></div>`;
  el.hidden = false; $("#scrim").hidden = false;
  $("#paste-btn").onclick = async () => { try { $("#add-url").value = (await navigator.clipboard.readText()).trim(); } catch { toast("Pano okunamadı — linki elle yapıştır"); } };
  $("#add-cat").onclick = () => categoryPicker(chosen, (id) => { chosen = id; openAdd($("#add-url")?.value || prefill); }, "Hangi kategoriye?");
  $("#add-go").onclick = () => { if (addLink($("#add-url").value, chosen)) closeSheets(); };
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
    const v = askNumber("Hedef fiyat (₺) — bu fiyata ya da altına inince bildirim gelir. Kaldırmak için 0:", p.target_price || (n ? Math.round(n * 0.85) : ""));
    if (v === undefined) return; edit(p.id, (x) => { x.target_price = v > 0 ? v : null; x.target_notified = targetReached(x); },
      v > 0 ? (targetReached(p) ? "Zaten hedefin altında 🎯" : `Hedef ${money(v)} — inince haber vereceğim`) : "Hedef kaldırıldı"); openDetail(p.id); return; }
  if (d.move) { const p = product(d.move); categoryPicker(p.category_id, (id) => { edit(p.id, (x) => (x.category_id = id), `→ ${pathText(id)}`); openDetail(p.id); }); return; }
  if (d.check) { checkNow([d.check]); return; }
  if (d.buy) { const p = product(d.buy), [n] = currentPrice(p); const v = askNumber("Kaça aldın? (₺)", n); if (v === undefined) return;
    const ref = refPrice(p); edit(p.id, (x) => (x.bought = { at: nowIso(), price: v || null, ref_price: ref }));
    confetti(); toast(ref && v && ref - v >= 1 ? `Hayırlı olsun! ${money(ref - v)} tasarruf ettin 🎉` : "Hayırlı olsun! 🎉"); openDetail(p.id); return; }
  if (d.unbuy) { edit(d.unbuy, (x) => (x.bought = null), "Tekrar takip listende"); openDetail(d.unbuy); return; }
  if (d.del) { removeProduct(d.del); return; }
  if (d.compare) { const p = product(d.compare), q = encodeURIComponent(p.title.slice(0, 90)); const el = $("#add");
    el.innerHTML = `<div class="grabber"></div><div class="sheet-pad"><h2>Başka yerde ara</h2><div class="set-group">${[["Akakçe", `https://www.akakce.com/arama/?q=${q}`], ["Cimri", `https://www.cimri.com/arama?q=${q}`],
      ["Google Alışveriş", `https://www.google.com/search?tbm=shop&q=${q}`], ["Trendyol", `https://www.trendyol.com/sr?q=${q}`]].map(([n, u]) => `<a class="set-row" href="${u}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${n}<span class="v">↗</span></a>`).join("")}</div>
      <button class="act wide" data-closeadd>Vazgeç</button></div>`;
    el.hidden = false; el.onclick = (ev) => { if (ev.target.closest("[data-closeadd]")) el.hidden = true; }; return; }
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
  $("#view-list").hidden = tab !== "list"; $("#view-dash").hidden = tab !== "dash"; $("#view-settings").hidden = tab !== "settings";
  $("#fab").hidden = tab !== "list";
  if (tab === "list") renderList(); else if (tab === "dash") renderDash(); else renderSettings();
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const params = new URLSearchParams(location.search);
  if (!S.token) { showSetup(); return; }
  $("#app").hidden = false;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === S.view.tab));
  $("#search").value = S.view.q || "";
  render();
  sync();
  if (params.get("add")) { openAdd(params.get("add")); history.replaceState(null, "", location.pathname); }
  const m = location.hash.match(/p=([\w-]+)/); if (m) setTimeout(() => openDetail(m[1]), 50);
})();
