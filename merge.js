// Port of sync_model.py (Mac app). Keep the two in step; tests/test_sync.py compares them.
(function (root) {
  const USER_FIELDS = ["url", "key", "title", "category_id", "favorite", "notes", "target_price", "bought", "added_at"];
  const CHECK_FIELDS = ["store", "image_urls", "list_price", "in_stock", "last_checked", "status", "error", "target_notified"];
  const LOCAL_ONLY = ["images"];
  const TOMBSTONE_DAYS = 60;
  const ms = (v) => (typeof v === "number" && isFinite(v) ? Math.trunc(v) : 0);
  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

  function mergeHistory(a, b) {
    const seen = new Set(), out = [];
    for (const h of [...(a || []), ...(b || [])]) {
      if (!h || typeof h !== "object") continue;
      const key = String(h.t) + "|" + JSON.stringify(h.price ?? null);
      if (!seen.has(key)) { seen.add(key); out.push(h); }
    }
    out.sort((x, y) => (String(x.t) < String(y.t) ? -1 : String(x.t) > String(y.t) ? 1 : 0));
    return out;
  }

  function mergeProduct(local, remote) {
    const lu = ms(local.u), ru = ms(remote.u), lc = ms(local.c), rc = ms(remote.c);
    const userSrc = lu >= ru ? local : remote;
    const checkSrc = lc >= rc ? local : remote;
    const out = clone(remote);
    for (const k of Object.keys(local)) if (!(k in out)) out[k] = clone(local[k]);
    for (const k of USER_FIELDS) if (k in userSrc) out[k] = clone(userSrc[k]);
    for (const k of CHECK_FIELDS) if (k in checkSrc) out[k] = clone(checkSrc[k]);
    for (const k of LOCAL_ONLY) if (k in local) out[k] = clone(local[k]);
    out.price_history = mergeHistory(local.price_history, remote.price_history);
    out.u = Math.max(lu, ru); out.c = Math.max(lc, rc);
    return out;
  }

  function merge(local, remote, keepTombstonesMs, nowMs) {
    local = local || {}; remote = remote || {};
    const now = nowMs ?? Date.now();
    let deleted = {};
    for (const d of [remote.deleted || {}, local.deleted || {}])
      for (const [k, v] of Object.entries(d)) deleted[k] = Math.max(ms(v), deleted[k] || 0);
    const cutoff = now - (keepTombstonesMs ?? TOMBSTONE_DAYS * 86400000);
    deleted = Object.fromEntries(Object.entries(deleted).filter(([, v]) => v >= cutoff));

    function combine(lstLocal, lstRemote, fn) {
      const order = [], byId = new Map();
      for (const [side, items] of [["r", lstRemote || []], ["l", lstLocal || []]]) {
        for (const it of items) {
          if (!it || typeof it !== "object" || !it.id) continue;
          if (!byId.has(it.id)) { order.push(it.id); byId.set(it.id, {}); }
          byId.get(it.id)[side] = it;
        }
      }
      const out = [];
      for (const id of order) {
        const s = byId.get(id);
        const item = s.l && s.r ? fn(s.l, s.r) : clone(s.l || s.r);
        if (id in deleted && deleted[id] >= ms(item.u)) continue;
        out.push(item);
      }
      return out;
    }
    const mergeCategory = (a, b) => clone(ms(a.u) >= ms(b.u) ? a : b);

    const result = {};
    for (const [k, v] of Object.entries(remote)) if (!["products", "categories", "deleted"].includes(k)) result[k] = clone(v);
    result.version = 2;
    result.products = combine(local.products, remote.products, mergeProduct);
    result.categories = combine(local.categories, remote.categories, mergeCategory);
    // the same link added on two devices before they met: keep one record (the oldest), merged
    const byKey = new Map();
    for (const p of result.products) if (p.key) { if (!byKey.has(p.key)) byKey.set(p.key, []); byKey.get(p.key).push(p); }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => { const x = String(a.added_at ?? ""), y = String(b.added_at ?? "");
        if (x !== y) return x < y ? -1 : 1; return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0; });
      const keep = group[0];
      for (const other of group.slice(1)) {
        const bought = keep.bought || other.bought;
        const merged = mergeProduct(keep, other);
        merged.id = keep.id; merged.added_at = keep.added_at;
        if (bought && !merged.bought) merged.bought = clone(bought);
        if (!merged.image_urls || !merged.image_urls.length) merged.image_urls = clone(other.image_urls || keep.image_urls || []);
        for (const k of Object.keys(keep)) delete keep[k];
        Object.assign(keep, merged);
        deleted[other.id] = Math.max(deleted[other.id] || 0, ms(keep.u), ms(other.u)) + 1;
      }
      const gone = new Set(group.slice(1).map((o) => o.id));
      result.products = result.products.filter((x) => !gone.has(x.id));
    }
    const catIds = new Set(result.categories.map((c) => c.id));
    for (const c of result.categories) if (c.parent_id && !catIds.has(c.parent_id)) c.parent_id = null;
    for (const p of result.products) if (p.category_id && !catIds.has(p.category_id)) p.category_id = null;
    result.deleted = deleted;
    return result;
  }

  const api = { merge, mergeProduct, mergeHistory, USER_FIELDS, CHECK_FIELDS };
  if (typeof module !== "undefined") module.exports = api; else root.WishMerge = api;
})(this);
