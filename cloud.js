/* Garage Manager – cloud login + sync (Supabase, no library needed)
   Auth: Supabase email + password.  Data: one row per car (photos stored once, separately).
   Works offline: changes are kept on the device and synced when the connection returns. */
(function (root) {
'use strict';
const BLOB = '@@blob:';

/* ---------- helpers ---------- */
function canon(x) {
  if (x === null || typeof x !== 'object') { const s = JSON.stringify(x); return s === undefined ? 'null' : s; }
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  return '{' + Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
}
function cy(str, seed) {
  seed = seed || 0; let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + str.length.toString(36);
}
const vhash = v => cy(canon(v));
async function sha(str) {
  const c = root.crypto;
  if (c && c.subtle) {
    const b = await c.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  return cy(str) + cy(str, 7);
}
const isImg = x => typeof x === 'string' && x.length > 3000 && x.startsWith('data:');
async function pack(v) {
  const blobs = {};
  async function walk(x) {
    if (typeof x === 'string') { if (isImg(x)) { const h = await sha(x); blobs[h] = x; return BLOB + h; } return x; }
    if (Array.isArray(x)) { const o = []; for (const i of x) o.push(await walk(i)); return o; }
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = await walk(x[k]); return o; }
    return x;
  }
  return { packed: await walk(v), blobs };
}
function blobRefs(x, set) {
  if (typeof x === 'string') { if (x.startsWith(BLOB)) set.add(x.slice(BLOB.length)); }
  else if (Array.isArray(x)) x.forEach(i => blobRefs(i, set));
  else if (x && typeof x === 'object') Object.values(x).forEach(i => blobRefs(i, set));
}
function unpack(x, map, miss) {
  if (typeof x === 'string') {
    if (x.startsWith(BLOB)) { const h = x.slice(BLOB.length); if (map.has(h)) return map.get(h); miss.add(h); }
    return x;
  }
  if (Array.isArray(x)) return x.map(i => unpack(i, map, miss));
  if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = unpack(x[k], map, miss); return o; }
  return x;
}
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const q = s => encodeURIComponent(s);

/* ---------- the client ---------- */
function createCloud(o) {
  const cfg = o.cfg || {}, F = o.fetch, LS = o.storage, now = o.now || Date.now;
  const base = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, ''), key = String(cfg.supabaseKey || '').trim();
  const enabled = !!(base && key);
  const SK = 'gm_session', MK = 'gm_sync';
  const load = k => { try { return JSON.parse(LS.getItem(k) || 'null'); } catch { return null; } };
  const put = (k, v) => { try { LS.setItem(k, JSON.stringify(v)); } catch (e) {} };
  let session = load(SK), meta = load(MK) || { uid: null, v: {}, tombs: {} };
  meta.v = meta.v || {}; meta.tombs = meta.tombs || {};
  let host = o.host || null, listener = null, authLost = null, busy = null, queued = false, tmr = null, poll = null;
  const status = { state: 'idle', at: 0, msg: '' };
  const setStatus = (state, msg) => { status.state = state; status.msg = msg || ''; if (state === 'ok') status.at = now(); if (listener) listener({ ...status }); };

  async function raw(path, op) {
    op = op || {};
    let r;
    try {
      r = await F(base + path, {
        method: op.method || 'GET',
        headers: Object.assign({ apikey: key, 'Content-Type': 'application/json' }, op.token ? { Authorization: 'Bearer ' + op.token } : {}, op.headers || {}),
        body: op.body === undefined ? undefined : JSON.stringify(op.body)
      });
    } catch (e) { const x = new Error('Cannot reach the server. Check your internet connection.'); x.offline = true; throw x; }
    const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) {
      const x = new Error((j && (j.msg || j.error_description || j.message || j.error)) || ('Server error ' + r.status));
      x.status = r.status; x.code = j && (j.error_code || j.code); throw x;
    }
    return j;
  }

  /* ----- session ----- */
  function setSession(s, email) {
    session = {
      access_token: s.access_token, refresh_token: s.refresh_token,
      expires_at: s.expires_at || (Math.floor(now() / 1000) + (s.expires_in || 3600)),
      uid: (s.user && s.user.id) || (session && session.uid),
      email: (s.user && s.user.email) || email || (session && session.email)
    };
    put(SK, session);
  }
  let refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const j = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
        setSession(j);
      } catch (e) {
        if (!e.offline && e.status >= 400 && e.status < 500) { session = null; LS.removeItem(SK); e.expired = true; if (authLost) authLost(); }
        throw e;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function token() {
    if (!session) { const e = new Error('Please sign in.'); e.expired = true; throw e; }
    if (session.expires_at * 1000 - now() < 60000) await refresh();
    return session.access_token;
  }
  async function rest(path, op) {
    op = op || {};
    const t = await token();
    try { return await raw('/rest/v1' + path, Object.assign({}, op, { token: t })); }
    catch (e) { if (e.status === 401 && !op._retry) { await refresh(); return rest(path, Object.assign({}, op, { _retry: 1 })); } throw e; }
  }

  /* ----- account ----- */
  const redirect = () => (root.location ? root.location.origin + root.location.pathname : '');
  async function signUp(email, password) {
    const j = await raw('/auth/v1/signup' + (redirect() ? '?redirect_to=' + q(redirect()) : ''), { method: 'POST', body: { email, password } });
    if (j && j.access_token) { setSession(j, email); return { session: true }; }
    return { session: false };
  }
  async function signIn(email, password) {
    const j = await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    setSession(j, email);
  }
  const recover = email => raw('/auth/v1/recover' + (redirect() ? '?redirect_to=' + q(redirect()) : ''), { method: 'POST', body: { email } });
  async function updatePassword(pw) { await raw('/auth/v1/user', { method: 'PUT', body: { password: pw }, token: await token() }); }
  async function fromHash(hash) {
    if (!enabled || !hash || hash.length < 2) return null;
    const p = new URLSearchParams(String(hash).replace(/^#/, ''));
    if (p.get('error')) return { error: p.get('error_description') || p.get('error') };
    if (!p.get('access_token')) return null;
    const s = { access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: +p.get('expires_in') || 3600 };
    s.user = await raw('/auth/v1/user', { token: s.access_token });
    setSession(s);
    return { type: p.get('type') || 'signup' };
  }

  /* ----- change tracking ----- */
  function scan() {
    const ids = new Set();
    for (const v of host.getVehicles()) {
      ids.add(v.id); const h = vhash(v), m = meta.v[v.id];
      if (!m) meta.v[v.id] = { ts: now(), h, cts: 0, dirty: true };
      else if (m.h !== h) { m.h = h; m.ts = now(); m.dirty = true; }
    }
    for (const id of Object.keys(meta.v)) if (!ids.has(id)) delete meta.v[id];
  }
  function pending() {
    if (!host) return false;
    scan(); put(MK, meta);
    const seed = v => host.isUntouchedSeed && host.isUntouchedSeed(v);
    return Object.keys(meta.tombs).length > 0 || host.getVehicles().some(v => !seed(v) && meta.v[v.id] && (meta.v[v.id].dirty || meta.v[v.id].cts === 0));
  }
  function noteDeleted(id) {
    const m = meta.v[id];
    if (m && m.cts > 0) meta.tombs[id] = now();
    delete meta.v[id]; put(MK, meta); touch();
  }

  /* ----- sync ----- */
  async function run() {
    const H = host; scan();
    const cloud = await rest('/vehicles?select=id,ts,h,deleted');
    const cmap = new Map(cloud.map(r => [r.id, r]));
    const local = H.getVehicles(), lmap = new Map(local.map(v => [v.id, v]));
    const isSeed = v => H.isUntouchedSeed && H.isUntouchedSeed(v);
    const up = new Set(), down = new Set(), rm = [], conflict = [], tombUp = [], notices = [];
    let retry = false;

    for (const id of Object.keys(meta.tombs)) {
      const c = cmap.get(id), t = meta.tombs[id];
      if (lmap.has(id)) { delete meta.tombs[id]; continue; }
      if (c && !c.deleted && c.ts > t) delete meta.tombs[id];          // edited elsewhere after we deleted: keep it
      else if (c && c.deleted && c.ts >= t) delete meta.tombs[id];     // already deleted online
      else tombUp.push(id);
    }
    for (const v of local) {
      if (isSeed(v)) continue;
      const m = meta.v[v.id], c = cmap.get(v.id);
      if (!c) { up.add(v.id); continue; }
      if (c.deleted) { if (m.dirty || m.cts === 0) up.add(v.id); else rm.push(v.id); continue; }
      if (m.cts === 0) { if (c.h && c.h === m.h) { m.cts = c.ts; m.ts = c.ts; m.dirty = false; } else conflict.push(v.id); continue; }
      const cc = c.ts > m.cts;
      if (cc && m.dirty) conflict.push(v.id); else if (cc) down.add(v.id); else if (m.dirty) up.add(v.id);
    }
    for (const c of cloud) if (!c.deleted && !lmap.has(c.id) && !meta.tombs[c.id]) down.add(c.id);

    const editing = !!(H.isEditing && H.isEditing());
    if (editing && (rm.length || conflict.length || down.size)) retry = true;
    else {
      let changed = false;
      for (const id of rm) if (H.removeVehicle(id)) { delete meta.v[id]; changed = true; }
      for (const id of conflict) {
        const nid = H.duplicateVehicle(id, ' (conflict copy)');
        if (nid) { up.add(nid); notices.push('Two devices changed the same car. Your version from this device was kept as “… (conflict copy)”.'); }
        down.add(id); changed = true;
      }
      if (down.size) { const e = await download([...down]); changed = true; if (e) retry = true; }
      const seeds = H.getVehicles().filter(isSeed);
      if (seeds.length && cloud.some(r => !r.deleted)) for (const s of seeds) if (H.getVehicles().length > 1 && H.removeVehicle(s.id)) { delete meta.v[s.id]; changed = true; }
      if (changed) H.changed();
    }
    const failed = await upload([...up], tombUp, cmap);
    if (failed) retry = true;
    put(MK, meta);
    if (notices.length && o.onNotice) o.onNotice(notices[0]);
    return retry;
  }

  async function download(ids) {
    const H = host, rows = []; let problem = false;
    for (const c of chunks(ids, 10)) rows.push(...await rest('/vehicles?select=id,ts,h,deleted,data&id=in.(' + c.map(i => '"' + i + '"').join(',') + ')'));
    const need = new Set(); rows.forEach(r => blobRefs(r.data, need));
    const map = new Map();
    if (need.size) {
      const scanImgs = async x => {
        if (isImg(x)) map.set(await sha(x), x);
        else if (Array.isArray(x)) for (const i of x) await scanImgs(i);
        else if (x && typeof x === 'object') for (const k of Object.keys(x)) await scanImgs(x[k]);
      };
      for (const v of H.getVehicles()) await scanImgs(v);
      const missing = [...need].filter(h => !map.has(h));
      for (const c of chunks(missing, 5)) (await rest('/blobs?select=hash,data&hash=in.(' + c.join(',') + ')')).forEach(b => map.set(b.hash, b.data));
    }
    for (const r of rows) {
      const miss = new Set(), obj = unpack(r.data, map, miss);
      if (miss.size) { problem = true; continue; }
      const stored = H.applyVehicle(obj);
      meta.v[r.id] = { ts: r.ts, h: vhash(stored), cts: r.ts, dirty: false };
    }
    return problem;
  }

  async function upload(ids, tombUp, cmap) {
    const H = host; let failed = false; const jobs = [], blobMap = {};
    for (const id of ids) {
      const v = H.getVehicles().find(x => x.id === id); if (!v) continue;
      const m = meta.v[id] || (meta.v[id] = { ts: now(), h: vhash(v), cts: 0, dirty: true });
      const { packed, blobs } = await pack(v); Object.assign(blobMap, blobs);
      jobs.push({ id, m, packed, c: cmap.get(id) });
    }
    const hs = Object.keys(blobMap);
    if (hs.length) {
      const have = new Set((await rest('/blobs?select=hash')).map(r => r.hash));
      let batch = [], size = 0;
      const flush = async () => { if (batch.length) { await rest('/blobs?on_conflict=user_id,hash', { method: 'POST', body: batch, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } }); batch = []; size = 0; } };
      for (const h of hs) if (!have.has(h)) {
        batch.push({ user_id: session.uid, hash: h, data: blobMap[h] }); size += blobMap[h].length;
        if (size > 700000) await flush();
      }
      await flush();
    }
    async function writeRow(id, c, fields) {
      const ts = Math.max(now(), (c ? c.ts : 0) + 1);
      let ok;
      if (c) {
        const res = await rest('/vehicles?id=eq.' + q(id) + '&ts=eq.' + c.ts, { method: 'PATCH', body: Object.assign({ ts }, fields), headers: { Prefer: 'return=representation' } });
        ok = Array.isArray(res) && res.length > 0;
      } else {
        try { await rest('/vehicles', { method: 'POST', body: Object.assign({ user_id: session.uid, id, ts }, fields), headers: { Prefer: 'return=minimal' } }); ok = true; }
        catch (e) { if (e.status === 409) ok = false; else throw e; }
      }
      return ok ? ts : 0;
    }
    for (const j of jobs) {
      const ts = await writeRow(j.id, j.c, { h: j.m.h, deleted: false, data: j.packed });
      if (ts) { j.m.cts = ts; j.m.ts = ts; j.m.dirty = false; } else failed = true;
    }
    for (const id of tombUp) {
      const ts = await writeRow(id, cmap.get(id), { h: '', deleted: true, data: {} });
      if (ts) delete meta.tombs[id]; else failed = true;
    }
    return failed;
  }

  async function sync() {
    if (!enabled || !session || !host) return;
    if (busy) { queued = true; return busy; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setStatus('offline'); return; }
    busy = (async () => {
      setStatus('syncing');
      try {
        const retry = await run();
        setStatus('ok');
        if (retry) schedule(8000);
      } catch (e) {
        if (e.offline) setStatus('offline');
        else if (e.expired) setStatus('auth', e.message);
        else setStatus('error', e.message);
      }
    })();
    try { await busy; } finally { busy = null; if (queued) { queued = false; schedule(500); } put(MK, meta); }
  }
  function schedule(ms) { clearTimeout(tmr); tmr = setTimeout(() => { sync(); }, ms); }
  function touch() { if (!enabled || !session || !host) return; if (status.state === 'ok' || status.state === 'idle') setStatus('pending'); schedule(2500); }

  function start() {
    if (!enabled || !session) return;
    if (!meta.uid) { meta.uid = session.uid; put(MK, meta); }
    sync();
    if (typeof document !== 'undefined' && !poll) {
      poll = setInterval(() => { if (!document.hidden) sync(); }, 30000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
      root.addEventListener('online', () => sync());
      root.addEventListener('focus', () => sync());
    }
  }
  const userChanged = () => !!(session && meta.uid && meta.uid !== session.uid);
  function resetMeta() { meta = { uid: session ? session.uid : null, v: {}, tombs: {} }; put(MK, meta); }

  async function prepareSignOut() {
    if (!session || !host) return { unsynced: false };
    await sync();
    let un = false; try { un = pending(); } catch {}
    return { unsynced: un };
  }
  async function finishSignOut() {
    clearTimeout(tmr);
    try { if (session) await raw('/auth/v1/logout', { method: 'POST', token: session.access_token }); } catch {}
    session = null; LS.removeItem(SK); LS.removeItem(MK); meta = { uid: null, v: {}, tombs: {} };
  }

  return {
    enabled, signUp, signIn, recover, updatePassword, fromHash, sync, touch, start, noteDeleted, pending,
    userChanged, resetMeta, prepareSignOut, finishSignOut, vhash,
    signedIn: () => !!session, email: () => session ? session.email : '', status: () => ({ ...status }),
    setHost: h => { host = h; }, onNotice: f => { o.onNotice = f; }, on: f => { listener = f; }, onAuthLost: f => { authLost = f; }, _meta: () => meta
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createCloud, vhash, canon, pack, unpack };
else root.GMCloud = createCloud({ cfg: root.GM_CONFIG, fetch: (...a) => root.fetch(...a), storage: root.localStorage });
})(typeof window !== 'undefined' ? window : globalThis);
