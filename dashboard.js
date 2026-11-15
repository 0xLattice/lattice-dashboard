// Lattice node dashboard: a static page that manages nodes through their
// operator API, each reached by its URL with a token the operator pastes (on a
// node's loopback RPC port, its cookie). No dependencies, no build step.
'use strict';
(() => {

// ---------------------------------------------------------------- utilities

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
function part(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
/** Template literal that escapes every value unless it is raw(). */
function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < values.length) out += part(values[i]); });
  return raw(out);
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const store = {
  get(area, key, fallback) {
    try { const v = area.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(area, key, value) {
    try { if (value == null) area.removeItem(key); else area.setItem(key, JSON.stringify(value)); } catch { /* storage off */ }
  },
};
const local = (() => { try { return window.localStorage; } catch { return null; } })();
const session = (() => { try { return window.sessionStorage; } catch { return null; } })();
const lget = (k, f) => local ? store.get(local, k, f) : f;
const lset = (k, v) => local && store.set(local, k, v);
const sget = (k, f) => session ? store.get(session, k, f) : f;
const sset = (k, v) => session && store.set(session, k, v);

const num = (n) => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString());
function bytes(n) {
  if (n == null) return '–';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n);
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i += 1; }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
const ago = (t) => (t ? `${duration(Date.now() - t)} ago` : '–');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const lastSegment = (path) => path.split('/').pop();
const parentOf = (path) => path.split('/').slice(0, -1).join('/');
function shortCid(cid) { return cid && cid.length > 18 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid || ''; }
function cidView(cid) {
  if (!cid) return html`<span class="muted">none</span>`;
  return html`<span class="cid"><span title="${cid}">${shortCid(cid)}</span><button type="button" class="quiet" data-copy="${cid}" aria-label="Copy ${cid}">Copy</button></span>`;
}
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const deepEqual = (a, b) => same(sortKeys(a), sortKeys(b));

const ICON = {
  warn: '<svg class="icon warn" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18.5 17h-17z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 8v4.2M10 14.6v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  bad: '<svg class="icon bad" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m7 7 6 6m0-6-6 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  note: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9v5M10 6.2v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  mark: '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2v12M3 5h5v4M8 9h5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
};
const LEVEL_WORD = { bad: 'Problem', warn: 'Warning', note: 'Note' };

function toast(message) {
  const box = $('#toast');
  box.innerHTML = '';
  const div = document.createElement('div');
  div.textContent = message;
  box.append(div);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.innerHTML = ''; }, 3200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed: select the text and copy it'); }
}

// ---------------------------------------------------------------- nodes + API

const NODES_KEY = 'lattice.dashboard.nodes';
const SESSION_TOKENS = 'lattice.dashboard.tokens';
const CURRENT_KEY = 'lattice.dashboard.current';

/** The nodes added in this browser, stored on this device only. */
function loadNodes() {
  return lget(NODES_KEY, []).filter((n) => n && n.url);
}
function saveNodes() {
  lset(NODES_KEY, state.nodes.map((n) => ({ id: n.id, name: n.name, url: n.url, remember: !!n.remember, token: n.remember ? n.token : undefined })));
  sset(SESSION_TOKENS, Object.fromEntries(state.nodes.filter((n) => n.token && !n.remember).map((n) => [n.id, n.token])));
}
function restoreTokens() {
  const sessionTokens = sget(SESSION_TOKENS, {});
  for (const n of state.nodes) if (!n.token && sessionTokens[n.id]) n.token = sessionTokens[n.id];
}
/** A pasted secret: a token, or the cookie file's whole content. */
const cleanToken = (t) => t.trim().replace(/^__cookie__:/, '');

class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}
function apiBase(node) {
  return `${node.url.replace(/\/+$/, '')}/`;
}
async function api(node, path, { method = 'GET', body, text = false, contentType = 'application/json', timeout = 12000, accept = [], headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (node.token) headers.Authorization = `Bearer ${node.token}`;
  if (body !== undefined) headers['Content-Type'] = contentType;
  let res;
  try {
    res = await fetch(apiBase(node) + path.replace(/^\//, ''), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const err = new ApiError(0, e && e.name === 'TimeoutError' ? 'The node did not answer in time.' : 'The node could not be reached.');
    err.timedOut = !!(e && e.name === 'TimeoutError');
    throw err;
  }
  const bodyText = await res.text();
  let data = bodyText;
  if (!text) { try { data = bodyText ? JSON.parse(bodyText) : null; } catch { data = bodyText; } }
  if (!res.ok && !accept.includes(res.status)) {
    const message = (data && data.error && (data.error.message || data.error.reason)) || (typeof data === 'string' && data) || res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, message, data);
  }
  return { status: res.status, data, etag: res.headers.get('ETag') };
}
const get = async (node, path, opts) => (await api(node, path, opts)).data;
const q = (path, chain) => (chain && chain !== 'Nexus' ? `${path}${path.includes('?') ? '&' : '?'}chainPath=${encodeURIComponent(chain)}` : path);

// ---------------------------------------------------------------- app state

const state = {
  nodes: [],
  current: null,
  snaps: {},        // node id -> snapshot
  timers: {},
  failures: {},     // node id -> consecutive failures
  inflight: {},
  route: { name: 'overview', params: {} },
};
const node = (id = state.current) => state.nodes.find((n) => n.id === id);
const snap = (id = state.current) => state.snaps[id] || (state.snaps[id] = blankSnap());
function blankSnap() { return { at: 0, chains: {}, hist: {}, progress: {}, blockTime: {} }; }
const SNAP_KEY = (id) => `lattice.dashboard.snap.${id}`;
function persistSnap(id) {
  const n = node(id); const s = state.snaps[id];
  if (!n || !s) return;
  // Who the token is belongs to the token, not the node: asked afresh.
  const keep = { ...s, who: undefined, whoToken: undefined, blockCache: undefined, logCache: undefined, pinsCache: undefined };
  if (n.remember) lset(SNAP_KEY(id), keep); else sset(SNAP_KEY(id), keep);
}
function restoreSnap(id) {
  const n = node(id);
  const s = (n && n.remember ? lget(SNAP_KEY(id), null) : null) || sget(SNAP_KEY(id), null);
  if (s) { s.restored = true; delete s.who; delete s.whoToken; state.snaps[id] = { ...blankSnap(), ...s }; }
}

/** One refresh of everything the overview shows for a node. Last-known
 *  values stay when a read fails; the failure is recorded beside them. */
async function refresh(id) {
  const n = node(id);
  if (!n || !n.token) return;
  if (state.inflight[id]) return state.inflight[id];
  const s = snap(id);
  s.busy = true; paintFreshness();
  const token = n.token;
  const run = (async () => {
    const now = Date.now();
    try {
      const [status, hosted] = await Promise.all([get(n, 'status'), get(n, 'hosted-chains')]);
      s.status = status;
      s.hosted = hosted;
      // Asked again whenever the token changed.
      if (s.whoToken !== token) {
        const who = await whoami(n);
        if (n.token === token) { s.who = who; s.whoToken = who ? token : undefined; }
      }
      const chains = ['Nexus', ...(hosted.chains || [])];
      const extra = await Promise.allSettled([
        get(n, 'disk'),
        api(n, 'config', { accept: [409] }),
        get(n, 'metrics', { text: true }),
      ]);
      if (extra[0].status === 'fulfilled') s.disk = extra[0].value;
      if (extra[1].status === 'fulfilled') s.config = extra[1].value.status === 409 ? { flags: true } : extra[1].value.data;
      if (extra[2].status === 'fulfilled') s.metrics = parseMetrics(extra[2].value);
      const per = await Promise.all(chains.map(async (path) => {
        const [health, peers, latest] = await Promise.allSettled([
          path === 'Nexus' ? Promise.resolve(status) : get(n, q('health', path)),
          get(n, q('api/peers', path)),
          get(n, q('api/block/latest', path)),
        ]);
        if (s.blockTime[path] == null) {
          try { const spec = await get(n, q('api/chain/spec', path)); s.blockTime[path] = Number(spec.targetBlockTime); } catch { /* later */ }
        }
        return [path, {
          path,
          health: health.status === 'fulfilled' ? health.value : (s.chains[path] && s.chains[path].health),
          peers: peers.status === 'fulfilled' ? peers.value.count : (s.chains[path] && s.chains[path].peers),
          latest: latest.status === 'fulfilled' ? latest.value : (s.chains[path] && s.chains[path].latest),
          error: health.status === 'rejected' ? health.reason.message : null,
        }];
      }));
      s.chains = Object.fromEntries(per);
      for (const [path, c] of per) record(s, path, c, now);
      s.at = now;
      s.error = null;
      s.restored = false;
      state.failures[id] = 0;
    } catch (e) {
      s.error = { status: e.status, message: e.message, at: now };
      state.failures[id] = (state.failures[id] || 0) + 1;
      if (e.status === 401 && id === state.current && n.token === token) { n.token = null; saveNodes(); signInReason = 'That node no longer accepts the saved token. Paste one it knows. (A loopback cookie changes whenever the node restarts.)'; }
    } finally {
      s.busy = false;
      if (state.inflight[id] === run) delete state.inflight[id];
      persistSnap(id);
    }
  })();
  state.inflight[id] = run;
  await run;
  if (id === state.current || state.route.name === 'nodes') paint();
  else paintChrome();
}

/** Remembers each chain's heights over time: the rate, and when it last moved. */
function record(s, path, c, now) {
  const h = c.health;
  if (!h || h.height == null) return;
  const height = Number(h.height);
  const best = Number(h.bestHeaderHeight ?? h.height);
  const hist = (s.hist[path] = (s.hist[path] || []).filter((p) => now - p[0] < 10 * 60e3));
  const last = hist[hist.length - 1];
  if (!last || last[1] !== height || now - last[0] > 20e3) hist.push([now, height, best]);
  const blockTime = c.latest && c.latest.timestamp ? Number(c.latest.timestamp) : 0;
  const p = s.progress[path];
  if (!p || p.height !== height) s.progress[path] = { height, at: p ? now : Math.max(blockTime, now - 1), firstSeen: p ? p.firstSeen : now };
  if (blockTime && blockTime > s.progress[path].at && blockTime <= now) s.progress[path].at = blockTime;
}
function rateOf(s, path) {
  const hist = s.hist[path] || [];
  if (hist.length < 2) return null;
  const now = hist[hist.length - 1];
  const from = hist.find((p) => now[0] - p[0] <= 3 * 60e3) || hist[0];
  const dt = (now[0] - from[0]) / 1000;
  if (dt < 15) return null;
  return (now[1] - from[1]) / dt; // blocks per second
}

/** The credential's name, role and routes (GET /whoami), or undefined when
 *  the node could not be asked: the next refresh asks again. */
async function whoami(n) {
  try { return await get(n, 'whoami'); } catch { return undefined; }
}
/** The process start time (ms): /status startedAt when the node reports it,
 *  else process_start_time_seconds from /metrics. */
function startMs(v) {
  if (v == null) return undefined;
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v)) { const t = Date.parse(v); return Number.isNaN(t) ? undefined : t; }
  const x = Number(v); return x < 1e12 ? x * 1000 : x;
}
const startedAt = (s) => startMs(s.status && s.status.startedAt) || (s.metrics && s.metrics.start);
function parseMetrics(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    if (line.startsWith('process_start_time_seconds')) out.start = Number(line.split(' ').pop()) * 1000;
    const peers = line.match(/^lattice_overlay_peers\{chain="Nexus"\} (\d+)/);
    if (peers) out.peers = Number(peers[1]);
  }
  return out;
}

function schedule(id) {
  clearTimeout(state.timers[id]);
  const fails = state.failures[id] || 0;
  const base = id === state.current ? 5000 : 15000;
  const wait = Math.min(base * 2 ** fails, 60000);
  state.nodes.find((n) => n.id === id).nextAt = Date.now() + wait;
  state.timers[id] = setTimeout(async () => {
    if (!document.hidden) await refresh(id);
    schedule(id);
  }, wait);
}
function startPolling() {
  for (const n of state.nodes) {
    if (!n.token) continue;
    if (!state.snaps[n.id]) restoreSnap(n.id);
    refresh(n.id).then(() => schedule(n.id));
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && node() && node().token) refresh(state.current); });

// ---------------------------------------------------------------- verdicts

const WAITING = {
  'not obtained from any peer': 'No peer has sent this block yet.',
  "exceeds this node's byte budget": "The block is bigger than this node fetches at once (maxAcquisitionBytes).",
  'local storage failed': 'Writing it to disk failed. Check free space and the log.',
};
function waitingCause(w) {
  if (!w) return null;
  const reason = w.replace(/^body of \S+: /, '');
  if (WAITING[reason]) return WAITING[reason];
  if (reason.startsWith('not connected')) return "It couldn't be connected to the chain yet; the node keeps retrying.";
  return reason;
}

/** One verdict per chain, or null when there is nothing to say. */
function chainVerdict(s, path) {
  const c = s.chains[path];
  const configured = (s.hosted && s.hosted.configured) || [];
  if (!c) {
    if (configured.includes(path)) {
      const st = chainStatus(s, path);
      return { level: 'bad', text: "Didn't start", detail: st && st.error ? `It's in the configuration but isn't running: ${st.error}` : "It's in the configuration but isn't running. The node log says why." };
    }
    return null;
  }
  const h = c.health;
  if (!h) return { level: 'warn', text: 'No answer for this chain', detail: c.error || '' };
  if (h.phase === 'awaitingGenesis' || h.height == null) {
    const seen = s.genesisWait = s.genesisWait || {};
    seen[path] = seen[path] || s.at || Date.now();
    const waited = (s.at || Date.now()) - seen[path];
    const how = 'A chain added by its path needs a peer that hosts it; a new chain gets its first block from its parent’s miners.';
    if (waited > 3 * 60e3) return { level: 'warn', text: 'Still no first block', detail: `Waiting for ${duration(waited)}${c.peers === 0 ? ' with no peers serving it' : ''}. ${how}` };
    return { level: 'note', text: 'Waiting for its first block', detail: how };
  }
  const now = s.at || Date.now();
  const height = Number(h.height);
  const best = Number(h.bestHeaderHeight ?? h.height);
  const gap = Math.max(0, best - height);
  const p = s.progress[path] || {};
  const still = now - (p.at || now);
  const watched = now - (p.firstSeen || now);
  const rate = rateOf(s, path);
  const blockTime = s.blockTime[path];
  const cause = waitingCause(h.waiting);
  if (gap > 2) {
    if (still > 90e3 && watched > 60e3 && !(rate > 0)) {
      return {
        level: 'bad', text: `Stalled ${plural(gap, 'block')} behind`,
        detail: `No new block for ${duration(still)} while peers are at ${num(best)}. ${cause || (c.peers === 0 ? 'It has no peers to fetch from.' : 'The node keeps asking its peers.')}`,
        gap, best, height,
      };
    }
    if (rate > 0) {
      const eta = gap / rate * 1000;
      return { level: 'note', text: `Syncing: ${plural(gap, 'block')} to go`, detail: `${num(Math.round(rate * 60))} blocks a minute, about ${duration(eta)} left.`, gap, best, height, progress: best ? height / best : 0 };
    }
    return {
      level: 'note', text: `Catching up: ${plural(gap, 'block')} behind`,
      detail: blockTime ? `About ${duration(gap * blockTime)} of blocks. Last progress ${ago(p.at)}.` : `Last progress ${ago(p.at)}.`,
      gap, best, height, progress: best ? height / best : 0,
    };
  }
  if (h.waiting) return { level: 'warn', text: 'Waiting on its next block', detail: cause };
  // When the node has no peers at all, Nexus says so once for every chain.
  const isolated = s.chains.Nexus && s.chains.Nexus.peers === 0;
  if (c.peers === 0 && path !== 'Nexus' && isolated) return { level: 'quiet', text: 'no peers', detail: 'This node has no peers at all; see Nexus.' };
  if (c.peers === 0 && path !== 'Nexus') {
    return { level: 'warn', text: 'No peers', detail: "No other node is serving this chain to this one, so it won't hear about new blocks." };
  }
  if (c.peers === 0 && path === 'Nexus') {
    const hosted = ((s.hosted && s.hosted.chains) || []).length;
    return { level: 'warn', text: 'No peers', detail: `This node isn't connected to anyone, so it won't hear about new blocks${hosted ? ` on Nexus or the ${plural(hosted, 'chain')} it hosts` : ''}. Check its peers and network.` };
  }
  return null;
}

/** What the operator should look at, worst first. Empty when all is well. */
function attention(id = state.current) {
  const s = snap(id); const n = node(id);
  const items = [];
  if (s.error && s.error.status !== 401) {
    items.push({ level: 'bad', what: "Can't reach this node", why: `${s.error.message} ${s.at ? `Showing what it said ${ago(s.at)}.` : ''} Retrying ${n.nextAt ? `in ${duration(n.nextAt - Date.now())}` : 'soon'}.`, action: { label: 'Retry now', run: 'retry' } });
  }
  for (const path of chainPaths(s)) {
    const v = chainVerdict(s, path);
    if (v && (v.level === 'bad' || v.level === 'warn')) {
      items.push({ level: v.level, what: `${path}: ${v.text.toLowerCase()}`, why: v.detail, action: { label: 'Open chain', href: `#/chain/${path}` } });
    }
  }
  if (s.disk && s.disk.freeBytes != null) {
    const free = s.disk.freeBytes;
    if (free < 1e9) items.push({ level: 'bad', what: `Only ${bytes(free)} of disk left`, why: 'The node stops writing blocks when the disk fills. Free space or keep less history.', action: { label: 'Storage', href: '#/storage' } });
    else if (free < 5e9) items.push({ level: 'warn', what: `Disk is getting full: ${bytes(free)} left`, why: 'Free space, or keep less state history in Settings.', action: { label: 'Storage', href: '#/storage' } });
  }
  return items.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}
function worst(id) {
  const items = attention(id);
  if (!items.length) return null;
  return items.some((i) => i.level === 'bad') ? 'bad' : 'warn';
}
/** Nexus and every hosted chain, parent before child, plus configured
 *  chains that did not start. */
function chainPaths(s) {
  const set = new Set(['Nexus']);
  for (const c of (s.hosted && s.hosted.chains) || []) set.add(c);
  for (const c of (s.hosted && s.hosted.configured) || []) set.add(c);
  return [...set].sort((a, b) => a.localeCompare(b));
}
/** GET /config status, each chain with its `from` list even when absent. */
function configStatus(s) {
  const st = (s.config && s.config.status) || {};
  return { ...st, chains: (st.chains || []).map((c) => ({ ...c, from: c.from || [] })) };
}
const restartKeys = (s) => configStatus(s).pendingRestart || [];
/** The merged configuration (GET /config spec): what every layer says together. */
const mergedSpec = (s) => (s.config && s.config.spec) || {};
/** A chain's entry in GET /config status: the layers that list it, or the
 *  listed chains under it that keep it hosted (impliedBy). */
const chainStatus = (s, path) => (configStatus(s).chains || []).find((c) => c.path === path);

// ---------------------------------------------------------------- routing

function parseRoute() {
  let hash;
  try { hash = decodeURIComponent(location.hash.replace(/^#\/?/, '')); } catch { return { name: 'not-found', arg: '', params: {} }; }
  const [pathPart, query = ''] = hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const [name, ...rest] = pathPart.split('/');
  return { name: name || 'overview', arg: rest.join('/'), params };
}
window.addEventListener('hashchange', () => { state.route = parseRoute(); leaveLogs(); paint(true); });

const NAV = [
  { name: 'overview', label: 'Overview' },
  { name: 'logs', label: 'Logs' },
  { name: 'storage', label: 'Storage' },
  { name: 'settings', label: 'Settings' },
  { name: 'access', label: 'Access' },
  { name: 'danger', label: 'Restart and wipe' },
];

// ---------------------------------------------------------------- painting

let signInReason = '';
let dirtyForm = false;

function paint(navigated = false) {
  const n = node();
  if (!n) { paintWelcome(); return; }
  if (!n.token) { paintSignIn(); return; }
  if (!$('.shell')) {
    $('#app').innerHTML = shellHTML().s;
  }
  paintChrome();
  const main = $('main');
  const view = VIEWS[state.route.name] || VIEWS.overview;
  const editing = !navigated && (view.form || (main.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) || $('dialog[open]'));
  if (editing) {
    const slot = $('#restart-slot'); if (slot) slot.innerHTML = part(restartBannerInner());
    if (view.update) view.update();
    return;
  }
  const scroll = navigated ? 0 : window.scrollY;
  main.innerHTML = `<div class="page">${renderView(view).s}</div>`;
  applyWidths(main);
  if (view.mount) view.mount(main);
  if (navigated) { window.scrollTo(0, 0); const h = $('h1', main); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } } else window.scrollTo(0, scroll);
}
/** A view's markup; one the page can't draw says so instead of blanking the page. */
function renderView(view) {
  try { return view.render(); } catch (e) {
    console.error(e);
    return html`<div class="banner bad" role="alert">${raw(ICON.bad)}<div class="grow"><strong>This page couldn't be shown.</strong> The node said something it didn't expect (${e.message}). The other pages still work.</div></div>`;
  }
}
function applyWidths(root) { for (const el of $$('[data-w]', root)) el.style.width = el.dataset.w; }

function shellHTML() {
  return html`<div class="shell">
    <aside class="rail" aria-label="Node"></aside>
    <div class="col">
      <header class="topbar"></header>
      <main id="main" tabindex="-1"></main>
    </div>
  </div>`;
}

function paintChrome() {
  if (!$('.shell')) return;
  const rail = $('.rail'); const top = $('.topbar');
  if (!rail.contains(document.activeElement)) rail.innerHTML = railHTML().s;
  if (!top.contains(document.activeElement)) top.innerHTML = topHTML().s;
  paintFreshness();
}
function navLinks(mobile) {
  const s = snap(); const route = state.route.name === 'chain' ? 'overview' : state.route.name;
  const w = worst(state.current);
  return NAV.map((item) => {
    let badge = '';
    if (item.name === 'overview' && w) badge = html`<span class="flag ${w === 'bad' ? 'bad' : ''}" aria-hidden="true"></span><span class="visually-hidden">(needs attention)</span>`;
    if (item.name === 'settings' && restartKeys(s).length) badge = html`<span class="flag" aria-hidden="true"></span><span class="visually-hidden">(restart needed)</span>`;
    return html`<a href="#/${item.name === 'overview' ? '' : item.name}" ${raw(route === item.name ? 'aria-current="page"' : '')}>${item.label}${mobile ? badge : html`<span>${badge}</span>`}</a>`;
  });
}
function switcherHTML(id) {
  if (state.nodes.length < 2) return '';
  return html`<label for="${id}" class="visually-hidden">Node</label>
    <select id="${id}" data-switch>${state.nodes.map((n) => html`<option value="${n.id}" ${raw(n.id === state.current ? 'selected' : '')}>${n.name}${worst(n.id) ? ' (needs attention)' : ''}</option>`)}</select>`;
}
function railHTML() {
  const fleet = state.nodes.length > 1;
  return html`<div class="brand">${raw(ICON.mark)} Lattice</div>
    ${fleet ? html`<div class="switcher">${switcherHTML('switch-rail')}<a class="small" href="#/nodes">All nodes</a></div>` : html`<div class="node-label">${node().name}</div>`}
    <nav class="nav" aria-label="Sections">${navLinks(false)}</nav>
    <div class="rail-foot">
      <span id="fresh-rail"></span>
      ${fleet ? '' : html`<a href="#/nodes">Add another node</a>`}
      <button type="button" class="quiet small" data-signout>Sign out</button>
      ${fleet ? html`<button type="button" class="quiet small" data-signout-all>Sign out of all nodes</button>` : ''}
    </div>`;
}
function topHTML() {
  return html`<div class="brand-line"><span class="brand">${raw(ICON.mark)} ${state.nodes.length > 1 ? '' : node().name}</span>${switcherHTML('switch-top')}<span id="fresh-top"></span></div>
    <nav aria-label="Sections">${navLinks(true)}${state.nodes.length > 1 ? html`<a href="#/nodes" ${raw(state.route.name === 'nodes' ? 'aria-current="page"' : '')}>All nodes</a>` : ''}</nav>`;
}
function freshnessHTML() {
  const s = snap();
  if (s.error && s.at) return html`<span class="fresh stale"><span class="dot"></span>Offline: last heard ${ago(s.at)}</span>`;
  if (s.error) return html`<span class="fresh stale"><span class="dot"></span>Not reachable</span>`;
  if (s.busy && (!s.at || s.restored)) return html`<span class="fresh busy"><span class="dot"></span>Updating…</span>`;
  if (!s.at) return html`<span class="fresh busy"><span class="dot"></span>Loading…</span>`;
  return html`<span class="fresh ${s.busy ? 'busy' : ''}"><span class="dot"></span>Updated ${ago(s.at)}</span>`;
}
function paintFreshness() {
  for (const id of ['fresh-rail', 'fresh-top']) { const el = document.getElementById(id); if (el) el.innerHTML = freshnessHTML().s; }
}
setInterval(paintFreshness, 1000);

/** The restart banner, shown on every page while a written key waits. */
function restartBanner() {
  return html`<div id="restart-slot">${restartBannerInner()}</div>`;
}
/** The settings layer this page writes: config.d/operator.json, the one
 *  people and `lattice config set` write. */
const FRAGMENT = 'operator';
const FRAGMENT_ROUTE = '/config/fragments/{name}';
const FRAGMENT_PATH = `/config/fragments/${FRAGMENT}`;
/** Whether this credential may make `route` (`METHOD /pattern`, as the node
 *  registers it, a parameter in braces), or, with `concrete`, that one
 *  request path. As the node checks a route list: the listed route is the
 *  pattern verbatim or the concrete path, its method in any case. Unknown
 *  until /whoami answers: offered, and the node decides. */
function allows(route, concrete) {
  const who = snap().who;
  if (!who || who.role === 'admin') return true;
  if (who.role === 'read') return false;
  return (who.routes || []).some((r) => {
    const listed = r.replace(/^\S+/, (m) => m.toUpperCase());
    return listed === route || (concrete !== undefined && listed === concrete);
  });
}
/** `may(route)`: that route. `may()`: changing the operator layer, which
 *  takes reading it (its version) and writing it. */
function may(route) {
  if (route !== undefined) return allows(route);
  return allows(`PUT ${FRAGMENT_ROUTE}`, `PUT ${FRAGMENT_PATH}`) && allows(`GET ${FRAGMENT_ROUTE}`, `GET ${FRAGMENT_PATH}`);
}
function writeGuard(action, route) {
  return may(route) ? '' : html`<p class="why-not">This ${snap().who.role === 'read' ? 'read-only token' : 'token'} can't ${action}.</p>`;
}
const disabledUnless = (route, action = 'change settings') => raw(may(route) ? '' : `disabled title="This token can't ${action}"`);
function restartBannerInner() {
  const keys = restartKeys(snap());
  if (!keys.length) return '';
  return html`<div class="banner" role="status">
    ${raw(ICON.warn)}
    <div class="grow"><strong>Restart needed.</strong> ${keys.length === 1 ? 'One saved setting applies' : `${keys.length} saved settings apply`} only after the node restarts: ${keys.join(', ')}.</div>
    ${may('POST /restart') ? html`<button type="button" class="primary" data-restart>Restart now</button>` : html`<span class="why-not">This token can't restart the node.</span>`}
  </div>`;
}

// ---------------------------------------------------------------- sign in

function addNodeForm(first) {
  return html`<form id="add-node" class="stack">
    <div class="field"><label for="node-url" class="label-line">Node address</label><input id="node-url" type="url" required placeholder="http://10.0.0.6:8090" spellcheck="false"><span class="hint">Its operator listener, or for a node on this machine its RPC port (http://127.0.0.1:8080).</span></div>
    <div class="field"><label for="node-name" class="label-line">Name</label><input id="node-name" type="text" placeholder="Defaults to the address" spellcheck="false"></div>
    <div class="field"><label for="node-token" class="label-line">Token</label><input id="node-token" type="password" required spellcheck="false" autocapitalize="off" placeholder="64 hexadecimal characters"></div>
    <label class="check"><input type="checkbox" id="node-remember"> Remember on this device</label>
    <p class="error" id="add-error" role="alert"></p>
    <div><button class="primary" type="submit">${first ? 'Connect' : 'Add node'}</button></div>
  </form>`;
}
const tokenHelp = () => html`<details><summary>Where do I get a token?</summary>
    <p class="mt-2">On the node's machine, make one (an admin token can change settings; a read token can only look):</p>
    <pre class="cmd">lattice tokens create dashboard --role admin --root &lt;root&gt;</pre>
    <p class="mt-2">For a node's loopback RPC port, its cookie works as the token. It changes every time the node restarts:</p>
    <pre class="cmd">cat &lt;root&gt;/chains/Nexus/.cookie</pre>
    <p class="mt-2">Either way the node must list this page's address, <code>${location.origin}</code>, as an allowed origin: <code>operatorAllowedOrigins</code> for the operator listener, <code>rpcAllowedOrigins</code> for the loopback port.</p>
  </details>`;
function paintWelcome() {
  $('#app').innerHTML = html`<div class="signin"><div class="stack">
    <div class="brand">${raw(ICON.mark)} Lattice node</div>
    <div>
      <h1>Connect to a node</h1>
      <p class="soft mt-1">Its address and a token. The token stays in this tab unless you ask this browser to remember it, and is only ever sent to that node.</p>
    </div>
    ${addNodeForm(true)}
    ${tokenHelp()}
  </div></div>`.s;
  $('#node-url').focus();
}
function paintSignIn() {
  const n = node();
  $('#app').innerHTML = html`<div class="signin"><form id="signin" autocomplete="off">
    <div class="brand">${raw(ICON.mark)} Lattice node</div>
    <div>
      <h1>Sign in to ${n.name}</h1>
      <p class="soft mt-1">Paste an operator token. It stays in this tab unless you ask this browser to remember it, and is only ever sent to this node.</p>
    </div>
    ${signInReason ? html`<p class="error" role="alert">${signInReason}</p>` : ''}
    <div class="field"><label for="token" class="label-line">Token</label>
      <input id="token" type="password" required spellcheck="false" autocapitalize="off" placeholder="64 hexadecimal characters">
    </div>
    <label class="check"><input type="checkbox" id="remember" ${raw(n.remember ? 'checked' : '')}> Remember on this device</label>
    <div class="inline"><button class="primary" type="submit">Sign in</button>${state.nodes.length > 1 ? html`<select data-switch aria-label="Another node">${state.nodes.map((o) => html`<option value="${o.id}" ${raw(o.id === n.id ? 'selected' : '')}>${o.name}</option>`)}</select>` : ''}<button type="button" class="quiet" data-forget="${n.id}">Remove this node</button></div>
    ${tokenHelp()}
  </form></div>`.s;
  $('#token').focus();
}

async function signIn(token, remember) {
  const n = node();
  n.token = cleanToken(token);
  try {
    await get(n, 'status');
  } catch (e) {
    n.token = null;
    signInReason = e.status === 401 ? "This node doesn't know that token." :
      e.status === 403 ? 'That token may not read this node’s status. Use an admin or read token.' :
      `${e.message} Check the address and that the node is running.`;
    paintSignIn();
    return;
  }
  n.remember = remember;
  signInReason = '';
  saveNodes();
  state.snaps[n.id] = state.snaps[n.id] || blankSnap();
  restoreSnap(n.id);
  snap().who = undefined;
  delete state.inflight[n.id]; // a read begun with the previous token
  $('#app').innerHTML = '';
  paint(true);
  refresh(n.id).then(() => schedule(n.id));
}
/** Every token, snapshot and setting this page stored, in both stores. */
function signOutAll() {
  for (const id of Object.keys(state.timers)) clearTimeout(state.timers[id]);
  for (const area of [local, session]) {
    if (!area) continue;
    try {
      for (const key of Object.keys(area)) if (key.startsWith('lattice.dashboard.')) area.removeItem(key);
    } catch { /* storage off */ }
  }
  state.nodes = loadNodes();
  state.snaps = {}; state.timers = {}; state.failures = {};
  state.current = null;
  $('#app').innerHTML = '';
  location.hash = '#/';
  paint(true);
}
function signOut() {
  const n = node();
  n.token = null; n.remember = false;
  store.set(local, SNAP_KEY(n.id), null); sset(SNAP_KEY(n.id), null);
  clearTimeout(state.timers[n.id]);
  saveNodes();
  $('#app').innerHTML = '';
  paint(true);
}

// ---------------------------------------------------------------- views

const VIEWS = {};

// Overview -------------------------------------------------------------

VIEWS.overview = {
  render() {
    const s = snap(); const n = node();
    const items = attention();
    return html`
      <div class="page-head"><div class="titles"><h1>${n.name}</h1>${vitalsHTML(s)}</div></div>
      ${restartBanner()}
      ${items.length ? html`<section class="attention" aria-labelledby="att-h"><h2 id="att-h">Needs attention</h2>${items.map(issueHTML)}</section>` : ''}
      <section aria-labelledby="chains-h">
        <div class="section-head"><h2 id="chains-h">Chains</h2>${may() ? html`<a class="small" href="#/settings?focus=chains">Host another chain</a>` : ''}</div>
        ${s.status ? treeHTML(s) : html`<p class="empty">Reading the node…</p>`}
      </section>`;
  },
};
function vitalsHTML(s) {
  const peers = s.metrics && s.metrics.peers != null ? s.metrics.peers : s.chains.Nexus && s.chains.Nexus.peers;
  const parts = [
    ['Version', s.status && s.status.version], // absent from a node that predates it
    ['Up for', startedAt(s) ? duration(Date.now() - startedAt(s)) : '–'],
    ['Peers', peers == null ? '–' : num(peers)],
    ['Disk free', s.disk ? bytes(s.disk.freeBytes) : '–'],
    ['Waiting transactions', s.status ? num(s.status.mempoolCount) : '–'],
  ];
  return html`<dl class="vitals">${parts.filter(([, v]) => v != null).map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}
function issueHTML(i) {
  const action = i.action ? (i.action.href ? html`<a class="button small" href="${i.action.href}">${i.action.label}</a>` : html`<button type="button" class="small" data-action="${i.action.run}">${i.action.label}</button>`) : '';
  return html`<div class="issue" role="group" aria-label="${LEVEL_WORD[i.level]}">${raw(ICON[i.level])}<div><div class="what">${i.what}</div>${i.why ? html`<div class="why">${i.why}</div>` : ''}</div><div class="act">${action}</div></div>`;
}

/** Chains as an always-open tree. A healthy row says nothing beyond its
 *  height; a row with a problem says what and since when. */
function treeHTML(s) {
  const paths = chainPaths(s);
  const children = (p) => paths.filter((c) => parentOf(c) === p);
  const problemsBelow = (p) => paths.filter((c) => c.startsWith(`${p}/`)).filter((c) => { const v = chainVerdict(s, c); return v && (v.level === 'bad' || v.level === 'warn'); }).length;
  const item = (p) => {
    const kids = children(p);
    return html`<li>${rowHTML(s, p, problemsBelow(p))}${kids.length ? html`<ul>${kids.map(item)}</ul>` : ''}</li>`;
  };
  return html`<ul class="tree">${item('Nexus')}</ul>`;
}
function rowHTML(s, path, below) {
  const c = s.chains[path]; const v = chainVerdict(s, path);
  const h = c && c.health;
  const height = h && h.height != null ? Number(h.height) : null;
  const level = v ? v.level : '';
  const last = c && c.latest && c.latest.timestamp ? Number(c.latest.timestamp) : null;
  const facts = height == null ? '' : html`<span class="h" title="Height of the newest block this node acts on">${num(height)}</span><span class="age">${last ? ago(last) : ''}</span>`;
  const name = lastSegment(path);
  // A problem the attention list explains is only named on its row.
  const covered = level === 'bad' || level === 'warn';
  return html`<a class="row ${level}" href="#/chain/${path}">
    <span class="name">${name}${level === 'quiet' && !quietAbove(s, path) ? html`<small>${v.text}</small>` : ''}</span>
    <span class="facts">${facts}</span>
    ${v && level !== 'quiet' ? html`<span class="verdict">${raw(ICON[level] || '')}${covered ? html`<span>${v.text}</span>` : html`<span><strong>${v.text}.</strong> ${v.detail || ''}</span>`}</span>` : ''}
    ${v && v.progress != null ? html`<span class="progress" role="progressbar" aria-label="Sync progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v.progress * 100)}"><i data-w="${(v.progress * 100).toFixed(1)}%"></i></span>` : ''}
    ${below && !(v && (v.level === 'bad' || v.level === 'warn')) ? html`<span class="below">${below === 1 ? 'A chain below needs attention' : `${below} chains below need attention`}</span>` : ''}
  </a>`;
}

/** A solo chain says so once, at the top of its run of solo chains. */
function quietAbove(s, path) {
  const parent = parentOf(path);
  if (!parent) return false;
  const v = chainVerdict(s, parent);
  return !!(v && v.level === 'quiet');
}

// Chain detail ------------------------------------------------------------

VIEWS.chain = {
  render() {
    const s = snap(); const path = state.route.arg || 'Nexus';
    const c = s.chains[path]; const v = chainVerdict(s, path);
    const h = c && c.health;
    const rate = rateOf(s, path);
    const last = c && c.latest && c.latest.timestamp ? Number(c.latest.timestamp) : null;
    const p = s.progress[path];
    const cfg = mergedSpec(s);
    return html`
      <a class="back" href="#/">Overview</a>
      <div class="page-head"><div class="titles"><h1>${lastSegment(path)}</h1><p class="muted">${path.split('/').join(' / ')}</p></div></div>
      ${restartBanner()}
      ${v && v.level !== 'quiet' ? html`<p class="lede ${v.level}">${raw(v.level === 'note' ? '' : ICON[v.level])} ${v.text}. <span class="lede-detail">${v.detail}</span></p>` : ''}
      ${!c ? html`<p class="prose">This chain isn't running on this node.</p>` : html`
      <dl class="facts-grid">
        <div><dt>Height</dt><dd>${h && h.height != null ? num(Number(h.height)) : '–'} ${h && h.bestHeaderHeight != null && h.bestHeaderHeight !== h.height ? html`<small>of ${num(Number(h.bestHeaderHeight))}</small>` : ''}</dd></div>
        <div><dt>Last block</dt><dd>${last ? ago(last) : '–'}</dd></div>
        <div><dt>Last progress seen</dt><dd>${p ? ago(p.at) : '–'}</dd></div>
        <div><dt>Peers serving it</dt><dd>${c.peers == null ? '–' : num(c.peers)}</dd></div>
        <div><dt>Recent pace</dt><dd>${rate == null ? html`<small>measuring…</small>` : rate > 0 ? html`${num(Math.round(rate * 60))} <small>blocks/min</small>` : '0'}</dd></div>
        <div><dt>Target block time</dt><dd>${s.blockTime[path] ? duration(s.blockTime[path]) : '–'}</dd></div>
        <div><dt>Keeps state for</dt><dd>${retention(cfg, path)}</dd></div>
        <div><dt>Waiting transactions</dt><dd>${h ? num(h.mempoolCount) : '–'}</dd></div>
      </dl>`}
      <section aria-labelledby="bt-h"><h2 id="bt-h">Time between recent blocks</h2><div id="intervals">${s.blockCache && s.blockCache[path] ? intervalsHTML(s.blockCache[path], s.blockTime[path]) : html`<p class="empty">Reading recent blocks…</p>`}</div></section>
      <section aria-labelledby="log-h">
        <div class="section-head"><h2 id="log-h">Recent log lines about this chain</h2><a class="small" href="#/logs?chain=${encodeURIComponent(path)}">All logs for ${lastSegment(path)}</a></div>
        <div id="chain-log" class="log-mini ${s.logCache && s.logCache[path] && s.logCache[path].length ? '' : 'muted'}">${s.logCache && s.logCache[path] ? (s.logCache[path].length ? s.logCache[path].join('\n') : 'Nothing about this chain in the last 3,000 lines.') : 'Reading the log…'}</div>
      </section>
      <section aria-labelledby="act-h"><h2 id="act-h">Actions</h2>${chainActions(s, path)}</section>
      <details><summary class="small">Identifiers</summary>
        <dl class="facts-grid mt-3">
          <div><dt>Newest block</dt><dd>${cidView(h && h.tipCID)}</dd></div>
          <div><dt>Network genesis</dt><dd>${cidView(h && h.nexusGenesisCID)}</dd></div>
          ${h && h.waiting ? html`<div><dt>Waiting on</dt><dd class="small">${h.waiting}</dd></div>` : ''}
        </dl>
      </details>`;
  },
  async mount() {
    const path = state.route.arg || 'Nexus';
    const n = node(); const s = snap();
    try {
      const page = await get(n, q('api/blocks?limit=25', path));
      s.blockCache = { ...(s.blockCache || {}), [path]: page.blocks };
      const box = $('#intervals'); if (box) { box.innerHTML = intervalsHTML(page.blocks, s.blockTime[path]).s; mountSpark(box); }
    } catch (e) { const box = $('#intervals'); if (box) box.innerHTML = html`<p class="empty">Couldn't read recent blocks: ${e.message}</p>`.s; }
    try {
      const text = await get(n, 'logs?tail=3000', { text: true });
      const lines = text.split('\n').filter((l) => mentions(l, path)).slice(-12);
      s.logCache = { ...(s.logCache || {}), [path]: lines };
      const box = $('#chain-log');
      if (box) { box.classList.toggle('muted', !lines.length); box.textContent = lines.length ? lines.join('\n') : 'Nothing about this chain in the last 3,000 lines.'; }
    } catch (e) { const box = $('#chain-log'); if (box) box.textContent = e.status === 404 ? "This node's log goes to its standard output, not a file the dashboard can read." : `Couldn't read the log: ${e.message}`; }
  },
};
function retention(cfg, path) {
  const mode = cfg.state || 'recent';
  if (mode === 'all') return 'All history';
  if (mode === 'none') return 'Current state only';
  const w = (cfg.stateWindows && cfg.stateWindows[path]) || cfg.stateWindow || 64;
  return `${num(w)} recent blocks`;
}
function mentions(line, path) {
  if (path === 'Nexus') return /Nexus(?![/\w])/.test(line);
  return line.includes(path) && !line.includes(`${path}/`);
}
const codeList = (list) => list.map((x) => html`<code>${x}</code>`).reduce((a, b, i) => (i ? html`${a}, ${b}` : b), raw(''));
/** Why this page can't stop hosting `path`, or '' when it can. Like
 *  `lattice child unhost`, it drops the operator layer's listing only, so
 *  it needs one to drop. */
function unhostBlocked(s, path) {
  if (s.config && s.config.flags) return 'This node was started with command-line flags; change its flags instead.';
  const st = chainStatus(s, path);
  if (!st) return s.config ? "It isn't in this node's configuration." : '';
  if (st.from.includes(FRAGMENT)) return '';
  if (st.impliedBy && st.impliedBy.length) return html`It's hosted for ${codeList(st.impliedBy)} under it. Stop hosting ${st.impliedBy.length === 1 ? 'that' : 'those'} instead.`;
  if (st.from.length) return html`It's listed in the ${codeList(st.from)} settings ${st.from.length === 1 ? 'layer' : 'layers'}, not the operator settings this page changes. Remove it there.`;
  return html`It's no longer in the configuration but did not stop${st.error ? `: ${st.error}` : ''}. Restarting the node stops it.`;
}
/** What keeps `path` hosted once the operator layer no longer lists it:
 *  another layer listing it, or a listed chain under it. '' when nothing. */
function stillHostedFor(s, path) {
  const st = chainStatus(s, path);
  if (!st) return '';
  const others = st.from.filter((f) => f !== FRAGMENT);
  if (others.length) return `still listed in ${others.join(', ')}`;
  const below = (configStatus(s).chains || []).filter((c) => c.path.startsWith(`${path}/`) && c.from.length).map((c) => c.path);
  return below.length ? `still hosted for ${below.join(', ')} under it` : '';
}
function chainActions(s, path) {
  if (path === 'Nexus') return html`<p class="prose">Nexus is the root chain; every node hosts it. To start it over from its peers, see <a href="#/danger">Restart and wipe</a>.</p>`;
  const blocked = unhostBlocked(s, path);
  const kept = blocked ? '' : stillHostedFor(s, path);
  return html`<div class="actions">
    <div class="action">
      <div class="grow"><strong>Stop hosting ${lastSegment(path)}</strong><p class="soft small">The node stops following it right away. What it stored stays, so hosting it again resumes where it left off.</p>${blocked ? html`<p class="why-not">${blocked}</p>` : ''}${kept ? html`<p class="why-not">Dropping this listing leaves it ${kept}.</p>` : ''}</div>
      <button type="button" class="danger" data-unhost="${path}" ${raw(blocked || !may() ? 'disabled' : '')}>Stop hosting</button>
    </div>
    <div class="action">
      <div class="grow"><strong>Commit a block on ${lastSegment(parentOf(path))}</strong>
      <p class="soft small mb-2">Asks ${parentOf(path)}'s miners to carry this chain's next block. It's a signed transaction, so it runs where your wallet key is, not here:</p>
      <pre class="cmd">lattice child commit ${path} --key ./wallet.json --fee 1 --root &lt;root&gt;</pre></div>
    </div>
  </div>
  ${writeGuard('stop hosting a chain')}`;
}

// Sparkline: one series (seconds between consecutive blocks), with the
// target block time as a dashed reference. Hover or focus a point for its value.
function intervalsHTML(blocks, target) {
  const rows = (blocks || []).filter((b) => b.timestamp).sort((a, b) => Number(a.height) - Number(b.height));
  const pts = [];
  for (let i = 1; i < rows.length; i += 1) pts.push({ height: Number(rows[i].height), ms: Number(rows[i].timestamp) - Number(rows[i - 1].timestamp) });
  if (pts.length < 2) return html`<p class="empty">Not enough blocks yet.</p>`;
  const W = 560; const H = 72; const pad = 6;
  const max = Math.max(...pts.map((p) => p.ms), target || 0) * 1.1 || 1;
  const x = (i) => pad + (i * (W - 2 * pad)) / (pts.length - 1);
  const y = (ms) => H - pad - (Math.max(0, ms) / max) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.ms).toFixed(1)}`).join('');
  const sorted = pts.map((p) => p.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const lastPt = pts[pts.length - 1];
  const label = `Time between the last ${pts.length} blocks: median ${duration(median)}${target ? `, target ${duration(target)}` : ''}, most recent ${duration(lastPt.ms)}.`;
  return html`<div class="spark-wrap">
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}">
      <line class="base" x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}"/>
      ${target ? html`<line class="ref" x1="0" x2="${W}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}"/>` : ''}
      <path class="line" d="${d}" vector-effect="non-scaling-stroke"/>
      <line class="cursor" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
      ${pts.map((p, i) => html`<rect class="hit" x="${(x(i) - (W / pts.length) / 2).toFixed(1)}" y="0" width="${(W / pts.length).toFixed(1)}" height="${H}" data-i="${i}" data-x="${x(i).toFixed(1)}" data-tip="Block ${num(p.height)}: ${duration(p.ms)} after the one before"/>`)}
    </svg>
    <div class="tip" hidden></div>
    <div class="spark-legend"><span>Block ${num(pts[0].height)}</span><span>Median ${duration(median)}${target ? html`, target ${duration(target)} (dashed)` : ''}</span><span>Block ${num(lastPt.height)}</span></div>
    <details class="small"><summary>Show as a table</summary>
      <table class="fleet mt-2"><thead><tr><th>Block</th><th>Seconds after the one before</th></tr></thead>
      <tbody>${pts.slice().reverse().map((p) => html`<tr><td>${num(p.height)}</td><td>${(p.ms / 1000).toFixed(1)}</td></tr>`)}</tbody></table>
    </details>
  </div>`;
}
function mountSpark(root) {
  const svg = $('svg.spark', root); const tip = $('.tip', root); const cursor = svg && $('.cursor', svg);
  if (!svg) return;
  const show = (rect) => {
    const box = svg.getBoundingClientRect(); const wrap = root.querySelector('.spark-wrap').getBoundingClientRect();
    const vx = Number(rect.dataset.x);
    const px = (vx / svg.viewBox.baseVal.width) * box.width;
    cursor.setAttribute('x1', vx); cursor.setAttribute('x2', vx); cursor.setAttribute('visibility', 'visible');
    tip.textContent = rect.dataset.tip; tip.hidden = false;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(px, half), box.width - half)}px`;
    tip.style.top = `${box.top - wrap.top}px`;
  };
  const hide = () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); };
  for (const r of $$('.hit', svg)) { r.addEventListener('mouseenter', () => show(r)); }
  svg.addEventListener('mouseleave', hide);
  // keyboard: arrow through points
  svg.tabIndex = 0;
  let at = -1; const rects = $$('.hit', svg);
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    at = at < 0 ? rects.length - 1 : Math.max(0, Math.min(rects.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)));
    show(rects[at]);
  });
  svg.addEventListener('blur', hide);
}

// Logs ------------------------------------------------------------------------

const logs = { lines: [], timer: null, follow: true, fresh: 0, filter: '', level: 'all', chain: '', error: null };
function leaveLogs() { clearTimeout(logs.timer); logs.timer = null; }
function lineLevel(l) {
  const m = l.match(/^\S+\s+(trace|debug|info|notice|warning|error|critical)\b/);
  if (m) return m[1] === 'error' || m[1] === 'critical' ? 'bad' : m[1] === 'warning' ? 'warn' : '';
  if (/\b(error|fatal|panic)\b/i.test(l)) return 'bad';
  if (/\b(fail(ed|ure|s)?|refus(ed|es)|stall(ed)?|warning)\b/i.test(l)) return 'warn';
  return '';
}
VIEWS.logs = {
  form: true,
  render() {
    const s = snap(); const p = state.route.params;
    if (p.chain !== undefined) logs.chain = p.chain;
    return html`
      <div class="page-head"><div class="titles"><h1>Logs</h1><p class="muted">The node's newest lines since it last started, kept up to date. Scroll up to pause.</p></div></div>
      ${restartBanner()}
      <div class="log-tools">
        <div class="chips" role="group" aria-label="Lines">
          <button type="button" class="chip" data-loglevel="all" aria-pressed="${String(logs.level === 'all')}">All lines</button>
          <button type="button" class="chip" data-loglevel="problems" aria-pressed="${String(logs.level === 'problems')}">Problems only</button>
        </div>
        <label class="visually-hidden" for="log-chain">Chain</label>
        <select id="log-chain"><option value="">Every chain</option>${chainPaths(s).map((c) => html`<option value="${c}" ${raw(c === logs.chain ? 'selected' : '')}>${c}</option>`)}</select>
        <label class="visually-hidden" for="log-search">Search</label>
        <input id="log-search" type="search" placeholder="Search the log" value="${logs.filter}">
        <button type="button" class="small" data-logfollow>${logs.follow ? 'Pause' : 'Follow'}</button>
      </div>
      <div class="log-wrap">
        <div class="logbox" id="logbox" tabindex="0" role="log" aria-label="Node log"></div>
        <button type="button" class="newlines primary small" data-lognew hidden></button>
      </div>
      <p class="muted small" id="log-status"></p>`;
  },
  mount() {
    const box = $('#logbox');
    box.addEventListener('scroll', () => {
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      if (atBottom && !logs.follow) { logs.follow = true; logs.fresh = 0; paintLogMeta(); }
      else if (!atBottom && logs.follow && !logs.autoScrolling) { logs.follow = false; paintLogMeta(); }
    });
    $('#log-search').addEventListener('input', (e) => { logs.filter = e.target.value; paintLog(true); });
    $('#log-chain').addEventListener('change', (e) => { logs.chain = e.target.value; paintLog(true); });
    paintLog(true);
    pollLogs();
  },
  update() { paintLogMeta(); },
};
async function pollLogs() {
  clearTimeout(logs.timer);
  const n = node();
  try {
    const text = await get(n, 'logs?tail=1500', { text: true });
    const got = text.split('\n'); if (got[got.length - 1] === '') got.pop();
    let added = got;
    if (logs.lines.length) {
      const anchor = logs.lines.slice(-3).join('\n');
      added = got;
      for (let i = got.length - 1; i >= 2; i -= 1) {
        if (got.slice(i - 2, i + 1).join('\n') === anchor) { added = got.slice(i + 1); break; }
      }
      if (added === got && got.length && logs.lines.length && got.join('\n').includes(anchor)) added = [];
    }
    if (added.length) {
      logs.lines = logs.lines.concat(added).slice(-5000);
      if (!logs.follow) logs.fresh += added.filter(matchesLog).length;
      paintLog(false);
    }
    logs.error = null;
  } catch (e) {
    logs.error = e.status === 404 ? "This node's log goes to its standard output, not a file the dashboard can read." : `Couldn't read the log: ${e.message}`;
  }
  paintLogMeta();
  if (state.route.name === 'logs') logs.timer = setTimeout(pollLogs, document.hidden ? 10000 : 2000);
}
function matchesLog(l) {
  if (logs.level === 'problems' && !lineLevel(l)) return false;
  if (logs.chain && !mentions(l, logs.chain)) return false;
  if (logs.filter && !l.toLowerCase().includes(logs.filter.toLowerCase())) return false;
  return true;
}
function highlight(line) {
  if (!logs.filter) return esc(line);
  const i = line.toLowerCase().indexOf(logs.filter.toLowerCase());
  if (i < 0) return esc(line);
  return esc(line.slice(0, i)) + '<mark>' + esc(line.slice(i, i + logs.filter.length)) + '</mark>' + highlight(line.slice(i + logs.filter.length));
}
function paintLog() {
  const box = $('#logbox'); if (!box) return;
  const shown = logs.lines.filter(matchesLog).slice(-2000);
  const keep = box.scrollTop;
  box.innerHTML = shown.length
    ? shown.map((l) => { const lv = lineLevel(l); return `<div class="ln ${lv}">${lv ? `<span class="visually-hidden">${LEVEL_WORD[lv]}: </span>` : ''}${highlight(l)}</div>`; }).join('')
    : `<div class="ln muted">${logs.lines.length ? 'No lines match.' : 'Reading…'}</div>`;
  if (logs.follow) { logs.autoScrolling = true; box.scrollTop = box.scrollHeight; requestAnimationFrame(() => { logs.autoScrolling = false; }); } else box.scrollTop = keep;
}
function paintLogMeta() {
  const btn = $('[data-lognew]'); const st = $('#log-status'); const f = $('[data-logfollow]');
  if (btn) { btn.hidden = logs.follow || !logs.fresh; btn.textContent = `${plural(logs.fresh, 'new line')} ↓`; }
  if (f) f.textContent = logs.follow ? 'Pause' : 'Follow';
  if (st) st.textContent = logs.error || (logs.follow ? `Following. ${plural(logs.lines.filter(matchesLog).length, 'line')} shown.` : 'Paused. New lines collect below.');
}

// Storage ----------------------------------------------------------------------

const STORE_GROUPS = [
  [/^state\.db/, 'Chain state', 'Accounts and balances, as many blocks back as the node keeps'],
  [/^volumes\.db/, 'Blocks and content', 'Blocks, transactions and pinned content'],
  [/^volume-bundles\.db/, 'Bundles', 'Content grouped for serving'],
];
VIEWS.storage = {
  render() {
    const s = snap(); const d = s.disk;
    const cfg = mergedSpec(s);
    const groups = [];
    if (d) {
      const by = new Map();
      for (const st of d.stores) {
        const g = STORE_GROUPS.find(([re]) => re.test(st.name)) || [null, 'Other files', 'Peers, cookie, locks'];
        const cur = by.get(g[1]) || { name: g[1], about: g[2], bytes: 0 };
        cur.bytes += st.bytes; by.set(g[1], cur);
      }
      groups.push(...[...by.values()].sort((a, b) => b.bytes - a.bytes));
    }
    const max = Math.max(1, ...groups.map((g) => g.bytes));
    return html`
      <div class="page-head"><div class="titles"><h1>Storage</h1>${d ? html`<p class="lede sub">${bytes(d.totalBytes)} used, ${bytes(d.freeBytes)} free on the data volume.</p>` : ''}</div></div>
      ${restartBanner()}
      ${d ? html`<ul class="meters" aria-label="Space by store">${groups.map((g) => html`<li><span><strong>${g.name}</strong><br><span class="muted small">${g.about}</span></span><span class="bar" aria-hidden="true"><i data-w="${((g.bytes / max) * 100).toFixed(1)}%"></i></span><span class="val">${bytes(g.bytes)}</span></li>`)}</ul>
        <p class="muted small">Data directory: <code>${d.storage}</code></p>` : html`<p class="empty">Reading…</p>`}
      <section aria-labelledby="ret-h">
        <div class="section-head"><h2 id="ret-h">What the node keeps</h2>${may() ? html`<a class="small" href="#/settings?focus=retention">Change in Settings</a>` : ''}</div>
        <dl class="facts-grid">
          <div><dt>State</dt><dd>${retention(cfg, 'Nexus')}</dd></div>
          <div><dt>Block bodies</dt><dd>${cfg.blockBodies === 'none' ? 'Not kept after use' : 'All'}</dd></div>
          <div><dt>Finality window</dt><dd>${cfg.finalityWindow ? `${num(cfg.finalityWindow)} blocks` : 'Off'}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="pins-h"><h2 id="pins-h">Pinned content</h2><div id="pins">${pinsHTML(s.pinsCache)}</div></section>`;
  },
  async mount() {
    const s = snap();
    try {
      s.pinsCache = { pins: (await get(node(), 'pins')).pins };
    } catch (e) {
      s.pinsCache = { error: e.status === 403 || e.status === 404 ? 'Pins are managed on the node’s own loopback port, not through this listener.' : e.message };
    }
    const box = $('#pins'); if (box) box.innerHTML = pinsHTML(s.pinsCache).s;
  },
};
function pinsHTML(c) {
  if (!c) return html`<p class="empty">Reading…</p>`;
  if (c.error) return html`<p class="empty">${c.error}</p>`;
  return c.pins.length
    ? html`<p class="muted small">Kept and served until you unpin them, whatever the node otherwise keeps.</p><ul class="list">${c.pins.map((cid) => html`<li><span class="grow">${cidView(cid)}</span><button type="button" class="small danger" data-unpin="${cid}" ${disabledUnless('DELETE /pins/{cid}', 'unpin')}>Unpin</button></li>`)}</ul>`
    : html`<p class="empty">Nothing is pinned. Apps pin content with <code>lattice pins add</code>.</p>`;
}

// Settings ------------------------------------------------------------------

const LIVE_KEYS = new Set(['hostedChains', 'peers']);
// original: the operator layer as read; etag: its version, sent back as If-Match.
const settings = { tab: 'form', original: null, etag: null, draft: null, review: null, result: null, rawError: null };
function isLive(key, patch) {
  if (key === 'peers') {
    const p = patch && patch.peers;
    return !(Array.isArray(p) || p === null || (isPlainObject(p) && 'Nexus' in p));
  }
  return LIVE_KEYS.has(key);
}
function liveTag(key, patch) {
  return isLive(key, patch) ? html`<span class="tag live">Applies now</span>` : html`<span class="tag restart">Needs restart</span>`;
}
/** RFC 7396 merge patch turning `from` into `to`. */
function mergePatch(from, to) {
  const patch = {};
  for (const k of Object.keys(to)) {
    if (deepEqual(from[k], to[k])) continue;
    if (isPlainObject(from[k]) && isPlainObject(to[k])) {
      const inner = mergePatch(from[k], to[k]);
      if (Object.keys(inner).length) patch[k] = inner;
    } else patch[k] = clone(to[k]);
  }
  for (const k of Object.keys(from)) if (!(k in to)) patch[k] = null;
  return patch;
}
/** `target` with RFC 7396 merge patch `patch` applied. */
function applyPatch(target, patch) {
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = isPlainObject(v) ? applyPatch(out[k], v) : clone(v);
  }
  return out;
}
function flatten(patch, from, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(patch)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const old = from ? from[k] : undefined;
    if (isPlainObject(v) && isPlainObject(old)) out.push(...flatten(v, old, key));
    else out.push({ key, old, value: v });
  }
  return out;
}
const show = (v) => (v === undefined || v === null ? '(not set)' : typeof v === 'string' ? v : JSON.stringify(v));
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, value) {
  const keys = path.split('.');
  const holders = [obj];
  for (const k of keys.slice(0, -1)) { const o = holders[holders.length - 1]; if (!isPlainObject(o[k])) o[k] = {}; holders.push(o[k]); }
  const last = keys[keys.length - 1];
  const target = holders[holders.length - 1];
  if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete target[last]; else target[last] = value;
  // An object left empty goes with its last member.
  for (let i = holders.length - 1; i > 0; i -= 1) {
    if (Object.keys(holders[i]).length) break;
    delete holders[i - 1][keys[i - 1]];
  }
}

const FIELDS = [
  { group: 'retention', key: 'state', label: 'State to keep', type: 'select', options: [['', 'Recent blocks (default)'], ['all', 'All history'], ['recent', 'Recent blocks'], ['none', 'Current state only']], hint: 'Older state is what lets the node answer questions about past blocks.' },
  { group: 'retention', key: 'stateWindow', label: 'Recent window', type: 'number', unit: 'blocks', placeholder: '64', hint: 'How many recent blocks of state to keep. Setting it chooses "Recent blocks".' },
  { group: 'retention', key: 'blockBodies', label: 'Block bodies', type: 'select', options: [['', 'Keep all (default)'], ['all', 'Keep all'], ['none', 'Drop after use']] },
  { group: 'retention', key: 'finalityWindow', label: 'Finality window', type: 'number', unit: 'blocks', placeholder: 'Off', hint: 'Ignore forks deeper than this. Empty is off.' },
  { group: 'serving', key: 'publicReadURL', label: 'Public read address', type: 'url', placeholder: 'https://reads.example.org', hint: 'Told to other nodes and explorers as where to read these chains.' },
  { group: 'serving', key: 'publicRead', label: 'Public read port', type: 'number', placeholder: 'Off' },
  { group: 'serving', key: 'servingMaxConcurrent', label: 'Content served at once', type: 'number', unit: 'requests', placeholder: 'Default' },
  { group: 'serving', key: 'servingMaxInFlightVolumeBytes', label: 'Content in flight', type: 'number', unit: 'bytes', placeholder: '128000000' },
  { group: 'serving', key: 'publicReadFetches', label: 'Peer reads for public readers', type: 'number', placeholder: '4', hint: '0 serves only what this node holds.' },
];

VIEWS.settings = {
  form: true,
  render() {
    const s = snap();
    if (s.config && s.config.flags) return html`<div class="page-head"><div class="titles"><h1>Settings</h1></div></div><p class="prose">This node was started with command-line flags, so it has no configuration file to change here. Start it with <code>lattice up</code> (a root made by <code>lattice init</code>) to manage settings from the dashboard.</p>`;
    if (!settings.original) {
      return html`<div class="page-head"><div class="titles"><h1>Settings</h1></div></div><p class="empty">Reading the configuration…</p>`;
    }
    const patch = mergePatch(settings.original, settings.draft || {});
    const changes = flatten(patch, settings.original);
    const st = configStatus(s);
    const layers = (s.config && s.config.fragments) || [];
    return html`
      <div class="page-head"><div class="titles"><h1>Settings</h1><p class="muted">The node reads <code>lattice.json</code> and then each layer in <code>config.d</code>, in name order${layers.length ? html` (${layers.join(', ')})` : ''}. This page changes the <code>operator</code> layer. A later layer's value wins; lists such as chains and peers combine every layer's. Some changes apply at once; the rest wait for a restart, and each one says which.</p></div></div>
      ${restartBanner()}
      ${(st.errors || []).length ? html`<div class="banner bad" role="alert">${raw(ICON.bad)}<div class="grow"><strong>The node isn't running the configuration as written.</strong><ul class="failures">${st.errors.map((x) => html`<li>${x}</li>`)}</ul></div></div>` : ''}
      ${(st.inert || []).length ? html`<div class="banner info" role="status"><div class="grow"><strong>Set but not in use:</strong><ul class="failures">${st.inert.map((x) => html`<li>${x}</li>`)}</ul></div></div>` : ''}
      ${writeGuard('change settings')}
      <div class="tabs" role="tablist"><button type="button" role="tab" data-tab="form" aria-selected="${String(settings.tab === 'form')}">Common settings</button><button type="button" role="tab" data-tab="raw" aria-selected="${String(settings.tab === 'raw')}">Raw JSON</button></div>
      ${settings.result ? resultHTML() : ''}
      ${settings.tab === 'form' ? settingsForm(s) : rawForm()}
      ${changes.length && !settings.review ? html`<div class="staged" role="region" aria-label="Unsaved changes"><span class="grow"><strong>${plural(changes.length, 'change')}</strong> not applied yet.</span><button type="button" class="quiet" data-discard>Discard</button><button type="button" class="primary" data-review ${disabledUnless()}>Review changes</button></div>` : ''}
      ${settings.review ? reviewHTML(changes, patch) : ''}`;
  },
  mount(main) {
    const s = snap();
    if (!settings.original && s.config && !s.config.flags) loadSettings();
    const focus = state.route.params.focus;
    if (focus) { const el = document.getElementById(`set-${focus}`); if (el) el.scrollIntoView({ block: 'start' }); }
    main.addEventListener('input', onSettingsInput);
    main.addEventListener('change', onSettingsInput);
  },
  // Opened before the first read of the node answered: read it once it has.
  update() {
    const s = snap();
    if (!settings.original && !settings.loading && s.config && !s.config.flags) loadSettings();
  },
};
/** The operator layer as it is, and its version: {} and null when there is none yet. */
async function readFragment(n) {
  const r = await api(n, `config/fragments/${FRAGMENT}`, { accept: [404] });
  return r.status === 404 ? { body: {}, etag: null } : { body: isPlainObject(r.data) ? r.data : {}, etag: r.etag };
}
/** Writes the operator layer only while it is still the version read
 *  (If-Match), or, read as none, while there still is none (If-None-Match).
 *  412 when someone else wrote it first. Answers as GET /config. */
async function putFragment(n, body, etag) {
  // Hosting a chain starts it before the node answers: give it time.
  return get(n, `config/fragments/${FRAGMENT}`, { method: 'PUT', body, timeout: 60000, headers: etag ? { 'If-Match': etag } : { 'If-None-Match': '*' } });
}
/** Reads the configuration and the operator layer. With keepEdits, unsaved
 *  edits are carried onto the layer as read, as long as they still apply. */
async function loadSettings({ keepEdits = false } = {}) {
  const n = node();
  settings.loading = true;
  try {
    const [config, frag] = await Promise.all([get(n, 'config'), readFragment(n)]);
    snap().config = config;
    const pending = keepEdits && settings.original ? mergePatch(settings.original, settings.draft || {}) : {};
    settings.original = frag.body; settings.etag = frag.etag;
    settings.draft = applyPatch(frag.body, pending); settings.review = null;
  } catch (e) { toast(`Couldn't read settings: ${e.message}`); }
  settings.loading = false;
  if (state.route.name === 'settings') rerender();
}
function rerender() {
  const main = $('main'); const view = VIEWS[state.route.name];
  if (!main || !view) return;
  const y = window.scrollY;
  main.innerHTML = `<div class="page">${renderView(view).s}</div>`;
  applyWidths(main);
  window.scrollTo(0, y);
}
function fieldHTML(f) {
  const d = settings.draft || {}; const o = settings.original || {};
  const value = getPath(d, f.key);
  const changed = !deepEqual(value, getPath(o, f.key));
  const merged = getPath(mergedSpec(snap()), f.key);
  const elsewhere = merged !== undefined && !deepEqual(merged, getPath(o, f.key));
  const id = `f-${f.key.replace(/\W/g, '-')}`;
  let control;
  if (f.type === 'select') control = html`<select id="${id}" data-key="${f.key}" data-type="select">${f.options.map(([v, l]) => html`<option value="${v}" ${raw((value ?? '') === v ? 'selected' : '')}>${l}</option>`)}</select>`;
  else control = html`<input id="${id}" type="${f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}" ${raw(f.type === 'number' ? 'min="0" inputmode="numeric"' : '')} data-key="${f.key}" data-type="${f.type}" value="${value ?? ''}" placeholder="${f.placeholder || ''}">`;
  return html`<div class="field ${changed ? 'changed' : ''}"><label for="${id}" class="label-line">${f.label}${f.unit ? html`<span class="muted small">${f.unit}</span>` : ''} ${liveTag(f.key)}</label>${control}${elsewhere ? html`<span class="hint">In effect: ${show(merged)}, set in another layer.</span>` : ''}${f.hint ? html`<span class="hint">${f.hint}</span>` : ''}</div>`;
}
const peersOf = (v) => (Array.isArray(v) ? { Nexus: v } : (v || {}));
/** What other layers add to a list this layer sets: the merged list less this layer's. */
const fromOthers = (merged, mine) => (merged || []).filter((x) => !(mine || []).includes(x));
function settingsForm(s) {
  const d = settings.draft || {}; const o = settings.original || {};
  const spec = mergedSpec(s);
  const peers = peersOf(d.peers);
  const chains = ['Nexus', ...(spec.hostedChains || [])];
  const ro = disabledUnless();
  const origins = d.operatorAllowedOrigins || [];
  const otherOrigins = fromOthers(spec.operatorAllowedOrigins, o.operatorAllowedOrigins);
  return html`
    ${chainsSection(s)}
    <section id="set-peers" aria-labelledby="sp-h">
      <div class="section-head"><h2 id="sp-h">Peers</h2></div>
      <p class="prose small">Nodes to connect to, one per line, as <code>publicKey@host:port</code>.</p>
      <div class="form-grid">${chains.map((c) => {
        const id = `peers-${c.replace(/\W/g, '-')}`; const v = (peers[c] || []).join('\n');
        const was = peersOf(o.peers)[c] || [];
        const others = fromOthers(peersOf(spec.peers)[c], was);
        return html`<div class="field ${same(peers[c] || [], was) ? '' : 'changed'}"><label for="${id}" class="label-line">${c} ${c === 'Nexus' ? html`<span class="tag restart">Needs restart</span>` : html`<span class="tag live">Applies now</span>`}</label><textarea id="${id}" rows="3" data-peers="${c}" spellcheck="false" ${ro}>${v}</textarea>${others.length ? html`<span class="hint">Also from other layers: ${others.join(', ')}</span>` : ''}</div>`;
      })}</div>
    </section>
    <section id="set-retention" aria-labelledby="sr-h"><h2 id="sr-h">What the node keeps</h2><div class="form-grid">${FIELDS.filter((f) => f.group === 'retention').map(fieldHTML)}</div></section>
    <section id="set-serving" aria-labelledby="sv-h"><h2 id="sv-h">Serving others</h2><div class="form-grid">${FIELDS.filter((f) => f.group === 'serving').map(fieldHTML)}</div></section>
    <section id="set-access" aria-labelledby="sa-h">
      <div class="section-head"><h2 id="sa-h">Dashboards allowed to connect</h2>${liveTag('operatorAllowedOrigins')}</div>
      <p class="prose small">A dashboard page can manage this node only if its address is listed here, one per line, exactly as the browser shows it (for example <code>${location.origin}</code>, this page's). Removing this page's address disconnects it.</p>
      <div class="field ${same(origins, o.operatorAllowedOrigins || []) ? '' : 'changed'}"><label class="visually-hidden" for="origins">Allowed dashboard addresses</label><textarea id="origins" rows="3" data-lines="operatorAllowedOrigins" spellcheck="false" ${ro}>${origins.join('\n')}</textarea>${otherOrigins.length ? html`<span class="hint">Also from other layers: ${otherOrigins.join(', ')}</span>` : ''}</div>
    </section>`;
}
/** The chains the configuration hosts, each with what keeps it hosted.
 *  Hosting, creating and stopping apply at once, apart from the staged edits. */
function chainsSection(s) {
  const list = configStatus(s).chains || [];
  const ro = disabledUnless();
  const why = (c) => (c.from.length ? html`Listed in ${c.from.join(', ')}`
    : c.impliedBy && c.impliedBy.length ? html`Hosted for ${c.impliedBy.join(', ')}, under it`
      : html`No longer configured`);
  return html`<section id="set-chains" aria-labelledby="sc-h">
      <div class="section-head"><h2 id="sc-h">Chains this node hosts</h2>${liveTag('hostedChains')}</div>
      <p class="prose small">Nexus is always hosted. Hosting a chain also hosts the chains above it, down from Nexus. A chain is synced from peers that host it, or mined here if it was created on this node. These changes take effect as soon as you make them.</p>
      <ul class="list">${list.length ? list.map((c) => {
        const blocked = unhostBlocked(s, c.path);
        const kept = blocked ? '' : stillHostedFor(s, c.path);
        return html`<li><span class="grow"><strong>${c.path}</strong><br><span class="muted small">${why(c)}${c.actual === 'hosted' ? '' : html`. Not running`}${c.error ? `: ${c.error}` : ''}</span>${blocked ? html`<br><span class="why-not">${blocked}</span>` : ''}${kept ? html`<br><span class="why-not">Stopping here leaves it ${kept}.</span>` : ''}</span><button type="button" class="small" data-unhost="${c.path}" ${raw(blocked || !may() ? 'disabled' : '')}>Stop hosting</button></li>`;
      }) : html`<li class="muted">No chains besides Nexus.</li>`}</ul>
      <form class="inline" data-host-chain><label class="visually-hidden" for="host-chain">Chain path</label><input id="host-chain" type="text" placeholder="Nexus/Name" spellcheck="false" pattern="Nexus(/[^/\\s]+)+" ${ro}><button type="submit" ${ro}>Host chain</button></form>
      <details><summary class="small">Create a new chain</summary>
        <form class="stack mt-2" data-create-chain>
          <p class="prose small">Makes a new chain with its first block mined here, then hosts it. For policies, genesis transactions or a full spec, use <code>lattice child create</code>.</p>
          <div class="form-grid">
            <div class="field"><label for="cc-path" class="label-line">Path</label><input id="cc-path" type="text" required placeholder="Nexus/Name" spellcheck="false" pattern="Nexus(/[^/\\s]+)+"></div>
            <div class="field"><label for="cc-time" class="label-line">Target block time <span class="muted small">ms</span></label><input id="cc-time" type="number" min="1" required value="10000"></div>
            <div class="field"><label for="cc-reward" class="label-line">Block reward</label><input id="cc-reward" type="number" min="0" required value="1000"></div>
            <div class="field"><label for="cc-premine" class="label-line">Premine <span class="muted small">blocks of reward</span></label><input id="cc-premine" type="number" min="0" required value="0"></div>
            <div class="field"><label for="cc-to" class="label-line">Premine paid to</label><input id="cc-to" type="text" spellcheck="false" placeholder="Address (with a premine)"></div>
          </div>
          <div><button type="submit" ${raw(may() && may('POST /chains') ? '' : 'disabled title="This token can\'t create chains"')}>Create and host</button></div>
        </form>
      </details>
    </section>`;
}
function rawForm() {
  return html`<div class="field"><label for="raw" class="label-line">config.d/operator.json <span class="muted small">edit, then review</span></label>
    <textarea id="raw" rows="24" data-raw spellcheck="false" ${disabledUnless()}>${JSON.stringify(settings.draft, null, 2)}</textarea>
    <span class="error" id="raw-error" role="alert">${settings.rawError || ''}</span></div>`;
}
function reviewHTML(changes, patch) {
  const restart = changes.some((c) => !isLive(c.key.split('.')[0], patch));
  return html`<section class="attention review" aria-labelledby="rv-h">
    <h2 id="rv-h">Review ${plural(changes.length, 'change')}</h2>
    <div class="review-body">
      <ul class="diff">${changes.map((c) => html`<li><span class="key">${c.key}</span>${liveTag(c.key.split('.')[0], patch)}<span class="vals"><del>${show(c.old)}</del><ins>${show(c.value)}</ins></span></li>`)}</ul>
      ${restart ? html`<p class="soft small">Changes marked "Needs restart" are saved now and take effect when the node restarts. You can restart right after.</p>` : ''}
      <div class="inline"><button type="button" class="primary" data-apply>Apply ${plural(changes.length, 'change')}</button><button type="button" data-cancel-review>Keep editing</button></div>
    </div>
  </section>`;
}
function resultHTML() {
  const r = settings.result;
  if (r.error) return html`<div class="banner bad" role="alert">${raw(ICON.bad)}<div class="grow"><strong>${r.unconfirmed ? 'Not confirmed.' : 'Nothing was changed.'}</strong> ${r.error}</div><button type="button" class="quiet" data-dismiss-result>Dismiss</button></div>`;
  return html`<div class="banner info" role="status"><div class="grow">
    <strong>Saved.</strong>
    ${r.applied.length ? html` Applied now: ${r.applied.join(', ')}.` : ''}
    ${r.restartRequired.length ? html` Waiting for a restart: ${r.restartRequired.join(', ')}.` : ''}
  </div><button type="button" class="quiet" data-dismiss-result>Dismiss</button></div>`;
}
function onSettingsInput(e) {
  const t = e.target;
  if (!settings.draft || state.route.name !== 'settings') return;
  const d = settings.draft;
  if (t.dataset.raw !== undefined) {
    if (e.type !== 'input') return;
    try { const v = JSON.parse(t.value); if (!isPlainObject(v)) throw new Error('The file must be one JSON object.'); settings.draft = v; settings.rawError = null; } catch (err) { settings.rawError = err.message; }
    const errBox = $('#raw-error'); if (errBox) errBox.textContent = settings.rawError || '';
    paintStaged();
    return;
  }
  if (t.dataset.key) {
    let v;
    if (t.dataset.type === 'number') v = t.value === '' ? undefined : Number(t.value);
    else v = t.value.trim() === '' ? undefined : t.value.trim();
    setPath(d, t.dataset.key, v);
    // A window is only valid with state "recent"; say so in the file.
    if (t.dataset.key === 'stateWindow' && v !== undefined && !d.state) {
      d.state = 'recent';
      const sel = document.getElementById('f-state'); if (sel) { sel.value = 'recent'; sel.closest('.field').classList.add('changed'); }
    }
  } else if (t.dataset.peers) {
    const list = t.value.split('\n').map((x) => x.trim()).filter(Boolean);
    const cur = Array.isArray(d.peers) ? { Nexus: d.peers } : { ...(d.peers || {}) };
    if (list.length) cur[t.dataset.peers] = list; else delete cur[t.dataset.peers];
    const keys = Object.keys(cur);
    if (!keys.length) delete d.peers;
    else if (keys.length === 1 && keys[0] === 'Nexus' && Array.isArray(settings.original.peers)) d.peers = cur.Nexus;
    else d.peers = cur;
  } else if (t.dataset.lines) {
    const list = t.value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (list.length) d[t.dataset.lines] = list; else delete d[t.dataset.lines];
  } else return;
  const field = t.closest('.field');
  if (field) field.classList.add('changed');
  paintStaged();
}
function paintStaged() {
  const patch = mergePatch(settings.original, settings.draft || {});
  const changes = flatten(patch, settings.original);
  let bar = $('.staged');
  if (!changes.length) { if (bar) bar.remove(); return; }
  if (settings.review) return;
  const markup = html`<span class="grow"><strong>${plural(changes.length, 'change')}</strong> not applied yet.</span><button type="button" class="quiet" data-discard>Discard</button><button type="button" class="primary" data-review ${disabledUnless()}>Review changes</button>`.s;
  if (!bar) { bar = document.createElement('div'); bar.className = 'staged'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Unsaved changes'); $('main .page').append(bar); }
  bar.innerHTML = markup;
}
async function applySettings() {
  const patch = mergePatch(settings.original, settings.draft);
  const btn = $('[data-apply]'); if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
  try {
    const config = await putFragment(node(), settings.draft, settings.etag);
    snap().config = config;
    settings.result = { applied: Object.keys(patch).filter((k) => isLive(k, patch)), restartRequired: (config.status && config.status.pendingRestart) || [] };
    toast('Settings saved');
    await loadSettings();
  } catch (e) {
    if (e.status === 412) {
      settings.result = { error: 'Someone else changed these settings since this page read them (another dashboard, or lattice config set). They are reloaded below with that change. Make yours again.' };
      await loadSettings();
    } else {
      settings.result = e.timedOut ? { error: 'The node did not answer in time. The change may still apply; reload this page to see what it reports.', unconfirmed: true } : { error: e.message };
      settings.review = null;
    }
  }
  rerender();
  paintChrome();
  refresh(state.current);
}

/** Hosting changes, made at once: the operator layer is read, changed by
 *  `edit` and written back only if no one wrote it in between; when someone
 *  did, it is read and changed again, as `lattice child host` does. `done`
 *  says what happened, given GET /config as it is after. Unsaved edits on
 *  the Settings page are kept. */
async function changeHosting(edit, done, failed = (m) => `Nothing was changed: ${m}`) {
  const n = node();
  try {
    for (let attempt = 0; ; attempt += 1) {
      const { body, etag } = await readFragment(n);
      const next = clone(body);
      edit(next);
      try {
        snap().config = await putFragment(n, next, etag);
        break;
      } catch (e) { if (e.status !== 412 || attempt >= 4) throw e; }
    }
    toast(done(snap()));
  } catch (e) {
    toast(e.status === 412 ? failed('the operator settings kept changing while this page wrote them; try again.')
      : e.timedOut ? 'The node did not answer in time. The change may still apply; this page shows what it reports.' : failed(e.message));
    return false;
  } finally {
    if (settings.original) await loadSettings({ keepEdits: true });
    refresh(state.current);
  }
  return true;
}
const sortChains = (list) => list.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
function hostPath(path, failed) {
  return changeHosting((f) => { f.hostedChains = sortChains([...new Set([...(f.hostedChains || []), path])]); }, () => `Hosting ${path}`, failed);
}

// Access (tokens) -------------------------------------------------------------

VIEWS.access = {
  form: true,
  render() {
    const s = snap();
    return html`
      <div class="page-head"><div class="titles"><h1>Access</h1><p class="muted">Tokens let a dashboard or the <code>lattice</code> command manage this node from another machine.</p></div></div>
      ${restartBanner()}
      ${s.who && s.who.role !== 'admin' ? html`<p class="prose">Only an admin token can see or change tokens; this one can't.</p>` : html`
      <section aria-labelledby="tok-h"><h2 id="tok-h">Tokens</h2><div id="tokens"><p class="empty">Reading…</p></div></section>
      <section aria-labelledby="new-h">
        <h2 id="new-h">Make a token</h2>
        <form id="new-token" class="stack">
          <div class="field"><label for="tok-name" class="label-line">Name</label><input id="tok-name" type="text" required pattern="[^/]+" placeholder="laptop, seller, monitoring" spellcheck="false"><span class="hint">So you can tell tokens apart later. No slashes.</span></div>
          <fieldset class="radio-group"><legend>It may</legend>
            <label><input type="radio" name="role" value="admin" checked> <span><strong>Do everything</strong><br><span class="soft small">Change settings, restart, wipe, make tokens.</span></span></label>
            <label><input type="radio" name="role" value="read"> <span><strong>Look, not change</strong><br><span class="soft small">Every read, nothing that changes the node.</span></span></label>
            <label><input type="radio" name="role" value="routes"> <span><strong>Use only some routes</strong><br><span class="soft small">For a program that needs one or two things.</span></span></label>
          </fieldset>
          <div class="field" id="routes-field" hidden><label for="tok-routes" class="label-line">Routes, one per line</label><textarea id="tok-routes" rows="3" placeholder="GET /config&#10;PUT /config/fragments/hostmarket" spellcheck="false"></textarea></div>
          <div><button class="primary" type="submit">Make token</button></div>
        </form>
      </section>`}
      <section aria-labelledby="org-h">
        <h2 id="org-h">Dashboards allowed to connect</h2>
        <p class="prose small">${originsSentence(s)} <a href="#/settings?focus=access">Change in Settings</a>.</p>
      </section>`;
  },
  mount() { const w = snap().who; if (!w || w.role === 'admin') loadTokens(); },
};
function originsSentence(s) {
  const list = mergedSpec(s).operatorAllowedOrigins || [];
  return list.length ? `Dashboards at ${list.join(', ')} may connect.` : 'No dashboard is listed; a browser page cannot connect.';
}
async function loadTokens() {
  const box = $('#tokens'); if (!box) return;
  try {
    const r = await get(node(), 'tokens');
    box.innerHTML = r.tokens.length ? html`<ul class="list">${r.tokens.map((t) => html`<li><span class="grow"><strong>${t.name}</strong> <span class="muted small">${t.role === 'admin' ? 'Does everything' : t.role === 'read' ? 'Looks, not changes' : `Only ${(t.routes || []).join(', ')}`}</span></span><button type="button" class="small danger" data-revoke="${t.name}">Revoke</button></li>`)}</ul>`.s : html`<p class="empty">No tokens yet.</p>`.s;
  } catch (e) {
    box.innerHTML = html`<p class="empty">${e.status === 409 ? 'This node has no token file yet. Set operatorListen and operatorTokens in Settings, restart, then make tokens here.' : e.message}</p>`.s;
  }
}

// Restart and wipe ---------------------------------------------------------------

const restartSeconds = () => lget(`lattice.dashboard.restart.${state.current}`, 10);
VIEWS.danger = {
  form: true,
  render() {
    const s = snap(); const n = node();
    return html`
      <div class="page-head"><div class="titles"><h1>Restart and wipe</h1></div></div>
      ${restartBanner()}
      ${!may('POST /restart') && !may('POST /stop') && !may('POST /wipe') ? writeGuard('restart, stop or wipe this node', 'POST /restart') : html`${writeGuard('restart this node', 'POST /restart')}${writeGuard('stop this node', 'POST /stop')}${writeGuard('wipe this node', 'POST /wipe')}`}
      <p class="prose">The node never starts itself. When it's asked to restart, it exits and whatever runs it (systemd, launchd, Docker, the desktop app) starts it again. A node run by hand, such as <code>lattice up</code> in a terminal, has nothing to start it again: after a restart or a wipe it stays stopped until someone starts it.</p>
      <section aria-labelledby="rs-h">
        <h2 id="rs-h">Restart the node</h2>
        <p class="prose">The node exits and its process manager starts it again, reading its settings afresh. It's offline for about ${restartSeconds()} seconds; every chain then resumes where it was.${restartKeys(s).length ? ` This applies ${restartKeys(s).join(', ')}.` : ''}</p>
        <div><button type="button" data-restart ${disabledUnless('POST /restart', 'restart the node')}>Restart…</button></div>
      </section>
      <section aria-labelledby="st-h" class="ruled">
        <h2 id="st-h">Stop the node</h2>
        <p class="prose">The node exits and its process manager leaves it stopped. This page can't start it again: start it on its machine (<code>lattice up</code>, or its service).</p>
        <div><button type="button" class="danger" data-stop ${disabledUnless('POST /stop', 'stop the node')}>Stop…</button></div>
      </section>
      <section aria-labelledby="wp-h" class="ruled">
        <h2 id="wp-h">Wipe chain data</h2>
        <div class="prose"><p>Deletes everything this node stored for every chain, then restarts. It downloads Nexus again from its peers, and each hosted chain from that chain's peers. That can take a long time.</p>
        <p><strong>Kept:</strong> the node's identity, its settings, chain specs and tokens. <strong>Deleted:</strong> blocks, state, and pinned content.</p></div>
        <div><button type="button" class="danger" data-wipe ${disabledUnless('POST /wipe', 'wipe the node')} ${raw(s.config && s.config.flags ? 'disabled' : '')}>Wipe…</button></div>
        ${s.config && s.config.flags ? html`<p class="why-not">A wipe needs a node started with <code>lattice up</code>.</p>` : ''}
      </section>
      <p class="muted small">This node: ${n.name}</p>`;
  },
};

// Fleet ------------------------------------------------------------------------

function fleetTable() {
    const rows = state.nodes.map((n) => {
      const s = snap(n.id); const w = n.token ? worst(n.id) : null;
      const items = n.token ? attention(n.id) : [];
      const h = s.status;
      return { n, s, w, items, h, rank: !n.token ? 1 : w === 'bad' ? 0 : w === 'warn' ? 0.5 : 2 };
    }).sort((a, b) => a.rank - b.rank);
    return state.nodes.length ? html`<table class="fleet"><thead><tr><th>Node</th><th>Status</th><th class="hide-narrow num">Nexus height</th><th class="hide-narrow num">Last heard</th></tr></thead><tbody>
        ${rows.map(({ n, s, w, items, h }) => html`<tr class="${n.id === state.current ? 'current' : ''}">
          <td><a href="#/" data-switch-to="${n.id}"><strong>${n.name}</strong></a><br><span class="muted small">${n.url}</span></td>
          <td>${!n.token ? html`<span class="soft">Not signed in</span>` : w ? html`<span class="flagged">${raw(ICON[w])}<span>${items[0].what}${items.length > 1 ? html` <span class="muted">and ${items.length - 1} more</span>` : ''}</span></span>` : html`<span class="muted">${s.at ? '' : 'Reading…'}</span>`}</td>
          <td class="num hide-narrow">${h ? num(Number(h.height)) : '–'}</td>
          <td class="num hide-narrow">${s.at ? ago(s.at) : '–'}</td>
        </tr>`)}
      </tbody></table>` : '';
}
VIEWS.nodes = {
  form: true,
  update() { const box = $('#fleet-table'); if (box) box.innerHTML = part(fleetTable()); },
  render() {
    return html`
      <div class="page-head"><div class="titles"><h1>All nodes</h1><p class="muted">Problems first. Added nodes and their tokens are stored in this browser only.</p></div></div>
      <div id="fleet-table">${fleetTable()}</div>
      <section aria-labelledby="add-h">
        <h2 id="add-h">Add a node</h2>
        <p class="prose small">The node must list this page's address, <code>${location.origin}</code>, as an allowed origin (<code>operatorAllowedOrigins</code>, or <code>rpcAllowedOrigins</code> for a loopback RPC port).</p>
        ${addNodeForm(false)}
      </section>
      ${state.nodes.length ? html`<section aria-labelledby="rm-h"><h2 id="rm-h">Remove a node from this browser</h2><ul class="list">${state.nodes.map((n) => html`<li><span class="grow">${n.name}</span><button type="button" class="small" data-forget="${n.id}">Remove</button></li>`)}</ul>
        <p class="mt-1"><button type="button" data-signout-all>Sign out of all nodes</button></p><p class="soft small">Forgets every node and token this browser kept for the dashboard.</p></section>` : ''}`;
  },
};

// ---------------------------------------------------------------- dialogs

function dialog({ title, body, confirm, danger = false, typed = null, cancel = true }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = html`<form method="dialog"><div class="dialog-body"><h2>${title}</h2>${raw(body.s || body)}
      ${typed ? html`<div class="field"><label for="typed" class="label-line">Type <strong>${typed}</strong> to confirm</label><input id="typed" type="text" autocomplete="off" spellcheck="false"></div>` : ''}
    </div><div class="dialog-actions">${cancel ? html`<button value="cancel" type="submit">Cancel</button>` : ''}<button value="ok" type="submit" class="${danger ? 'danger solid' : 'primary'}" ${raw(typed ? 'disabled' : '')}>${confirm}</button></div></form>`.s;
    document.body.append(d);
    if (typed) {
      const input = $('#typed', d); const ok = $('button[value="ok"]', d);
      input.addEventListener('input', () => { ok.disabled = input.value.trim() !== typed; });
    }
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    d.showModal();
    const first = typed ? $('#typed', d) : $('button[value="cancel"]', d) || $('button[value="ok"]', d);
    first.focus();
  });
}

/** Waits for the process that replaces the one asked to restart, as
 *  `lattice restart` does. With the old start time (process_start_time_seconds)
 *  known, only a different one is back: a slow answer from the old process is
 *  not. Without it (a token that may not read /metrics), the node must be
 *  seen gone (unreachable, or a 5xx; not a timeout) and then answer anything.
 *  A 401 means the loopback cookie rotated: a new process. */
async function waitForNewProcess({ before, startOf, health, deadline, offline = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const gone = (e) => (e.status === 0 && !e.timedOut) || e.status >= 500;
  let seenDown = false;
  while (now() < deadline) {
    try {
      if (before != null) {
        const start = await startOf();
        if (start != null && start !== before) return { back: true };
      } else {
        await health();
        if (seenDown) return { back: true };
      }
    } catch (e) {
      if (e.status === 401) return { back: true, cookieChanged: true };
      if (gone(e)) { seenDown = true; offline(); } else if (before == null && seenDown && e.status) return { back: true };
    }
    await sleep(1000);
  }
  return { back: false };
}

async function restartFlow({ wipe = false } = {}) {
  const n = node();
  const ok = wipe
    ? await dialog({ title: `Wipe ${n.name}?`, body: html`<p class="soft">Every chain's blocks, state and pinned content on this node are deleted, and it restarts empty. It downloads everything again from its peers. Identity, settings, specs and tokens stay. Without a process manager to start it again, it stays stopped.</p>`, confirm: 'Wipe and restart', danger: true, typed: n.name })
    : await dialog({ title: `Restart ${n.name}?`, body: html`<p class="soft">It's offline for about ${restartSeconds()} seconds while its process manager starts it again. Every chain resumes where it was.${restartKeys(snap()).length ? ` It then uses the saved ${restartKeys(snap()).join(', ')}.` : ''} Without a process manager, it stays stopped.</p>`, confirm: 'Restart' });
  if (!ok) return;
  const startOf = async () => {
    const st = startMs((await get(n, 'status', { timeout: 2000 })).startedAt);
    return st != null ? st : parseMetrics(await get(n, 'metrics', { text: true, timeout: 2000 })).start;
  };
  const before = await startOf().catch(() => undefined);
  const started = Date.now();
  try {
    await api(n, wipe ? 'wipe' : 'restart', { method: 'POST', body: {} });
  } catch (e) { toast(`${wipe ? 'Wipe' : 'Restart'} refused: ${e.message}`); return; }
  const overlay = document.createElement('dialog');
  overlay.innerHTML = html`<div class="dialog-body"><h2>${wipe ? 'Wiping and restarting' : 'Restarting'} ${n.name}</h2><p class="soft" id="rs-status">Waiting for the node to stop…</p></div>`.s;
  document.body.append(overlay); overlay.showModal();
  const status = $('#rs-status', overlay);
  await new Promise((r) => setTimeout(r, 1200));
  const { back, cookieChanged } = await waitForNewProcess({
    before, startOf,
    health: () => api(n, 'health', { timeout: 2000 }),
    deadline: started + 180000,
    offline: () => { status.textContent = `Offline for ${duration(Date.now() - started)}. Waiting for it to answer…`; },
  });
  overlay.close(); overlay.remove();
  const took = Math.max(2, Math.round((Date.now() - started) / 1000));
  if (back && !wipe) lset(`lattice.dashboard.restart.${n.id}`, took);
  if (!back) { toast("The node hasn't come back after 3 minutes. If nothing restarts it (no process manager), start it on its machine; otherwise check its process manager's log."); return; }
  if (cookieChanged) {
    // The loopback cookie changes at every start.
    try { await get(n, 'status'); } catch (e) { if (e.status === 401) { n.token = null; signInReason = 'The node restarted and made a new cookie. Paste the new one.'; saveNodes(); paint(true); return; } }
  }
  if (wipe) state.snaps[n.id] = blankSnap();
  settings.original = null; settings.result = null;
  toast(wipe ? `Wiped. ${n.name} is syncing again from its peers.` : `Restarted in ${took} s.`);
  await refresh(n.id);
  paint(true);
}

async function stopFlow() {
  const n = node();
  if (!await dialog({ title: `Stop ${n.name}?`, body: html`<p class="soft">It exits and stays stopped: this page can't start it again. Start it on its machine with <code>lattice up</code> or its service.</p>`, confirm: 'Stop', danger: true, typed: n.name })) return;
  const startOf = async () => startMs((await get(n, 'status', { timeout: 2000 })).startedAt);
  const before = await startOf().catch(() => undefined);
  try { await api(n, 'stop', { method: 'POST', body: {} }); } catch (e) { toast(`Stop refused: ${e.message}`); return; }
  const started = Date.now();
  // Stopped once nothing answers. A 503 is a node still stopping; a new
  // start time (or, on the loopback port, a new cookie) is a new process.
  while (Date.now() - started < 180000) {
    try {
      const now = await startOf();
      if (before != null && now != null && now !== before) { toast(`${n.name} was started again, by its process manager.`); refresh(n.id); return; }
    } catch (e) {
      if (e.status === 0 && !e.timedOut) { toast(`${n.name} stopped.`); refresh(n.id); return; }
      if (e.status === 401) { toast(`${n.name} was started again, by its process manager.`); refresh(n.id); return; }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  toast(`${n.name} still answers 3 minutes after it was asked to stop. Check its log.`);
}

// ---------------------------------------------------------------- events

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const ds = t.dataset;
  if (ds.copy) { copy(ds.copy); return; }
  if ('signout' in ds) { signOut(); return; }
  if ('signoutAll' in ds) { signOutAll(); return; }
  if ('restart' in ds) { restartFlow(); return; }
  if ('wipe' in ds) { restartFlow({ wipe: true }); return; }
  if ('stop' in ds) { stopFlow(); return; }
  if (ds.action === 'retry') { refresh(state.current); return; }
  if ('gotoFleet' in ds) { location.hash = '#/nodes'; return; }
  if (ds.switchTo) { switchTo(ds.switchTo); return; }
  if (ds.loglevel) { logs.level = ds.loglevel; $$('[data-loglevel]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.loglevel === logs.level))); paintLog(); paintLogMeta(); return; }
  if ('logfollow' in ds) { logs.follow = !logs.follow; if (logs.follow) { logs.fresh = 0; paintLog(); } paintLogMeta(); return; }
  if ('lognew' in ds) { logs.follow = true; logs.fresh = 0; paintLog(); paintLogMeta(); return; }
  if (ds.unhost) {
    const path = ds.unhost;
    if (!await dialog({ title: `Stop hosting ${lastSegment(path)}?`, body: html`<p class="soft">This node stops following ${path} now and drops it from the operator settings. Peers set for it stay, unused. What it stored stays: hosting it again resumes it.</p>`, confirm: 'Stop hosting', danger: true })) return;
    const ok = await changeHosting((f) => {
      f.hostedChains = (f.hostedChains || []).filter((c) => c !== path);
      if (!f.hostedChains.length) delete f.hostedChains;
    }, (after) => { const kept = stillHostedFor(after, path); return kept ? `${path}: no longer listed; ${kept}` : `Stopped hosting ${path}`; });
    if (ok && state.route.name === 'chain') location.hash = '#/';
    return;
  }
  if (ds.unpin) {
    if (!await dialog({ title: 'Unpin this content?', body: html`<p class="soft">The node stops keeping ${shortCid(ds.unpin)} for you. It's deleted unless something else the node keeps uses it.</p>`, confirm: 'Unpin', danger: true })) return;
    try { await api(node(), `pins/${encodeURIComponent(ds.unpin)}`, { method: 'DELETE' }); toast('Unpinned'); VIEWS.storage.mount(); } catch (err) { toast(`Couldn't unpin: ${err.message}`); }
    return;
  }
  if (ds.revoke) {
    if (!await dialog({ title: `Revoke ${ds.revoke}?`, body: html`<p class="soft">Anything using this token is refused from its next request. If it's the token you signed in with, you'll be signed out.</p>`, confirm: 'Revoke', danger: true })) return;
    try { await api(node(), `tokens/${encodeURIComponent(ds.revoke)}`, { method: 'DELETE' }); toast(`Revoked ${ds.revoke}`); loadTokens(); } catch (err) { toast(`Couldn't revoke: ${err.message}`); if (err.status === 401) paint(true); }
    return;
  }
  if (ds.forget) {
    state.nodes = state.nodes.filter((n) => n.id !== ds.forget);
    clearTimeout(state.timers[ds.forget]); store.set(local, SNAP_KEY(ds.forget), null); sset(SNAP_KEY(ds.forget), null);
    delete state.snaps[ds.forget];
    if (state.current === ds.forget) { state.current = state.nodes.length ? state.nodes[0].id : null; sset(CURRENT_KEY, state.current); }
    saveNodes(); $('#app').innerHTML = ''; paint(true); return;
  }
  // settings
  if (ds.tab) { settings.tab = ds.tab; settings.rawError = null; rerender(); return; }
  if ('review' in ds) { settings.review = true; rerender(); $('#rv-h') && $('#rv-h').scrollIntoView({ block: 'center' }); return; }
  if ('cancelReview' in ds) { settings.review = null; rerender(); return; }
  if ('discard' in ds) { settings.draft = clone(settings.original); settings.review = null; settings.rawError = null; rerender(); return; }
  if ('apply' in ds) { applySettings(); return; }
  if ('dismissResult' in ds) { settings.result = null; rerender(); return; }
});

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-switch]')) switchTo(e.target.value);
  if (e.target.name === 'role') { const f = $('#routes-field'); if (f) f.hidden = e.target.value !== 'routes'; }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id === 'signin') { e.preventDefault(); signIn($('#token').value, $('#remember').checked); return; }
  if (f.matches('[data-host-chain]')) {
    e.preventDefault();
    const path = $('#host-chain').value.trim().replace(/\/+$/, '');
    if (!/^Nexus(\/[^/\s]+)+$/.test(path)) { toast('A chain path starts with Nexus/, like Nexus/Name'); return; }
    const st = chainStatus(snap(), path);
    if (st && st.from.includes(FRAGMENT)) { toast(`${path} is already hosted`); return; }
    if (await hostPath(path)) { const again = $('#host-chain'); if (again) again.focus(); }
    return;
  }
  if (f.matches('[data-create-chain]')) {
    e.preventDefault();
    const path = $('#cc-path').value.trim().replace(/\/+$/, '');
    if (!/^Nexus(\/[^/\s]+)+$/.test(path)) { toast('A chain path starts with Nexus/, like Nexus/Name'); return; }
    const premine = Number($('#cc-premine').value); const to = $('#cc-to').value.trim();
    if (premine > 0 && !to) { toast('A premine is paid to an address: give one'); return; }
    // The spec `lattice child create` builds from the same flags; keep in
    // step with lattice-node's Sources/LatticeCtl/Child.swift.
    const spec = {
      maxNumberOfTransactionsPerBlock: 1000, maxStateGrowth: 1000000, maxBlockSize: 1000000,
      premine, targetBlockTime: Number($('#cc-time').value), initialReward: Number($('#cc-reward').value),
      halvingInterval: 1000000, halfLife: 100, wasmPolicies: [],
    };
    try {
      await get(node(), 'chains', { method: 'POST', body: { path, spec, ...(premine > 0 ? { premineTo: to } : {}) } });
    } catch (err) { toast(`Couldn't create ${path}: ${err.message}`); return; }
    if (await hostPath(path, (m) => `Created ${path}, but it isn't hosted yet: ${m} Host it again; that is safe.`)) f.reset();
    return;
  }
  if (f.id === 'new-token') {
    e.preventDefault();
    const name = $('#tok-name').value.trim();
    const role = f.querySelector('input[name="role"]:checked').value;
    const body = role === 'routes' ? { name, routes: $('#tok-routes').value.split('\n').map((x) => x.trim()).filter(Boolean) } : { name, role };
    try {
      const r = await get(node(), 'tokens', { method: 'POST', body });
      f.reset(); $('#routes-field').hidden = true;
      loadTokens();
      await dialog({ title: `Token ${r.name}`, body: html`<p class="soft">Copy it now. It isn't shown again: the node keeps only a fingerprint of it.</p><div class="secret"><code>${r.token}</code><button type="button" data-copy="${r.token}">Copy</button></div>`, confirm: 'Done', cancel: false });
    } catch (err) { toast(err.status === 409 ? (err.message.includes('exists') ? `A token named ${name} exists; revoke it first.` : 'This node has no token file yet.') : `Couldn't make the token: ${err.message}`); }
    return;
  }
  if (f.id === 'add-node') {
    e.preventDefault();
    const url = $('#node-url').value.trim().replace(/\/+$/, '');
    if (state.nodes.some((o) => o.url === url)) { $('#add-error').textContent = 'That node is already added.'; return; }
    const n = { id: `n${Date.now().toString(36)}`, name: $('#node-name').value.trim() || new URL(url).host, url, token: cleanToken($('#node-token').value), remember: $('#node-remember').checked };
    const err = $('#add-error');
    try { await get(n, 'status'); } catch (ex) {
      err.textContent = ex.status === 401 ? "That node doesn't know this token." : ex.status === 403 ? `That node refused this page. List ${location.origin} under "Dashboards allowed to connect" on it, then restart it.` : `${ex.message} If it's running, it may not list ${location.origin} as an allowed dashboard.`;
      return;
    }
    state.nodes.push(n); saveNodes();
    state.snaps[n.id] = blankSnap();
    toast(`Added ${n.name}`);
    switchTo(n.id);
    schedule(n.id);
  }
});

function switchTo(id) {
  if (!node(id)) return;
  state.current = id; sset(CURRENT_KEY, id);
  settings.original = null; settings.result = null; logs.lines = [];
  for (const n of state.nodes) if (n.token) schedule(n.id);
  $('#app').innerHTML = '';
  location.hash = '#/';
  paint(true);
  if (node().token) refresh(id);
}

// ---------------------------------------------------------------- start

state.nodes = loadNodes();
restoreTokens();
state.current = node(sget(CURRENT_KEY, null)) ? sget(CURRENT_KEY, null) : (state.nodes[0] ? state.nodes[0].id : null);
state.route = parseRoute();
for (const n of state.nodes) restoreSnap(n.id);
paint(true);
startPolling();
})();
