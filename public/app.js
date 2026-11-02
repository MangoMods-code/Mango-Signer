// Mango Signer — front end
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = {
  tab: 'library', account: null, apps: [], categories: [], certs: [], signed: [], users: [], invites: [], settings: {}, server: {},
  sources: [], github: { connected: false },
  udidState: null,
  lib: { q: '', cat: 'all', sort: 'smart', select: false, selected: new Set(), limit: 40 },
};
const isOwner = () => state.account && state.account.role === 'owner';

// ---------- version & updates ----------
const pageData = document.documentElement.dataset;
const real = (v) => (v && !/^__/.test(v) ? v : null);
const CLIENT_VERSION = real(pageData.version); // what's shown (can be a custom label)
const CLIENT_BUILD = real(pageData.build); // changes with every update
const CODE_VERSION = real(pageData.codeVersion); // the real version, used for What's New

async function checkForUpdate() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    const { version, build } = await r.json();
    const bar = $('#updateBar');
    if (CLIENT_BUILD && build && build !== CLIENT_BUILD) {
      bar.innerHTML = `<b>✨ Version Updated! Tap here to refresh</b><span>${CLIENT_VERSION === version ? `V${esc(version)} · new build` : `V${esc(CLIENT_VERSION)} → V${esc(version)}`}</span>`;
      bar.classList.remove('hidden');
      document.body.classList.add('has-update');
    }
  } catch { /* offline — try again later */ }
}
$('#updateBar').onclick = () => {
  const u = new URL(location.href);
  u.searchParams.set('r', Date.now().toString(36));
  location.replace(u.toString());
};
setInterval(checkForUpdate, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });

// ---------- what's new ----------
const SEEN_KEY = 'mango.seenVersion';
function whatsNewHtml(v, open) {
  return `<details class="wn" ${open ? 'open' : ''}>
    <summary><span class="wn-ver">V${esc(v.version)}</span><span class="wn-title">${esc(v.title)}</span><span class="wn-date">${fmtDate(v.date + 'T12:00:00')}</span></summary>
    <p class="wn-summary">${esc(v.summary)}</p>
    ${v.sections.map((sec) => `<div class="wn-sec"><h4>${esc(sec.title)}</h4><ul>${sec.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('')}
  </details>`;
}
async function whatsNewSheet() {
  try {
    const { version, versions } = await api('GET', '/api/whats-new');
    openSheet(`
      <h2>What's New</h2>
      <p class="muted small" style="margin-top:-8px">You're on Mango Signer V${esc(CLIENT_VERSION || version)}</p>
      ${versions.length ? whatsNewHtml(versions[0], true) : ''}
      <button class="btn primary big block" id="wnDone" style="margin:14px 0 4px">Got it</button>
      ${versions.length > 1 ? `<div class="section-title">Earlier versions</div>${versions.slice(1).map((v) => whatsNewHtml(v, false)).join('')}` : ''}`, (el) => {
      $('#wnDone', el).onclick = closeSheet;
    });
    try { localStorage.setItem(SEEN_KEY, CODE_VERSION || version); } catch { /* */ }
  } catch (e) { toast(e.message, true); }
}
function maybeShowWhatsNew() {
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { return; }
  if (CODE_VERSION && seen !== CODE_VERSION && $('#sheet').classList.contains('hidden')) whatsNewSheet();
}
try { Object.assign(state.lib, JSON.parse(localStorage.getItem('mango.lib') || '{}'), { q: '', select: false, selected: new Set() }); } catch { /* */ }
const saveLibPrefs = () => { try { localStorage.setItem('mango.lib', JSON.stringify({ cat: state.lib.cat, sort: state.lib.sort })); } catch { /* */ } };

// ---------- api ----------
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && !['/api/login', '/api/signup'].includes(url)) { showLogin(); throw new Error('Please sign in'); }
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, data });
  return data;
}

// Keeps the screen on during long uploads (iOS 16.4+).
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && uploadFile.active) keepAwake(true); });

function xhrSend(method, url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status === 401) { showLogin(); return reject(new Error('Please sign in')); }
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 409) resolve({ status: xhr.status, data });
      else reject(Object.assign(new Error(data.error || `Upload failed (${xhr.status})`), { fatal: xhr.status !== 0 && xhr.status < 500 }));
    };
    xhr.onerror = () => reject(new Error('Connection lost'));
    xhr.ontimeout = () => reject(new Error('Connection timed out'));
    xhr.timeout = 5 * 60 * 1000;
    xhr.send(body);
  });
}

// Upload speed setting (saved on this device): how many pieces are sent at the same time.
const UPLOAD_MODES = [
  { streams: 1, label: 'Normal', sub: 'One piece at a time' },
  { streams: 3, label: 'Fast', sub: '3 pieces at once' },
  { streams: 6, label: 'Turbo', sub: '6 pieces at once' },
  { streams: 10, label: 'Max', sub: '10 pieces at once — best on strong Wi-Fi' },
];
function uploadStreams() {
  try { return Number(localStorage.getItem('mango.uploadStreams')) || 6; } catch { return 6; }
}

// Uploads a file in numbered pieces, several at once. If the connection drops it waits,
// asks which pieces are missing, and sends only those.
async function uploadFile(file, onProgress, onStatus) {
  const CHUNK = 8 * 1024 * 1024;
  uploadFile.active = (uploadFile.active || 0) + 1;
  keepAwake(true);
  try {
    if (file.size <= CHUNK) {
      const { data } = await xhrSend('POST', '/api/upload', file, (n) => onProgress && onProgress(n / file.size));
      onProgress && onProgress(1);
      return data;
    }
    const { uploadId, chunkSize, count } = await api('POST', '/api/upload/start', { size: file.size, chunkSize: CHUNK });
    const done = new Set();
    const inFlight = new Map(); // piece -> bytes sent so far
    let doneBytes = 0;
    let failures = 0;
    let next = 0;
    const started = Date.now();
    const pieceSize = (i) => Math.min(chunkSize, file.size - i * chunkSize);

    const report = () => {
      let sent = doneBytes;
      for (const n of inFlight.values()) sent += n;
      onProgress && onProgress(Math.min(1, sent / file.size));
      if (onStatus && failures === 0) {
        const secs = Math.max(1, (Date.now() - started) / 1000);
        const rate = sent / secs;
        onStatus(`${fmtSize(sent)} of ${fmtSize(file.size)} · ${fmtSize(rate)}/s · ${fmtTime((file.size - sent) / Math.max(1, rate))} left`);
      }
    };
    const takePiece = () => {
      while (next < count && (done.has(next) || inFlight.has(next))) next++;
      if (next < count) return next++;
      for (let i = 0; i < count; i++) if (!done.has(i) && !inFlight.has(i)) return i; // retry missed pieces
      return -1;
    };

    const worker = async () => {
      for (;;) {
        const i = takePiece();
        if (i < 0) return;
        inFlight.set(i, 0);
        try {
          const start = i * chunkSize;
          const { status, data } = await xhrSend('PUT', `/api/upload/${uploadId}?index=${i}`, file.slice(start, start + pieceSize(i)), (n) => { inFlight.set(i, n); report(); });
          inFlight.delete(i);
          if (status === 409 && data.busy) { await sleep(1500); continue; }
          if (!done.has(i)) { done.add(i); doneBytes += pieceSize(i); }
          failures = 0;
          report();
        } catch (e) {
          inFlight.delete(i);
          if (e.fatal) throw e;
          failures++;
          if (failures > 40) throw new Error('Upload keeps failing — check your connection and try again');
          onStatus && onStatus(`Connection dropped — retrying (${failures})…`);
          await sleep(Math.min(15000, 800 * failures));
          try {
            const st = await api('GET', `/api/upload/${uploadId}`);
            for (const d of st.done || []) if (!done.has(d)) { done.add(d); doneBytes += pieceSize(d); }
          } catch (err) { if (err.status === 404) throw err; }
        }
      }
    };

    const streams = Math.max(1, Math.min(uploadStreams(), count));
    await Promise.all(Array.from({ length: streams }, worker));
    if (done.size < count) throw new Error('Upload didn\'t finish — try again');
    onProgress && onProgress(1);
    return { uploadId, size: file.size };
  } finally {
    uploadFile.active--;
    if (!uploadFile.active) keepAwake(false);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(jobId, onUpdate) {
  for (;;) {
    await sleep(900);
    const j = await api('GET', `/api/jobs/${jobId}`);
    onUpdate && onUpdate(j);
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw Object.assign(new Error(j.error || 'Failed'), { log: j.log });
  }
}

async function refresh() {
  const d = await api('GET', '/api/state');
  Object.assign(state, d);
  render();
}

// ---------- helpers ----------
function pickFile(accept = '', multiple = false) {
  return new Promise((resolve) => {
    const old = $('#filePicker');
    const input = old.cloneNode();
    old.replaceWith(input);
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(multiple ? [...input.files] : input.files[0] || null);
    input.click();
  });
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toast.timer);
  clearTimeout(toast.hideTimer);
  toast.timer = setTimeout(() => {
    t.classList.remove('show');
    t.classList.add('leaving');
    toast.hideTimer = setTimeout(() => t.classList.add('hidden'), 260);
  }, isError ? 4200 : 2400);
}

function fmtSize(b) {
  if (!b && b !== 0) return '';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
function fmtTime(s) {
  if (!Number.isFinite(s)) return '…';
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
const daysLeft = (iso) => (iso ? Math.floor((new Date(iso) - Date.now()) / 864e5) : null);
function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const shortUdid = (u) => (u ? `${u.slice(0, 8)}…${u.slice(-4)}` : '');
const shownVersion = (a) => a.versionOverride || a.version || '';
const catById = (cid) => state.categories.find((c) => c.id === cid);
const catLabel = (cid) => { const c = catById(cid); return c ? `${c.emoji} ${c.name}` : 'Uncategorized'; };

function iconHtml(src, name, big = false) {
  const letter = esc((name || '?').trim().charAt(0).toUpperCase());
  const cls = 'app-icon' + (big ? ' big' : '');
  if (!src) return `<div class="${cls}">${letter}</div>`;
  return `<img class="${cls} fade-img" src="${esc(src)}" alt="" loading="lazy" onload="this.classList.add('loaded')" onerror="this.outerHTML='<div class=&quot;${cls}&quot;>${letter}</div>'">`;
}
const appIcon = (a, big) => iconHtml(a.hasIcon || a.customIcon ? `/api/apps/${a.id}/icon?v=${a.iconVersion || 0}` : null, a.name, big);
const signedIcon = (s, big) => iconHtml(s.hasIcon ? `/i/${s.token}/icon.png` : null, s.name, big);

async function copy(text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copy this:', text); }
}

function certExpiry(c) {
  const dates = [c.p12 && c.p12.validTo, c.profile && c.profile.expires].filter(Boolean).sort();
  return dates[0] || null;
}

const ICONS = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 3v11m0 0-4-4m4 4 4-4"/><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20c0-2.8-1.6-4.9-4-5.7"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};
const TAB_ICONS = {
  library: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
  signed: ICONS.down,
  certs: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z"/><path d="m8.8 12 2.2 2.2 4.4-4.4"/></svg>',
  users: ICONS.users,
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

// ---------- sheet ----------
// Freezes the page behind a sheet so pulling on the sheet can't drag or scroll the page.
let pageLock = null;
function lockPage() {
  if (pageLock) return;
  pageLock = { y: window.scrollY };
  Object.assign(document.body.style, { position: 'fixed', top: `-${pageLock.y}px`, left: '0', right: '0', width: '100%' });
}
function unlockPage() {
  if (!pageLock) return;
  const { y } = pageLock;
  pageLock = null;
  Object.assign(document.body.style, { position: '', top: '', left: '', right: '', width: '' });
  window.scrollTo(0, y);
}

function resetSheetPosition() {
  const sheet = $('#sheet');
  sheet.style.transition = '';
  sheet.style.transform = '';
  $('#sheetBackdrop').style.opacity = '';
}

const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function openSheet(html, onMount) {
  const sheet = $('#sheet');
  const backdrop = $('#sheetBackdrop');
  const closing = sheet.classList.contains('closing');
  const wasOpen = !sheet.classList.contains('hidden') && !closing;
  clearTimeout(closeSheet.timer);
  sheet.classList.remove('closing');
  backdrop.classList.remove('closing');
  resetSheetPosition();
  const body = $('#sheetBody');
  body.innerHTML = html;
  sheet.classList.toggle('locked', !!closeSheet.locked);
  sheet.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  sheet.classList.toggle('no-anim', wasOpen || closing);
  // Going from one pop-up to another: fade the new content in instead of sliding the whole sheet again.
  if (wasOpen || closing) { body.classList.remove('swap'); void body.offsetWidth; body.classList.add('swap'); }
  sheet.scrollTop = 0;
  lockPage();
  onMount && onMount(body);
}
function closeSheet(opts) {
  if (closeSheet.locked) return;
  const sheet = $('#sheet');
  const backdrop = $('#sheetBackdrop');
  if (sheet.classList.contains('hidden') || sheet.classList.contains('closing')) return;
  const finish = () => {
    sheet.classList.remove('closing');
    backdrop.classList.remove('closing');
    resetSheetPosition();
    sheet.classList.add('hidden');
    backdrop.classList.add('hidden');
    $('#sheetBody').innerHTML = '';
    unlockPage();
  };
  if ((opts && opts.instant) || reducedMotion()) return finish();
  sheet.classList.add('closing');
  backdrop.classList.add('closing');
  closeSheet.timer = setTimeout(finish, 260);
}
$('#sheetBackdrop').onclick = closeSheet;
$('#sheetClose').onclick = closeSheet;

// Swipe down to close. Works from the handle anywhere, or from the content when it's scrolled to the top.
(function sheetGestures() {
  const sheet = $('#sheet');
  const backdrop = $('#sheetBackdrop');
  let startY = 0, startX = 0, dy = 0, startT = 0, mode = 'idle', fromHandle = false;

  sheet.addEventListener('touchstart', (e) => {
    mode = 'idle';
    if (closeSheet.locked || e.touches.length !== 1) return;
    fromHandle = !!e.target.closest('.grabber-zone');
    if (!fromHandle && (sheet.scrollTop > 0 || e.target.closest('input, textarea, select, .chips-row, .shelf, .log'))) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    dy = 0;
    startT = Date.now();
    mode = 'maybe';
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (mode === 'idle') return;
    const d = e.touches[0].clientY - startY;
    const dx = Math.abs(e.touches[0].clientX - startX);
    if (mode === 'maybe') {
      if (d > 8 && d > dx && (fromHandle || sheet.scrollTop <= 0)) mode = 'drag';
      else if (Math.abs(d) > 8 || dx > 8) { mode = 'idle'; return; } else return;
    }
    e.preventDefault();
    dy = Math.max(0, d);
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${dy}px)`;
    backdrop.style.opacity = String(Math.max(0.2, 1 - dy / 500));
  }, { passive: false });

  const finish = (cancelled) => {
    if (mode !== 'drag') { mode = 'idle'; return; }
    mode = 'idle';
    const speed = dy / Math.max(1, Date.now() - startT);
    sheet.style.transition = 'transform .22s ease';
    backdrop.style.transition = 'opacity .22s ease';
    if (!cancelled && (dy > 120 || (dy > 30 && speed > 0.35))) {
      sheet.style.transform = 'translateY(105%)';
      backdrop.style.opacity = '0';
      setTimeout(() => { backdrop.style.transition = ''; closeSheet({ instant: true }); }, 210);
    } else {
      sheet.style.transform = '';
      backdrop.style.opacity = '';
      setTimeout(() => { sheet.style.transition = ''; backdrop.style.transition = ''; }, 230);
    }
  };
  sheet.addEventListener('touchend', () => finish(false));
  sheet.addEventListener('touchcancel', () => finish(true));
})();

// ---------- shared toggles & presets ----------
function toggle(id, label, sub = '', checked = false) {
  return `<label class="toggle-row"><div class="row-main">${label}${sub ? `<div class="row-sub" style="white-space:normal">${sub}</div>` : ''}<div class="ent-warn hidden" id="${id}Warn"></div></div>
    <span class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></span></label>`;
}

const ENT_PRESETS = [
  { id: 'eJit', key: 'get-task-allow', label: 'JIT support', short: 'JIT', sub: 'Lets StikDebug and other JIT tools attach to the app' },
  { id: 'eMem', key: 'com.apple.developer.kernel.increased-memory-limit', label: 'Increased memory limit', short: 'More RAM', sub: 'GetMoreRam — more RAM for emulators and games' },
  { id: 'eVA', key: 'com.apple.developer.kernel.extended-virtual-addressing', label: 'Extended virtual addressing', short: 'Extended VA', sub: 'Bigger memory space, used by some emulators' },
];
const PLIST_PRESETS = [
  { id: 'p120', key: 'CADisableMinimumFrameDurationOnPhone', label: '120Hz ProMotion', short: '120Hz', sub: 'Unlocks 120fps on ProMotion iPhones' },
  { id: 'pGame', key: 'GCSupportsGameMode', label: 'Game Mode', short: 'Game Mode', sub: 'Lower latency for controllers and AirPods' },
  { id: 'pFull', key: 'UIRequiresFullScreen', label: 'Require full screen', short: 'Full screen', sub: 'Turns off iPad split view for the app' },
];
const OPTION_TOGGLES = [
  { id: 'oRmExt', key: 'removeExtensions', label: 'Remove extensions', short: 'No extensions', sub: 'Fixes installs on profiles without matching App IDs' },
  { id: 'oRmWatch', key: 'removeWatch', label: 'Remove Watch app', short: 'No Watch app', sub: 'Smaller install, avoids Watch signing errors' },
  { id: 'oRmUISD', key: 'removeUISD', label: 'Remove device limits', short: 'No device limits', sub: 'Lets apps install on devices they weren\'t built for' },
  { id: 'oDocs', key: 'enableDocs', label: 'Show in Files app', short: 'Files app', sub: 'Turns on file sharing and document browser' },
];

function editorRow(kind, i, row) {
  const types = kind === 'plist'
    ? [['bool', 'Yes / No'], ['string', 'Text'], ['number', 'Number'], ['delete', 'Remove key']]
    : [['bool', 'Yes / No'], ['string', 'Text']];
  const valueInput = row.type === 'bool'
    ? `<select data-f="value"><option value="true" ${row.value !== false ? 'selected' : ''}>YES</option><option value="false" ${row.value === false ? 'selected' : ''}>NO</option></select>`
    : row.type === 'delete' ? '<span class="hint">Key will be removed</span>'
      : `<input type="${row.type === 'number' ? 'number' : 'text'}" data-f="value" value="${esc(row.value ?? '')}" placeholder="Value" autocapitalize="off" autocorrect="off">`;
  return `<div class="editor-row" data-i="${i}">
    <input type="text" data-f="key" value="${esc(row.key)}" placeholder="${kind === 'plist' ? 'Info.plist key, e.g. UIFileSharingEnabled' : 'Entitlement, e.g. com.apple.developer.…'}" autocapitalize="off" autocorrect="off">
    <div class="split">
      <select data-f="type">${types.map(([v, l]) => `<option value="${v}" ${row.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${valueInput}
      <button class="x" data-f="remove" aria-label="Remove" type="button">×</button>
    </div>
  </div>`;
}

// Renders preset toggles + custom key editors for entitlements, Info.plist and options.
// Used both by the sign sheet and by "default sign settings" in the app editor.
function signOptionsHtml(a, prefix = '') {
  return `
    <div class="section-title">Entitlements</div>
    <div class="group">${ENT_PRESETS.map((p) => toggle(prefix + p.id, p.label, p.sub)).join('')}</div>
    <div id="${prefix}entRows"></div>
    <button class="btn add-key" id="${prefix}addEnt" type="button">+ Add custom entitlement</button>

    <div class="section-title">Info.plist</div>
    <div class="group">${PLIST_PRESETS.map((p) => toggle(prefix + p.id, p.label, p.sub)).join('')}</div>
    <div id="${prefix}plistRows"></div>
    <button class="btn add-key" id="${prefix}addPlist" type="button">+ Add custom Info.plist key</button>

    <div class="section-title">Options</div>
    <div class="group">
      ${OPTION_TOGGLES.filter((o) => o.key !== 'removeWatch' || !a || a.hasWatch).map((o) => toggle(prefix + o.id, o.label,
        o.key === 'removeExtensions' && a ? (a.extensions ? `${a.extensions} found · ${o.sub.toLowerCase()}` : 'None found in this app') : o.sub)).join('')}
    </div>`;
}

function bindSignOptions(el, defaults = {}, prefix = '') {
  const custom = {
    ent: (defaults.entitlements || []).filter((e) => !ENT_PRESETS.some((p) => p.key === e.key)).map((e) => ({ ...e })),
    plist: (defaults.plist || []).filter((e) => !PLIST_PRESETS.some((p) => p.key === e.key && e.type === 'bool' && e.value === true)).map((e) => ({ ...e })),
  };
  for (const p of ENT_PRESETS) $('#' + prefix + p.id, el).checked = (defaults.entitlements || []).some((e) => e.key === p.key && e.value !== false);
  for (const p of PLIST_PRESETS) $('#' + prefix + p.id, el).checked = (defaults.plist || []).some((e) => e.key === p.key && e.type === 'bool' && e.value === true);
  for (const o of OPTION_TOGGLES) { const t = $('#' + prefix + o.id, el); if (t && defaults[o.key] !== undefined) t.checked = !!defaults[o.key]; }

  const drawRows = (kind) => {
    const box = $('#' + prefix + (kind === 'plist' ? 'plistRows' : 'entRows'), el);
    box.innerHTML = custom[kind].map((r, i) => editorRow(kind, i, r)).join('');
    box.querySelectorAll('.editor-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const r = custom[kind][i];
      row.querySelector('[data-f=key]').oninput = (e) => { r.key = e.target.value.trim(); };
      row.querySelector('[data-f=type]').onchange = (e) => { r.type = e.target.value; r.value = r.type === 'bool' ? true : ''; drawRows(kind); };
      const v = row.querySelector('[data-f=value]');
      if (v) v.oninput = v.onchange = (e) => { r.value = r.type === 'bool' ? e.target.value === 'true' : e.target.value; };
      row.querySelector('[data-f=remove]').onclick = () => { custom[kind].splice(i, 1); drawRows(kind); };
    });
  };
  drawRows('ent');
  drawRows('plist');
  $('#' + prefix + 'addEnt', el).onclick = () => { custom.ent.push({ key: '', type: 'bool', value: true }); drawRows('ent'); };
  $('#' + prefix + 'addPlist', el).onclick = () => { custom.plist.push({ key: '', type: 'bool', value: true }); drawRows('plist'); };

  return function collect() {
    const out = {
      entitlements: ENT_PRESETS.filter((p) => $('#' + prefix + p.id, el).checked).map((p) => ({ key: p.key, type: 'bool', value: true }))
        .concat(custom.ent.filter((r) => r.key)),
      plist: PLIST_PRESETS.filter((p) => $('#' + prefix + p.id, el).checked).map((p) => ({ key: p.key, type: 'bool', value: true }))
        .concat(custom.plist.filter((r) => r.key)),
    };
    for (const o of OPTION_TOGGLES) { const t = $('#' + prefix + o.id, el); if (t) out[o.key] = t.checked; }
    return out;
  };
}

// Short list of what an app's default sign settings turn on, e.g. "JIT · More RAM · 120Hz".
function defaultsSummary(d = {}) {
  const bits = [];
  for (const p of ENT_PRESETS) if ((d.entitlements || []).some((e) => e.key === p.key)) bits.push(p.short);
  for (const p of PLIST_PRESETS) if ((d.plist || []).some((e) => e.key === p.key)) bits.push(p.short);
  const extraEnt = (d.entitlements || []).filter((e) => !ENT_PRESETS.some((p) => p.key === e.key)).length;
  const extraPlist = (d.plist || []).filter((e) => !PLIST_PRESETS.some((p) => p.key === e.key)).length;
  if (extraEnt) bits.push(`${extraEnt} custom entitlement${extraEnt === 1 ? '' : 's'}`);
  if (extraPlist) bits.push(`${extraPlist} Info.plist change${extraPlist === 1 ? '' : 's'}`);
  for (const o of OPTION_TOGGLES) if (d[o.key]) bits.push(o.short);
  return bits;
}

// ---------- render ----------
function tabsFor() {
  return isOwner()
    ? [['library', 'Library'], ['signed', 'Signed'], ['certs', 'Certificates'], ['users', 'Users'], ['settings', 'Settings']]
    : [['library', 'Apps'], ['signed', 'Signed'], ['certs', 'Certificates'], ['settings', 'Account']];
}

function renderTabs() {
  const tabs = tabsFor();
  const nav = $('#tabs');
  nav.style.setProperty('--tab-count', tabs.length);
  nav.innerHTML = tabs.map(([key, label]) => {
    let dot = '';
    if (key === 'certs' && state.certs.some((c) => (c.check && c.check.status === 'revoked') || (daysLeft(certExpiry(c)) ?? 99) < 7)) dot = '<i class="dot"></i>';
    if (key === 'users' && (state.requests || []).some((r) => r.status === 'pending')) dot = '<i class="dot"></i>';
    if (key === 'library' && state.apps.some(hasUpdate)) dot = '<i class="dot mango"></i>';
    return `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}">${TAB_ICONS[key]}${dot}<span>${label}</span></button>`;
  }).join('');
  nav.querySelectorAll('button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
}

function render() {
  if (!tabsFor().some(([k]) => k === state.tab)) state.tab = 'library';
  const title = Object.fromEntries(tabsFor())[state.tab];
  $('#pageTitle').textContent = state.tab === 'library' && !isOwner() ? 'App Library' : title;
  renderTabs();
  const top = $('#topAction');
  const actions = { library: isOwner() ? addAppSheet : null, certs: addCertSheet, users: newInviteSheet };
  top.innerHTML = actions[state.tab] ? ICONS.plus : '';
  top.onclick = actions[state.tab] || null;
  const view = $('#view');
  view.innerHTML = announcementHtml() + { library: renderLibrary, signed: renderSigned, certs: renderCerts, users: renderUsers, settings: renderSettings }[state.tab]();
  bindView(view);
  if (state.tab === 'library') bindLibrary(view);
}

// ---------- library ----------
const DAY = 864e5;
const isNewApp = (a) => Date.now() - new Date(a.addedAt) < 3 * DAY;
const isUpdatedApp = (a) => !isNewApp(a) && a.updatedAt && a.previousVersion && Date.now() - new Date(a.updatedAt) < 3 * DAY;
const hasUpdate = (a) => a.installed && a.installed.version && shownVersion(a) && a.installed.version !== shownVersion(a);
function libView() { try { return localStorage.getItem('mango.libView') || 'list'; } catch { return 'list'; } }

function filteredApps() {
  const { q, cat, sort } = state.lib;
  let apps = state.apps.slice();
  if (q) {
    const needle = q.toLowerCase();
    apps = apps.filter((a) => [a.name, a.bundleId, a.description, a.developer, a.notes, a.sourceName, shownVersion(a), catLabel(a.categoryId), ...(a.tags || [])].some((f) => (f || '').toLowerCase().includes(needle)));
  }
  if (cat === 'featured') apps = apps.filter((a) => a.featured);
  else if (cat === 'installed') apps = apps.filter((a) => a.installed);
  else if (cat === 'updates') apps = apps.filter(hasUpdate);
  else if (cat === 'new') apps = apps.filter((a) => isNewApp(a) || isUpdatedApp(a));
  else if (cat === 'none') apps = apps.filter((a) => !a.categoryId || !catById(a.categoryId));
  else if (cat === 'hidden') apps = apps.filter((a) => !a.published);
  else if (cat === 'missing') apps = apps.filter((a) => a.missing);
  else if (cat === 'cloud:github') apps = apps.filter((a) => a.cloud === 'github');
  else if (cat === 'cloud:link') apps = apps.filter((a) => a.cloud === 'link');
  else if (cat.startsWith('src:')) apps = apps.filter((a) => a.cloud === 'source' && a.sourceName === cat.slice(4));
  else if (cat.startsWith('tag:')) apps = apps.filter((a) => (a.tags || []).includes(cat.slice(4)));
  else if (cat !== 'all') apps = apps.filter((a) => a.categoryId === cat);
  const by = {
    smart: (x, y) => (y.featured - x.featured) || x.name.localeCompare(y.name),
    name: (x, y) => x.name.localeCompare(y.name),
    newest: (x, y) => String(y.updatedAt || y.addedAt).localeCompare(String(x.updatedAt || x.addedAt)),
    popular: (x, y) => (y.installCount || 0) - (x.installCount || 0) || (y.likes - y.dislikes) - (x.likes - x.dislikes),
    rating: (x, y) => (y.likes - y.dislikes) - (x.likes - x.dislikes) || (y.installCount || 0) - (x.installCount || 0),
    size: (x, y) => y.size - x.size,
  };
  return apps.sort(by[sort] || by.smart);
}

function appBadges(a, { compact = false } = {}) {
  const b = [];
  if (hasUpdate(a)) b.push('<span class="badge mango">⬆ Update</span>');
  else if (a.installed) b.push('<span class="badge good">✓ Installed</span>');
  if (isNewApp(a)) b.push('<span class="badge new">NEW</span>');
  else if (isUpdatedApp(a)) b.push('<span class="badge new">UPDATED</span>');
  if (!compact && isOwner() && !a.published) b.push('<span class="badge">Hidden</span>');
  if (!compact && a.missing) b.push('<span class="badge bad">Removed from source</span>');
  if (!compact) b.push(cloudBadge(a));
  return b.join('');
}

// Where an app's file lives. Users only see the source name; you also see GitHub / link-only.
function cloudBadge(a) {
  if (a.cloud === 'source') return `<span class="badge cloud">☁ ${esc(a.sourceName || 'Source')}</span>`;
  if (!isOwner()) return '';
  if (a.cloud === 'github') return '<span class="badge cloud">☁ GitHub</span>';
  if (a.cloud === 'link') return '<span class="badge cloud">🔗 Link</span>';
  return '';
}
const storedLabel = (a) => ({ source: `Linked from ${a.sourceName || 'a source'} (not stored here)`, github: 'Your GitHub repo (not stored here)', link: 'Download link (not stored here)' }[a.cloud] || 'This server');

function getLabel(a) {
  if (hasUpdate(a)) return 'Update';
  return 'Get';
}

function appRow(a, { age = false } = {}) {
  const sel = state.lib.select;
  const checked = state.lib.selected.has(a.id);
  const rating = a.likes + a.dislikes ? `👍 ${Math.round((100 * a.likes) / (a.likes + a.dislikes))}%` : '';
  const when = age ? `${a.updatedAt && a.updatedAt !== a.addedAt ? 'Updated' : 'Added'} ${ago(a.updatedAt || a.addedAt)}` : '';
  const sub2 = [when, a.developer, fmtSize(a.size), a.installCount ? `🔥 ${a.installCount}` : '', rating].filter(Boolean).join(' · ');
  return `
    <div class="row ${checked ? 'selected' : ''}" data-act="${sel ? 'toggle-select' : 'app'}" data-id="${a.id}">
      ${sel ? `<span class="check ${checked ? 'on' : ''}">${checked ? ICONS.check : ''}</span>` : ''}
      ${appIcon(a)}
      <div class="row-main">
        <div class="row-title">${esc(a.name)}${a.featured ? '<span class="star">★</span>' : ''}</div>
        <div class="row-sub">${esc(shownVersion(a) || '—')} · ${esc(a.description ? a.description.split('\n')[0] : a.bundleId)}</div>
        <div class="row-sub">${esc(sub2)}</div>
        ${appBadges(a) ? `<div class="row-badges">${appBadges(a)}</div>` : ''}
      </div>
      ${sel ? '' : `<button class="pill" data-act="get" data-id="${a.id}">${getLabel(a)}</button>`}
    </div>`;
}

function appTile(a) {
  return `<button class="tile" data-act="app" data-id="${a.id}">
    <span class="tile-icon">${appIcon(a, true)}${hasUpdate(a) ? '<i class="tile-dot up">⬆</i>' : a.installed ? '<i class="tile-dot ok">✓</i>' : isNewApp(a) ? '<i class="tile-dot new">NEW</i>' : ''}</span>
    <span class="tile-name">${esc(a.name)}</span>
    <span class="tile-sub">${esc(shownVersion(a) || '')}</span>
  </button>`;
}

function miniCard(a, sub = '') {
  return `<button class="mini-card" data-act="app" data-id="${a.id}">${appIcon(a)}<span class="mini-name">${esc(a.name)}</span>${sub ? `<span class="mini-sub">${esc(sub)}</span>` : ''}</button>`;
}

function shelfCard(a, sub) {
  return `<button class="shelf-card" data-act="app" data-id="${a.id}">${appIcon(a, true)}<span class="shelf-name">${esc(a.name)}</span><span class="shelf-sub">${esc(sub)}</span></button>`;
}

function appsBlock(apps, opts = {}) {
  return libView() === 'grid'
    ? `<div class="grid">${apps.map((a) => appTile(a)).join('')}</div>`
    : `<div class="list">${apps.map((a) => appRow(a, opts)).join('')}</div>`;
}

function libraryListHtml() {
  const apps = filteredApps();
  const { q, cat } = state.lib;
  if (!state.apps.length) {
    return isOwner()
      ? `<div class="empty">${ICONS.box}<h3>No apps yet</h3><p>Add an .ipa from Files or paste a download link. Apps you add show up in the App Library for everyone you invite.</p>
        <button class="btn primary" data-act="add-app">Add App</button></div>`
      : `<div class="empty">${ICONS.box}<h3>No apps yet</h3><p>The owner hasn't added any apps yet. Want something? Request it!</p>
        <button class="btn primary" data-act="request-app">Request an App</button></div>`;
  }
  if (!apps.length) {
    return `<div class="empty" style="padding:30px 20px">${ICONS.search}<h3>Nothing found</h3><p>${q ? `No apps match “${esc(q)}”.` : 'Nothing here yet.'}</p>
      ${!isOwner() ? '<button class="btn" data-act="request-app">Request an App</button>' : ''}</div>`;
  }

  // Grouped view: shelves up top, then one section per category, in your order.
  if (cat === 'all' && !q && state.lib.sort === 'smart' && !state.lib.select) {
    let html = '';
    // Kept small on purpose: a slim row of icons instead of big cards.
    const updates = apps.filter(hasUpdate);
    if (updates.length) {
      html += `<div class="section-title" style="margin-top:6px">⬆ Updates for you <span class="count">${updates.length}</span></div><div class="mini-shelf">${updates.map((a) => miniCard(a, `→ ${shownVersion(a)}`)).join('')}</div>`;
    }
    const featured = apps.filter((a) => a.featured);
    if (featured.length) {
      html += `<div class="section-title" style="margin-top:6px">★ Featured</div><div class="mini-shelf">${featured.map((a) => miniCard(a)).join('')}</div>`;
    }
    // Everything else: one list, most recently added or updated first.
    const recent = apps.slice().sort((x, y) => String(y.updatedAt || y.addedAt).localeCompare(String(x.updatedAt || x.addedAt)));
    const shown = recent.slice(0, state.lib.limit);
    html += `<div class="section-title">🕒 Recently updated <span class="count">${apps.length}</span></div>${appsBlock(shown, { age: true })}`;
    if (recent.length > shown.length) html += `<button class="btn block see-all" data-act="lib-more">Show more (${recent.length - shown.length} left)</button>`;
    return html;
  }
  return `<div class="section-title" style="margin-top:6px">${apps.length} app${apps.length === 1 ? '' : 's'}</div>${state.lib.select ? `<div class="list">${apps.map((a) => appRow(a)).join('')}</div>` : appsBlock(apps)}`;
}

function renderLibrary() {
  const { q, cat, sort } = state.lib;
  const allTags = [...new Set(state.apps.flatMap((a) => a.tags || []))].sort();
  const srcNames = [...new Set(state.apps.filter((a) => a.cloud === 'source' && a.sourceName).map((a) => a.sourceName))].sort();
  const chips = [['all', 'All'], ['installed', '✓ Installed'], ['updates', '⬆ Updates'], ['new', '🆕 New'], ['featured', '★ Featured'],
    ...state.categories.map((c) => [c.id, `${c.emoji} ${c.name}`]), ...srcNames.map((n) => [`src:${n}`, `☁ ${n}`]), ...allTags.map((t) => [`tag:${t}`, `# ${t}`])];
  if (isOwner()) chips.push(['cloud:github', '☁ GitHub'], ['cloud:link', '🔗 Links'], ['none', 'Uncategorized'], ['hidden', 'Hidden'], ['missing', '⚠ Removed']);
  const counts = (key) => {
    if (key === 'all') return state.apps.length;
    if (key === 'installed') return state.apps.filter((a) => a.installed).length;
    if (key === 'updates') return state.apps.filter(hasUpdate).length;
    if (key === 'new') return state.apps.filter((a) => isNewApp(a) || isUpdatedApp(a)).length;
    if (key === 'featured') return state.apps.filter((a) => a.featured).length;
    if (key === 'none') return state.apps.filter((a) => !catById(a.categoryId)).length;
    if (key === 'hidden') return state.apps.filter((a) => !a.published).length;
    if (key.startsWith('tag:')) return state.apps.filter((a) => (a.tags || []).includes(key.slice(4))).length;
    if (key.startsWith('src:')) return state.apps.filter((a) => a.cloud === 'source' && a.sourceName === key.slice(4)).length;
    if (key === 'cloud:github') return state.apps.filter((a) => a.cloud === 'github').length;
    if (key === 'cloud:link') return state.apps.filter((a) => a.cloud === 'link').length;
    if (key === 'missing') return state.apps.filter((a) => a.missing).length;
    return state.apps.filter((a) => a.categoryId === key).length;
  };
  const setup = !isOwner() && !state.certs.length
    ? `<p class="warning" data-act="go-certs" style="margin:0 0 12px;cursor:pointer">Add your certificate in the Certificates tab to start signing →</p>` : '';
  const view = libView();
  return `${setup}
    ${state.apps.length ? `
    <div class="searchbar">${ICONS.search}<input type="search" id="libSearch" placeholder="Search ${state.apps.length} apps" value="${esc(q)}" autocapitalize="off" autocorrect="off"></div>
    <div class="chips-row" id="libChips">
      ${chips.filter(([k]) => k === 'all' || k === cat || (counts(k) > 0 && !(k === 'new' && counts(k) === state.apps.length)) || (isOwner() && state.categories.some((c) => c.id === k))).map(([k, l]) => `<button class="fchip ${cat === k ? 'on' : ''}" data-cat="${esc(k)}">${esc(l)} <span>${counts(k)}</span></button>`).join('')}
      ${state.collections.filter((c) => c.appIds.some((x) => state.apps.some((a) => a.id === x))).map((c) => `<button class="fchip" data-act="collection" data-id="${c.id}">${esc(c.emoji)} ${esc(c.name)} <span>${c.appIds.filter((x) => state.apps.some((a) => a.id === x)).length}</span></button>`).join('')}
      ${isOwner() ? '<button class="fchip ghost" data-act="manage-cats">⚙︎ Edit</button>' : ''}
    </div>
    <div class="lib-tools">
      <select id="libSort">
        ${[['smart', cat === 'all' ? 'Recently updated' : 'Featured first'], ['popular', 'Popular'], ['rating', 'Top rated'], ['name', 'A–Z'], ['newest', 'Newest'], ['size', 'Biggest']].map(([k, l]) => `<option value="${k}" ${sort === k ? 'selected' : ''}>Sort: ${l}</option>`).join('')}
      </select>
      <div class="seg" role="group" aria-label="Layout">
        <button data-view="list" class="${view === 'list' ? 'on' : ''}" aria-label="List">☰</button>
        <button data-view="grid" class="${view === 'grid' ? 'on' : ''}" aria-label="Grid">▦</button>
      </div>
      ${isOwner() ? `<button class="btn small-btn" data-act="toggle-select-mode">${state.lib.select ? 'Done' : 'Select'}</button>`
        : '<button class="btn small-btn" data-act="request-app">Request</button>'}
    </div>` : ''}
    <div id="libList">${libraryListHtml()}</div>
    ${state.lib.select ? bulkBarHtml() : ''}`;
}

function bulkBarHtml() {
  const n = state.lib.selected.size;
  return `<div class="bulk-bar">
    <span>${n} selected</span>
    <button data-bulk="category" ${n ? '' : 'disabled'}>Move</button>
    <button data-bulk="show" ${n ? '' : 'disabled'}>Show</button>
    <button data-bulk="hide" ${n ? '' : 'disabled'}>Hide</button>
    <button data-bulk="feature" ${n ? '' : 'disabled'}>★</button>
    <button data-bulk="delete" class="danger" ${n ? '' : 'disabled'}>Delete</button>
  </div>`;
}

function bindLibrary(view) {
  const search = $('#libSearch', view);
  if (search) {
    search.oninput = () => {
      state.lib.q = search.value;
      const list = $('#libList', view);
      list.innerHTML = libraryListHtml();
      bindView(list);
    };
  }
  view.querySelectorAll('[data-cat-jump]').forEach((b) => {
    b.onclick = () => { state.lib.cat = b.dataset.catJump; saveLibPrefs(); window.scrollTo(0, 0); render(); };
  });
  view.querySelectorAll('.fchip[data-cat]').forEach((b) => {
    b.onclick = () => { state.lib.cat = b.dataset.cat; state.lib.limit = 40; saveLibPrefs(); render(); };
  });
  const sort = $('#libSort', view);
  if (sort) sort.onchange = () => { state.lib.sort = sort.value; saveLibPrefs(); render(); };
  view.querySelectorAll('[data-bulk]').forEach((b) => { b.onclick = () => bulkAction(b.dataset.bulk); });
  view.querySelectorAll('.seg [data-view]').forEach((b) => {
    b.onclick = () => { try { localStorage.setItem('mango.libView', b.dataset.view); } catch { /* */ } render(); };
  });
}

async function bulkAction(action) {
  const ids = [...state.lib.selected];
  if (!ids.length) return;
  if (action === 'category') {
    return openSheet(`<h2>Move ${ids.length} app${ids.length === 1 ? '' : 's'} to…</h2>
      <div class="list">${[...state.categories.map((c) => [c.id, `${c.emoji} ${c.name}`]), ['', 'Uncategorized']].map(([cid, l]) => `<button class="row" data-cid="${cid}"><span class="row-main row-title">${esc(l)}</span></button>`).join('')}</div>`, (el) => {
      el.querySelectorAll('[data-cid]').forEach((b) => {
        b.onclick = async () => {
          try { await api('POST', '/api/apps/bulk', { ids, action: 'category', categoryId: b.dataset.cid || null }); closeSheet(); finishBulk('Moved'); } catch (e) { toast(e.message, true); }
        };
      });
    });
  }
  if (action === 'delete' && !confirm(`Delete ${ids.length} app${ids.length === 1 ? '' : 's'} from the library? This can't be undone.`)) return;
  const all = ids.every((i) => (state.apps.find((a) => a.id === i) || {}).featured);
  const act = action === 'feature' && all ? 'unfeature' : action;
  try { await api('POST', '/api/apps/bulk', { ids, action: act }); finishBulk({ show: 'Shown', hide: 'Hidden', feature: 'Featured', unfeature: 'Unfeatured', delete: 'Deleted' }[act]); } catch (e) { toast(e.message, true); }
}
async function finishBulk(msg) {
  state.lib.selected.clear();
  state.lib.select = false;
  toast(msg);
  await refresh();
}

function installHistoryHtml(limit = 20) {
  const list = (state.installs || []).slice(0, limit);
  if (!list.length) return '';
  return `<div class="section-title">Install history <span class="count">${state.installs.length}</span></div>
    <div class="list">${list.map((l) => {
      const app = state.apps.find((a) => a.id === l.appId);
      return `<div class="row" ${app ? `data-act="app" data-id="${app.id}"` : ''}>
        ${app ? appIcon(app) : iconHtml(null, l.name)}
        <div class="row-main"><div class="row-title">${esc(l.name)}</div>
          <div class="row-sub">${esc(l.shownVersion || l.version || '')} · ${esc(l.certLabel || '')}</div>
          <div class="row-sub">${new Date(l.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></div>
        <span class="badge good">✓</span></div>`;
    }).join('')}</div>`;
}

function renderSigned() {
  if (!state.signed.length && !(state.installs || []).length) {
    return `<div class="empty">${ICONS.down}<h3>Nothing signed yet</h3><p>Signed apps show up here, ready to install.</p>
      <button class="btn primary" data-act="go-library">Go to ${isOwner() ? 'Library' : 'App Library'}</button></div>`;
  }
  const keep = Number(state.settings.signedRetentionDays);
  const notes = [];
  if (!isOwner()) notes.push(`Your newest ${state.settings.maxSignedPerUser || 10} signed apps are kept.`);
  if (keep) notes.push(`Signed files are removed after ${keep} day${keep === 1 ? '' : 's'} to save space — tap Sign again any time.`);
  const ready = state.signed.filter((s) => s.fileAvailable);
  const old = state.signed.filter((s) => !s.fileAvailable);
  const row = (s) => {
    const left = daysLeft(s.expires);
    const badge = left === null ? '' : left < 0 ? '<span class="badge bad">Cert expired</span>' : left < 7 ? `<span class="badge warn">${left}d left</span>` : `<span class="badge">${left}d left</span>`;
    return `
    <div class="row" data-act="signed" data-id="${s.id}">
      ${signedIcon(s)}
      <div class="row-main">
        <div class="row-title">${esc(s.name)} ${badge}</div>
        <div class="row-sub">${esc(s.version || '—')} · ${esc(s.certLabel)}</div>
        <div class="row-sub">Signed ${ago(s.signedAt)} · ${fmtSize(s.size)}</div>
      </div>
      ${s.fileAvailable ? `<button class="pill" data-act="install" data-id="${s.id}">Get</button>` : `<button class="pill dim" data-act="resign" data-id="${s.id}">Re-sign</button>`}
    </div>`;
  };
  return `${notes.length ? `<p class="hint" style="margin:0 4px 10px">${notes.join(' ')}</p>` : ''}
    ${ready.length ? `<div class="section-title" style="margin-top:4px">Ready to install <span class="count">${ready.length}</span></div><div class="list">${ready.map(row).join('')}</div>` : ''}
    ${old.length ? `<div class="section-title">File removed <span class="count">${old.length}</span></div><div class="list">${old.map(row).join('')}</div>` : ''}
    ${installHistoryHtml()}`;
}

function certStatusBadge(c) {
  const left = daysLeft(certExpiry(c));
  if (left !== null && left < 0) return '<span class="badge bad">Expired</span>';
  const st = c.check && c.check.status;
  if (st === 'revoked') return '<span class="badge bad">Revoked</span>';
  if (st === 'valid') return '<span class="badge good">Valid</span>';
  return '<span class="badge">Status unknown</span>';
}
function profileAllows(c, key) {
  const vals = c.profile.entitlementValues;
  if (vals) return vals[key] === true || (Array.isArray(vals[key]) && vals[key].length > 0) || (typeof vals[key] === 'string' && vals[key] !== '');
  return (c.profile.entitlements || []).includes(key);
}

function renderCerts() {
  if (!state.certs.length) {
    return `<div class="empty">${ICONS.shield}<h3>No certificates</h3><p>Add your .p12 and .mobileprovision to start signing.</p>
      <button class="btn primary" data-act="add-cert">Add Certificate</button></div>`;
  }
  return state.certs.map((c) => {
    const exp = certExpiry(c);
    const left = daysLeft(exp);
    const leftBadge = left === null || left < 0 ? '' : `<span class="badge ${left < 14 ? 'warn' : 'mango'}">${left} days left</span>`;
    let deviceNote = '';
    if (c.deviceIncluded === false) deviceNote = '<p class="warning bad">Your iPhone isn\'t in this profile, so apps signed with it won\'t install on it. Add your UDID to the profile in your Apple Developer account.</p>';
    else if (c.deviceIncluded === null && !state.account.udid && c.profile.type !== 'Enterprise') deviceNote = '<p class="hint" style="margin-top:8px">Link your iPhone in ' + (isOwner() ? 'Settings' : 'Account') + ' to check if it\'s in this profile.</p>';
    const caps = ENT_PRESETS.map((p) => `<span class="badge ${profileAllows(c, p.key) ? 'good' : ''}">${profileAllows(c, p.key) ? '✓' : '✕'} ${p.short}</span>`).join('');
    return `<div class="card">
      <div class="card-head"><h3>${esc(c.label)}</h3>${c.isDefault ? '<span class="badge mango">Default</span>' : ''}</div>
      <div class="badges">${certStatusBadge(c)}<span class="badge">${esc(c.profile.type)}</span>${leftBadge}${c.deviceIncluded === true && c.profile.type !== 'Enterprise' ? '<span class="badge good">Your iPhone ✓</span>' : ''}</div>
      <dl class="kv">
        <dt>Certificate</dt><dd>${esc(c.p12.commonName)}</dd>
        <dt>Team</dt><dd>${esc(c.profile.teamName || '—')} ${c.profile.teamId ? `(${esc(c.profile.teamId)})` : ''}</dd>
        <dt>App ID</dt><dd>${esc(c.profile.appId || '—')}</dd>
        <dt>Profile</dt><dd>${esc(c.profile.name || '—')}</dd>
        ${c.profile.type === 'Enterprise' ? '' : `<dt>Devices</dt><dd>${c.profile.deviceCount}</dd>`}
        <dt>Cert expires</dt><dd>${fmtDate(c.p12.validTo)}</dd>
        <dt>Profile expires</dt><dd>${fmtDate(c.profile.expires)}</dd>
        ${c.check && c.check.checkedAt ? `<dt>Last checked</dt><dd>${ago(c.check.checkedAt)}</dd>` : ''}
      </dl>
      <div class="section-title" style="margin:12px 0 6px">Profile allows</div>
      <div class="badges" style="margin-top:0">${caps}</div>
      ${c.matches === false ? '<p class="warning bad">This .p12 isn\'t listed in the provisioning profile, so signed apps won\'t install. Use the profile made for this certificate.</p>' : ''}
      ${c.profile.type === 'App Store' ? '<p class="warning">App Store profiles can\'t install apps directly. Use a Development, Ad Hoc or Enterprise profile.</p>' : ''}
      ${deviceNote}
      <div class="card-actions">
        <button class="btn" data-act="check-cert" data-id="${c.id}">Check</button>
        ${c.isDefault ? '' : `<button class="btn" data-act="default-cert" data-id="${c.id}">Make Default</button>`}
        <button class="btn" data-act="rename-cert" data-id="${c.id}">Rename</button>
        <button class="btn danger" data-act="delete-cert" data-id="${c.id}">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function renderUsers() {
  const invites = state.invites.length
    ? `<div class="list">${state.invites.map((i) => `
        <div class="row" data-act="invite" data-id="${esc(i.code)}">
          <div class="row-main">
            <div class="row-title mono" style="font-size:16px">${esc(i.code)}</div>
            <div class="row-sub">${esc(i.note || 'No note')} · ${i.uses}/${i.maxUses} used</div>
          </div>
          ${i.uses >= i.maxUses ? '<span class="badge">Used up</span>' : '<span class="badge good">Active</span>'}
        </div>`).join('')}</div>`
    : `<div class="card"><p class="muted" style="margin:0 0 12px">Make an invite code and send it to someone so they can create an account.</p><button class="btn primary block" data-act="new-invite">New Invite</button></div>`;
  const users = state.users.length
    ? `<div class="list">${state.users.map((u) => `
        <div class="row" data-act="user" data-id="${u.id}">
          <div class="app-icon" style="width:44px;height:44px;border-radius:50%;font-size:18px">${esc(u.username.charAt(0).toUpperCase())}</div>
          <div class="row-main">
            <div class="row-title">${esc(u.username)}${u.disabled ? '<span class="badge bad">Off</span>' : ''}</div>
            <div class="row-sub">${u.deviceName ? esc(u.deviceName) : 'No iPhone linked'} · ${u.certCount} cert${u.certCount === 1 ? '' : 's'} · ${u.signedCount} signed</div>
            <div class="row-sub">Last seen ${ago(u.lastLogin)}</div>
          </div>
        </div>`).join('')}</div>`
    : `<div class="empty" style="padding:24px">${ICONS.users}<p>No users yet. Share an invite code to get started.</p></div>`;
  const pending = (state.requests || []).filter((r) => r.status === 'pending');
  const others = (state.requests || []).filter((r) => r.status !== 'pending').slice(0, 10);
  const reqs = (state.requests || []).length
    ? `<div class="section-title" style="margin-top:4px">App requests ${pending.length ? `<span class="count hot">${pending.length} new</span>` : ''}</div>
       <div class="list">${[...pending, ...others].map(requestRow).join('')}</div>` : '';
  return `${reqs}<div class="section-title" style="margin-top:${reqs ? 22 : 4}px">Invite codes</div>${invites}<div class="section-title">People <span class="count">${state.users.length}</span></div>${users}`;
}

function accountSection() {
  const a = state.account;
  return `
    <div class="section-title">Account</div>
    <div class="list">
      <div class="setting"><span>Upload speed<br><span class="hint">Saved on this device</span></span>
        <select data-act="upload-speed">${UPLOAD_MODES.map((m) => `<option value="${m.streams}" ${m.streams === uploadStreams() ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>
      <button class="row" data-act="appearance"><span class="row-main" style="font-weight:600">🎨 Appearance</span><span class="value muted">${esc(themeLabel())} ›</span></button>
      <button class="row" data-act="tour"><span class="row-main" style="font-weight:600">👋 Show the welcome tour</span><span class="value muted">›</span></button>
      <button class="row" data-act="whats-new"><span class="row-main" style="font-weight:600">✨ What's New</span><span class="value muted">V${esc(CLIENT_VERSION || state.server.version || '')} ›</span></button>
      <div class="setting"><span>Username</span><span class="value">${esc(a.username)}</span></div>
      <div class="setting"><span>iPhone</span><span class="value">${a.udid ? `${esc(a.deviceName || 'iPhone')}<br><span class="mono">${esc(shortUdid(a.udid))}</span>` : 'Not linked'}</span></div>
      ${a.udid ? '<button class="row" data-act="copy-udid"><span class="row-main" style="font-weight:600">Copy my UDID</span></button><button class="row" data-act="unlink-device"><span class="row-main" style="color:var(--red);font-weight:600">Unlink iPhone</span></button>'
        : '<a class="row" href="/udid/profile.mobileconfig?intent=link" style="text-decoration:none"><span class="row-main" style="color:var(--mango);font-weight:600">Link this iPhone</span></a>'}
      ${!isOwner() ? '<button class="row" data-act="change-password"><span class="row-main" style="font-weight:600">Change Password</span></button>' : ''}
      ${state.server.passwordSet !== false ? '<button class="row" data-act="logout"><span class="row-main" style="color:var(--red);font-weight:600">Log Out</span></button>' : ''}
    </div>
    <p class="hint" style="margin:8px 4px 0">${a.udid ? 'Your iPhone can sign in without a password, and Mango checks whether it\'s in your profiles.' : 'Linking downloads a quick profile: open Settings › Profile Downloaded › Install, and you\'ll come back here.'}</p>
    ${!isOwner() ? `<div class="section-title">My app requests</div>
      ${(state.requests || []).length ? `<div class="list">${state.requests.map(requestRow).join('')}</div>` : ''}
      <button class="btn block" data-act="request-app" style="margin-top:${(state.requests || []).length ? 10 : 0}px">+ Request an App</button>` : ''}`;
}

function renderSettings() {
  if (!isOwner()) {
    return `${accountSection()}<p class="footer-note">🥭 Mango Signer ${esc(state.server.version || '')}<br>© 2026 MangoMods · All rights reserved</p>`;
  }
  const s = state.server;
  const b = s.storageBreakdown || {};
  const z = state.settings.zipLevel ?? 6;
  const total = s.storage || 1;
  const bar = (n, cls) => `<div class="${cls}" style="width:${Math.max(0.5, (100 * (n || 0)) / (s.disk ? s.disk.total : total))}%"></div>`;
  return `
    ${!s.https ? '<p class="warning bad">Your server isn\'t on HTTPS, so iOS will refuse to install apps. On Railway, generate a public domain for the service.</p>' : ''}
    ${!s.passwordSet ? '<p class="warning">No APP_PASSWORD is set, so anyone with your link has owner access. Add an APP_PASSWORD variable on Railway.</p>' : ''}
    <div class="section-title">Server</div>
    <div class="list">
      <div class="setting"><span>Address</span><span class="value">${esc(s.baseUrl)}</span></div>
      <div class="setting"><span>Signing engine</span><span class="value">${s.zsign ? 'zsign ' + esc(s.zsign) : '<span style="color:var(--red)">Not installed</span>'}</span></div>
      <div class="setting"><span>Version</span><span class="value">${esc(s.version)}</span></div>
    </div>
    <div class="section-title">Storage</div>
    <div class="card">
      ${s.disk ? `<div class="disk-head"><b>${fmtSize(s.disk.total - s.disk.free)}</b> of ${fmtSize(s.disk.total)} used<span class="${s.disk.free < 1024 ** 3 ? 'low' : ''}">${fmtSize(s.disk.free)} free</span></div>` : ''}
      ${s.disk && s.disk.free < 1024 ** 3 ? '<p class="warning bad" style="margin:0 0 10px">Storage is almost full. Big apps need about twice their size free to sign. Clean up below or delete apps you don\'t need.</p>' : ''}
      <div class="stack-bar">${bar(b.library, 's-lib')}${bar(b.signed, 's-signed')}${bar(b.certs, 's-certs')}${bar(b.temp, 's-temp')}</div>
      <div class="legend">
        <span><i class="s-lib"></i>Library ${fmtSize(b.library)}</span>
        <span><i class="s-signed"></i>Signed ${fmtSize(b.signed)}</span>
        <span><i class="s-certs"></i>Certs ${fmtSize(b.certs)}</span>
        <span><i class="s-temp"></i>Temp ${fmtSize(b.temp)}</span>
      </div>
      ${cloudCount() ? `<p class="hint" style="margin:8px 0 0">☁ ${cloudCount()} app${cloudCount() === 1 ? '' : 's'} (${fmtSize(cloudBytes())}) live in the cloud and use no space here.</p>` : ''}
      <div class="card-actions">
        <button class="btn" data-act="purge-signed">Clean signed files</button>
        <button class="btn" data-act="clear-temp">Clear temp</button>
      </div>
    </div>
    <div class="section-title">Cloud Library <span class="count">saves space</span></div>
    ${cloudSettingsHtml()}
    <div class="section-title">Signing</div>
    <div class="list">
      <div class="setting"><span>IPA compression</span>
        <select data-act="zip-level">${[0, 1, 3, 6, 9].map((n) => `<option value="${n}" ${n === Number(z) ? 'selected' : ''}>${n === 0 ? 'None (fastest)' : n === 9 ? 'Max (smallest)' : 'Level ' + n}</option>`).join('')}</select>
      </div>
      <label class="setting"><span>Remove signed file after it installs<br><span class="hint">Frees the space right away. Re-sign any time.</span></span>
        <span class="switch"><input type="checkbox" data-act="delete-after-install" ${state.settings.deleteAfterInstall !== false ? 'checked' : ''}><span></span></span></label>
      <div class="setting"><span>Delete signed files after</span>
        <select data-act="retention">${[[1, '1 day'], [3, '3 days'], [7, '7 days'], [30, '30 days'], [0, 'Never']].map(([n, l]) => `<option value="${n}" ${n === Number(state.settings.signedRetentionDays) ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
    </div>
    <p class="hint" style="margin:8px 4px 0">Signed files are only needed to install. Removing old ones keeps big games from filling your Railway volume.</p>
    <div class="section-title">Users</div>
    <div class="list">
      <div class="setting"><span>Signed apps kept per user</span>
        <select data-act="max-signed">${[3, 5, 10, 20, 50].map((n) => `<option value="${n}" ${n === Number(state.settings.maxSignedPerUser) ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </div>
      <label class="setting"><span>Sign in with iPhone (UDID)</span>
        <span class="switch"><input type="checkbox" data-act="udid-login" ${state.settings.udidLogin ? 'checked' : ''}><span></span></span></label>
    </div>
    <div class="section-title">Library</div>
    <div class="list">
      <div class="setting"><span>Apps</span><span class="value">${state.apps.length} (${state.apps.filter((a) => a.published).length} shown)</span></div>
      <button class="row" data-act="manage-cats"><span class="row-main" style="font-weight:600">Categories</span><span class="value muted">${state.categories.length} ›</span></button>
      <button class="row" data-act="manage-cols"><span class="row-main" style="font-weight:600">Collections</span><span class="value muted">${state.collections.length} ›</span></button>
      <button class="row" data-act="announce"><span class="row-main" style="font-weight:600">📣 Announcement</span><span class="value muted">${state.announcement ? 'On' : 'Off'} ›</span></button>
      <div class="setting"><span>Your signed apps</span><span class="value">${state.signed.length}</span></div>
      <div class="setting"><span>Users</span><span class="value">${state.users.length}</span></div>
    </div>
    ${accountSection()}
    <p class="footer-note">🥭 Mango Signer · signing powered by zsign (MIT)<br>© 2026 MangoMods · All rights reserved</p>`;
}

function bindView(view) {
  view.querySelectorAll('[data-stop]').forEach((el) => el.addEventListener('click', (e) => e.stopPropagation()));
  view.querySelectorAll('[data-act]').forEach((el) => {
    const act = el.dataset.act;
    const idv = el.dataset.id;
    const saveSetting = (body, msg = 'Saved') => api('PATCH', '/api/settings', body).then((d) => { state.settings = d.settings; toast(msg); }).catch((e) => toast(e.message, true));
    if (act === 'zip-level') { el.onchange = () => saveSetting({ zipLevel: Number(el.value) }); return; }
    if (act === 'max-signed') { el.onchange = () => saveSetting({ maxSignedPerUser: Number(el.value) }); return; }
    if (act === 'upload-speed') {
      el.onchange = () => {
        try { localStorage.setItem('mango.uploadStreams', el.value); } catch { /* */ }
        const m = UPLOAD_MODES.find((x) => String(x.streams) === el.value);
        toast(`Upload speed: ${m.label} (${m.sub.toLowerCase()})`);
      };
      return;
    }
    if (act === 'delete-after-install') { el.onchange = () => saveSetting({ deleteAfterInstall: el.checked }, el.checked ? 'Signed files are removed after installing' : 'Signed files are kept after installing'); return; }
    if (act === 'retention') { el.onchange = () => saveSetting({ signedRetentionDays: Number(el.value) }); return; }
    if (act === 'udid-login') { el.onchange = () => saveSetting({ udidLogin: el.checked }, el.checked ? 'iPhone sign-in on' : 'iPhone sign-in off'); return; }
    if (el.tagName === 'A') return;
    el.onclick = (e) => {
      e.stopPropagation();
      ({
        'add-app': addAppSheet,
        'add-cert': addCertSheet,
        'go-library': () => switchTab('library'),
        'go-certs': () => switchTab('certs'),
        app: () => appSheet(idv),
        sign: () => signSheet(idv),
        get: () => quickGet(idv),
        collection: () => collectionSheet(idv),
        'request-app': requestAppSheet,
        'manage-cols': manageCollectionsSheet,
        'add-source': addSourceSheet,
        'lib-more': () => { state.lib.limit += 40; const y = window.scrollY; render(); window.scrollTo(0, y); },
        source: () => sourceSheet(idv),
        github: githubSheet,
        announce: announcementSheet,
        appearance: appearanceSheet,
        tour: () => tourSheet(true),
        'dismiss-announce': dismissAnnouncement,
        signed: () => signedSheet(idv),
        resign: () => resignFromSigned(idv),
        install: () => startInstall(state.signed.find((x) => x.id === idv)),
        'toggle-select-mode': () => { state.lib.select = !state.lib.select; state.lib.selected.clear(); render(); },
        'toggle-select': () => { const s = state.lib.selected; s.has(idv) ? s.delete(idv) : s.add(idv); render(); },
        'manage-cats': manageCategoriesSheet,
        'check-cert': () => checkCert(idv, el),
        'default-cert': () => makeDefault(idv),
        'rename-cert': () => renameCert(idv),
        'delete-cert': () => deleteCert(idv),
        'new-invite': newInviteSheet,
        invite: () => inviteSheet(idv),
        user: () => userSheet(idv),
        'whats-new': whatsNewSheet,
        'copy-udid': () => copy(state.account.udid, 'UDID copied'),
        'unlink-device': unlinkDevice,
        'change-password': changePasswordSheet,
        'purge-signed': () => maintenance('purge-signed'),
        'clear-temp': () => maintenance('clear-temp'),
        logout,
      }[act] || (() => {}))();
    };
  });
}

function switchTab(tab) {
  const keys = tabsFor().map(([k]) => k);
  const from = keys.indexOf(state.tab);
  const to = keys.indexOf(tab);
  const same = tab === state.tab;
  state.tab = tab;
  state.lib.select = false;
  state.lib.selected.clear();
  window.scrollTo(0, 0);
  render();
  if (same || reducedMotion()) return;
  // Slide the new page in from the side you tapped toward, and let its rows ripple in.
  const view = $('#view');
  view.classList.remove('slide-left', 'slide-right', 'enter');
  void view.offsetWidth;
  view.classList.add(to > from ? 'slide-right' : 'slide-left', 'enter');
  clearTimeout(switchTab.timer);
  switchTab.timer = setTimeout(() => view.classList.remove('slide-left', 'slide-right', 'enter'), 700);
}

async function maintenance(action) {
  try { const { message } = await api('POST', '/api/maintenance', { action }); toast(message); await refresh(); } catch (e) { toast(e.message, true); }
}

// ---------- cloud library (sources + GitHub storage) ----------
const cloudApps = () => state.apps.filter((a) => a.cloud);
const cloudCount = () => cloudApps().length;
const cloudBytes = () => cloudApps().reduce((n, a) => n + (a.size || 0), 0);
const localApps = () => state.apps.filter((a) => !a.cloud);
const SUGGESTED_SOURCES = [
  { name: 'ryP0 Repository', url: 'https://github.com/Sami-Wali/ryP0-repository/blob/main/repo.json' },
  { name: 'MikeBuilds', url: 'https://github.com/mikevillarroel/mikebuilds-source/blob/main/source.json' },
];
const rawGithub = (u) => String(u).replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\//, 'https://raw.githubusercontent.com/$1/$2/');

function cloudSettingsHtml() {
  const g = state.github || {};
  const srcs = state.sources || [];
  return `<div class="list">
      ${srcs.map((src) => `
        <button class="row" data-act="source" data-id="${src.id}">
          ${iconHtml(src.iconURL || null, src.name)}
          <span class="row-main"><span class="row-title">${esc(src.name)}</span>
            <span class="row-sub">${src.lastError ? `<span style="color:var(--red)">⚠ ${esc(src.lastError)}</span>` : `${src.apps} app${src.apps === 1 ? '' : 's'} · synced ${ago(src.lastSync)}${src.showInLibrary === false ? ' · hidden' : ''}`}</span></span>
          <span class="value muted">›</span>
        </button>`).join('')}
      <button class="row" data-act="add-source"><span class="row-main" style="font-weight:600;color:var(--accent)">＋ Add a source</span><span class="value muted">AltStore / ESign repos</span></button>
      <button class="row" data-act="github">
        <span class="row-main"><span class="row-title">GitHub storage</span>
          <span class="row-sub">${g.connected ? `${esc(g.owner)}/${esc(g.repo)} · ${g.apps} app${g.apps === 1 ? '' : 's'}${g.lastError ? ' · ⚠ ' + esc(g.lastError) : ''}` : 'Keep your own IPAs in a private repo instead of here'}</span></span>
        <span class="value ${g.connected ? '' : 'muted'}">${g.connected ? '<span class="badge good">On</span>' : 'Off ›'}</span>
      </button>
    </div>
    <p class="hint" style="margin:8px 4px 0">Cloud apps only keep their info and icon here. The file is downloaded while signing and deleted right after, so your Railway volume stays empty.</p>`;
}

function addSourceSheet() {
  const have = new Set((state.sources || []).map((x) => x.url));
  const sugg = SUGGESTED_SOURCES.filter((x) => !have.has(rawGithub(x.url)));
  openSheet(`
    <h2>Add a Source</h2>
    <p class="muted small" style="margin-top:-6px">A source is a list of apps someone keeps up to date (the same kind AltStore, SideStore, ESign and Feather use). Its apps show up in your library as links — nothing is downloaded to your server until someone signs one.</p>
    <div class="field"><label>Source link</label><input type="url" id="srcUrl" placeholder="https://…/source.json" autocapitalize="off" autocorrect="off"><div class="hint">GitHub links work as-is — the page link is turned into the raw file for you.</div></div>
    <div class="group">${toggle('srcShow', 'Show its apps to everyone', 'Turn off to keep them just for you until you check them out', true)}</div>
    <button class="btn primary block" id="srcAdd" style="margin-top:12px">Add Source</button>
    ${sugg.length ? `<div class="section-title">Suggested</div><div class="list">${sugg.map((x, i) => `
      <div class="row">${iconHtml(null, x.name)}<div class="row-main"><div class="row-title">${esc(x.name)}</div><div class="row-sub mono small-break">${esc(x.url.replace('https://github.com/', ''))}</div></div><button class="pill" data-sugg="${i}">Add</button></div>`).join('')}</div>` : ''}
    <div id="addProgress"></div>`, (el) => {
    const add = async (url, btn) => {
      if (!url) return toast('Paste a source link first', true);
      el.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
      const old = btn.textContent;
      btn.textContent = 'Reading source…';
      try {
        const { source, result } = await api('POST', '/api/sources', { url, showInLibrary: $('#srcShow', el).checked });
        await refresh();
        toast(`Added ${source.name}: ${result.added} app${result.added === 1 ? '' : 's'}`);
        sourceSheet(source.id);
      } catch (e) {
        toast(e.message, true);
        el.querySelectorAll('button, input').forEach((b) => { b.disabled = false; });
        btn.textContent = old;
      }
    };
    $('#srcAdd', el).onclick = (e) => add($('#srcUrl', el).value.trim(), e.currentTarget);
    el.querySelectorAll('[data-sugg]').forEach((b) => { b.onclick = () => add(sugg[Number(b.dataset.sugg)].url, b); });
  });
}

function sourceSheet(sid) {
  const src = (state.sources || []).find((x) => x.id === sid);
  if (!src) return toast('Source not found', true);
  const apps = state.apps.filter((a) => a.cloud === 'source' && a.sourceName === src.name);
  const missing = apps.filter((a) => a.missing).length;
  openSheet(`
    <div class="sheet-head">${iconHtml(src.iconURL || null, src.name, true)}<div class="row-main"><h2>${esc(src.name)}</h2><div class="row-sub">${esc(src.subtitle || 'App source')}</div></div></div>
    ${src.lastError ? `<p class="warning bad">Last refresh failed: ${esc(src.lastError)}</p>` : ''}
    <dl class="kv card" style="margin:0">
      <dt>Apps</dt><dd>${src.apps}${missing ? ` <span class="muted small">(+${missing} removed upstream)</span>` : ''}</dd>
      <dt>Last refresh</dt><dd>${src.lastSync ? ago(src.lastSync) : 'never'}</dd>
      <dt>Link</dt><dd class="mono small-break">${esc(src.url)}</dd>
    </dl>
    <p class="hint" style="margin:8px 4px 0">Refreshes by itself every 6 hours. New versions show as UPDATED in the library. Anything you edit on an app (name, category, description…) is kept when it refreshes.</p>
    <div class="group" style="margin-top:12px">${toggle('srcShow', 'Show its apps to everyone', 'Off = only you can see them', src.showInLibrary !== false)}</div>
    <div class="field" style="margin-top:12px"><label>Name in your library</label><input type="text" id="srcName" value="${esc(src.name)}" maxlength="60"></div>
    <div class="actions">
      <button class="btn primary block" id="srcSync">Refresh now</button>
      ${apps.length ? `<button class="btn block" id="srcBrowse">See its ${apps.length} app${apps.length === 1 ? '' : 's'} in the library</button>` : ''}
      <button class="btn block" id="srcSave">Save name</button>
      <button class="btn block danger" id="srcDel">Remove source</button>
    </div>`, (el) => {
    $('#srcShow', el).onchange = async (e) => {
      try { await api('PATCH', `/api/sources/${sid}`, { showInLibrary: e.target.checked }); await refresh(); toast(e.target.checked ? 'Shown to everyone' : 'Only you can see these apps now'); } catch (err) { toast(err.message, true); }
    };
    $('#srcSave', el).onclick = async () => {
      try { await api('PATCH', `/api/sources/${sid}`, { name: $('#srcName', el).value }); await refresh(); toast('Renamed'); sourceSheet(sid); } catch (e) { toast(e.message, true); }
    };
    $('#srcSync', el).onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true; b.textContent = 'Refreshing…';
      try {
        const { result: r } = await api('POST', `/api/sources/${sid}/sync`);
        await refresh();
        const bits = [r.added && `${r.added} new`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`].filter(Boolean);
        toast(bits.length ? bits.join(' · ') : 'Already up to date');
      } catch (err) { await refresh().catch(() => {}); toast(err.message, true); }
      sourceSheet(sid);
    };
    if ($('#srcBrowse', el)) $('#srcBrowse', el).onclick = () => { closeSheet(); state.lib.cat = `src:${src.name}`; state.lib.q = ''; switchTab('library'); };
    $('#srcDel', el).onclick = async () => {
      if (!confirm(`Remove ${src.name}? Its ${apps.length} app${apps.length === 1 ? '' : 's'} leave the library. People who installed them keep them.`)) return;
      try { await api('DELETE', `/api/sources/${sid}`); closeSheet(); toast('Source removed'); await refresh(); } catch (e) { toast(e.message, true); }
    };
  });
}

function parseRepo(v) {
  const t = String(v || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const [owner, repo] = t.split('/');
  return { owner: owner || '', repo: repo || '' };
}

function githubSheet(editing = false) {
  const g = state.github || {};
  const local = localApps();
  const localSize = local.reduce((n, a) => n + (a.size || 0), 0);
  if (!g.connected || editing) {
    openSheet(`
      <h2>GitHub storage</h2>
      <p class="muted small" style="margin-top:-6px">Keep your own IPAs in a GitHub repo (private works) instead of on Railway. Files up to 2 GB each, and it's free.</p>
      ${editing ? '' : `<ol class="gh-steps">
        <li>On github.com make a <b>new repository</b> (e.g. <span class="mono">mango-ipas</span>). Set it to <b>Private</b> and tick <b>Add a README</b>.</li>
        <li>Go to <b>Settings › Developer settings › Personal access tokens › Fine-grained tokens</b> and tap <b>Generate new token</b>.</li>
        <li>Under <b>Repository access</b> pick <b>Only select repositories</b> and choose that repo. Under <b>Permissions › Repository permissions</b> set <b>Contents</b> to <b>Read and write</b>. Pick the longest expiration you're happy with.</li>
        <li>Copy the token and paste it below.</li>
      </ol>`}
      <div class="field"><label>Repository</label><input type="text" id="ghRepo" value="${g.owner ? esc(g.owner + '/' + g.repo) : ''}" placeholder="your-name/mango-ipas" autocapitalize="off" autocorrect="off"><div class="hint">owner/name, or paste the repo's link</div></div>
      <div class="field"><label>Token</label><input type="password" id="ghToken" placeholder="${g.connected ? 'Leave blank to keep the current token' : 'github_pat_…'}" autocapitalize="off" autocorrect="off" autocomplete="off"><div class="hint">Stored encrypted on your server and never shown again.</div></div>
      <button class="btn primary block" id="ghConnect">${g.connected ? 'Save' : 'Connect'}</button>
      ${editing ? '<button class="btn block" id="ghBack" style="margin-top:8px">Back</button>' : ''}`, (el) => {
      if ($('#ghBack', el)) $('#ghBack', el).onclick = () => githubSheet();
      $('#ghConnect', el).onclick = async (e) => {
        const { owner, repo } = parseRepo($('#ghRepo', el).value);
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Checking…';
        try {
          const { github, result } = await api('PUT', '/api/github', { owner, repo, token: $('#ghToken', el).value.trim() });
          state.github = github;
          await refresh();
          toast(result && result.added ? `Connected · found ${result.added} app${result.added === 1 ? '' : 's'}` : 'GitHub connected');
          githubSheet();
        } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = g.connected ? 'Save' : 'Connect'; }
      };
    });
    return;
  }
  openSheet(`
    <h2>GitHub storage</h2>
    ${g.lastError ? `<p class="warning bad">${esc(g.lastError)}</p>` : ''}
    <dl class="kv card" style="margin:0">
      <dt>Repo</dt><dd>${esc(g.owner)}/${esc(g.repo)} ${g.private ? '<span class="badge">Private</span>' : '<span class="badge warn">Public</span>'}</dd>
      <dt>Apps there</dt><dd>${g.apps}</dd>
      <dt>Last sync</dt><dd>${g.lastSync ? ago(g.lastSync) : 'never'}</dd>
    </dl>
    <div class="group" style="margin-top:12px">${toggle('ghStore', 'Save new uploads to GitHub', 'Apps you upload go straight to your repo, then get removed from this server', g.storeUploads)}</div>
    <p class="hint" style="margin:8px 4px 0">You can also add apps on github.com: open your repo › <b>Releases</b> › <b>Mango Library</b> › ✏️ Edit, drop .ipa files in, save, then tap <b>Sync</b> here.</p>
    <div class="actions">
      <button class="btn primary block" id="ghSync">Sync with GitHub</button>
      ${local.length ? `<button class="btn block" id="ghMove">Move ${local.length} app${local.length === 1 ? '' : 's'} off this server (frees ${fmtSize(localSize)})</button>` : ''}
      <a class="btn block" href="https://github.com/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}/releases/tag/${encodeURIComponent(g.tag || 'mango-library')}" target="_blank" rel="noopener">Open the release on GitHub ↗</a>
      <button class="btn block" id="ghEdit">Change repo or token</button>
      <button class="btn block danger" id="ghOff">Disconnect</button>
    </div>`, (el) => {
    $('#ghStore', el).onchange = async (e) => {
      try { state.github = (await api('PATCH', '/api/github', { storeUploads: e.target.checked })).github; toast(e.target.checked ? 'New uploads go to GitHub' : 'New uploads stay on this server'); } catch (err) { toast(err.message, true); }
    };
    $('#ghSync', el).onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true; b.textContent = 'Syncing…';
      try {
        const { result: r } = await api('POST', '/api/github/sync');
        await refresh();
        const bits = [r.added && `${r.added} added`, r.removed && `${r.removed} removed`].filter(Boolean);
        toast(bits.length ? bits.join(' · ') : 'Already in sync');
        if (r.failed) toast(`${r.failed} file${r.failed === 1 ? '' : 's'} on GitHub couldn't be read (not a valid .ipa?)`, true);
      } catch (err) { await refresh().catch(() => {}); toast(err.message, true); }
      githubSheet();
    };
    if ($('#ghMove', el)) $('#ghMove', el).onclick = () => moveToGithubSheet(null, `${local.length} app${local.length === 1 ? '' : 's'}`);
    $('#ghEdit', el).onclick = () => githubSheet(true);
    $('#ghOff', el).onclick = async () => {
      if (!confirm(`Disconnect GitHub? Your ${g.apps} GitHub app${g.apps === 1 ? '' : 's'} stay listed but can't be signed until you connect again. Nothing is deleted from GitHub.`)) return;
      try { state.github = (await api('DELETE', '/api/github')).github; await refresh(); toast('Disconnected'); closeSheet(); } catch (e) { toast(e.message, true); }
    };
  });
}

function moveToGithubSheet(ids, label) {
  openSheet(`
    <h2>Move to GitHub</h2>
    <p class="muted small" style="margin-top:-6px">Uploads ${esc(label)} to your repo, then deletes ${ids && ids.length === 1 ? 'it' : 'them'} from this server. Nothing changes for anyone using the library.</p>
    <button class="btn primary block" id="mvGo">Move ${esc(label)}</button>
    <div id="addProgress"></div>`, (el) => {
    $('#mvGo', el).onclick = async () => {
      const box = $('#addProgress', el);
      el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      closeSheet.locked = true;
      $('#sheet').classList.add('locked');
      box.innerHTML = uploadProgressHtml();
      keepAwake(true);
      try {
        const { jobId } = await api('POST', '/api/github/move', ids ? { ids } : {});
        const r = await waitJob(jobId, (j) => {
          if (j.progress != null) $('.bar > div', box).style.width = `${Math.round(j.progress * 100)}%`;
          const step = [...j.log].reverse().find((l) => /^\(\d+\/\d+\)/.test(l));
          $('#addMsg', box).textContent = `${step || 'Starting…'}${j.progress != null ? ` · ${Math.round(j.progress * 100)}%` : ''}`;
        });
        toast(`Moved ${r.moved} app${r.moved === 1 ? '' : 's'} · freed ${fmtSize(r.freed)}`);
        if (r.errors && r.errors.length) toast(r.errors[0], true);
      } catch (e) { toast(e.message, true); }
      keepAwake(false);
      closeSheet.locked = false;
      $('#sheet').classList.remove('locked');
      await refresh().catch(() => {});
      ids && ids.length === 1 ? appSheet(ids[0]) : githubSheet();
    };
  });
}

// ---------- adding & updating apps ----------
function uploadProgressHtml() {
  return `<div class="bar"><div></div></div><p class="muted small" id="addMsg">Starting…</p><p class="hint" id="addSub"></p>`;
}

// Uploads with GitHub storage on come back as a job (the file is sent on to GitHub).
async function appFromResponse(r, setProgress) {
  if (!r.jobId) return r;
  return waitJob(r.jobId, (j) => setProgress(j.progress, j.progress != null ? `Saving to GitHub ${Math.round(j.progress * 100)}%` : (j.log.slice(-1)[0] || 'Saving…')));
}
const ghStoring = () => state.github && state.github.connected && state.github.storeUploads;

function addAppSheet() {
  openSheet(`
    <h2>Add App</h2>
    <div class="actions">
      <button class="file-btn" id="pickIpa">${ICONS.file}<div class="row-main"><div class="row-title">Choose .ipa file</div><div class="row-sub">${ghStoring() ? 'Saved to your GitHub repo, not this server.' : 'From Files, iCloud Drive or Downloads. Big files resume if your connection drops.'}</div></div></button>
    </div>
    <div class="section-title">Or add from a link</div>
    <div class="field"><input type="url" id="ipaUrl" placeholder="https://example.com/app.ipa" autocapitalize="off" autocorrect="off"><div class="hint">Direct download links only. Dropbox links work (dl=0 is fixed for you).</div></div>
    <div class="group">${toggle('linkOnly', 'Link only (uses no storage)', "Only the app's info and icon are saved. The file is downloaded fresh each time someone signs it.", true)}</div>
    <button class="btn block" id="importUrl" style="margin-top:10px">Add from link</button>
    <button class="link-btn block" id="goSources" type="button">☁ Add a whole source (AltStore / ESign repo) instead</button>
    <div id="addProgress"></div>`, (el) => {
    $('#goSources', el).onclick = addSourceSheet;
    $('#pickIpa', el).onclick = async () => {
      const file = await pickFile('');
      if (!file) return;
      if (!/\.ipa$/i.test(file.name)) return toast('Pick an .ipa file', true);
      await runWithProgress(el, async (setProgress, setSub) => {
        const up = await uploadFile(file, (p) => setProgress(p, `Uploading ${Math.round(p * 100)}%`), setSub);
        setProgress(ghStoring() ? 0 : 1, 'Reading app info…');
        setSub('');
        return appFromResponse(await api('POST', '/api/apps', { uploadId: up.uploadId, fileName: file.name }), setProgress);
      }, (app) => { toast(`Added ${app.name}`); editAppSheet(app, true); });
    };
    $('#importUrl', el).onclick = async () => {
      const url = $('#ipaUrl', el).value.trim();
      if (!url) return toast('Paste a link first', true);
      const linkOnly = $('#linkOnly', el).checked;
      await runWithProgress(el, async (setProgress) => {
        const { jobId } = await api('POST', linkOnly ? '/api/apps/link' : '/api/apps/import', { url });
        return waitJob(jobId, (j) => setProgress(j.progress, j.progress != null ? `${linkOnly ? 'Reading' : 'Downloading'} ${Math.round(j.progress * 100)}%` : (j.log.slice(-1)[0] || 'Working…')));
      }, (app) => { toast(`Added ${app.name}`); editAppSheet(app, true); });
    };
  });
}

async function runWithProgress(el, work, onDone) {
  const box = $('#addProgress', el);
  el.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
  closeSheet.locked = true;
  $('#sheet').classList.add('locked');
  box.innerHTML = uploadProgressHtml();
  const setProgress = (p, msg) => {
    if (p != null) $('.bar > div', box).style.width = `${Math.round(p * 100)}%`;
    if (msg) $('#addMsg', box).textContent = msg;
  };
  const setSub = (t) => { $('#addSub', box).textContent = t || ''; };
  try {
    const { app } = await work(setProgress, setSub);
    closeSheet.locked = false;
    $('#sheet').classList.remove('locked');
    await refresh();
    const fresh = state.apps.find((a) => a.id === app.id) || app;
    onDone ? onDone(fresh) : closeSheet();
  } catch (e) {
    closeSheet.locked = false;
    $('#sheet').classList.remove('locked');
    el.querySelectorAll('button, input').forEach((b) => { b.disabled = false; });
    box.innerHTML = '';
    toast(e.message, true);
  }
}

function updateIpaSheet(a) {
  const isLink = a.cloud === 'link';
  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>Update ${esc(a.name)}</h2><div class="row-sub">Now ${esc(shownVersion(a) || '—')}</div></div></div>
    <p class="muted small">Swap in a new .ipa. The name, category, description, notes, icon and default sign settings all stay the same.</p>
    <button class="file-btn" id="uPick">${ICONS.file}<div class="row-main"><div class="row-title">Choose new .ipa</div><div class="row-sub">${ghStoring() ? 'Saved to your GitHub repo' : 'Resumes if your connection drops'}</div></div></button>
    <div class="section-title">Or from a link</div>
    <div class="field"><input type="url" id="uUrl" placeholder="https://example.com/app.ipa" autocapitalize="off" autocorrect="off"></div>
    <div class="group">${toggle('uLinkOnly', 'Link only (uses no storage)', 'Keeps just the link instead of downloading the file to the server', isLink || !a.cloud)}</div>
    <button class="btn block" id="uImport" style="margin-top:10px">Update from link</button>
    <div id="addProgress"></div>`, (el) => {
    const done = (app) => { toast(`Updated to ${app.version || 'new version'}`); appSheet(app.id); };
    $('#uPick', el).onclick = async () => {
      const file = await pickFile('');
      if (!file) return;
      if (!/\.ipa$/i.test(file.name)) return toast('Pick an .ipa file', true);
      await runWithProgress(el, async (setProgress, setSub) => {
        const up = await uploadFile(file, (p) => setProgress(p, `Uploading ${Math.round(p * 100)}%`), setSub);
        setProgress(ghStoring() ? 0 : 1, 'Reading app info…');
        setSub('');
        return appFromResponse(await api('POST', `/api/apps/${a.id}/replace`, { uploadId: up.uploadId }), setProgress);
      }, done);
    };
    $('#uImport', el).onclick = async () => {
      const url = $('#uUrl', el).value.trim();
      if (!url) return toast('Paste a link first', true);
      const linkOnly = $('#uLinkOnly', el).checked;
      await runWithProgress(el, async (setProgress) => {
        const { jobId } = await api('POST', `/api/apps/${a.id}/replace`, { url, linkOnly });
        return waitJob(jobId, (j) => setProgress(j.progress, j.progress != null ? `${linkOnly ? 'Reading' : 'Downloading'} ${Math.round(j.progress * 100)}%` : (j.log.slice(-1)[0] || 'Working…')));
      }, done);
    };
  });
}

function appSheet(appId) {
  const a = state.apps.find((x) => x.id === appId);
  if (!a) return;
  const owner = isOwner();
  const defaults = defaultsSummary(a.signDefaults);
  const total = a.likes + a.dislikes;
  const pct = total ? Math.round((100 * a.likes) / total) : null;
  const shots = a.screenshots || [];
  const shotList = shotSrcs(a);
  const versions = a.versions || [];
  const inCols = state.collections.filter((c) => c.appIds.includes(a.id));
  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>${esc(a.name)}</h2><div class="row-sub">${esc(a.developer || a.bundleId)}</div></div></div>
    <div class="badges" style="margin-top:0">
      ${appBadges(a)}
      <span class="badge mango">${esc(catLabel(a.categoryId))}</span>
      ${a.featured ? '<span class="badge warn">★ Featured</span>' : ''}
      <span class="badge">v${esc(shownVersion(a) || '?')}</span>
      <span class="badge">${fmtSize(a.size)}</span>
    </div>
    <div class="stat-row">
      <div><b>${a.installCount || 0}</b><span>installs</span></div>
      <div><b>${pct === null ? '—' : pct + '%'}</b><span>${total ? `liked · ${total} vote${total === 1 ? '' : 's'}` : 'no votes yet'}</span></div>
      <div><b>${esc(a.minOS || '—')}</b><span>min iOS</span></div>
    </div>
    ${a.missing ? `<p class="warning bad">${owner ? `This app was removed from ${esc(a.sourceName || 'its source')}, so it's hidden from everyone. You can still try signing it if the link works, or delete it.` : 'This app is no longer available.'}</p>` : ''}
    <button class="btn primary big block" id="aGet">${hasUpdate(a) ? `Update to ${esc(shownVersion(a))}` : a.installed ? 'Get Again' : 'Get'}</button>
    ${a.installed ? `<p class="hint center" style="margin-top:8px">You installed ${esc(a.installed.version || '')} ${ago(a.installed.at)}</p>` : ''}
    ${defaults.length ? `<p class="hint center" style="margin-top:${a.installed ? 2 : 8}px">Comes set up with: ${esc(defaults.join(' · '))}</p>` : ''}
    <button class="link-btn block" id="aOptions" type="button">Sign with options…</button>

    ${shotList.length ? `<div class="shots">${shotList.map((src, i) => `<button class="shot" data-shot="${i}"><img class="fade-img" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.add('loaded')" onerror="this.closest('.shot').remove()" src="${esc(src)}" alt="Screenshot ${i + 1}"></button>`).join('')}</div>` : ''}

    <div class="vote-row">
      <span class="muted small">Do you like it?</span>
      <button class="vote ${a.myVote > 0 ? 'on' : ''}" data-vote="1">👍 <b>${a.likes}</b></button>
      <button class="vote down ${a.myVote < 0 ? 'on' : ''}" data-vote="-1">👎 <b>${a.dislikes}</b></button>
    </div>

    ${(a.tags || []).length ? `<div class="tag-row">${a.tags.map((t) => `<button class="tag" data-tag="${esc(t)}"># ${esc(t)}</button>`).join('')}</div>` : ''}
    ${a.description ? `<div class="section-title">About</div><p class="desc">${esc(a.description)}</p>` : ''}
    ${a.notes ? `<div class="section-title">What's changed / notes</div><p class="desc">${esc(a.notes)}</p>` : ''}
    ${!a.notes && versions[0] && versions[0].notes ? `<div class="section-title">What's new in ${esc(versions[0].version || 'this version')}</div><p class="desc">${esc(versions[0].notes)}</p>` : ''}
    ${versions.length > 1 ? `<div class="section-title">Other versions <span class="count">${versions.length - 1}</span></div>
      <div class="list">${versions.slice(1).map((v, n) => `
        <div class="row ver-row">
          <div class="row-main">
            <div class="row-title">${esc(v.version || 'Version ' + (n + 2))}${v.channel && v.channel !== 'stable' ? ` <span class="badge">${esc(v.channel)}</span>` : ''}</div>
            <div class="row-sub">${[v.date ? esc(String(v.date).slice(0, 10)) : '', v.size ? fmtSize(v.size) : ''].filter(Boolean).join(' · ')}</div>
            ${v.notes ? `<div class="row-sub ver-notes">${esc(v.notes)}</div>` : ''}
          </div>
          <button class="pill" data-ver="${n + 1}">Get</button>
        </div>`).join('')}</div>
      <p class="hint" style="margin:6px 4px 0">Older versions are handy if the newest one has a bug or needs a newer iOS.</p>` : ''}
    ${inCols.length ? `<div class="section-title">In collections</div><div class="tag-row">${inCols.map((c) => `<button class="tag" data-col="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`).join('')}</div>` : ''}
    <div class="section-title">Info</div>
    <dl class="kv card" style="margin:0">
      <dt>Version</dt><dd>${esc(shownVersion(a) || '—')}${!a.versionOverride && a.build && a.build !== a.version ? ` (${esc(a.build)})` : ''}${a.versionOverride && owner ? `<br><span class="muted small">file says ${esc(a.version || '?')}</span>` : ''}${a.previousVersion && a.previousVersion !== shownVersion(a) ? `<br><span class="muted small">was ${esc(a.previousVersion)}</span>` : ''}</dd>
      <dt>Bundle ID</dt><dd class="mono">${esc(a.bundleId)}</dd>
      <dt>Minimum iOS</dt><dd>${esc(a.minOS || '—')}</dd>
      <dt>Size</dt><dd>${fmtSize(a.size)}</dd>
      <dt>Extensions</dt><dd>${a.extensions || 0}${a.hasWatch ? ' + Watch app' : ''}</dd>
      <dt>${a.updatedAt && a.updatedAt !== a.addedAt ? 'Updated' : 'Added'}</dt><dd>${ago(a.updatedAt || a.addedAt)}</dd>
      ${a.cloud === 'source' ? `<dt>Source</dt><dd>☁ ${esc(a.sourceName || '—')}</dd>` : ''}
      ${owner ? `<dt>Stored on</dt><dd>${esc(storedLabel(a))}</dd>` : ''}
      ${owner && a.remoteUrl ? `<dt>Link</dt><dd class="mono small-break">${esc(a.remoteUrl)}</dd>` : ''}
    </dl>
    ${owner ? `
    <div class="group" style="margin-top:14px">
      ${toggle('aPub', 'Show in App Library', 'Everyone you invite can sign and install it', a.published)}
      ${toggle('aFeat', 'Featured', 'Pinned to the top of the library', a.featured)}
    </div>
    <div class="actions">
      <button class="btn block" id="aEdit">Edit details, tags &amp; sign settings</button>
      <button class="btn block" id="aShots">Screenshots (${shots.length})</button>
      <button class="btn block" id="aCols">Add to collection</button>
      ${a.cloud === 'source' ? `<p class="hint center">Updates come in by themselves when ${esc(a.sourceName || 'the source')} adds a new version.</p>` : '<button class="btn block" id="aUpdate">Update IPA (new version)</button>'}
      ${!a.cloud && state.github.connected ? `<button class="btn block" id="aMoveGh">☁ Move to GitHub (frees ${fmtSize(a.size)})</button>` : ''}
      <a class="btn block" href="/api/apps/${a.id}/download">Download original .ipa</a>
      <button class="btn block danger" id="aDelete">Delete</button>
    </div>` : ''}`, (el) => {
    $('#aGet', el).onclick = () => quickGet(a.id);
    $('#aOptions', el).onclick = () => signSheet(a.id);
    el.querySelectorAll('[data-shot]').forEach((b) => { b.onclick = () => shotViewer(a, Number(b.dataset.shot)); });
    el.querySelectorAll('[data-ver]').forEach((b) => {
      b.onclick = () => {
        if (!state.certs.length) { closeSheet(); toast('Add your certificate first', true); return switchTab('certs'); }
        runSign(a, { ...signOptsFromDefaults(a), versionIndex: Number(b.dataset.ver) }, { icon: null, dylibs: [] });
      };
    });
    el.querySelectorAll('[data-vote]').forEach((b) => {
      b.onclick = async () => {
        const v = Number(b.dataset.vote);
        try {
          const { app } = await api('POST', `/api/apps/${a.id}/vote`, { value: a.myVote === v ? 0 : v });
          Object.assign(a, app);
          appSheet(a.id);
          render();
        } catch (e) { toast(e.message, true); }
      };
    });
    el.querySelectorAll('[data-tag]').forEach((b) => { b.onclick = () => { closeSheet(); state.lib.cat = `tag:${b.dataset.tag}`; state.lib.q = ''; switchTab('library'); }; });
    el.querySelectorAll('[data-col]').forEach((b) => { b.onclick = () => collectionSheet(b.dataset.col); });
    if (!owner) return;
    const flip = (id, field, on, off) => {
      $(id, el).onchange = async (e) => {
        try { await api('PATCH', `/api/apps/${a.id}`, { [field]: e.target.checked }); a[field] = e.target.checked; toast(e.target.checked ? on : off); render(); } catch (err) { toast(err.message, true); }
      };
    };
    flip('#aPub', 'published', 'Shown in App Library', 'Hidden from App Library');
    flip('#aFeat', 'featured', 'Featured ★', 'No longer featured');
    $('#aEdit', el).onclick = () => editAppSheet(a);
    $('#aShots', el).onclick = () => screenshotsSheet(a);
    $('#aCols', el).onclick = () => addToCollectionSheet(a);
    if ($('#aUpdate', el)) $('#aUpdate', el).onclick = () => updateIpaSheet(a);
    if ($('#aMoveGh', el)) $('#aMoveGh', el).onclick = () => moveToGithubSheet([a.id], a.name);
    $('#aDelete', el).onclick = async () => {
      if (!confirm(`Delete ${a.name} from the library? People who already installed it keep it.`)) return;
      try { await api('DELETE', `/api/apps/${a.id}`); closeSheet(); toast('Deleted'); await refresh(); } catch (e) { toast(e.message, true); }
    };
  });
}

// Full-screen screenshot viewer with swipe between images.
// Your uploaded screenshots first, then any that came with the source.
function shotSrcs(a) {
  const local = (a.screenshots || []).map((sh) => `/api/apps/${a.id}/screenshots/${sh.id}`);
  return local.length ? local : (a.remoteScreens || []);
}

function shotViewer(a, start = 0) {
  const shots = shotSrcs(a);
  const ov = document.createElement('div');
  ov.className = 'viewer';
  ov.innerHTML = `<button class="viewer-x" aria-label="Close">✕</button>
    <div class="viewer-track">${shots.map((src) => `<div class="viewer-slide"><img src="${esc(src)}" referrerpolicy="no-referrer" alt=""></div>`).join('')}</div>
    <div class="viewer-dots">${shots.map((_, i) => `<i data-i="${i}"></i>`).join('')}</div>`;
  document.body.appendChild(ov);
  const track = ov.querySelector('.viewer-track');
  const dots = [...ov.querySelectorAll('.viewer-dots i')];
  const mark = () => { const i = Math.round(track.scrollLeft / track.clientWidth); dots.forEach((d, n) => d.classList.toggle('on', n === i)); };
  requestAnimationFrame(() => { track.scrollLeft = start * track.clientWidth; mark(); });
  track.addEventListener('scroll', mark, { passive: true });
  const close = () => { ov.classList.add('out'); setTimeout(() => ov.remove(), 220); };
  ov.querySelector('.viewer-x').onclick = close;
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.classList.contains('viewer-slide')) close(); });
}

function screenshotsSheet(a) {
  const shots = a.screenshots || [];
  openSheet(`
    <h2>Screenshots</h2>
    <p class="hint" style="margin-top:-6px">Up to 8. They show on the app's page — tap one there to view it full screen.</p>
    <div class="shot-grid">${shots.map((sh, i) => `
      <div class="shot-edit"><img src="/api/apps/${a.id}/screenshots/${sh.id}" alt="">
        <div class="shot-tools">
          <button class="mini" data-left="${i}" ${i === 0 ? 'disabled' : ''}>←</button>
          <button class="mini danger" data-del="${sh.id}">✕</button>
          <button class="mini" data-right="${i}" ${i === shots.length - 1 ? 'disabled' : ''}>→</button>
        </div></div>`).join('')}</div>
    ${shots.length < 8 ? `<button class="file-btn" id="shAdd">${ICONS.plus}<div class="row-main"><div class="row-title">Add screenshots</div><div class="row-sub">PNG, JPEG or WebP · pick several at once</div></div></button>` : ''}
    <div id="addProgress"></div>
    <button class="btn block" id="shBack" style="margin-top:12px">Back to ${esc(a.name)}</button>`, (el) => {
    const reload = async (app) => { Object.assign(a, app); await refresh(); screenshotsSheet(state.apps.find((x) => x.id === a.id) || a); };
    const move = async (from, to) => {
      const ids = shots.map((s) => s.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      try { reload((await api('POST', `/api/apps/${a.id}/screenshots/order`, { ids })).app); } catch (e) { toast(e.message, true); }
    };
    el.querySelectorAll('[data-left]').forEach((b) => { b.onclick = () => move(+b.dataset.left, +b.dataset.left - 1); });
    el.querySelectorAll('[data-right]').forEach((b) => { b.onclick = () => move(+b.dataset.right, +b.dataset.right + 1); });
    el.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => { try { reload((await api('DELETE', `/api/apps/${a.id}/screenshots/${b.dataset.del}`)).app); } catch (e) { toast(e.message, true); } };
    });
    $('#shBack', el).onclick = () => appSheet(a.id);
    if ($('#shAdd', el)) {
      $('#shAdd', el).onclick = async () => {
        const files = (await pickFile('image/*', true)) || [];
        if (!files.length) return;
        const box = $('#addProgress', el);
        box.innerHTML = '<p class="muted small center">Uploading…</p>';
        let app = a;
        try {
          for (const [i, f] of files.slice(0, 8 - shots.length).entries()) {
            box.innerHTML = `<p class="muted small center">Uploading ${i + 1} of ${Math.min(files.length, 8 - shots.length)}…</p>`;
            const up = await uploadFile(f);
            app = (await api('POST', `/api/apps/${a.id}/screenshots`, { uploadId: up.uploadId })).app;
          }
          toast('Screenshots added');
        } catch (e) { toast(e.message, true); }
        reload(app);
      };
    }
  });
}

// ---------- one-tap Get ----------
function signOptsFromDefaults(a) {
  const d = a.signDefaults || {};
  return {
    appId: a.id,
    certId: (state.certs.find((c) => c.isDefault) || state.certs[0] || {}).id,
    minOS: d.minOS || '',
    entitlements: d.entitlements || [],
    plist: d.plist || [],
    removeExtensions: !!d.removeExtensions,
    removeWatch: d.removeWatch !== undefined ? !!d.removeWatch : !!a.hasWatch,
    removeUISD: !!d.removeUISD,
    enableDocs: !!d.enableDocs,
  };
}

// A signed copy is reusable if it's for this app, still on the server, signed with your default cert, and newer than the app.
function reusableSigned(a) {
  const cert = state.certs.find((c) => c.isDefault) || state.certs[0];
  if (!cert) return null;
  return state.signed.find((s) => s.appId === a.id && s.fileAvailable && s.certId === cert.id
    && new Date(s.signedAt) >= new Date(a.updatedAt || a.addedAt) && !(s.options && (s.options.dylibs || []).length) && !(s.options && s.options.icon)
    && !(s.options && s.options.versionIndex)) || null;
}

function quickGet(appId) {
  const a = state.apps.find((x) => x.id === appId);
  if (!a) return toast('That app is no longer in the library', true);
  if (!state.certs.length) {
    closeSheet();
    toast('Add your certificate first', true);
    return switchTab('certs');
  }
  const ready = reusableSigned(a);
  if (ready) return startInstall(ready); // already signed — install right away
  runSign(a, signOptsFromDefaults(a), { icon: null, dylibs: [] }, { quick: true });
}

// ---------- collections ----------
function collectionSheet(cid) {
  const c = state.collections.find((x) => x.id === cid);
  if (!c) return;
  const apps = c.appIds.map((x) => state.apps.find((a) => a.id === x)).filter(Boolean);
  openSheet(`
    <div class="sheet-head"><div class="app-icon big col-big">${esc(c.emoji)}</div><div class="row-main"><h2>${esc(c.name)}</h2><div class="row-sub">${apps.length} app${apps.length === 1 ? '' : 's'}</div></div></div>
    ${c.description ? `<p class="desc">${esc(c.description)}</p>` : ''}
    ${apps.length > 1 ? `<button class="btn primary big block" id="cAll">Get all ${apps.length}</button>` : ''}
    <div class="list" style="margin-top:12px">${apps.map((a) => `
      <div class="row" data-open="${a.id}">${appIcon(a)}
        <div class="row-main"><div class="row-title">${esc(a.name)}</div><div class="row-sub">${esc(shownVersion(a))} · ${fmtSize(a.size)}</div>${appBadges(a, { compact: true }) ? `<div class="row-badges">${appBadges(a, { compact: true })}</div>` : ''}</div>
        <button class="pill" data-get="${a.id}">${getLabel(a)}</button>
      </div>`).join('')}</div>
    ${isOwner() ? '<button class="btn block" id="cEdit" style="margin-top:12px">Edit collection</button>' : ''}`, (el) => {
    el.querySelectorAll('[data-open]').forEach((r) => { r.onclick = () => appSheet(r.dataset.open); });
    el.querySelectorAll('[data-get]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); quickGet(b.dataset.get); }; });
    if ($('#cAll', el)) $('#cAll', el).onclick = () => getAll(apps, c.name);
    if ($('#cEdit', el)) $('#cEdit', el).onclick = () => editCollectionSheet(c);
  });
}

// Signs several apps one after another, then lists them with Install buttons (iOS needs a tap for each install).
async function getAll(apps, title) {
  if (!state.certs.length) { closeSheet(); toast('Add your certificate first', true); return switchTab('certs'); }
  const rows = apps.map((a) => ({ a, status: reusableSigned(a) ? 'ready' : 'waiting', signed: reusableSigned(a) }));
  closeSheet.locked = true;
  const draw = () => {
    openSheet(`
      <h2>${esc(title)}</h2>
      <p class="hint" style="margin-top:-6px">Each app installs with its own tap — your iPhone asks for every one.</p>
      <div class="list">${rows.map((r, i) => `
        <div class="row">${appIcon(r.a)}
          <div class="row-main"><div class="row-title">${esc(r.a.name)}</div>
            <div class="row-sub">${{ waiting: 'Waiting…', signing: 'Signing…', ready: 'Ready to install', failed: 'Failed — tap to retry' }[r.status]}</div></div>
          ${r.status === 'ready' ? `<button class="pill" data-inst="${i}">Install</button>` : r.status === 'signing' ? '<div class="mini-spin"></div>' : r.status === 'failed' ? `<button class="pill dim" data-retry="${i}">Retry</button>` : ''}
        </div>`).join('')}</div>
      <button class="btn block" id="gaDone" style="margin-top:12px" ${closeSheet.locked ? 'disabled' : ''}>Done</button>`, (el) => {
      el.querySelectorAll('[data-inst]').forEach((b) => { b.onclick = () => { const r = rows[+b.dataset.inst]; location.href = r.signed.installUrl; api('POST', `/api/signed/${r.signed.id}/install`).catch(() => {}); b.textContent = 'Opening…'; }; });
      el.querySelectorAll('[data-retry]').forEach((b) => { b.onclick = () => { rows[+b.dataset.retry].status = 'waiting'; run(); }; });
      $('#gaDone', el).onclick = () => { closeSheet(); };
    });
  };
  const run = async () => {
    closeSheet.locked = true;
    draw();
    for (const r of rows) {
      if (r.status !== 'waiting') continue;
      r.status = 'signing';
      draw();
      try {
        const { jobId } = await api('POST', '/api/sign', signOptsFromDefaults(r.a));
        const res = await waitJob(jobId);
        r.signed = res.signed;
        r.status = 'ready';
      } catch { r.status = 'failed'; }
      draw();
    }
    closeSheet.locked = false;
    $('#sheet').classList.remove('locked');
    await refresh().catch(() => {});
    draw();
  };
  run();
}

function manageCollectionsSheet() {
  const cols = [...state.collections];
  openSheet(`
    <h2>Collections</h2>
    <p class="hint" style="margin-top:-6px">Bundles of apps people can get together, like "Emulator setup". Shown as a shelf in the library.</p>
    <div class="list">${cols.map((c) => `
      <button class="row" data-ed="${c.id}"><span class="cat-emoji">${esc(c.emoji)}</span>
        <div class="row-main"><div class="row-title">${esc(c.name)}</div><div class="row-sub">${c.appIds.length} apps</div></div><span class="value muted">›</span></button>`).join('') || '<div class="setting muted">No collections yet</div>'}</div>
    <button class="btn primary block" id="colNew" style="margin-top:12px">+ New collection</button>`, (el) => {
    el.querySelectorAll('[data-ed]').forEach((b) => { b.onclick = () => editCollectionSheet(state.collections.find((c) => c.id === b.dataset.ed)); });
    $('#colNew', el).onclick = () => editCollectionSheet(null);
  });
}

function editCollectionSheet(c) {
  const isNew = !c;
  const sel = new Set(c ? c.appIds : []);
  openSheet(`
    <h2>${isNew ? 'New collection' : 'Edit collection'}</h2>
    <div class="field"><label>Name</label><input type="text" id="coName" value="${esc(c ? c.name : '')}" placeholder="e.g. Emulator setup"></div>
    <div class="field"><label>Emoji</label><input type="text" id="coEmoji" value="${esc(c ? c.emoji : '📦')}" maxlength="8"></div>
    <div class="field"><label>Description</label><textarea id="coDesc" placeholder="What's in it and why">${esc(c ? c.description : '')}</textarea></div>
    <div class="section-title">Apps <span class="count" id="coCount">${sel.size}</span></div>
    <div class="list">${state.apps.map((a) => `
      <div class="row ${sel.has(a.id) ? 'selected' : ''}" data-pick="${a.id}"><span class="check ${sel.has(a.id) ? 'on' : ''}">${sel.has(a.id) ? ICONS.check : ''}</span>${appIcon(a)}
        <div class="row-main"><div class="row-title">${esc(a.name)}</div><div class="row-sub">${esc(catLabel(a.categoryId))}</div></div></div>`).join('')}</div>
    <button class="btn primary big block" id="coSave" style="margin-top:14px">Save</button>
    ${isNew ? '' : '<button class="btn block danger" id="coDel" style="margin-top:8px">Delete collection</button>'}`, (el) => {
    el.querySelectorAll('[data-pick]').forEach((r) => {
      r.onclick = () => {
        const x = r.dataset.pick;
        sel.has(x) ? sel.delete(x) : sel.add(x);
        const on = sel.has(x);
        r.classList.toggle('selected', on);
        const ch = r.querySelector('.check');
        ch.classList.toggle('on', on);
        ch.innerHTML = on ? ICONS.check : '';
        $('#coCount', el).textContent = sel.size;
      };
    });
    $('#coSave', el).onclick = async () => {
      const body = { name: $('#coName', el).value, emoji: $('#coEmoji', el).value, description: $('#coDesc', el).value, appIds: [...sel] };
      try {
        if (isNew) await api('POST', '/api/collections', body); else await api('PATCH', `/api/collections/${c.id}`, body);
        await refresh();
        toast('Collection saved');
        manageCollectionsSheet();
      } catch (e) { toast(e.message, true); }
    };
    if ($('#coDel', el)) {
      $('#coDel', el).onclick = async () => {
        if (!confirm(`Delete ${c.name}? The apps stay in the library.`)) return;
        try { await api('DELETE', `/api/collections/${c.id}`); await refresh(); toast('Deleted'); manageCollectionsSheet(); } catch (e) { toast(e.message, true); }
      };
    }
  });
}

function addToCollectionSheet(a) {
  openSheet(`
    <h2>Add ${esc(a.name)} to…</h2>
    <div class="list">${state.collections.map((c) => `
      <button class="row" data-c="${c.id}"><span class="cat-emoji">${esc(c.emoji)}</span><div class="row-main"><div class="row-title">${esc(c.name)}</div></div>
        <span class="value">${c.appIds.includes(a.id) ? '✓' : ''}</span></button>`).join('') || '<div class="setting muted">No collections yet</div>'}</div>
    <button class="btn block" id="acNew" style="margin-top:12px">+ New collection</button>
    <button class="btn block" id="acBack" style="margin-top:8px">Back</button>`, (el) => {
    el.querySelectorAll('[data-c]').forEach((b) => {
      b.onclick = async () => {
        const c = state.collections.find((x) => x.id === b.dataset.c);
        const ids = c.appIds.includes(a.id) ? c.appIds.filter((x) => x !== a.id) : [...c.appIds, a.id];
        try { await api('PATCH', `/api/collections/${c.id}`, { appIds: ids }); await refresh(); addToCollectionSheet(a); } catch (e) { toast(e.message, true); }
      };
    });
    $('#acNew', el).onclick = () => editCollectionSheet({ id: null, name: '', emoji: '📦', description: '', appIds: [a.id] });
    $('#acBack', el).onclick = () => appSheet(a.id);
  });
}

// ---------- app requests ----------
function requestAppSheet() {
  openSheet(`
    <h2>Request an App</h2>
    <p class="hint" style="margin-top:-6px">Ask for an app to be added to the library. You'll see the answer in ${isOwner() ? 'Users' : 'Account'} › Requests.</p>
    <div class="field"><label>App name</label><input type="text" id="rqName" placeholder="e.g. Delta Emulator"></div>
    <div class="field"><label>Link (optional)</label><input type="url" id="rqLink" placeholder="Where to find it" autocapitalize="off" autocorrect="off"></div>
    <div class="field"><label>Anything else? (optional)</label><textarea id="rqNote" placeholder="Version, tweaks you want, why…"></textarea></div>
    <button class="btn primary big block" id="rqSend">Send Request</button>`, (el) => {
    $('#rqSend', el).onclick = async () => {
      try {
        await api('POST', '/api/requests', { name: $('#rqName', el).value, link: $('#rqLink', el).value, note: $('#rqNote', el).value });
        closeSheet();
        toast('Request sent 🙌');
        await refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
}

const REQ_STATUS = { pending: ['⏳ Waiting', ''], added: ['✅ Added', 'good'], declined: ['✕ Declined', 'bad'] };
function requestRow(r) {
  const [label, cls] = REQ_STATUS[r.status] || REQ_STATUS.pending;
  return `<div class="row" data-req="${r.id}">
    <div class="row-main"><div class="row-title">${esc(r.name)}</div>
      <div class="row-sub">${isOwner() ? `${esc(r.username || '?')} · ` : ''}${ago(r.createdAt)}${r.reply ? ` · “${esc(r.reply)}”` : ''}</div></div>
    <span class="badge ${cls}">${label}</span></div>`;
}

function requestSheet(rid) {
  const r = state.requests.find((x) => x.id === rid);
  if (!r) return;
  const app = r.appId && state.apps.find((a) => a.id === r.appId);
  openSheet(`
    <h2>${esc(r.name)}</h2>
    <dl class="kv">
      ${isOwner() ? `<dt>From</dt><dd>${esc(r.username || '?')}</dd>` : ''}
      <dt>Asked</dt><dd>${ago(r.createdAt)}</dd>
      <dt>Status</dt><dd>${REQ_STATUS[r.status][0]}</dd>
      ${r.link ? `<dt>Link</dt><dd><a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.link)}</a></dd>` : ''}
    </dl>
    ${r.note ? `<p class="desc">${esc(r.note)}</p>` : ''}
    ${r.reply ? `<p class="setup-note">💬 ${esc(r.reply)}</p>` : ''}
    ${app ? `<button class="btn primary block" id="rqOpen">Open ${esc(app.name)}</button>` : ''}
    ${isOwner() ? `
      <div class="field" style="margin-top:12px"><label>Reply (optional)</label><input type="text" id="rqReply" value="${esc(r.reply || '')}" placeholder="e.g. Added! Turn on JIT first"></div>
      <div class="field"><label>Link it to a library app (optional)</label><select id="rqApp"><option value="">—</option>${state.apps.map((a) => `<option value="${a.id}" ${a.id === r.appId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="card-actions">
        <button class="btn" id="rqAdded">✅ Mark added</button>
        <button class="btn" id="rqDecline">✕ Decline</button>
      </div>` : ''}
    ${isOwner() || r.status === 'pending' ? '<button class="btn block danger" id="rqDel" style="margin-top:8px">Delete request</button>' : ''}`, (el) => {
    if ($('#rqOpen', el)) $('#rqOpen', el).onclick = () => appSheet(app.id);
    const set = async (status) => {
      try {
        await api('PATCH', `/api/requests/${r.id}`, { status, reply: $('#rqReply', el).value, appId: $('#rqApp', el).value });
        await refresh();
        toast(status === 'added' ? 'Marked as added' : 'Declined');
        closeSheet();
      } catch (e) { toast(e.message, true); }
    };
    if ($('#rqAdded', el)) $('#rqAdded', el).onclick = () => set('added');
    if ($('#rqDecline', el)) $('#rqDecline', el).onclick = () => set('declined');
    if ($('#rqDel', el)) {
      $('#rqDel', el).onclick = async () => {
        try { await api('DELETE', `/api/requests/${r.id}`); await refresh(); toast('Deleted'); closeSheet(); } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ---------- QR codes ----------
function qrSheet(title, url, back) {
  openSheet(`
    <h2>${esc(title)}</h2>
    <p class="hint" style="margin-top:-6px">Scan with another iPhone's Camera to open the install page.</p>
    <div class="qr-box"><img src="/api/qr?text=${encodeURIComponent(url)}" alt="QR code"></div>
    <p class="mono center" style="word-break:break-all;color:var(--muted)">${esc(url)}</p>
    <div class="actions">
      <button class="btn block" id="qrCopy">Copy link</button>
      ${back ? '<button class="btn block" id="qrBack">Back</button>' : ''}
    </div>`, (el) => {
    $('#qrCopy', el).onclick = () => copy(url, 'Link copied');
    if (back) $('#qrBack', el).onclick = back;
  });
}

function categorySelectHtml(selected) {
  return `<select id="eCat">
    <option value="">Uncategorized</option>
    ${state.categories.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)}</option>`).join('')}
    <option value="__new">+ New category…</option>
  </select>`;
}

function editAppSheet(a, isNew = false) {
  const pending = { icon: null, resetIcon: false };
  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>${isNew ? 'Add details' : 'Edit app'}</h2><div class="row-sub">${esc(a.originalName || a.name)} · ${esc(shownVersion(a))}</div></div></div>
    ${isNew ? '<p class="hint" style="margin-top:-6px">All optional — you can change these any time.</p>' : ''}

    <div class="field"><label>Name in the library</label><input type="text" id="eName" value="${esc(a.name)}"></div>
    <div class="field"><label>Category</label>${categorySelectHtml(a.categoryId)}</div>
    <div class="field"><label>Tags</label><input type="text" id="eTags" value="${esc((a.tags || []).join(', '))}" placeholder="e.g. Needs JIT, Controller support" autocapitalize="words">
      <div class="tag-row" id="eTagSuggest">${[...new Set(['Needs JIT', 'Controller support', 'iPad friendly', 'Tweaked', 'No ads', ...state.apps.flatMap((x) => x.tags || [])])].map((t) => `<button type="button" class="tag small" data-addtag="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div>
      <div class="hint">Separate with commas. Tags show on the app's page and as filters in the library.</div></div>
    <div class="field"><label>Version</label><input type="text" id="eVer" value="${esc(a.versionOverride || '')}" placeholder="${esc(a.version || '1.0')}" autocapitalize="off" autocorrect="off">
      <div class="hint">Leave blank to use the version from the .ipa (${esc(a.version || 'none')}). Cleared automatically when you Update IPA.</div></div>
    <div class="group">${toggle('eVerSign', 'Use this version when signing', 'Installed apps show it in Settings › General › iPhone Storage. Only numbers, letters, dots and dashes are used.', a.useVersionWhenSigning !== false)}</div>
    <div class="field"><label>Developer / source</label><input type="text" id="eDev" value="${esc(a.developer || '')}" placeholder="e.g. Nintendo, or where you got it"></div>
    <div class="field"><label>Description</label><textarea id="eDesc" placeholder="What it is, in a sentence or two">${esc(a.description || '')}</textarea></div>
    <div class="field"><label>Notes / what's tweaked</label><textarea id="eNotes" placeholder="e.g. Ad-free, works with controllers, turn on JIT in StikDebug first">${esc(a.notes || '')}</textarea></div>

    <div class="group">
      ${toggle('ePub', 'Show in App Library', 'Visible to everyone you invite', a.published)}
      ${toggle('eFeat', 'Featured', 'Pinned to the top of the library', a.featured)}
    </div>

    <div class="section-title">Icon</div>
    <button class="file-btn ${a.customIcon ? 'chosen' : ''}" id="eIcon">${ICONS.file}<div class="row-main"><div class="row-title">${a.customIcon ? 'Custom icon set' : 'Change icon'}</div><div class="row-sub" id="eIconName">${a.customIcon ? 'Tap to pick a different one' : 'Square PNG works best'}</div></div></button>
    ${a.customIcon ? '<button class="link-btn" id="eIconReset" type="button">Go back to the app\'s own icon</button>' : ''}
    <div class="group" style="margin-top:10px">${toggle('eIconSign', 'Use this icon when signing', 'The installed app shows your custom icon', a.useIconWhenSigning !== false)}</div>

    <div class="section-title" style="margin-top:22px">Default sign settings</div>
    <p class="hint" style="margin:0 4px 10px">These are switched on automatically when anyone signs this app, so they can just tap Sign.</p>
    <div class="field"><label>Minimum iOS (optional)</label><input type="text" id="eMin" value="${esc((a.signDefaults || {}).minOS || '')}" placeholder="${esc(a.minOS || 'unchanged')}" inputmode="decimal"></div>
    ${signOptionsHtml(a, 'd')}

    <button class="btn primary big block" id="eSave">Save</button>
    <div style="height:6px"></div>`, (el) => {
    const collect = bindSignOptions(el, a.signDefaults || {}, 'd');
    el.querySelectorAll('[data-addtag]').forEach((b) => {
      b.onclick = () => {
        const input = $('#eTags', el);
        const tags = input.value.split(',').map((t) => t.trim()).filter(Boolean);
        if (!tags.includes(b.dataset.addtag)) tags.push(b.dataset.addtag);
        input.value = tags.join(', ');
      };
    });
    const onCatChange = async (e) => {
      if (e.target.value !== '__new') return;
      const cat = await promptNewCategory();
      e.target.outerHTML = categorySelectHtml(cat ? cat.id : a.categoryId);
      $('#eCat', el).onchange = onCatChange;
    };
    $('#eCat', el).onchange = onCatChange;
    $('#eIcon', el).onclick = async () => {
      const f = await pickFile('image/png');
      if (!f) return;
      pending.icon = f;
      pending.resetIcon = false;
      $('#eIcon', el).classList.add('chosen');
      $('#eIconName', el).textContent = f.name;
    };
    if ($('#eIconReset', el)) $('#eIconReset', el).onclick = () => { pending.resetIcon = true; pending.icon = null; $('#eIconName', el).textContent = 'Will use the app\'s own icon'; };
    $('#eSave', el).onclick = async () => {
      const btn = $('#eSave', el);
      btn.disabled = true;
      try {
        const body = {
          name: $('#eName', el).value,
          categoryId: $('#eCat', el).value === '__new' ? a.categoryId : ($('#eCat', el).value || null),
          developer: $('#eDev', el).value,
          tags: $('#eTags', el).value.split(',').map((t) => t.trim()).filter(Boolean),
          versionOverride: $('#eVer', el).value.trim(),
          useVersionWhenSigning: $('#eVerSign', el).checked,
          description: $('#eDesc', el).value,
          notes: $('#eNotes', el).value,
          published: $('#ePub', el).checked,
          featured: $('#eFeat', el).checked,
          useIconWhenSigning: $('#eIconSign', el).checked,
          signDefaults: { ...collect(), minOS: $('#eMin', el).value.trim() },
        };
        if (pending.icon) body.iconUploadId = (await uploadFile(pending.icon)).uploadId;
        if (pending.resetIcon) body.resetIcon = true;
        await api('PATCH', `/api/apps/${a.id}`, body);
        await refresh();
        toast('Saved');
        appSheet(a.id);
      } catch (e) {
        btn.disabled = false;
        toast(e.message, true);
      }
    };
  });
}

async function promptNewCategory() {
  const name = prompt('New category name (e.g. Emulators)');
  if (!name) return null;
  const emoji = prompt('Pick an emoji for it (optional)', '📁') || '📁';
  try {
    const { category } = await api('POST', '/api/categories', { name, emoji });
    state.categories.push(category);
    toast(`Added ${category.emoji} ${category.name}`);
    return category;
  } catch (e) { toast(e.message, true); return null; }
}

function manageCategoriesSheet() {
  const draw = () => {
    const cats = state.categories;
    openSheet(`
      <h2>Categories</h2>
      <p class="hint" style="margin-top:-6px">Use the arrows to set the order they show in the library.</p>
      <div class="list">${cats.map((c, i) => `
        <div class="row cat-row">
          <span class="cat-emoji">${esc(c.emoji)}</span>
          <div class="row-main"><div class="row-title">${esc(c.name)}</div><div class="row-sub">${state.apps.filter((a) => a.categoryId === c.id).length} apps</div></div>
          <button class="mini" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="mini" data-down="${i}" ${i === cats.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="mini" data-edit="${c.id}">✎</button>
          <button class="mini danger" data-del="${c.id}">✕</button>
        </div>`).join('') || '<div class="setting muted">No categories yet</div>'}</div>
      <button class="btn primary block" id="cNew" style="margin-top:12px">+ New category</button>`, (el) => {
      const reorder = async (from, to) => {
        const ids = cats.map((c) => c.id);
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        try { state.categories = (await api('POST', '/api/categories/order', { ids })).categories; render(); draw(); } catch (e) { toast(e.message, true); }
      };
      el.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => reorder(+b.dataset.up, +b.dataset.up - 1); });
      el.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => reorder(+b.dataset.down, +b.dataset.down + 1); });
      el.querySelectorAll('[data-edit]').forEach((b) => {
        b.onclick = async () => {
          const c = catById(b.dataset.edit);
          const name = prompt('Category name', c.name);
          if (name === null) return;
          const emoji = prompt('Emoji', c.emoji);
          try { await api('PATCH', `/api/categories/${c.id}`, { name, emoji: emoji || c.emoji }); await refresh(); draw(); } catch (e) { toast(e.message, true); }
        };
      });
      el.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = async () => {
          const c = catById(b.dataset.del);
          if (!confirm(`Delete ${c.name}? Its apps move to Uncategorized.`)) return;
          try { await api('DELETE', `/api/categories/${c.id}`); if (state.lib.cat === c.id) state.lib.cat = 'all'; await refresh(); draw(); } catch (e) { toast(e.message, true); }
        };
      });
      $('#cNew', el).onclick = async () => { if (await promptNewCategory()) { render(); draw(); } };
    });
  };
  draw();
}

// ---------- signing ----------
function signSheet(appId, overrides) {
  const a = state.apps.find((x) => x.id === appId);
  if (!a) return toast('That app is no longer in the library', true);
  if (!state.certs.length) {
    closeSheet();
    toast('Add a certificate first', true);
    return switchTab('certs');
  }
  const def = state.certs.find((c) => c.isDefault) || state.certs[0];
  const extra = { icon: null, dylibs: [] };
  const defaults = overrides || a.signDefaults || {};
  const summary = defaultsSummary(defaults);

  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>Sign ${esc(a.name)}</h2><div class="row-sub">${esc(shownVersion(a))} · ${fmtSize(a.size)}</div></div></div>

    <div class="field"><label>Certificate</label>
      <select id="sCert">${state.certs.map((c) => `<option value="${c.id}" ${c.id === def.id ? 'selected' : ''}>${esc(c.label)} · ${esc(c.profile.type)}</option>`).join('')}</select>
      <div class="hint" id="sCertHint"></div>
    </div>
    ${(a.versions || []).length > 1 ? `<div class="field"><label>App version</label>
      <select id="sVer">${a.versions.map((v, i) => `<option value="${i}" ${i === (Number(defaults.versionIndex) || 0) ? 'selected' : ''}>${esc(v.version || 'Version ' + (i + 1))}${i === 0 ? ' (newest)' : ''}${v.date ? ' · ' + esc(String(v.date).slice(0, 10)) : ''}</option>`).join('')}</select></div>` : ''}
    ${summary.length ? `<p class="setup-note">✨ Set up for you: ${esc(summary.join(' · '))}</p>` : ''}
    ${state.signed.some((x) => x.appId === a.id) ? '<p class="hint center" style="margin:-4px 0 10px">This replaces your current signed copy of this app.</p>' : ''}
    <button class="btn primary big block" id="sGo">Sign App</button>
    <button class="link-btn block" id="sMore" type="button">More options ▾</button>

    <div id="sAdvanced" class="hidden">
      <div class="section-title">App details</div>
      <div class="field"><label>Name</label><input type="text" id="sName" placeholder="${esc(a.name)}"></div>
      <div class="field"><label>Bundle ID</label><input type="text" id="sBundle" placeholder="${esc(a.bundleId)}" autocapitalize="off" autocorrect="off"><div class="hint">Change it to install a second copy next to the original.</div></div>
      <div class="field"><label>Version</label><input type="text" id="sVersion" placeholder="${esc(shownVersion(a))}" autocapitalize="off"></div>
      <div class="field"><label>Minimum iOS</label><input type="text" id="sMin" value="${esc(defaults.minOS || '')}" placeholder="${esc(a.minOS || 'unchanged')}" inputmode="decimal"></div>

      <div class="section-title">Icon</div>
      <button class="file-btn" id="sIcon">${ICONS.file}<div class="row-main"><div class="row-title">Change icon</div><div class="row-sub" id="sIconName">${a.customIcon && a.useIconWhenSigning !== false ? 'Using the library\'s custom icon' : 'Optional · square PNG'}</div></div></button>

      ${signOptionsHtml(a, 's')}

      <div class="section-title">Tweaks</div>
      <button class="file-btn" id="sDylib">${ICONS.plus}<div class="row-main"><div class="row-title">Add .dylib</div><div class="row-sub">Inject tweaks or frameworks into the app</div></div></button>
      <div class="chips" id="sDylibs"></div>
      <div class="group" style="margin-top:10px">
        ${toggle('sWeak', 'Weak injection', 'App still opens if a tweak fails to load', !!defaults.weakDylibs)}
        ${toggle('sInjExt', 'Inject into extensions', 'Also load tweaks in widgets and share extensions', !!defaults.injectExtensions)}
      </div>
      <button class="btn primary big block" id="sGo2" style="margin-top:16px">Sign App</button>
    </div>
    <div style="height:6px"></div>`, (el) => {
    const collect = bindSignOptions(el, { removeWatch: true, ...defaults }, 's');
    const cert = () => state.certs.find((x) => x.id === $('#sCert', el).value);

    const updateEntWarnings = () => {
      const c = cert();
      const blocked = [];
      for (const p of ENT_PRESETS) {
        const on = $('#s' + p.id, el).checked;
        const ok = profileAllows(c, p.key);
        const w = $('#s' + p.id + 'Warn', el);
        w.textContent = on && !ok ? "Your profile doesn't allow this, so the app may not install. Turn on this capability for your App ID in your Apple Developer account." : '';
        w.classList.toggle('hidden', !(on && !ok));
        if (on && !ok) blocked.push(p.short);
      }
      return blocked;
    };
    ENT_PRESETS.forEach((p) => { $('#s' + p.id, el).addEventListener('change', certHint); });

    function certHint() {
      const c = cert();
      const left = daysLeft(certExpiry(c));
      const bits = [];
      if (c.check && c.check.status === 'revoked') bits.push('⚠️ This certificate is revoked, so apps won\'t open.');
      if (left !== null && left < 0) bits.push('⚠️ This certificate has expired.');
      else if (left !== null) bits.push(`Expires in ${left} days.`);
      if (c.deviceIncluded === false) bits.push('⚠️ Your iPhone isn\'t in this profile.');
      if (!c.profile.wildcard && c.profile.appId) {
        bits.push(`This profile only signs ${c.profile.appId}.`);
        if (!$('#sBundle', el).value) $('#sBundle', el).value = c.profile.appId;
      }
      const blocked = updateEntWarnings();
      if (blocked.length) bits.push(`⚠️ This profile doesn't allow ${blocked.join(', ')} — open More options to turn it off, or the app may not install.`);
      $('#sCertHint', el).textContent = bits.join(' ');
    }
    $('#sCert', el).onchange = certHint;
    certHint();

    $('#sMore', el).onclick = () => {
      const adv = $('#sAdvanced', el);
      adv.classList.toggle('hidden');
      $('#sMore', el).textContent = adv.classList.contains('hidden') ? 'More options ▾' : 'Fewer options ▴';
    };
    $('#sIcon', el).onclick = async () => {
      const f = await pickFile('image/png');
      if (!f) return;
      extra.icon = f;
      $('#sIcon', el).classList.add('chosen');
      $('#sIconName', el).textContent = f.name;
    };
    const drawDylibs = () => {
      $('#sDylibs', el).innerHTML = extra.dylibs.map((f, i) => `<span class="chip">${esc(f.name)}<button data-i="${i}" aria-label="Remove">×</button></span>`).join('');
      $('#sDylibs', el).querySelectorAll('button').forEach((b) => { b.onclick = () => { extra.dylibs.splice(Number(b.dataset.i), 1); drawDylibs(); }; });
    };
    $('#sDylib', el).onclick = async () => {
      const files = await pickFile('', true);
      for (const f of files || []) {
        if (!/\.dylib$/i.test(f.name)) { toast(`${f.name} isn't a .dylib`, true); continue; }
        extra.dylibs.push(f);
      }
      drawDylibs();
    };

    const go = () => {
      const o = collect();
      const opts = {
        appId: a.id,
        certId: $('#sCert', el).value,
        name: $('#sName', el).value.trim(),
        bundleId: $('#sBundle', el).value.trim(),
        version: $('#sVersion', el).value.trim(),
        minOS: $('#sMin', el).value.trim(),
        entitlements: o.entitlements,
        plist: o.plist,
        weakDylibs: $('#sWeak', el).checked,
        injectExtensions: $('#sInjExt', el).checked,
        removeExtensions: !!o.removeExtensions,
        removeWatch: !!o.removeWatch,
        removeUISD: !!o.removeUISD,
        enableDocs: !!o.enableDocs,
        versionIndex: $('#sVer', el) ? Number($('#sVer', el).value) : 0,
      };
      runSign(a, opts, extra);
    };
    $('#sGo', el).onclick = go;
    $('#sGo2', el).onclick = go;
  });
}

function resignFromSigned(sid) {
  const s = state.signed.find((x) => x.id === sid);
  if (!s) return;
  if (!state.apps.find((a) => a.id === s.appId)) return toast('That app is no longer in the library', true);
  signSheet(s.appId);
}

function runSign(a, opts, extra) {
  closeSheet.locked = true;
  $('#sheet').classList.add('locked');
  openSheet(`
    <div class="progress-wrap">
      ${appIcon(a, true).replace('class="app-icon big"', 'class="app-icon big" style="margin:4px auto 0"')}
      <div class="spinner"></div>
      <h2 id="pTitle" style="margin:0 0 4px">Getting ready…</h2>
      <p class="muted small" id="pSub">Keep this screen open</p>
      <div class="bar hidden" id="pBar"><div></div></div>
      <div class="log hidden" id="pLog"></div>
    </div>`);
  const body = $('#sheetBody');
  const setTitle = (t, s) => { $('#pTitle', body).textContent = t; if (s !== undefined) $('#pSub', body).textContent = s; };
  const setBar = (p) => { $('#pBar', body).classList.remove('hidden'); $('#pBar > div', body).style.width = `${Math.round(p * 100)}%`; };

  (async () => {
    try {
      keepAwake(true);
      if (extra.icon) {
        setTitle('Uploading icon…');
        opts.iconUploadId = (await uploadFile(extra.icon, setBar)).uploadId;
      }
      opts.dylibs = [];
      for (const [i, f] of extra.dylibs.entries()) {
        setTitle(`Uploading tweak ${i + 1} of ${extra.dylibs.length}…`, f.name);
        const up = await uploadFile(f, setBar);
        opts.dylibs.push({ uploadId: up.uploadId, name: f.name });
      }
      $('#pBar', body).classList.add('hidden');
      setTitle('Signing…', 'Big apps can take a minute');
      const { jobId } = await api('POST', '/api/sign', opts);
      const result = await waitJob(jobId, (j) => {
        if (j.status === 'queued') setTitle('Waiting in line…', 'Someone else is signing right now');
        else setTitle('Signing…', 'Big apps can take a minute');
        const log = $('#pLog', body);
        if (j.log.length) { log.classList.remove('hidden'); log.textContent = j.log.join('\n'); log.scrollTop = log.scrollHeight; }
      });
      closeSheet.locked = false;
      $('#sheet').classList.remove('locked');
    $('#sheet').classList.remove('locked');
      await refresh().catch(() => {});
      showSigned(result.signed, opts);
    } catch (e) {
      closeSheet.locked = false;
      $('#sheet').classList.remove('locked');
    $('#sheet').classList.remove('locked');
      openSheet(`
        <div class="progress-wrap">
          <h2>Signing failed</h2>
          <p class="warning bad" style="text-align:left">${esc(e.message)}</p>
          ${e.log && e.log.length ? `<div class="log">${esc(e.log.join('\n'))}</div>` : ''}
          <div class="actions" style="margin-top:16px">
            <button class="btn primary block" id="fRetry">Try Again</button>
            <button class="btn block" id="fClose">Close</button>
          </div>
        </div>`, (el) => {
        $('#fRetry', el).onclick = () => signSheet(a.id);
        $('#fClose', el).onclick = closeSheet;
      });
    } finally {
      keepAwake(false);
    }
  })();
}

function showSigned(s, opts = {}) {
  const https = state.server.https;
  const jit = (opts.entitlements || []).some((e) => e.key === 'get-task-allow');
  openSheet(`
    <div class="progress-wrap">
      <div class="success-mark">${ICONS.check}</div>
      <h2 style="margin:0 0 4px">Ready to install</h2>
      <p class="muted small">${esc(s.name)} ${esc(s.version || '')} · ${fmtSize(s.size)}</p>
      ${https ? '' : '<p class="warning bad">Install needs HTTPS. Generate a Railway domain and open the app from it.</p>'}
      <div class="actions" style="margin-top:14px">
        <button class="btn primary big block" data-install="${s.id}">Install</button>
        <button class="btn block" id="okShare">Copy install link</button>
        <button class="btn block" id="okQr">Show QR code</button>
        <button class="btn block" id="okDone">Done</button>
      </div>
      ${jit ? '<p class="warning" style="text-align:left">JIT is allowed for this app. Open StikDebug (or your JIT tool) and turn on JIT for it each time you launch it.</p>' : ''}
      <p class="hint" style="margin-top:12px">After tapping Install, go to your home screen to watch it download. For enterprise certs you may need to trust it in Settings › General › VPN &amp; Device Management.</p>
    </div>`, (el) => {
    $('#okShare', el).onclick = () => copy(s.shareUrl, 'Install link copied');
    $('#okQr', el).onclick = () => qrSheet(`Install ${s.name}`, s.shareUrl, () => showSigned(s, opts));
    $('#okDone', el).onclick = () => { closeSheet(); switchTab('signed'); };
  });
}

function signedSheet(sid) {
  const s = state.signed.find((x) => x.id === sid);
  if (!s) return;
  const left = daysLeft(s.expires);
  const o = s.options || {};
  const extras = [...(o.entitlements || []).map((k) => (ENT_PRESETS.find((p) => p.key === k) || { short: k.split('.').pop() }).short),
    ...(o.plist || []).map((k) => (PLIST_PRESETS.find((p) => p.key === k) || { short: k }).short)];
  openSheet(`
    <div class="sheet-head">${signedIcon(s, true)}<div class="row-main"><h2>${esc(s.name)}</h2><div class="row-sub">${esc(s.bundleId)}</div></div></div>
    ${s.fileAvailable ? '' : '<p class="warning">The signed file was cleaned up to save space. Tap Sign again to make a fresh one.</p>'}
    <dl class="kv">
      <dt>Version</dt><dd>${esc(s.version || '—')}</dd>
      <dt>Certificate</dt><dd>${esc(s.certLabel)}</dd>
      <dt>Signed</dt><dd>${ago(s.signedAt)}</dd>
      <dt>Works until</dt><dd>${fmtDate(s.expires)}${left !== null ? ` (${left < 0 ? 'expired' : left + ' days'})` : ''}</dd>
      <dt>Size</dt><dd>${fmtSize(s.size)}</dd>
      ${o.dylibs && o.dylibs.length ? `<dt>Tweaks</dt><dd>${esc(o.dylibs.join(', '))}</dd>` : ''}
      ${extras.length ? `<dt>Changes</dt><dd>${esc(extras.join(', '))}</dd>` : ''}
    </dl>
    <div class="actions">
      ${s.fileAvailable ? `<button class="btn primary big block" data-install="${s.id}">Install</button>
      <button class="btn block" id="gShare">Copy install link</button>
      <button class="btn block" id="gQr">Show QR code</button>
      <a class="btn block" href="${esc(s.downloadUrl)}">Download signed .ipa</a>` : ''}
      <button class="btn ${s.fileAvailable ? '' : 'primary big'} block" id="gResign">Sign again</button>
      ${s.fileAvailable ? '<button class="btn block" id="gRelink">Reset install link</button>' : ''}
      <button class="btn block danger" id="gDelete">Delete</button>
    </div>`, (el) => {
    if ($('#gShare', el)) $('#gShare', el).onclick = () => copy(s.shareUrl, 'Install link copied');
    if ($('#gQr', el)) $('#gQr', el).onclick = () => qrSheet(`Install ${s.name}`, s.shareUrl, () => signedSheet(s.id));
    $('#gResign', el).onclick = () => resignFromSigned(s.id);
    if ($('#gRelink', el)) {
      $('#gRelink', el).onclick = async () => {
        if (!confirm('Old install links will stop working. Continue?')) return;
        try { await api('POST', `/api/signed/${s.id}/relink`); closeSheet(); toast('New link created'); await refresh(); } catch (e) { toast(e.message, true); }
      };
    }
    $('#gDelete', el).onclick = async () => {
      if (!confirm(`Delete signed ${s.name}?`)) return;
      try { await api('DELETE', `/api/signed/${s.id}`); closeSheet(); toast('Deleted'); await refresh(); } catch (e) { toast(e.message, true); }
    };
  });
}

document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-req]');
  if (r && !e.target.closest('.sheet button, .sheet a') ) requestSheet(r.dataset.req);
});

// ---------- install progress ----------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-install]');
  if (!b) return;
  e.preventDefault();
  const s = state.signed.find((x) => x.id === b.dataset.install) || installSheet.last;
  if (s) startInstall(s);
});

// Starts the iPhone's install pop-up right away (it has to happen during the tap), then shows live progress.
function startInstall(s) {
  if (!s) return;
  if (!state.server.https) toast('Install needs HTTPS — open Mango Signer from your Railway link', true);
  location.href = s.installUrl;
  api('POST', `/api/signed/${s.id}/install`).catch((e) => toast(e.message, true));
  installSheet(s);
}

const RING = 2 * Math.PI * 52;
function installSheet(s) {
  installSheet.last = s;
  const token = Symbol('install');
  installSheet.token = token;
  const opened = Date.now();
  let lastSent = 0, lastT = Date.now(), rate = 0, doneSeen = 0;

  openSheet(`
    <div class="install-wrap">
      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 120 120">
          <circle class="ring-bg" cx="60" cy="60" r="52"/>
          <circle class="ring-fg" id="iRing" cx="60" cy="60" r="52" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/>
        </svg>
        <div class="ring-icon">${signedIcon(s, true)}</div>
        <div class="ring-check hidden" id="iCheck">${ICONS.check}</div>
      </div>
      <div class="install-pct" id="iPct"></div>
      <h2 id="iTitle">Waiting for your iPhone…</h2>
      <p class="muted" id="iSub">A pop-up should appear — tap <b>Install</b>.</p>
      <ol class="steps" id="iSteps">
        <li data-step="confirm">Install pop-up</li>
        <li data-step="downloading">Downloading</li>
        <li data-step="done">Finishing on Home Screen</li>
      </ol>
      <p class="warning hidden" id="iHint"></p>
      <div class="actions">
        <button class="btn block" id="iRetry">Try again</button>
        <button class="btn primary block" id="iDone">Done</button>
      </div>
    </div>`, (el) => {
    $('#iRetry', el).onclick = () => startInstall(s);
    $('#iDone', el).onclick = closeSheet;
  });

  const body = $('#sheetBody');
  const setStep = (phase) => {
    const order = ['confirm', 'downloading', 'done'];
    const at = order.indexOf(phase);
    body.querySelectorAll('#iSteps li').forEach((li, i) => {
      li.classList.toggle('on', i <= at);
      li.classList.toggle('now', i === at && phase !== 'done');
    });
  };
  const hint = (text) => { const h = $('#iHint', body); if (!h) return; h.textContent = text || ''; h.classList.toggle('hidden', !text); };

  const tick = async () => {
    if (installSheet.token !== token || !$('#iRing')) return;
    let st;
    try { st = (await api('GET', `/api/signed/${s.id}/install`)).install; } catch { setTimeout(tick, 1500); return; }
    if (installSheet.token !== token || !$('#iRing')) return;
    const ring = $('#iRing', body);
    const now = Date.now();
    if (st.phase === 'downloading' || st.phase === 'done') {
      const dt = (now - lastT) / 1000;
      if (dt > 0.4) { const inst = (st.sent - lastSent) / dt; rate = rate ? rate * 0.6 + inst * 0.4 : inst; lastSent = st.sent; lastT = now; }
    }
    const pct = st.phase === 'done' ? 1 : st.phase === 'downloading' ? st.progress : st.phase === 'confirm' ? 0.04 : 0;
    ring.style.strokeDashoffset = String(RING * (1 - pct));
    setStep(st.phase);
    const title = $('#iTitle', body), sub = $('#iSub', body), pctEl = $('#iPct', body);
    if (st.phase === 'waiting' || st.phase === 'idle') {
      title.textContent = 'Waiting for your iPhone…';
      sub.innerHTML = 'A pop-up should appear — tap <b>Install</b>.';
      pctEl.textContent = '';
      hint(now - opened > 15000 ? "Nothing popped up? Tap Try again. If it still doesn't, make sure you opened Mango Signer from your https link in Safari." : '');
    } else if (st.phase === 'confirm') {
      title.textContent = 'Tap Install on the pop-up';
      sub.textContent = `Your iPhone is asking to install ${s.name}.`;
      pctEl.textContent = '';
      hint(now - (st.manifestAt || now) > 30000 ? "Tapped Cancel by accident? Tap Try again to bring the pop-up back." : '');
    } else if (st.phase === 'downloading') {
      const p = Math.floor(st.progress * 100);
      title.textContent = 'Installing…';
      pctEl.textContent = `${p}%`;
      sub.textContent = `${fmtSize(st.sent)} of ${fmtSize(st.size)}${rate > 1024 ? ` · ${fmtSize(rate)}/s · ${fmtTime((st.size - st.sent) / rate)} left` : ''}`;
      hint('');
    } else if (st.phase === 'done') {
      if (!doneSeen) { doneSeen = now; confetti(); refresh().catch(() => {}); }
      pctEl.textContent = '100%';
      title.textContent = 'Downloaded ✓';
      sub.textContent = 'Your iPhone is finishing the install — check your Home Screen.';
      $('#iCheck', body).classList.remove('hidden');
      body.querySelector('.ring-wrap').classList.add('complete');
      hint("If your iPhone says “Unable to Install”, the certificate is revoked or your iPhone isn't in its profile.");
      $('#iRetry', body).textContent = 'Install again';
      if (now - doneSeen > 4000) return; // stop checking a little after it finishes
    }
    setTimeout(tick, document.visibilityState === 'visible' ? 600 : 2000);
  };
  setTimeout(tick, 400);
}

// ---------- themes ----------
const THEMES = [
  { id: 'mango', label: 'Mango', colors: ['#140c1a', '#241830'] },
  { id: 'midnight', label: 'Midnight', colors: ['#0b1020', '#161e36'] },
  { id: 'amoled', label: 'AMOLED', colors: ['#000000', '#111111'] },
  { id: 'light', label: 'Light', colors: ['#f6f2ee', '#ffffff'] },
];
const ACCENTS = [
  { id: 'mango', label: 'Mango', color: '#ff9f1c' },
  { id: 'pink', label: 'Pink', color: '#ff5fa2' },
  { id: 'blue', label: 'Blue', color: '#4c9dff' },
  { id: 'green', label: 'Green', color: '#3fcf8e' },
  { id: 'purple', label: 'Purple', color: '#a87bff' },
  { id: 'red', label: 'Red', color: '#ff5c5c' },
];
function getPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function setPref(key, value) { try { localStorage.setItem(key, value); } catch { /* */ } }
function applyTheme() {
  const theme = getPref('mango.theme', 'mango');
  const accent = getPref('mango.accent', 'mango');
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.accent = accent;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = (THEMES.find((t) => t.id === theme) || THEMES[0]).colors[0];
}
function themeLabel() {
  const t = THEMES.find((x) => x.id === getPref('mango.theme', 'mango')) || THEMES[0];
  const a = ACCENTS.find((x) => x.id === getPref('mango.accent', 'mango')) || ACCENTS[0];
  return t.id === 'mango' && a.id === 'mango' ? 'Mango' : `${t.label} · ${a.label}`;
}
applyTheme();

function appearanceSheet() {
  const theme = getPref('mango.theme', 'mango');
  const accent = getPref('mango.accent', 'mango');
  openSheet(`
    <h2>Appearance</h2>
    <p class="hint" style="margin-top:-6px">Saved on this device.</p>
    <div class="section-title">Theme</div>
    <div class="theme-grid">${THEMES.map((t) => `
      <button class="theme-card ${t.id === theme ? 'on' : ''}" data-theme-pick="${t.id}">
        <span class="theme-preview" style="background:${t.colors[0]}"><i style="background:${t.colors[1]}"></i><i style="background:${t.colors[1]}"></i></span>
        <span>${t.label}</span></button>`).join('')}</div>
    <div class="section-title">Accent color</div>
    <div class="accent-row">${ACCENTS.map((a) => `<button class="accent ${a.id === accent ? 'on' : ''}" data-accent-pick="${a.id}" style="--c:${a.color}" aria-label="${a.label}"></button>`).join('')}</div>
    <div class="section-title">Library layout</div>
    <div class="seg wide">
      <button data-layout="list" class="${libView() === 'list' ? 'on' : ''}">☰ List</button>
      <button data-layout="grid" class="${libView() === 'grid' ? 'on' : ''}">▦ Grid</button>
    </div>
    <button class="btn primary big block" id="apDone" style="margin-top:18px">Done</button>`, (el) => {
    el.querySelectorAll('[data-theme-pick]').forEach((b) => { b.onclick = () => { setPref('mango.theme', b.dataset.themePick); applyTheme(); appearanceSheet(); render(); }; });
    el.querySelectorAll('[data-accent-pick]').forEach((b) => { b.onclick = () => { setPref('mango.accent', b.dataset.accentPick); applyTheme(); appearanceSheet(); render(); }; });
    el.querySelectorAll('[data-layout]').forEach((b) => { b.onclick = () => { setPref('mango.libView', b.dataset.layout); appearanceSheet(); render(); }; });
    $('#apDone', el).onclick = closeSheet;
  });
}

// ---------- announcements ----------
function announcementHtml() {
  const an = state.announcement;
  if (!an) return '';
  if (getPref('mango.dismissedAnnouncement', '') === an.id) return '';
  const icon = { info: '📣', success: '✅', warning: '⚠️', party: '🎉' }[an.style] || '📣';
  return `<div class="announce ${esc(an.style)}"><span class="announce-icon">${icon}</span><p>${esc(an.text)}</p>
    <button class="announce-x" data-act="dismiss-announce" aria-label="Dismiss">✕</button></div>`;
}
function dismissAnnouncement() {
  if (state.announcement) setPref('mango.dismissedAnnouncement', state.announcement.id);
  const el = $('.announce');
  if (el) { el.classList.add('out'); setTimeout(render, 220); } else render();
}
function announcementSheet() {
  const an = state.announcement || {};
  openSheet(`
    <h2>📣 Announcement</h2>
    <p class="hint" style="margin-top:-6px">Shows at the top of the app for everyone until they dismiss it. Posting a new one shows it again to everybody.</p>
    <div class="field"><label>Message</label><textarea id="anText" placeholder="e.g. New emulators just dropped! Update GTA to 1.5.2.">${esc(an.text || '')}</textarea></div>
    <div class="field"><label>Style</label>
      <select id="anStyle">${[['info', '📣 Info'], ['success', '✅ Good news'], ['warning', '⚠️ Heads up'], ['party', '🎉 Party']].map(([k, l]) => `<option value="${k}" ${an.style === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <button class="btn primary big block" id="anPost">Post</button>
    ${an.text ? '<button class="btn block danger" id="anRemove" style="margin-top:8px">Remove announcement</button>' : ''}`, (el) => {
    $('#anPost', el).onclick = async () => {
      try {
        await api('PUT', '/api/announcement', { text: $('#anText', el).value, style: $('#anStyle', el).value });
        await refresh();
        closeSheet();
        toast('Announcement posted');
      } catch (e) { toast(e.message, true); }
    };
    if ($('#anRemove', el)) {
      $('#anRemove', el).onclick = async () => {
        try { await api('PUT', '/api/announcement', { text: '' }); await refresh(); closeSheet(); toast('Announcement removed'); } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ---------- welcome tour ----------
function tourSheet(force = false) {
  const slides = isOwner()
    ? [
      ['🥭', 'Welcome to Mango Signer', 'Your own app signer. Upload apps, sign them with your certificate, and install them right from Safari.'],
      ['📦', 'Build your library', 'Tap + in Library to add an .ipa or paste a link. Give apps categories, tags, screenshots and default settings.'],
      ['🛡️', 'Add your certificate', 'In Certificates, add your .p12 and .mobileprovision. Mango checks it and shows what it allows.'],
      ['📲', 'Tap Get', 'Mango signs the app and opens the install pop-up. Watch the ring fill up as it installs.'],
      ['👥', 'Invite friends', 'Make invite codes in Users. Friends bring their own certificate and get everything in your library.'],
    ]
    : [
      ['🥭', 'Welcome to Mango Signer', 'Sign and install apps from the App Library right from Safari.'],
      ['🛡️', 'Add your certificate', 'Go to Certificates and add your .p12 and .mobileprovision. It stays private to your account.'],
      ['📲', 'Tap Get', 'Pick any app and tap Get. It\'s already set up — just tap Install on the pop-up and watch the ring fill up.'],
      ['⬆️', 'Stay up to date', 'Apps you installed show ✓ Installed, and ⬆ Update when there\'s a newer version. Can\'t find something? Request it!'],
    ];
  let i = 0;
  const draw = () => {
    const [emoji, title, text] = slides[i];
    openSheet(`
      <div class="tour">
        <div class="tour-emoji">${emoji}</div>
        <h2>${esc(title)}</h2>
        <p class="muted">${esc(text)}</p>
        <div class="tour-dots">${slides.map((_, n) => `<i class="${n === i ? 'on' : ''}"></i>`).join('')}</div>
        <button class="btn primary big block" id="tNext">${i === slides.length - 1 ? "Let's go" : 'Next'}</button>
        ${i < slides.length - 1 ? '<button class="link-btn block" id="tSkip">Skip</button>' : ''}
      </div>`, (el) => {
      $('#tNext', el).onclick = () => { if (i < slides.length - 1) { i++; draw(); } else { closeSheet(); } };
      if ($('#tSkip', el)) $('#tSkip', el).onclick = closeSheet;
    });
  };
  setPref('mango.toured', '1');
  if (!force) try { localStorage.setItem(SEEN_KEY, CODE_VERSION || ''); } catch { /* */ }
  draw();
}
function maybeShowTour() {
  if (getPref('mango.toured', '')) return false;
  tourSheet();
  return true;
}

// ---------- confetti ----------
function confetti() {
  if (reducedMotion()) return;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#ff9f1c', '#ffcf4a', '#5cc45c', '#ff5fa2', '#4c9dff', '#a87bff'];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 13, vy: -Math.random() * 13 - 4,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
    w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, c: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  const frame = (t) => {
    const age = t - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - age / 2600);
      ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (age < 2600) requestAnimationFrame(frame); else c.remove();
  };
  requestAnimationFrame(frame);
}

// ---------- certificates ----------
function addCertSheet() {
  const chosen = { p12: null, prov: null };
  openSheet(`
    <h2>Add Certificate</h2>
    <div class="field">
      <button class="file-btn" id="cP12">${ICONS.file}<div class="row-main"><div class="row-title">Certificate (.p12)</div><div class="row-sub" id="cP12Name">Tap to choose</div></div></button>
    </div>
    <div class="field">
      <button class="file-btn" id="cProv">${ICONS.file}<div class="row-main"><div class="row-title">Provisioning profile (.mobileprovision)</div><div class="row-sub" id="cProvName">Tap to choose</div></div></button>
    </div>
    <div class="field"><label>Password</label><input type="password" id="cPass" placeholder="Leave blank if none" autocomplete="off"></div>
    <div class="field"><label>Nickname</label><input type="text" id="cLabel" placeholder="Optional, e.g. My Dev Cert"></div>
    <button class="btn primary big block" id="cAdd">Add Certificate</button>
    <p class="muted small" id="cMsg" style="text-align:center"></p>
    <p class="hint">Your certificate is private to your account. Its password is stored encrypted and only used for signing.</p>`, (el) => {
    const pick = (key, btn, label, re, kind) => async () => {
      const f = await pickFile('');
      if (!f) return;
      if (!re.test(f.name)) return toast(`That's not a ${kind} file`, true);
      chosen[key] = f;
      $(btn, el).classList.add('chosen');
      $(label, el).textContent = f.name;
    };
    $('#cP12', el).onclick = pick('p12', '#cP12', '#cP12Name', /\.(p12|pfx)$/i, '.p12');
    $('#cProv', el).onclick = pick('prov', '#cProv', '#cProvName', /\.mobileprovision$/i, '.mobileprovision');
    $('#cAdd', el).onclick = async () => {
      if (!chosen.p12 || !chosen.prov) return toast('Choose both files first', true);
      const btn = $('#cAdd', el);
      btn.disabled = true;
      $('#cMsg', el).textContent = 'Uploading…';
      try {
        const [p12, prov] = await Promise.all([uploadFile(chosen.p12), uploadFile(chosen.prov)]);
        $('#cMsg', el).textContent = 'Checking certificate…';
        const { cert } = await api('POST', '/api/certs', {
          p12UploadId: p12.uploadId, provUploadId: prov.uploadId,
          password: $('#cPass', el).value, label: $('#cLabel', el).value,
        });
        closeSheet();
        toast(`Added ${cert.label}`);
        await refresh();
      } catch (e) {
        btn.disabled = false;
        $('#cMsg', el).textContent = '';
        toast(e.message, true);
      }
    };
  });
}

async function checkCert(cid, btn) {
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const { cert } = await api('POST', `/api/certs/${cid}/check`);
    const st = cert.check && cert.check.status;
    toast(st === 'valid' ? 'Certificate is valid ✓' : st === 'revoked' ? 'Certificate is revoked' : `Couldn't confirm status${cert.check && cert.check.ocsp ? ': ' + cert.check.ocsp : ''}`, st === 'revoked');
    await refresh();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = 'Check';
  }
}

async function makeDefault(cid) {
  try { await api('PATCH', `/api/certs/${cid}`, { makeDefault: true }); await refresh(); } catch (e) { toast(e.message, true); }
}

async function renameCert(cid) {
  const c = state.certs.find((x) => x.id === cid);
  const label = prompt('Certificate nickname', c ? c.label : '');
  if (!label) return;
  try { await api('PATCH', `/api/certs/${cid}`, { label }); await refresh(); } catch (e) { toast(e.message, true); }
}

async function deleteCert(cid) {
  const c = state.certs.find((x) => x.id === cid);
  if (!confirm(`Delete ${c ? c.label : 'this certificate'}? Apps you already installed keep working.`)) return;
  try { await api('DELETE', `/api/certs/${cid}`); toast('Deleted'); await refresh(); } catch (e) { toast(e.message, true); }
}

// ---------- users & invites (owner) ----------
function newInviteSheet() {
  openSheet(`
    <h2>New Invite</h2>
    <div class="field"><label>Note</label><input type="text" id="iNote" placeholder="Who it's for, e.g. Jake"></div>
    <div class="field"><label>How many people can use it</label>
      <select id="iUses">${[1, 2, 5, 10, 25, 100].map((n) => `<option value="${n}">${n === 1 ? '1 person' : n + ' people'}</option>`).join('')}</select>
    </div>
    <button class="btn primary big block" id="iMake">Create Invite</button>`, (el) => {
    $('#iMake', el).onclick = async () => {
      try {
        const { invite, signupUrl } = await api('POST', '/api/invites', { note: $('#iNote', el).value, maxUses: Number($('#iUses', el).value) });
        await refresh();
        showInvite(invite, signupUrl);
      } catch (e) { toast(e.message, true); }
    };
  });
}

function showInvite(inv, signupUrl) {
  const link = signupUrl || `${state.server.baseUrl}/?invite=${inv.code}`;
  openSheet(`
    <h2>Invite ${inv.note ? 'for ' + esc(inv.note) : 'code'}</h2>
    <div class="code-box">${esc(inv.code)}</div>
    <p class="muted small center">${inv.uses}/${inv.maxUses} used${inv.usedBy && inv.usedBy.length ? ' · ' + esc(inv.usedBy.join(', ')) : ''}</p>
    <div class="actions">
      <button class="btn primary block" id="iLink">Copy invite link</button>
      <button class="btn block" id="iCode">Copy code</button>
      <button class="btn block danger" id="iDel">Delete invite</button>
    </div>
    <p class="hint" style="margin-top:12px">The link opens the sign-up screen with the code filled in. Deleting an invite doesn't remove accounts already made with it.</p>`, (el) => {
    $('#iLink', el).onclick = () => copy(link, 'Invite link copied');
    $('#iCode', el).onclick = () => copy(inv.code, 'Code copied');
    $('#iDel', el).onclick = async () => {
      if (!confirm('Delete this invite code?')) return;
      try { await api('DELETE', `/api/invites/${inv.code}`); closeSheet(); toast('Invite deleted'); await refresh(); } catch (e) { toast(e.message, true); }
    };
  });
}
function inviteSheet(code) {
  const inv = state.invites.find((i) => i.code === code);
  if (inv) showInvite(inv);
}

function userSheet(uid) {
  const u = state.users.find((x) => x.id === uid);
  if (!u) return;
  openSheet(`
    <div class="sheet-head"><div class="app-icon big" style="border-radius:50%">${esc(u.username.charAt(0).toUpperCase())}</div>
      <div class="row-main"><h2>${esc(u.username)}</h2><div class="row-sub">${u.disabled ? 'Turned off' : 'Active'}</div></div></div>
    <dl class="kv">
      <dt>iPhone</dt><dd>${u.udid ? `${esc(u.deviceName || 'iPhone')}<br><span class="mono">${esc(u.udid)}</span>` : 'Not linked'}</dd>
      <dt>Certificates</dt><dd>${u.certCount}</dd>
      <dt>Signed apps</dt><dd>${u.signedCount}</dd>
      <dt>Joined</dt><dd>${fmtDate(u.createdAt)}</dd>
      <dt>Last seen</dt><dd>${ago(u.lastLogin)}</dd>
      ${u.invite ? `<dt>Invite</dt><dd class="mono">${esc(u.invite)}</dd>` : ''}
    </dl>
    <div class="actions" style="margin-top:12px">
      ${u.udid ? '<button class="btn block" id="uCopy">Copy UDID</button>' : ''}
      <button class="btn block" id="uReset">Reset password</button>
      ${u.udid ? '<button class="btn block" id="uUnlink">Unlink iPhone</button>' : ''}
      <button class="btn block" id="uToggle">${u.disabled ? 'Turn account on' : 'Turn account off'}</button>
      <button class="btn block danger" id="uDelete">Delete account</button>
    </div>`, (el) => {
    const patch = async (body, msg) => {
      try { await api('PATCH', `/api/users/${u.id}`, body); toast(msg); closeSheet(); await refresh(); } catch (e) { toast(e.message, true); }
    };
    if ($('#uCopy', el)) $('#uCopy', el).onclick = () => copy(u.udid, 'UDID copied');
    $('#uReset', el).onclick = () => {
      const pw = prompt(`New password for ${u.username} (6+ characters)`);
      if (pw) patch({ password: pw }, 'Password reset — they\'ll need to sign in again');
    };
    if ($('#uUnlink', el)) $('#uUnlink', el).onclick = () => patch({ unlinkDevice: true }, 'iPhone unlinked');
    $('#uToggle', el).onclick = () => patch({ disabled: !u.disabled }, u.disabled ? 'Account turned on' : 'Account turned off');
    $('#uDelete', el).onclick = async () => {
      if (!confirm(`Delete ${u.username}? Their certificates and signed apps are removed too.`)) return;
      try { await api('DELETE', `/api/users/${u.id}`); closeSheet(); toast('Account deleted'); await refresh(); } catch (e) { toast(e.message, true); }
    };
  });
}

// ---------- account ----------
async function unlinkDevice() {
  if (!confirm('Unlink this iPhone from your account?')) return;
  try { await api('PATCH', '/api/account', { unlinkDevice: true }); toast('iPhone unlinked'); await refresh(); } catch (e) { toast(e.message, true); }
}

function changePasswordSheet() {
  openSheet(`
    <h2>Change Password</h2>
    <div class="field"><label>Current password</label><input type="password" id="pwOld" autocomplete="current-password"></div>
    <div class="field"><label>New password</label><input type="password" id="pwNew" autocomplete="new-password" placeholder="6+ characters"></div>
    <button class="btn primary big block" id="pwSave">Save</button>`, (el) => {
    $('#pwSave', el).onclick = async () => {
      try {
        await api('PATCH', '/api/account', { currentPassword: $('#pwOld', el).value, newPassword: $('#pwNew', el).value });
        closeSheet(); toast('Password changed');
      } catch (e) { toast(e.message, true); }
    };
  });
}

async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
}

// ---------- login / sign up ----------
function showPane(which) {
  $('#signinPane').classList.toggle('hidden', which !== 'signin');
  $('#signupPane').classList.toggle('hidden', which !== 'signup');
  $('#loginError').textContent = '';
}

function showLogin(pane = 'signin') {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  closeSheet.locked = false;
  closeSheet();
  showPane(pane);
}

$('#toSignup').onclick = () => showPane('signup');
$('#toSignin').onclick = () => showPane('signin');

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('POST', '/api/login', { username: $('#loginUser').value, password: $('#loginPassword').value });
    $('#loginPassword').value = '';
    await boot();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
};

$('#signupForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('POST', '/api/signup', {
      invite: $('#suInvite').value, username: $('#suUser').value, password: $('#suPassword').value,
      udidState: state.udidState || '',
    });
    state.udidState = null;
    toast('Welcome to Mango Signer! 🥭');
    await boot();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
};

async function handleUrlParams() {
  const q = new URLSearchParams(location.search);
  const udid = q.get('udid');
  const invite = q.get('invite');
  if (udid || invite || q.has('r')) history.replaceState(null, '', '/');
  if (invite) { $('#suInvite').value = invite; return 'signup'; }
  if (!udid) return null;
  const msgs = {
    welcome: ['Signed in with your iPhone', false],
    linked: ['iPhone linked to your account ✓', false],
    taken: ['That iPhone is already linked to another account', true],
    disabled: ['That account is turned off', true],
    off: ['iPhone sign-in is turned off', true],
    error: ["Couldn't read your iPhone's ID — try again", true],
  };
  if (msgs[udid]) toast(...msgs[udid]);
  if (udid === 'new') {
    state.udidState = q.get('s');
    try {
      const d = await api('GET', `/api/udid/pending?s=${encodeURIComponent(state.udidState || '')}`);
      if (d.udid) {
        $('#udidBanner').textContent = `This iPhone (${d.deviceName || 'iPhone'}) isn't linked to an account yet. Create one with an invite code and it'll be linked automatically.`;
        $('#udidBanner').classList.remove('hidden');
      }
    } catch { /* ignore */ }
    return 'signup';
  }
  if (udid === 'linked') state.tab = 'settings';
  return null;
}

async function boot() {
  const pane = await handleUrlParams();
  const s = await api('GET', '/api/session');
  $('#udidLoginBtn').classList.toggle('hidden', !s.udidLogin);
  $('#udidLoginHint').classList.toggle('hidden', !s.udidLogin);
  if (!s.authed) return showLogin(pane || 'signin');
  state.account = s.account;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#app').classList.add('app-in');
  await refresh();
  if (!maybeShowTour()) maybeShowWhatsNew();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#app').classList.contains('hidden') && $('#sheet').classList.contains('hidden') && !uploadFile.active) refresh().catch(() => {});
});

checkForUpdate();
boot().catch((e) => toast(e.message, true));
