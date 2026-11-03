// Mango Signer — front end
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = {
  tab: 'library', account: null, apps: [], categories: [], certs: [], signed: [], users: [], invites: [], settings: {}, server: {},
  sources: [], github: { connected: false }, tweaks: [], presets: [], substrate: { installed: false },
  alerts: [], favorites: [], mySignins: [], securityLog: [],
  udidState: null,
  lib: { q: '', cat: 'all', sort: 'smart', select: false, selected: new Set(), limit: 40 },
};
const isOwner = () => state.account && state.account.role === 'owner';
// Admins help run the library and users; testers get a badge and see "Testers only" apps.
const isAdmin = () => !!state.account && state.account.role === 'user' && state.account.rank === 'admin';
const isStaff = () => isOwner() || isAdmin();
const isTester = () => !!state.account && state.account.role === 'user' && state.account.rank === 'tester';
const seesTesterApps = () => isStaff() || isTester();
const RANK_LABEL = { admin: '⭐ Admin', tester: '🧪 Tester' };

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
  // Never wait forever: if the server or the connection goes quiet, give up with a clear message.
  const slow = /\/(sync|delete-removed|auto-categorize|restore|bulk|scan|dedupe)\b/.test(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), slow ? 300000 : 60000);
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
  } catch (e) {
    throw Object.assign(new Error(ctrl.signal.aborted ? 'Mango took too long to answer. Check your connection and try again.' : "Couldn't reach Mango. Check your connection and try again."), { network: true });
  } finally {
    clearTimeout(timer);
  }
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
  waitJob.active = jobId;
  try {
    let misses = 0;
    for (;;) {
      await sleep(900);
      let j;
      try {
        j = await api('GET', `/api/jobs/${jobId}`);
        misses = 0;
      } catch (e) {
        // Phone locked or the app was in the background: the job keeps running on the server, so just try again.
        if (e.status === 404 || ++misses > 120) throw e;
        await sleep(Math.min(10000, 1000 * misses));
        continue;
      }
      onUpdate && onUpdate(j);
      // Any "Cancel" button in the open sheet shows while the job can still be stopped.
      document.querySelectorAll('#sheetBody .job-cancel').forEach((b) => b.classList.toggle('hidden', !j.cancellable));
      if (j.status === 'done') return j.result;
      if (j.status === 'cancelled') throw Object.assign(new Error('Cancelled'), { cancelled: true, log: j.log });
      if (j.status === 'error') throw Object.assign(new Error(j.error || 'Failed'), { log: j.log });
    }
  } finally {
    if (waitJob.active === jobId) waitJob.active = null;
  }
}
const cancelBtnHtml = (label = 'Cancel') => `<button class="btn block job-cancel hidden" type="button" style="margin-top:12px">✕ ${label}</button>`;
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.job-cancel');
  if (!b || !waitJob.active) return;
  b.disabled = true;
  b.textContent = 'Stopping…';
  try { await api('POST', `/api/jobs/${waitJob.active}/cancel`); } catch (err) { toast(err.message, true); }
});

async function refresh() {
  const d = await api('GET', '/api/state');
  Object.assign(state, d);
  render();
  if (!pollTasks.timer) pollTasks();
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
// Checkboxes for tweaks from the Tweaks library.
function tweakPickerHtml(prefix, selected = []) {
  if (!state.tweaks.length) return '';
  return `<div class="group tweak-pick">${state.tweaks.map((t) => toggle(`${prefix}Tw_${t.id}`, `🧩 ${esc(t.name)}${t.version ? ' ' + esc(t.version) : ''}`,
    esc(t.description ? t.description.split('\n')[0].slice(0, 90) : (t.warnings.length ? '⚠️ ' + t.warnings[0] : `${t.files.length} file${t.files.length === 1 ? '' : 's'}`)), selected.includes(t.id))).join('')}</div>`;
}
const pickedTweaks = (el, prefix) => state.tweaks.filter((t) => { const x = $(`#${prefix}Tw_${t.id}`, el); return x && x.checked; }).map((t) => t.id);

function defaultsSummary(d = {}) {
  const bits = [];
  for (const p of ENT_PRESETS) if ((d.entitlements || []).some((e) => e.key === p.key)) bits.push(p.short);
  for (const p of PLIST_PRESETS) if ((d.plist || []).some((e) => e.key === p.key)) bits.push(p.short);
  const extraEnt = (d.entitlements || []).filter((e) => !ENT_PRESETS.some((p) => p.key === e.key)).length;
  const extraPlist = (d.plist || []).filter((e) => !PLIST_PRESETS.some((p) => p.key === e.key)).length;
  if (extraEnt) bits.push(`${extraEnt} custom entitlement${extraEnt === 1 ? '' : 's'}`);
  if (extraPlist) bits.push(`${extraPlist} Info.plist change${extraPlist === 1 ? '' : 's'}`);
  for (const o of OPTION_TOGGLES) if (d[o.key]) bits.push(o.short);
  const tw = (d.tweakIds || []).map((tid) => (state.tweaks.find((t) => t.id === tid) || {}).name).filter(Boolean);
  if (tw.length) bits.push(`🧩 ${tw.join(', ')}`);
  return bits;
}

// ---------- render ----------
function tabsFor() {
  return isStaff()
    ? [['library', 'Library'], ['signed', 'Signed'], ['certs', 'Certificates'], ['users', 'Users'], ['settings', isOwner() ? 'Settings' : 'Account']]
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
  $('#pageTitle').textContent = state.tab === 'library' && !isStaff() ? 'App Library' : title;
  renderTabs();
  const top = $('#topAction');
  const actions = { library: isStaff() ? addAppSheet : null, certs: addCertSheet, users: newInviteSheet };
  top.innerHTML = actions[state.tab] ? ICONS.plus : '';
  top.onclick = actions[state.tab] || null;
  top.classList.toggle('hidden', !actions[state.tab]);
  const unread = state.alerts.filter((x) => !x.read).length;
  $('#bellBtn').classList.toggle('hidden', !state.alerts.length);
  $('#bellDot').classList.toggle('hidden', !unread);
  $('#bellDot').textContent = unread > 9 ? '9+' : unread || '';
  $('#bellBtn').onclick = alertsSheet;
  const view = $('#view');
  view.innerHTML = announcementHtml() + { library: renderLibrary, signed: renderSigned, certs: renderCerts, users: renderUsers, settings: renderSettings }[state.tab]();
  bindView(view);
  if (state.tab === 'library') bindLibrary(view);
}

// ---------- library ----------
const DAY = 864e5;
const isNewApp = (a) => Date.now() - new Date(a.addedAt) < 3 * DAY;
const isUpdatedApp = (a) => !isNewApp(a) && a.updatedAt && a.previousVersion && Date.now() - new Date(a.updatedAt) < 3 * DAY;
// Mango works this out on the server: the real version you installed vs the newest one (a custom version name never triggers it).
const hasUpdate = (a) => !!(a.installed && a.installed.update && !a.installed.stopped);
const isStopped = (a) => !!(a.installed && a.installed.stopped);
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
  else if (cat === 'favorites') apps = apps.filter(isFav);
  else if (cat === 'updates') apps = apps.filter(hasUpdate);
  else if (cat === 'new') apps = apps.filter((a) => isNewApp(a) || isUpdatedApp(a));
  else if (cat === 'none') apps = apps.filter((a) => !a.categoryId || !catById(a.categoryId));
  else if (cat === 'hidden') apps = apps.filter((a) => !a.published);
  else if (cat === 'testers') apps = apps.filter((a) => a.testersOnly);
  else if (cat === 'missing') apps = apps.filter((a) => a.missing);
  else if (cat === 'cloud:github') apps = apps.filter((a) => a.cloud === 'github');
  else if (cat === 'cloud:link') apps = apps.filter((a) => a.cloud === 'link');
  else if (cat.startsWith('src:')) apps = apps.filter((a) => isSrcApp(a) && a.sourceName === cat.slice(4));
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

// Release notes are often written in Markdown (## headings, **bold**, - lists). Show them as tidy plain text.
function cleanNotes(t) {
  return String(t || '')
    .replace(/\r/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((l) => l.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[-*+]\s+/, '• ').replace(/^\s*>\s?/, ''))
    .join('\n')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// The "You installed…" line on an app's page, with quick fixes when Mango's guess is wrong.
function installedNoteHtml(a) {
  const i = a.installed;
  const why = i.stopped === 'revoked' ? 'the certificate it was signed with was revoked' : 'the certificate it was signed with has expired';
  return `<div class="installed-note">
    ${i.stopped ? `<p class="warning bad" style="margin:8px 0 0">You installed ${esc(i.version || '')} ${ago(i.at)}, but ${why}, so it won't open anymore. Sign it again with a working certificate to fix it.</p>`
      : `<p class="hint center" style="margin:8px 0 0">You installed ${esc(i.version || '')} ${ago(i.at)}${hasUpdate(a) ? ` · ${esc(shownVersion(a))} is out` : ''}</p>`}
    <div class="note-links">
      ${hasUpdate(a) ? '<button class="linkish" data-myapp="latest">I already updated it</button>' : ''}
      <button class="linkish" data-myapp="remove">Not on my phone anymore</button>
    </div>
  </div>`;
}
function bindInstalledNote(el, a, after) {
  el.querySelectorAll('[data-myapp]').forEach((b) => {
    b.onclick = async () => {
      const action = b.dataset.myapp;
      try {
        const { installed } = await api('POST', `/api/my-apps/${a.id}`, { action });
        const app = state.apps.find((x) => x.id === a.id);
        if (app) app.installed = action === 'remove' ? null : installed;
        toast(action === 'remove' ? 'Removed from your installed apps' : 'Marked as up to date');
        if (after) after();
        render();
        refresh().catch(() => {});
      } catch (e) { toast(e.message, true); }
    };
  });
}
// Everything Mango thinks is on your phone, so you can fix the list in one place.
function myAppsSheet() {
  const mine = state.apps.filter((a) => a.installed).sort((x, y) => (hasUpdate(y) - hasUpdate(x)) || (isStopped(y) - isStopped(x)) || String(y.installed.at).localeCompare(String(x.installed.at)));
  const stopped = mine.filter(isStopped).length;
  openSheet(`
    <h2>Your installed apps</h2>
    <p class="hint" style="margin:0 4px 12px">iPhones don't let websites see your home screen, so this is every app you installed through Mango. Deleted one, or updated it somewhere else? Fix it here and Mango stops bugging you about it.</p>
    ${stopped ? `<button class="btn block" id="maClean" style="margin-bottom:10px">Forget ${stopped} app${stopped === 1 ? '' : 's'} that won't open anymore</button>` : ''}
    ${mine.length ? `<div class="group">${mine.map((a) => `
      <div class="row" data-ma="${a.id}">
        ${appIcon(a)}
        <div class="row-main"><div class="row-title">${esc(a.name)}</div>
          <div class="row-sub">${esc(a.installed.version || '?')} · ${ago(a.installed.at)}${hasUpdate(a) ? ` · <b class="mango-text">${esc(shownVersion(a))} is out</b>` : isStopped(a) ? ' · <b class="bad-text">won\'t open</b>' : ' · up to date'}</div></div>
        <div class="row-btns">
          ${hasUpdate(a) ? '<button class="btn small-btn" data-ma-act="latest" title="I already updated it">✓</button>' : ''}
          <button class="btn small-btn" data-ma-act="remove" aria-label="Not on my phone">✕</button>
        </div>
      </div>`).join('')}</div>
      <p class="hint" style="margin:8px 4px 0">✓ = I already have the newest version · ✕ = not on my phone anymore</p>` : '<p class="empty">Nothing yet. Apps you install from Mango show up here.</p>'}
  `, (el) => {
    el.querySelectorAll('[data-ma-act]').forEach((b) => {
      b.onclick = async () => {
        const row = b.closest('[data-ma]');
        const action = b.dataset.maAct;
        b.disabled = true;
        try {
          const { installed } = await api('POST', `/api/my-apps/${row.dataset.ma}`, { action });
          const app = state.apps.find((x) => x.id === row.dataset.ma);
          if (app) app.installed = action === 'remove' ? null : installed;
          render();
          myAppsSheet();
        } catch (e) { b.disabled = false; toast(e.message, true); }
      };
    });
    if ($('#maClean', el)) $('#maClean', el).onclick = async () => {
      try { const { removed } = await api('POST', '/api/my-apps/clean'); await refresh(); toast(`Forgot ${removed} app${removed === 1 ? '' : 's'}`); myAppsSheet(); } catch (e) { toast(e.message, true); }
    };
  });
}

function appBadges(a, { compact = false } = {}) {
  const b = [];
  if (hasUpdate(a)) b.push('<span class="badge mango">⬆ Update</span>');
  else if (isStopped(a)) b.push('<span class="badge bad">⚠ Won\'t open</span>');
  else if (a.installed) b.push('<span class="badge good">✓ Installed</span>');
  if (isNewApp(a)) b.push('<span class="badge new">NEW</span>');
  else if (isUpdatedApp(a)) b.push('<span class="badge new">UPDATED</span>');
  if (a.testersOnly && seesTesterApps()) b.push('<span class="badge tester">🧪 Testers</span>');
  if (!compact && isStaff() && !a.published && !a.testersOnly) b.push('<span class="badge">Hidden</span>');
  if (!compact && a.missing) b.push('<span class="badge bad">Removed from source</span>');
  if (!compact) b.push(cloudBadge(a));
  return b.join('');
}

// Where an app's file lives. Users only see the source name; you also see GitHub / link-only.
function cloudBadge(a) {
  if (a.cloud === 'source') return `<span class="badge cloud">☁ ${esc(a.sourceName || 'Source')}</span>`;
  if (a.cloud === 'telegram') return `<span class="badge cloud">✈️ ${esc(a.sourceName || 'Telegram')}</span>`;
  if (!isStaff()) return '';
  if (a.cloud === 'github') return '<span class="badge cloud">☁ GitHub</span>';
  if (a.cloud === 'link') return '<span class="badge cloud">🔗 Link</span>';
  return '';
}
const isSrcApp = (a) => a.cloud === 'source' || a.cloud === 'telegram';
const storedLabel = (a) => ({ telegram: `Telegram: ${a.sourceName || 'a channel'} (not stored here)`, source: `Linked from ${a.sourceName || 'a source'} (not stored here)`, github: 'Your GitHub repo (not stored here)', link: 'Download link (not stored here)' }[a.cloud] || 'This server');

function getLabel(a) {
  if (hasUpdate(a)) return 'Update';
  if (isStopped(a)) return 'Fix';
  return 'Get';
}

function appRow(a, { age = false } = {}) {
  const sel = state.lib.select;
  const checked = state.lib.selected.has(a.id);
  const rating = a.likes + a.dislikes ? `👍 ${Math.round((100 * a.likes) / (a.likes + a.dislikes))}%` : '';
  const when = age ? `${a.updatedAt && a.updatedAt !== a.addedAt ? 'Updated' : 'Added'} ${ago(a.updatedAt || a.addedAt)}` : '';
  const sub2 = [when, fmtSize(a.size), a.developer, a.installCount ? `🔥 ${a.installCount}` : '', rating].filter(Boolean).join(' · ');
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
    <span class="tile-sub">${esc([shownVersion(a), fmtSize(a.size)].filter(Boolean).join(' · '))}</span>
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
    return isStaff()
      ? `<div class="empty">${ICONS.box}<h3>No apps yet</h3><p>Add an .ipa from Files or paste a download link. Apps you add show up in the App Library for everyone you invite.</p>
        <button class="btn primary" data-act="add-app">Add App</button></div>`
      : `<div class="empty">${ICONS.box}<h3>No apps yet</h3><p>The owner hasn't added any apps yet. Want something? Request it!</p>
        <button class="btn primary" data-act="request-app">Request an App</button></div>`;
  }
  if (!apps.length) {
    return `<div class="empty" style="padding:30px 20px">${ICONS.search}<h3>Nothing found</h3><p>${q ? `No apps match “${esc(q)}”.` : 'Nothing here yet.'}</p>
      ${!isStaff() ? '<button class="btn" data-act="request-app">Request an App</button>' : ''}</div>`;
  }

  // Grouped view: shelves up top, then one section per category, in your order.
  if (cat === 'all' && !q && state.lib.sort === 'smart' && !state.lib.select) {
    let html = '';
    // Kept small on purpose: a slim row of icons instead of big cards.
    const forTesters = seesTesterApps() ? apps.filter((a) => a.testersOnly) : [];
    if (forTesters.length) {
      html += `<div class="section-title" style="margin-top:6px">🧪 For testers <span class="count">${forTesters.length}</span></div><div class="mini-shelf">${forTesters.map((a) => miniCard(a, shownVersion(a))).join('')}</div>`;
    }
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

// How many apps a filter key matches.
function libCount(key) {
  const A = state.apps;
  if (key === 'all') return A.length;
  if (key === 'installed') return A.filter((a) => a.installed).length;
  if (key === 'favorites') return A.filter(isFav).length;
  if (key === 'updates') return A.filter(hasUpdate).length;
  if (key === 'new') return A.filter((a) => isNewApp(a) || isUpdatedApp(a)).length;
  if (key === 'featured') return A.filter((a) => a.featured).length;
  if (key === 'none') return A.filter((a) => !catById(a.categoryId)).length;
  if (key === 'hidden') return A.filter((a) => !a.published).length;
  if (key === 'testers') return A.filter((a) => a.testersOnly).length;
  if (key.startsWith('tag:')) return A.filter((a) => (a.tags || []).includes(key.slice(4))).length;
  if (key.startsWith('src:')) return A.filter((a) => isSrcApp(a) && a.sourceName === key.slice(4)).length;
  if (key === 'cloud:github') return A.filter((a) => a.cloud === 'github').length;
  if (key === 'cloud:link') return A.filter((a) => a.cloud === 'link').length;
  if (key === 'missing') return A.filter((a) => a.missing).length;
  return A.filter((a) => a.categoryId === key).length;
}
// Everything you can filter by, grouped for the Filters sheet.
function filterGroups() {
  const tags = [...new Set(state.apps.flatMap((a) => a.tags || []))].sort();
  const srcNames = [...new Set(state.apps.filter((a) => isSrcApp(a) && a.sourceName).map((a) => a.sourceName))].sort();
  const g = [
    { title: 'Show', items: [['all', '📱 All'], ['favorites', '♥ Favorites'], ['installed', '✓ Installed'], ['updates', '⬆ Updates'], ['new', '🆕 New'], ['featured', '★ Featured'], ...(seesTesterApps() ? [['testers', '🧪 Testers']] : [])] },
    { title: 'Categories', items: state.categories.map((c) => [c.id, `${c.emoji} ${c.name}`]) },
    { title: 'Sources', items: srcNames.map((n) => [`src:${n}`, `${state.apps.some((a) => a.cloud === 'telegram' && a.sourceName === n) ? '✈️' : '☁'} ${n}`]) },
    { title: 'Tags', items: tags.map((t) => [`tag:${t}`, `# ${t}`]) },
  ];
  if (isStaff()) g.push({ title: 'Owner', items: [['cloud:github', '☁ On GitHub'], ['cloud:link', '🔗 Links'], ['none', 'Uncategorized'], ['hidden', 'Hidden'], ['missing', '⚠ Removed']] });
  return g.map((x) => ({ ...x, items: x.items.filter(([k]) => k === 'all' || libCount(k) > 0 || (x.title === 'Categories' && isStaff())) })).filter((x) => x.items.length);
}
const filterLabel = (key) => (filterGroups().flatMap((x) => x.items).find(([k]) => k === key) || [key, key])[1];
const PRIMARY_FILTERS = ['all', 'favorites', 'installed', 'updates', 'featured'];

function filterSheet() {
  const cols = state.collections.filter((c) => c.appIds.some((x) => state.apps.some((a) => a.id === x)));
  openSheet(`
    <h2>Filter</h2>
    ${filterGroups().map((g) => `<div class="section-title">${esc(g.title)}</div>
      <div class="filter-grid">${g.items.map(([k, l]) => `<button class="fopt ${state.lib.cat === k ? 'on' : ''} ${libCount(k) ? '' : 'zero'}" data-f="${esc(k)}"><span>${esc(l)}</span><b>${libCount(k)}</b></button>`).join('')}</div>`).join('')}
    ${cols.length ? `<div class="section-title">Collections</div><div class="filter-grid">${cols.map((c) => `<button class="fopt" data-col="${c.id}"><span>${esc(c.emoji)} ${esc(c.name)}</span><b>${c.appIds.filter((x) => state.apps.some((a) => a.id === x)).length}</b></button>`).join('')}</div>` : ''}
    <div class="actions" style="margin-top:14px">
      ${isStaff() ? '<button class="btn block" id="fEdit">⚙︎ Edit categories</button>' : '<button class="btn block" id="fReq">+ Request an App</button>'}
    </div>`, (el) => {
    el.querySelectorAll('[data-f]').forEach((b) => {
      b.onclick = () => { state.lib.cat = b.dataset.f; state.lib.limit = 40; saveLibPrefs(); closeSheet(); window.scrollTo(0, 0); render(); };
    });
    el.querySelectorAll('[data-col]').forEach((b) => { b.onclick = () => collectionSheet(b.dataset.col); });
    if ($('#fEdit', el)) $('#fEdit', el).onclick = manageCategoriesSheet;
    if ($('#fReq', el)) $('#fReq', el).onclick = requestAppSheet;
  });
}

function renderLibrary() {
  const { q, cat, sort } = state.lib;
  const primary = [['all', 'All'], ['favorites', '♥'], ['installed', '✓ Installed'], ['updates', '⬆ Updates'], ['featured', '★ Featured']]
    .filter(([k]) => k === 'all' || k === cat || libCount(k) > 0);
  const extraOn = !PRIMARY_FILTERS.includes(cat);
  const certWarn = certBanner();
  const setup = !isOwner() && !state.certs.length
    ? `<p class="warning" data-act="go-certs" style="margin:0 0 12px;cursor:pointer">Add your certificate in the Certificates tab to start signing →</p>` : '';
  const view = libView();
  return `${setup}${certWarn}
    ${state.apps.length ? `
    <div class="searchbar">${ICONS.search}<input type="search" id="libSearch" placeholder="Search ${state.apps.length} app${state.apps.length === 1 ? '' : 's'}" value="${esc(q)}" autocapitalize="off" autocorrect="off"></div>
    <div class="chips-row compact" id="libChips">
      ${primary.map(([k, l]) => `<button class="fchip ${cat === k ? 'on' : ''}" data-cat="${esc(k)}">${esc(l)}${k === 'all' ? '' : ` <span>${libCount(k)}</span>`}</button>`).join('')}
      ${extraOn ? `<button class="fchip on" data-act="clear-filter" aria-label="Clear filter">${esc(filterLabel(cat))} <span>${libCount(cat)}</span> ✕</button>` : ''}
      <button class="fchip ghost" data-act="filters">☰ Filters</button>
    </div>
    <div class="lib-tools">
      <select id="libSort">
        ${[['smart', cat === 'all' ? 'Recently updated' : 'Featured first'], ['popular', 'Popular'], ['rating', 'Top rated'], ['name', 'A–Z'], ['newest', 'Newest'], ['size', 'Biggest']].map(([k, l]) => `<option value="${k}" ${sort === k ? 'selected' : ''}>Sort: ${l}</option>`).join('')}
      </select>
      <div class="seg" role="group" aria-label="Layout">
        <button data-view="list" class="${view === 'list' ? 'on' : ''}" aria-label="List">☰</button>
        <button data-view="grid" class="${view === 'grid' ? 'on' : ''}" aria-label="Grid">▦</button>
      </div>
      <button class="btn small-btn" data-act="toggle-select-mode">${state.lib.select ? 'Done' : 'Select'}</button>
    </div>` : ''}
    ${['installed', 'updates'].includes(cat) && libCount('installed') ? `<div class="hint-card"><span>Deleted something or updated it elsewhere?</span><button class="btn small-btn" data-act="my-apps">Fix the list</button></div>` : ''}
    ${isStaff() && ['all', 'none'].includes(cat) && libCount('none') ? `<div class="hint-card sort-card"><span>📂 ${libCount('none')} app${libCount('none') === 1 ? ' has' : 's have'} no category</span><button class="btn small-btn" data-act="auto-sort">✨ Auto-sort</button><button class="btn small-btn" data-act="quick-sort">Sort by hand</button></div>` : ''}
    ${cat === 'missing' && isStaff() && libCount('missing') ? `<div class="warning bad" style="margin:0 0 12px;display:flex;align-items:center;gap:10px"><span style="flex:1">These apps were removed from their source and are hidden from everyone.</span><button class="btn small-btn danger" data-act="delete-missing">Delete all ${libCount('missing')}</button></div>` : ''}
    <div id="libList">${libraryListHtml()}</div>
    ${state.lib.select ? bulkBarHtml() : ''}`;
}

function bulkBarHtml() {
  const n = state.lib.selected.size;
  if (!isStaff()) {
    return `<div class="bulk-bar"><span>${n} selected</span><button data-bulk="get" class="primary" ${n ? '' : 'disabled'}>Get ${n || ''}</button></div>`;
  }
  return `<div class="bulk-bar">
    <span>${n} selected</span>
    <button data-bulk="get" ${n ? '' : 'disabled'}>Get</button>
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
  if (action === 'get') {
    const apps = ids.map((i) => state.apps.find((a) => a.id === i)).filter(Boolean);
    state.lib.selected.clear();
    state.lib.select = false;
    render();
    return getAll(apps, `Get ${apps.length} app${apps.length === 1 ? '' : 's'}`);
  }
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
// Deletes every app marked "Removed from source" (all sources, or just one).
async function deleteRemovedApps(sourceId, n) {
  if (!confirm(`Delete ${n} app${n === 1 ? '' : 's'} that ${n === 1 ? 'was' : 'were'} removed from ${sourceId ? 'this source' : 'their sources'}? Mango double-checks Telegram channels first, so only apps that are really gone get deleted. This can't be undone.`)) return;
  toast('Deleting…');
  try {
    const { count } = await api('POST', '/api/apps/delete-removed', { sourceId: sourceId || null });
    closeSheet();
    if (state.lib.cat === 'missing') state.lib.cat = 'all';
    await refresh();
    toast(count ? `Deleted ${count} removed app${count === 1 ? '' : 's'}` : 'Nothing to delete — those apps are still there');
  } catch (e) { toast(e.message, true); }
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
  const mine = state.apps.filter((a) => a.installed).length;
  return `<div class="section-title">Install history <span class="count">${state.installs.length}</span></div>
    ${mine ? `<div class="hint-card"><span>${mine} app${mine === 1 ? '' : 's'} on your phone, as far as Mango knows</span><button class="btn small-btn" data-act="my-apps">Review</button></div>` : ''}
    <div class="list">${list.map((l) => {
      const app = state.apps.find((a) => a.id === l.appId);
      return `<div class="row" ${app ? `data-act="app" data-id="${app.id}"` : ''}>
        ${app ? appIcon(app) : iconHtml(null, l.name)}
        <div class="row-main"><div class="row-title">${esc(l.name)}</div>
          <div class="row-sub">${esc(l.shownVersion || l.version || '')} · ${esc(l.certLabel || '')}${l.via === 'link' ? ' · from a shared link' : ''}</div>
          <div class="row-sub">${new Date(l.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></div>
        <span class="badge good">✓</span></div>`;
    }).join('')}</div>`;
}

function renderSigned() {
  if (!state.signed.length && !(state.installs || []).length) {
    return `<div class="empty">${ICONS.down}<h3>Nothing signed yet</h3><p>Signed apps show up here, ready to install.</p>
      <button class="btn primary" data-act="go-library">Go to ${isStaff() ? 'Library' : 'App Library'}</button></div>`;
  }
  const keep = Number(state.settings.signedRetentionDays);
  const notes = [];
  if (!isOwner()) notes.push(`Your newest ${state.settings.maxSignedPerUser || 10} signed apps are kept.`);
  const onGh = state.settings.signedOnGithub || (state.github && state.github.signedToGithub);
  if (onGh) notes.push('Signed apps stay here until you delete them, or until their certificate expires.');
  else if (keep) notes.push(`Signed files are removed after ${keep} day${keep === 1 ? '' : 's'} to save space — tap Sign again any time.`);
  const ready = state.signed.filter((s) => s.fileAvailable);
  const old = state.signed.filter((s) => !s.fileAvailable);
  const row = (s) => {
    const left = daysLeft(s.expires);
    const badge = left === null ? '' : left < 0 ? '<span class="badge bad">Cert expired</span>' : left < 7 ? `<span class="badge warn">${left}d left</span>` : `<span class="badge">${left}d left</span>`;
    return `
    <div class="row" data-act="signed" data-id="${s.id}">
      ${signedIcon(s)}
      <div class="row-main">
        <div class="row-title">${esc(s.name)}</div>
        ${s.onPhone || badge || s.savedOnGithub ? `<div class="row-badges">${s.onPhone ? '<span class="badge good">On your phone</span>' : ''}${badge}${s.savedOnGithub ? '<span class="badge">☁ Saved</span>' : ''}</div>` : ''}
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
            <div class="row-sub">${i.rank ? `${i.rank === 'admin' ? '⭐ Admin' : '🧪 Tester'} · ` : ''}${esc(i.note || 'No note')} · ${i.uses}/${i.maxUses} used${i.expiresAt && new Date(i.expiresAt) > new Date() ? ` · expires ${fmtDate(i.expiresAt)}` : ''}</div>
          </div>
          ${i.uses >= i.maxUses ? '<span class="badge">Used up</span>' : i.expiresAt && new Date(i.expiresAt) < new Date() ? '<span class="badge">Expired</span>' : '<span class="badge good">Active</span>'}
        </div>`).join('')}</div>`
    : `<div class="card"><p class="muted" style="margin:0 0 12px">Make an invite code and send it to someone so they can create an account.</p><button class="btn primary block" data-act="new-invite">New Invite</button></div>`;
  const users = state.users.length
    ? `<div class="list">${state.users.map((u) => `
        <div class="row" data-act="user" data-id="${u.id}">
          <div class="app-icon" style="width:44px;height:44px;border-radius:50%;font-size:18px">${esc(u.username.charAt(0).toUpperCase())}</div>
          <div class="row-main">
            <div class="row-title">${esc(u.username)}${u.rank ? `<span class="badge ${u.rank === 'tester' ? 'tester' : 'mango'}">${RANK_LABEL[u.rank]}</span>` : ''}${u.disabled ? '<span class="badge bad">Off</span>' : ''}</div>
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
  const openBugs = (state.bugs || []).filter((b) => b.status === 'open');
  const bugs = (state.bugs || []).length
    ? `<div class="section-title" style="margin-top:${reqs ? 22 : 4}px">🐞 Bug reports ${openBugs.length ? `<span class="count hot">${openBugs.length} open</span>` : ''}</div>
       <div class="list">${[...openBugs, ...(state.bugs || []).filter((b) => b.status !== 'open').slice(0, 10)].map(bugRow).join('')}</div>` : '';
  return `${reqs}${bugs}<div class="section-title" style="margin-top:${reqs || bugs ? 22 : 4}px">Invite codes</div>${invites}<div class="section-title">People <span class="count">${state.users.length}</span></div>${users}`;
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
      <button class="row" data-act="tasks"><span class="row-main" style="font-weight:600">⏳ Activity</span><span class="value muted">${(() => { const n = (state.tasks || []).filter((j) => ['running', 'queued'].includes(j.status)).length; return n ? `<span style="color:var(--mango)">${n} going</span>` : ''; })()} ›</span></button>
      <button class="row" data-act="whats-new"><span class="row-main" style="font-weight:600">✨ What's New</span><span class="value muted">V${esc(CLIENT_VERSION || state.server.version || '')} ›</span></button>
      <div class="setting"><span>Username</span><span class="value">${esc(a.username)}${a.rank ? ` <span class="badge ${a.rank === 'tester' ? 'tester' : 'mango'}">${RANK_LABEL[a.rank] || esc(a.rank)}</span>` : ''}</span></div>
      <div class="setting"><span>iPhone</span><span class="value">${a.udid ? `${esc(a.deviceName || 'iPhone')}<br><span class="mono">${esc(shortUdid(a.udid))}</span>` : 'Not linked'}</span></div>
      ${a.udid ? '<button class="row" data-act="copy-udid"><span class="row-main" style="font-weight:600">Copy my UDID</span></button><button class="row" data-act="unlink-device"><span class="row-main" style="color:var(--red);font-weight:600">Unlink iPhone</span></button>'
        : '<a class="row" href="/udid/profile.mobileconfig?intent=link" style="text-decoration:none"><span class="row-main" style="color:var(--mango);font-weight:600">Link this iPhone</span></a>'}
      ${!isOwner() ? '<button class="row" data-act="change-password"><span class="row-main" style="font-weight:600">Change Password</span></button>' : ''}
      <button class="row" data-act="my-security"><span class="row-main" style="font-weight:600">🛡 Sign-ins &amp; security</span><span class="value muted">${state.mySignins.length ? esc(ago(state.mySignins[0].at)) : ''} ›</span></button>
      ${!isOwner() && state.settings.signsPerDay ? `<div class="setting"><span>Signs today</span><span class="value">${state.settings.signsToday || 0} of ${state.settings.signsPerDay}</span></div>` : ''}
      ${state.server.passwordSet !== false ? '<button class="row" data-act="logout"><span class="row-main" style="color:var(--red);font-weight:600">Log Out</span></button>' : ''}
    </div>
    <p class="hint" style="margin:8px 4px 0">${a.udid ? 'Your iPhone can sign in without a password, and Mango checks whether it\'s in your profiles.' : 'Linking downloads a quick profile: open Settings › Profile Downloaded › Install, and you\'ll come back here.'}</p>
    ${isTester() ? `<div class="section-title">🧪 Tester</div>
      <p class="hint" style="margin:0 4px 10px">You get the 🧪 badge and see the apps the owner picks for testers. Found something broken? Report it here.</p>
      ${(state.bugs || []).length ? `<div class="list" style="margin-bottom:10px">${state.bugs.map(bugRow).join('')}</div>` : ''}
      <button class="btn block" data-act="report-bug">🐞 Report a bug</button>` : ''}
    ${!isStaff() ? `<div class="section-title">My app requests</div>
      ${(state.requests || []).length ? `<div class="list">${state.requests.map(requestRow).join('')}</div>` : ''}
      <button class="btn block" data-act="request-app" style="margin-top:${(state.requests || []).length ? 10 : 0}px">+ Request an App</button>` : ''}`;
}

function renderSettings() {
  if (isAdmin()) {
    return `<p class="hint" style="margin:0 4px 10px">⭐ You're an admin: you can manage the library and users. Server settings, GitHub, Telegram sign-in and backups stay with the owner.</p>
    <div class="section-title">Cloud Library</div>
    ${cloudSettingsHtml()}
    <div class="section-title">Library</div>
    <div class="list">
      <div class="setting"><span>Apps</span><span class="value">${state.apps.length} (${state.apps.filter((a) => a.published).length} shown)</span></div>
      <button class="row" data-act="manage-cats"><span class="row-main" style="font-weight:600">Categories</span><span class="value muted">${state.categories.length} ›</span></button>
      <button class="row" data-act="manage-cols"><span class="row-main" style="font-weight:600">Collections</span><span class="value muted">${state.collections.length} ›</span></button>
      <button class="row" data-act="tweaks"><span class="row-main" style="font-weight:600">🧩 Tweaks</span><span class="value muted">${state.tweaks.length} ›</span></button>
      ${duplicateGroups().length ? `<button class="row" data-act="dupes"><span class="row-main" style="font-weight:600">🔁 Duplicates</span><span class="value" style="color:var(--mango)">${duplicateGroups().length} ›</span></button>` : ''}
    </div>
    <div class="section-title">Tools</div>
    <div class="list">
      <button class="row" data-act="stats"><span class="row-main" style="font-weight:600">📊 Stats &amp; activity</span><span class="value muted">›</span></button>
      <button class="row" data-act="security-log"><span class="row-main" style="font-weight:600">🛡 Security log</span><span class="value muted">›</span></button>
    </div>
    ${accountSection()}<p class="footer-note">🥭 Mango Signer ${esc(state.server.version || '')}<br>© 2026 MangoMods · All rights reserved</p>`;
  }
  if (!isOwner()) {
    return `${accountSection()}<p class="footer-note">🥭 Mango Signer ${esc(state.server.version || '')}<br>© 2026 MangoMods · All rights reserved</p>`;
  }
  const s = state.server;
  const b = s.storageBreakdown || {};
  const z = state.settings.zipLevel ?? 1;
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
        <select data-act="zip-level">${[0, 1, 3, 6, 9].map((n) => `<option value="${n}" ${n === Number(z) ? 'selected' : ''}>${n === 0 ? 'None (fastest)' : n === 9 ? 'Max (smallest)' : n === 1 ? 'Level 1 (fast, default)' : 'Level ' + n}</option>`).join('')}</select>
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
      <div class="setting"><span>Signs per user per day<br><span class="hint">You can change it per person on their page</span></span>
        <select data-act="signs-per-day">${[[0, 'No limit'], [3, '3'], [5, '5'], [10, '10'], [20, '20'], [50, '50']].map(([n, l]) => `<option value="${n}" ${n === Number(state.settings.signsPerDay || 0) ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <button class="row" data-act="security-log"><span class="row-main" style="font-weight:600">🛡 Security log</span><span class="value ${state.securityLog.some((e) => !e.ok && Date.now() - new Date(e.at) < 864e5) ? '' : 'muted'}" ${state.securityLog.some((e) => !e.ok && Date.now() - new Date(e.at) < 864e5) ? 'style="color:var(--red)"' : ''}>${state.securityLog.filter((e) => !e.ok && Date.now() - new Date(e.at) < 864e5).length ? `${state.securityLog.filter((e) => !e.ok && Date.now() - new Date(e.at) < 864e5).length} failed today` : ''} ›</span></button>
      <label class="setting"><span>Sign in with iPhone (UDID)</span>
        <span class="switch"><input type="checkbox" data-act="udid-login" ${state.settings.udidLogin ? 'checked' : ''}><span></span></span></label>
    </div>
    <div class="section-title">Library</div>
    <div class="list">
      <div class="setting"><span>Apps</span><span class="value">${state.apps.length} (${state.apps.filter((a) => a.published).length} shown)</span></div>
      <button class="row" data-act="manage-cats"><span class="row-main" style="font-weight:600">Categories</span><span class="value muted">${state.categories.length} ›</span></button>
      <button class="row" data-act="manage-cols"><span class="row-main" style="font-weight:600">Collections</span><span class="value muted">${state.collections.length} ›</span></button>
      <button class="row" data-act="tweaks"><span class="row-main" style="font-weight:600">🧩 Tweaks</span><span class="value muted">${state.tweaks.length}${state.tweaks.length && !state.substrate.installed && state.tweaks.some((t) => t.files.some((f) => f.needsSubstrate)) ? ' · ⚠️ needs Substrate' : ''} ›</span></button>
      ${duplicateGroups().length ? `<button class="row" data-act="dupes"><span class="row-main" style="font-weight:600">🔁 Duplicates</span><span class="value" style="color:var(--mango)">${duplicateGroups().length} ›</span></button>` : ''}
      <button class="row" data-act="announce"><span class="row-main" style="font-weight:600">📣 Announcement</span><span class="value muted">${state.announcement ? 'On' : 'Off'} ›</span></button>
      <div class="setting"><span>Your signed apps</span><span class="value">${state.signed.length}</span></div>
      <div class="setting"><span>Users</span><span class="value">${state.users.length}</span></div>
    </div>
    <div class="section-title">Owner tools</div>
    <div class="list">
      <button class="row" data-act="stats"><span class="row-main" style="font-weight:600">📊 Stats &amp; activity</span><span class="value muted">›</span></button>
      <button class="row" data-act="broadcast"><span class="row-main" style="font-weight:600">📣 Message everyone</span><span class="value muted">›</span></button>
      <button class="row" data-act="backup"><span class="row-main" style="font-weight:600">💾 Backup &amp; restore</span><span class="value muted">${state.settings.lastBackup ? ago(state.settings.lastBackup) : 'never'} ›</span></button>
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
    if (act === 'signs-per-day') { el.onchange = () => saveSetting({ signsPerDay: Number(el.value) }, Number(el.value) ? `Limit: ${el.value} signs per day` : 'No daily limit'); return; }
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
        tweaks: tweaksSheet,
        'my-security': mySecuritySheet,
        stats: statsSheet,
        broadcast: broadcastSheet,
        backup: backupSheet,
        'security-log': securityLogSheet,
        dupes: () => duplicatesSheet(),
        filters: filterSheet,
        'my-apps': myAppsSheet,
        'delete-missing': () => deleteRemovedApps(null, libCount('missing')),
        'clear-filter': () => { state.lib.cat = 'all'; state.lib.limit = 40; saveLibPrefs(); render(); },
        'lib-more': () => { state.lib.limit += 40; const y = window.scrollY; render(); window.scrollTo(0, y); },
        source: () => sourceSheet(idv),
        github: githubSheet,
        telegram: telegramSheet,
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
        'auto-sort': () => autoSortRun(false),
        'quick-sort': () => quickSortSheet(),
        'check-cert': () => checkCert(idv, el),
        'default-cert': () => makeDefault(idv),
        'rename-cert': () => renameCert(idv),
        'delete-cert': () => deleteCert(idv),
        'new-invite': newInviteSheet,
        invite: () => inviteSheet(idv),
        user: () => userSheet(idv),
        bug: () => bugSheet(idv),
        'report-bug': () => reportBugSheet(),
        'whats-new': whatsNewSheet,
        tasks: () => tasksSheet(),
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
  const srcs = (state.sources || []).filter((x) => x.kind !== 'telegram');
  const tgc = (state.sources || []).filter((x) => x.kind === 'telegram');
  const t = state.telegram || {};
  return `<div class="list">
      ${srcs.map((src) => `
        <button class="row" data-act="source" data-id="${src.id}">
          ${iconHtml(src.iconURL || null, src.name)}
          <span class="row-main"><span class="row-title">${esc(src.name)}</span>
            <span class="row-sub">${src.lastError ? `<span style="color:var(--red)">⚠ ${esc(src.lastError)}</span>` : `${src.apps} app${src.apps === 1 ? '' : 's'} · synced ${ago(src.lastSync)}${src.showInLibrary === false ? ' · hidden' : ''}`}</span></span>
          <span class="value muted">›</span>
        </button>`).join('')}
      <button class="row" data-act="add-source"><span class="row-main" style="font-weight:600;color:var(--accent)">＋ Add a source</span><span class="value muted">AltStore / ESign repos</span></button>
      ${isOwner() || t.connected ? `<button class="row" data-act="telegram">
        <span class="row-main"><span class="row-title">✈️ Telegram channels</span>
          <span class="row-sub">${t.connected ? `${tgc.length} channel${tgc.length === 1 ? '' : 's'} · ${tgc.reduce((n, c) => n + (c.apps || 0), 0)} apps${t.error ? ' · ⚠ ' + esc(t.error) : ''}` : 'Pull new .ipa posts from channels automatically'}</span></span>
        <span class="value ${t.connected ? '' : 'muted'}">${t.connected ? '<span class="badge good">On</span>' : 'Off ›'}</span>
      </button>` : ''}
      ${isOwner() ? `<button class="row" data-act="github">
        <span class="row-main"><span class="row-title">GitHub storage</span>
          <span class="row-sub">${g.connected ? `${esc(g.owner)}/${esc(g.repo)} · ${g.apps} app${g.apps === 1 ? '' : 's'}${g.lastError ? ' · ⚠ ' + esc(g.lastError) : ''}` : 'Keep your own IPAs in a private repo instead of here'}</span></span>
        <span class="value ${g.connected ? '' : 'muted'}">${g.connected ? '<span class="badge good">On</span>' : 'Off ›'}</span>
      </button>` : ''}
    </div>
    <p class="hint" style="margin:8px 4px 0">Cloud apps only keep their info and icon here. The file is downloaded while signing and deleted right after, so your Railway volume stays empty.</p>`;
}

// A direct link to one app file (any website, not a GitHub repo page or a source list).
const isIpaLink = (u) => { try { const x = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u); return /\.ipa$/i.test(decodeURIComponent(x.pathname)) && !/\/releases\/download\//.test(x.pathname); } catch { return false; } };
// Adds one app from a direct .ipa link (works from anywhere: Add App, Add Source, or the + button).
async function addIpaLink(url, el) {
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  await runWithProgress(el, async (setProgress) => {
    const { jobId } = await api('POST', '/api/apps/link', { url });
    return waitJob(jobId, (j) => setProgress(j.progress, j.progress != null ? `Reading ${Math.round(j.progress * 100)}%` : (j.log.slice(-1)[0] || 'Reading the app…')));
  }, (app) => { toast(`Added ${app.name}`); editAppSheet(app, true); });
}
function addSourceSheet(prefill = '') {
  const have = new Set((state.sources || []).map((x) => x.url));
  const sugg = SUGGESTED_SOURCES.filter((x) => !have.has(rawGithub(x.url)));
  openSheet(`
    <h2>Add a Source</h2>
    <p class="muted small" style="margin-top:-6px">A source is a list of apps someone keeps up to date (the same kind AltStore, SideStore, ESign and Feather use). Its apps show up in your library as links — nothing is downloaded to your server until someone signs one.</p>
    <div class="field"><label>Source link</label><input type="url" id="srcUrl" placeholder="https://…/source.json or github.com/owner/repo" value="${esc(typeof prefill === 'string' ? prefill : '')}" autocapitalize="off" autocorrect="off"><div class="hint">Works with AltStore-style sources, and with <b>GitHub repos</b>: paste github.com/owner/repo and every release with an .ipa becomes a version, with new releases showing up as updates. A website's <b>downloads page</b> works too (like example.com/downloads): Mango picks up every .ipa link on it and adds new ones as updates. A link straight to one <b>.ipa</b> file adds just that app.</div></div>
    <div class="group">${toggle('srcShow', 'Show its apps to everyone', 'Turn off to keep them just for you until you check them out', true)}</div>
    <button class="btn primary block" id="srcAdd" style="margin-top:12px">Add Source</button>
    ${sugg.length ? `<div class="section-title">Suggested</div><div class="list">${sugg.map((x, i) => `
      <div class="row">${iconHtml(null, x.name)}<div class="row-main"><div class="row-title">${esc(x.name)}</div><div class="row-sub mono small-break">${esc(x.url.replace('https://github.com/', ''))}</div></div><button class="pill" data-sugg="${i}">Add</button></div>`).join('')}</div>` : ''}
    <div id="addProgress"></div>`, (el) => {
    const add = async (url, btn) => {
      if (!url) return toast('Paste a source link first', true);
      // A link to a single .ipa (from any website): add that app as a link instead of as a source.
      if (isIpaLink(url)) return addIpaLink(url, el);
      el.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
      const old = btn.textContent;
      btn.textContent = 'Reading source…';
      try {
        const { source, result, jobId, waitingFor } = await api('POST', '/api/sources', { url, showInLibrary: $('#srcShow', el).checked });
        await refresh();
        if (jobId) {
          // Another check was running: the source is added and its apps come in when it's this one's turn.
          toast(`Added ${source.name}. Its apps come in after ${waitingFor ? waitingFor[0] : 'the current check'} finishes.`);
          return tgRunSheet(`Checking ${source.name}…`, jobId, () => sourceSheet(source.id));
        }
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

// Apps you deleted from this source, which it won't add back. Tap Restore to let it.
function excludedHtml(src) {
  const ex = src.excluded || [];
  if (!ex.length) return '';
  return `<div class="section-title">Deleted from this ${src.kind === 'telegram' ? 'channel' : 'source'} <span class="count">${ex.length}</span></div>
    <p class="hint" style="margin:-4px 4px 8px">These won't come back when it refreshes.</p>
    <div class="list">${ex.map((e, i) => `<div class="row"><div class="row-main"><div class="row-title">${esc(e.name || e.bundleId || 'App')}</div>${e.bundleId ? `<div class="row-sub mono">${esc(e.bundleId)}</div>` : ''}</div><button class="pill" data-restore="${i}">Restore</button></div>`).join('')}</div>`;
}
function bindExcluded(el, src, reopen) {
  el.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api('POST', `/api/sources/${src.id}/restore`, { index: Number(b.dataset.restore) });
        await refresh();
        toast(r.note ? `${r.restored} restored. ${r.note}` : `${r.restored} is back`);
        reopen();
      } catch (e) { b.disabled = false; toast(e.message, true); }
    };
  });
}
function sourceSheet(sid) {
  const src = (state.sources || []).find((x) => x.id === sid);
  if (!src) return toast('Source not found', true);
  if (src.kind === 'telegram') return tgChannelSheet(sid);
  const apps = state.apps.filter((a) => isSrcApp(a) && a.sourceName === src.name);
  const missing = apps.filter((a) => a.missing).length;
  openSheet(`
    <div class="sheet-head">${iconHtml(src.iconURL || null, src.name, true)}<div class="row-main"><h2>${esc(src.name)}</h2><div class="row-sub">${src.kind === 'ghrepo' ? `GitHub · ${esc(src.repo.owner)}/${esc(src.repo.repo)}` : esc(src.subtitle || 'App source')}</div></div></div>
    ${srcTaskHtml(src.id)}
    ${src.lastError ? `<p class="warning bad">Last refresh failed: ${esc(src.lastError)}</p>` : ''}
    <dl class="kv card" style="margin:0">
      <dt>Apps</dt><dd>${src.apps}${missing ? ` <span class="muted small">(+${missing} removed upstream)</span>` : ''}</dd>
      <dt>Last refresh</dt><dd>${src.lastSync ? ago(src.lastSync) : 'never'}</dd>
      <dt>Link</dt><dd class="mono small-break">${esc(src.url)}</dd>
    </dl>
    <p class="hint" style="margin:8px 4px 0">Refreshes by itself every hour${src.kind === 'ghrepo' ? ': each new GitHub release with an .ipa becomes the new version, and older ones stay downloadable' : src.kind === 'webpage' ? ': any new .ipa link on the page becomes the new version, and links it saw before stay as older versions' : ''}. New versions show as UPDATED in the library. Anything you edit on an app (name, category, description…) is kept when it refreshes.</p>
    <div class="group" style="margin-top:12px">${toggle('srcShow', 'Show its apps to everyone', 'Off = only you can see them', src.showInLibrary !== false)}
      ${toggle('srcSkip', 'Skip apps I already have', 'Don\'t add an app that\'s already in your library from somewhere else', src.skipHave === undefined ? src.kind !== 'ghrepo' : !!src.skipHave)}</div>
    <div class="field" style="margin-top:12px"><label>Name in your library</label><input type="text" id="srcName" value="${esc(src.name)}" maxlength="60"></div>
    <div class="actions">
      <button class="btn primary block" id="srcSync">Refresh now</button>
      ${apps.length ? `<button class="btn block" id="srcBrowse">See its ${apps.length} app${apps.length === 1 ? '' : 's'} in the library</button>` : ''}
      ${missing ? `<button class="btn block danger" id="srcDelMissing">🗑 Delete ${missing} removed app${missing === 1 ? '' : 's'}</button>` : ''}
      <button class="btn block" id="srcSave">Save name</button>
      <button class="btn block danger" id="srcDel">Remove source</button>
    </div>
    ${excludedHtml(src)}`, (el) => {
    bindExcluded(el, src, () => sourceSheet(sid));
    if ($('#srcDelMissing', el)) $('#srcDelMissing', el).onclick = () => deleteRemovedApps(sid, missing);
    $('#srcSkip', el).onchange = async (e) => {
      try { await api('PATCH', `/api/sources/${sid}`, { skipHave: e.target.checked }); await refresh(); toast(e.target.checked ? 'Apps you already have are skipped' : 'It adds every app, even ones you have'); } catch (err) { toast(err.message, true); }
    };
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
        const r = await api('POST', `/api/sources/${sid}/sync`);
        if (r.waitingFor) toast(`Waiting for ${r.waitingFor[0]} to finish first — it starts right after`);
        tgRunSheet(`Checking ${src.name}…`, r.jobId, () => sourceSheet(sid));
      } catch (err) { await refresh().catch(() => {}); toast(err.message, true); sourceSheet(sid); }
    };
    if ($('#srcBrowse', el)) $('#srcBrowse', el).onclick = () => { closeSheet(); state.lib.cat = `src:${src.name}`; state.lib.q = ''; switchTab('library'); };
    $('#srcDel', el).onclick = async () => {
      if (!confirm(`Remove ${src.name}? Its ${apps.length} app${apps.length === 1 ? '' : 's'} leave the library. People who installed them keep them.`)) return;
      try { await api('DELETE', `/api/sources/${sid}`); closeSheet(); toast('Source removed'); await refresh(); } catch (e) { toast(e.message, true); }
    };
  });
}

// ---------- Telegram channels ----------
function telegramSheet(step) {
  const t = state.telegram || {};
  if (!t.connected) {
    const pending = step || t.pending;
    if (pending === 'code' || pending === 'password') {
      const pw = pending === 'password';
      openSheet(`
        <h2>✈️ ${pw ? 'Two-step password' : 'Enter the code'}</h2>
        <p class="muted small" style="margin-top:-6px">${pw ? 'Your Telegram account has a two-step verification password. Enter it to finish.' : 'Telegram just sent a login code to your Telegram app (check the chat named "Telegram"), or by text.'}</p>
        <div class="field"><input type="${pw ? 'password' : 'text'}" id="tgVal" ${pw ? 'autocomplete="current-password"' : 'inputmode="numeric" autocomplete="one-time-code" maxlength="8"'} placeholder="${pw ? 'Password' : '12345'}"></div>
        <button class="btn primary big block" id="tgGo">${pw ? 'Finish' : 'Sign in'}</button>
        <button class="link-btn block" id="tgBack" type="button">Start over</button>`, (el) => {
        $('#tgBack', el).onclick = async () => { await api('DELETE', '/api/telegram').catch(() => {}); await refresh(); telegramSheet('start'); };
        $('#tgGo', el).onclick = async (e) => {
          const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
          try {
            const r = await api('POST', pw ? '/api/telegram/password' : '/api/telegram/code', pw ? { password: $('#tgVal', el).value } : { code: $('#tgVal', el).value });
            await refresh();
            if (r.needPassword) return telegramSheet('password');
            toast('Telegram connected ✈️');
            telegramSheet();
          } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = pw ? 'Finish' : 'Sign in'; }
        };
        setTimeout(() => $('#tgVal', el).focus(), 350);
      });
      return;
    }
    openSheet(`
      <h2>✈️ Telegram channels</h2>
      <p class="muted small" style="margin-top:-6px">Mango signs in to Telegram as you and watches channels you pick. When a channel posts an .ipa, it's added to your library (or updates the app that's already there). Only you sign in — everyone else just sees the apps.</p>
      <ol class="gh-steps">
        <li>On your iPhone, open <b>my.telegram.org</b> in Safari and log in with your Telegram phone number (the code arrives in Telegram).</li>
        <li>Tap <b>API development tools</b>. Fill in any app title and short name (e.g. <span class="mono">Mango</span> / <span class="mono">mangosigner</span>), pick any platform, and tap <b>Create application</b>.</li>
        <li>Copy the <b>App api_id</b> (a number) and <b>App api_hash</b> (32 letters and numbers) into the boxes below.</li>
      </ol>
      <div class="field"><label>API ID</label><input type="text" id="tgId" inputmode="numeric" placeholder="1234567" autocomplete="off"></div>
      <div class="field"><label>API hash</label><input type="text" id="tgHash" placeholder="0123456789abcdef…" autocapitalize="off" autocorrect="off" autocomplete="off"></div>
      <div class="field"><label>Your Telegram phone number</label><input type="tel" id="tgPhone" placeholder="+1 555 123 4567" autocomplete="tel"><div class="hint">With the country code. A spare Telegram account works too, and keeps your main one safer.</div></div>
      <button class="btn primary big block" id="tgSend">Send login code</button>
      <p class="hint" style="margin-top:10px">Your login is stored encrypted on your server. Telegram will show "Mango Signer" under Settings › Devices, and you can end it there any time.</p>`, (el) => {
      $('#tgSend', el).onclick = async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Sending…';
        try {
          await api('POST', '/api/telegram/login', { apiId: $('#tgId', el).value, apiHash: $('#tgHash', el).value, phone: $('#tgPhone', el).value });
          await refresh();
          telegramSheet('code');
        } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Send login code'; }
      };
    });
    return;
  }
  const chans = (state.sources || []).filter((x) => x.kind === 'telegram');
  openSheet(`
    <h2>✈️ Telegram channels</h2>
    ${t.error ? `<p class="warning bad">${esc(t.error)}</p>` : ''}
    <div class="card sub-card"><div class="row-main"><div class="row-title">Signed in as ${esc((t.me && t.me.name) || 'you')} <span class="badge good">Connected</span></div>
      <div class="row-sub">${esc([t.me && t.me.username ? '@' + t.me.username : '', t.me && t.me.phone].filter(Boolean).join(' · '))}</div></div></div>
    ${chans.length ? `<div class="list">${chans.map((c) => `
      <button class="row" data-ch="${c.id}"><span class="app-icon tw-icon">✈️</span>
        <span class="row-main"><span class="row-title">${esc(c.name)}</span>
        <span class="row-sub">${c.lastError ? `<span style="color:var(--red)">⚠ ${esc(c.lastError)}</span>` : `${c.apps} app${c.apps === 1 ? '' : 's'} · ${c.lastSync ? 'checked ' + ago(c.lastSync) : 'not checked yet'}${c.options && c.options.storage === 'github' ? ' · GitHub copies' : ''}`}</span></span>
        <span class="value muted">›</span></button>`).join('')}</div>` : ''}
    <button class="file-btn" id="tgAdd" style="margin-top:12px">${ICONS.plus}<div class="row-main"><div class="row-title">Add a channel</div><div class="row-sub">Its @username or t.me link</div></div></button>
    <p class="hint" style="margin:10px 4px 0">Channels, GitHub repos and sources are checked every hour, one at a time. Only posts with an .ipa file are looked at.</p>
    <div class="actions"><button class="btn block danger" id="tgOff">Disconnect Telegram</button></div>`, (el) => {
    el.querySelectorAll('[data-ch]').forEach((b) => { b.onclick = () => tgChannelSheet(b.dataset.ch); });
    $('#tgAdd', el).onclick = () => tgChannelSheet(null);
    $('#tgOff', el).onclick = async () => {
      if (!confirm('Disconnect Telegram? Mango signs out of your account. Apps from channels stay listed but can\'t be signed until you connect again (unless they were copied to GitHub).')) return;
      try { await api('DELETE', '/api/telegram'); await refresh(); toast('Disconnected'); closeSheet(); } catch (e) { toast(e.message, true); }
    };
  });
}

function tgOptionsHtml(o = {}, src = {}) {
  const gh = state.github && state.github.connected;
  return `
    <div class="field"><label>Where the files live</label>
      <select id="tcStore">
        <option value="telegram" ${o.storage !== 'github' ? 'selected' : ''}>On Telegram (link only, uses no storage)</option>
        <option value="github" ${o.storage === 'github' ? 'selected' : ''} ${gh ? '' : 'disabled'}>Copy to my GitHub storage${gh ? '' : ' (connect GitHub first)'}</option>
      </select>
      <div class="hint">Link only is fastest to set up. A GitHub copy keeps working even if the channel deletes the post.</div></div>
    <div class="group">
      ${toggle('tcSkip', 'Skip apps I already have', 'Don\'t add an app that\'s already in your library from another channel, repo or upload', o.skipHave !== false)}
      ${toggle('tcMine', 'Update apps I added myself', 'If the channel posts a newer version of an app you uploaded, replace yours with it', !!o.updateMine)}
      ${toggle('tcName', 'Also match by app name', 'For channels that change the bundle ID between builds', !!o.matchName)}
      ${toggle('tcNotes', 'Use the post\'s text as “What\'s new”', 'Promo lines (Tap Here, links, @mentions) are left out', o.captionNotes !== false)}
      ${toggle('tcAuto', 'Check automatically', 'Every hour', o.autoSync !== false)}
      ${toggle('tcShow', 'Show its apps to everyone', 'Off = only you can see them until you turn it on', src.showInLibrary !== false)}
    </div>
    <div class="field" style="margin-top:12px"><label>Only import posts that mention</label><input type="text" id="tcWords" value="${esc(o.keywords || '')}" placeholder="Optional, e.g. mortal kombat, youtube" autocapitalize="off"><div class="hint">Comma-separated. Leave empty to import every .ipa.</div></div>
    <div class="field"><label>Category for new apps</label>
      <select id="tcCat">
        <option value="__auto" ${!src.categoryId || src.categoryId === '__auto' ? 'selected' : ''}>✨ Automatic (your rules, then the App Store)</option>
        <option value="__none" ${src.categoryId === '__none' ? 'selected' : ''}>Uncategorized</option>
        ${state.categories.map((c) => `<option value="${c.id}" ${c.id === src.categoryId ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)}</option>`).join('')}
      </select></div>`;
}
const readTgOptions = (el) => ({
  storage: $('#tcStore', el).value, updateMine: $('#tcMine', el).checked, matchName: $('#tcName', el).checked,
  captionNotes: $('#tcNotes', el).checked, autoSync: $('#tcAuto', el).checked, skipHave: $('#tcSkip', el).checked, keywords: $('#tcWords', el).value,
});

function tgRunSheet(title, jobId, back) {
  closeSheet.locked = true;
  $('#sheet').classList.add('locked');
  openSheet(`<div class="progress-wrap"><div class="spinner"></div><h2 id="trTitle" style="margin:0 0 4px">${esc(title)}</h2><p class="muted small" id="trSub">This can take a while for big files</p><p class="muted small" id="trCount"></p><div class="bar hidden" id="trBar"><div></div></div><div class="log" id="trLog"></div>${cancelBtnHtml('Stop')}
    <button class="btn block" id="trBg" type="button" style="margin-top:8px">Keep going in the background</button>
    <p class="hint center">It runs on your server, so you can leave the app or lock your phone. Check on it from the ⏳ button.</p></div>`);
  $('#trBg', $('#sheetBody')).onclick = () => { closeSheet.locked = false; $('#sheet').classList.remove('locked'); tgRunSheet.detached = jobId; closeSheet(); pollTasks(true); };
  const body = $('#sheetBody');
  tgRunSheet.detached = null;
  waitJob(jobId, (j) => {
    if (tgRunSheet.detached === jobId || !document.body.contains(body) || !$('#trLog', body)) return;
    if (j.counter) $('#trCount', body).textContent = `${j.counter.done.toLocaleString()}${j.counter.total ? ' / ' + j.counter.total.toLocaleString() : ''} ${j.counter.label}`;
    const log = $('#trLog', body);
    log.textContent = j.log.join('\n'); log.scrollTop = log.scrollHeight;
    // Waiting in line behind another check.
    if (j.status === 'queued') { $('#trTitle', body).textContent = 'Waiting its turn…'; $('#trSub', body).textContent = `${j.waitingFor ? `Starts after ${j.waitingFor}` : 'Starts in a moment'}${j.position > 1 ? ` · #${j.position} in line` : ''}. Only one channel, repo or source is checked at a time.`; }
    else if (j.status === 'running' && $('#trTitle', body).textContent === 'Waiting its turn…') { $('#trTitle', body).textContent = title; $('#trSub', body).textContent = 'This can take a while for big files'; }
    if (j.progress != null) { $('#trBar', body).classList.remove('hidden'); $('#trBar > div', body).style.width = `${Math.round(j.progress * 100)}%`; } else $('#trBar', body).classList.add('hidden');
  }).then(async (r) => {
    if (tgRunSheet.detached === jobId) return refresh().catch(() => {});
    closeSheet.locked = false; $('#sheet').classList.remove('locked');
    await refresh().catch(() => {});
    const bits = [r.added && `${r.added} new`, r.updated && `${r.updated} updated`, (r.same || r.known) && `${(r.same || 0) + (r.known || 0)} already had`, r.older && `${r.older} older skipped`, r.removed && `${r.removed} removed`, r.failed && `${r.failed} failed`].filter(Boolean);
    toast(bits.length ? bits.join(' · ') : 'Nothing new', !!r.failed && !r.added && !r.updated);
    back();
  }).catch(async (e) => {
    if (tgRunSheet.detached === jobId) return refresh().catch(() => {});
    closeSheet.locked = false; $('#sheet').classList.remove('locked');
    await refresh().catch(() => {});
    if (e.cancelled) { toast('Stopped. Apps that finished importing were kept.'); return back(); }
    toast(e.message, true);
    back();
  });
}

// Go further back in a channel's history than the first import did. Nothing you already have is removed.
function tgScanSheet(src) {
  const sizes = [[25, 'Last 25 .ipa posts'], [50, 'Last 50'], [100, 'Last 100'], [250, 'Last 250'], [500, 'Last 500'], [1000, 'Last 1,000'], [0, 'Everything (the whole channel)']];
  openSheet(`
    <h2>🔍 Scan older posts</h2>
    <p class="muted small" style="margin-top:-6px">Looks back through ${esc(src.name)}'s history for .ipa files and adds any apps you don't have yet. Apps already in your library stay exactly as they are, and an older post never replaces a newer version.</p>
    <div class="field"><label>How far back</label>
      <select id="dsCount">${sizes.map(([n, l]) => `<option value="${n}" ${n === 100 ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="hint">${src.deepest ? `Last deep scan went back ${src.deepest} posts. ` : ''}Bigger scans take longer, and you can stop any time. Apps found so far are kept.</div></div>
    <div class="group">
      ${toggle('dsQuick', 'Quick mode', 'Skips older reposts of the same app by file name, without opening them. Much faster on big channels.', true)}
      ${toggle('dsRecheck', 'Re-check posts already checked', 'Off = posts looked at in an earlier scan are skipped instantly', false)}
    </div>
    ${src.options && src.options.keywords ? `<p class="hint">Only posts that mention: ${esc(src.options.keywords)} (change this in the channel's settings).</p>` : ''}
    ${src.options && src.options.storage === 'github' ? '<p class="warning">This channel copies files to GitHub, so a big scan can take a long time. Switch it to "On Telegram" in the channel settings first if you want it fast.</p>' : ''}
    <button class="btn primary big block" id="dsGo">Start scanning</button>
    <button class="link-btn block" id="dsBack" type="button">Back</button>`, (el) => {
    $('#dsBack', el).onclick = () => tgChannelSheet(src.id);
    $('#dsGo', el).onclick = async () => {
      try {
        const { jobId, waitingFor } = await api('POST', `/api/sources/${src.id}/scan`, { count: Number($('#dsCount', el).value), quick: $('#dsQuick', el).checked, recheck: $('#dsRecheck', el).checked });
        if (waitingFor) toast(`Waiting for ${waitingFor[0]} to finish first — it starts right after`);
        tgRunSheet(`Scanning ${src.name}…`, jobId, () => tgChannelSheet(src.id));
      } catch (e) { toast(e.message, true); }
    };
  });
}

function tgChannelSheet(sid) {
  const src = sid ? (state.sources || []).find((x) => x.id === sid) : null;
  if (!src) {
    openSheet(`
      <h2>Add a Telegram channel</h2>
      <div class="field"><label>Channel</label><input type="text" id="tcRef" placeholder="@channelname or https://t.me/channelname" autocapitalize="off" autocorrect="off"><div class="hint">Public channels work right away. For a private one, join it in Telegram first and use its @username.</div></div>
      <div class="field"><label>Import recent posts</label>
        <select id="tcBack">${[[0, 'None — only new posts from now on'], [5, 'Last 5 .ipa posts'], [10, 'Last 10'], [25, 'Last 25'], [50, 'Last 50']].map(([n, l]) => `<option value="${n}" ${n === 10 ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="hint">If the same app was posted several times, only its newest version is kept.</div></div>
      ${tgOptionsHtml({}, {})}
      <button class="btn primary big block" id="tcAdd" style="margin-top:12px">Add channel</button>`, (el) => {
      $('#tcAdd', el).onclick = async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Finding the channel…';
        try {
          const { jobId } = await api('POST', '/api/telegram/channels', {
            ref: $('#tcRef', el).value, showInLibrary: $('#tcShow', el).checked, categoryId: $('#tcCat', el).value || null,
            options: { ...readTgOptions(el), backfill: Number($('#tcBack', el).value) },
          });
          await refresh();
          tgRunSheet('Importing…', jobId, telegramSheet);
        } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Add channel'; }
      };
    });
    return;
  }
  const apps = state.apps.filter((a) => a.cloud === 'telegram' && a.sourceName === src.name);
  const r = src.lastResult;
  const tcMissing = apps.filter((a) => a.missing).length;
  openSheet(`
    <div class="sheet-head"><span class="app-icon big tw-icon">✈️</span><div class="row-main"><h2>${esc(src.name)}</h2><div class="row-sub">${src.username ? '@' + esc(src.username) : 'Telegram channel'}</div></div></div>
    ${srcTaskHtml(src.id)}
    ${src.lastError ? `<p class="warning bad">Last check failed: ${esc(src.lastError)}</p>` : ''}
    <dl class="kv card" style="margin:0">
      <dt>Apps</dt><dd>${src.apps}</dd>
      <dt>Last check</dt><dd>${src.lastSync ? ago(src.lastSync) : 'never'}</dd>
      ${r ? `<dt>Last result</dt><dd>${esc([`${r.added} new`, `${r.updated} updated`, r.same ? `${r.same} already had` : '', r.failed ? `${r.failed} failed` : ''].filter(Boolean).join(' · '))}</dd>` : ''}
    </dl>
    <div class="actions">
      <button class="btn primary block" id="tcSync">Check for new posts now</button>
      ${apps.length ? `<button class="btn block" id="tcBrowse">See its ${apps.length} app${apps.length === 1 ? '' : 's'}</button>` : ''}
      ${tcMissing ? `<button class="btn block danger" id="tcDelMissing">🗑 Delete ${tcMissing} removed app${tcMissing === 1 ? '' : 's'}</button>` : ''}
    </div>
    <div class="section-title">Settings</div>
    ${tgOptionsHtml(src.options || {}, src)}
    <div class="field"><label>Name in your library</label><input type="text" id="tcNameIn" value="${esc(src.name)}" maxlength="60"></div>
    <div class="actions">
      <button class="btn primary block" id="tcSave">Save settings</button>
      <button class="btn block" id="tcDeep">🔍 Scan older posts</button>
      <button class="btn block" id="tcBackBtn">Back</button>
      <button class="btn block danger" id="tcDel">Remove channel</button>
    </div>
    ${excludedHtml(src)}`, (el) => {
    bindExcluded(el, src, () => tgChannelSheet(sid));
    $('#tcBackBtn', el).onclick = () => telegramSheet();
    $('#tcSync', el).onclick = async () => {
      try {
        const { jobId, waitingFor } = await api('POST', `/api/sources/${src.id}/sync`);
        if (waitingFor) toast(`Waiting for ${waitingFor[0]} to finish first — it starts right after`);
        tgRunSheet(`Checking ${src.name}…`, jobId, () => tgChannelSheet(src.id));
      } catch (e) { toast(e.message, true); }
    };
    if ($('#tcDelMissing', el)) $('#tcDelMissing', el).onclick = () => deleteRemovedApps(sid, tcMissing);
    $('#tcDeep', el).onclick = () => tgScanSheet(src);
    if ($('#tcBrowse', el)) $('#tcBrowse', el).onclick = () => { closeSheet(); state.lib.cat = `src:${src.name}`; state.lib.q = ''; switchTab('library'); };
    $('#tcSave', el).onclick = async () => {
      try {
        await api('PATCH', `/api/sources/${src.id}`, { name: $('#tcNameIn', el).value, showInLibrary: $('#tcShow', el).checked, categoryId: $('#tcCat', el).value || null, options: readTgOptions(el) });
        await refresh(); toast('Saved'); tgChannelSheet(src.id);
      } catch (e) { toast(e.message, true); }
    };
    $('#tcDel', el).onclick = async () => {
      if (!confirm(`Remove ${src.name}? Its ${apps.length} app${apps.length === 1 ? '' : 's'} leave the library. People who installed them keep them.`)) return;
      try { await api('DELETE', `/api/sources/${src.id}`); await refresh(); toast('Channel removed'); telegramSheet(); } catch (e) { toast(e.message, true); }
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
    <div class="group" style="margin-top:12px">${toggle('ghSigned', 'Keep signed apps on GitHub', g.private ? `Signed apps stay in everyone's Signed tab until they delete them, without using space here${g.signedSaved ? ` · ${g.signedSaved} saved` : ''}` : 'Needs a private repo — anyone could download signed apps from a public one', g.signedToGithub)}</div>
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
    $('#ghSigned', el).onchange = async (e) => {
      try {
        state.github = (await api('PATCH', '/api/github', { signedToGithub: e.target.checked })).github;
        toast(e.target.checked ? 'Signed apps are saved to GitHub' : 'Signed apps stay on this server only');
      } catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); }
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

// ---------- favorites, alerts & security ----------
const isFav = (a) => state.favorites.includes(a.id);

// A heads-up at the top of the library when your default certificate is about to stop working.
function certBanner() {
  const c = state.certs.find((x) => x.isDefault) || state.certs[0];
  if (!c) return '';
  const left = daysLeft(certExpiry(c));
  if (c.check && c.check.status === 'revoked') return `<p class="warning bad" data-act="go-certs" style="margin:0 0 12px;cursor:pointer">🚫 ${esc(c.label)} was revoked, so apps signed with it won't open. Add a new certificate →</p>`;
  if (left !== null && left < 0) return `<p class="warning bad" data-act="go-certs" style="margin:0 0 12px;cursor:pointer">⚠️ ${esc(c.label)} has expired. Add a new certificate →</p>`;
  if (left !== null && left <= 7) return `<p class="warning" data-act="go-certs" style="margin:0 0 12px;cursor:pointer">⏳ ${esc(c.label)} expires ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`}. Apps signed with it stop opening then →</p>`;
  return '';
}

const ALERT_ICONS = { signed: '✅', bug: '🐞', broadcast: '📣', update: '⬆️', request: '🙋', cert: '🔐', security: '🔒', user: '👋', storage: '💾' };
function alertsSheet() {
  const list = state.alerts;
  const unreadIds = list.filter((a) => !a.read).map((a) => a.id);
  openSheet(`
    <h2>🔔 Alerts</h2>
    ${list.length ? `<div class="list">${list.map((a) => `
      <button class="row alert-row ${a.read ? '' : 'unread'}" data-alert="${a.id}">
        <span class="alert-ic">${ALERT_ICONS[a.kind] || '🔔'}</span>
        <span class="row-main"><span class="row-title">${esc(a.title.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''))}</span>${a.body ? `<span class="row-sub">${esc(a.body)}</span>` : ''}<span class="row-sub muted small">${ago(a.at)}</span></span>
      </button>`).join('')}</div>
      <button class="btn block" id="alClear" style="margin-top:12px">Clear all</button>` : '<div class="empty" style="padding:30px 10px"><h3>No alerts</h3><p>Updates to apps you installed, answers to your requests and certificate warnings show up here.</p></div>'}`, (el) => {
    el.querySelectorAll('[data-alert]').forEach((b) => {
      b.onclick = () => {
        const a = list.find((x) => x.id === b.dataset.alert);
        if (a.kind === 'update' && a.appId && state.apps.some((x) => x.id === a.appId)) return appSheet(a.appId);
        if (a.kind === 'request' && a.appId && state.apps.some((x) => x.id === a.appId)) return appSheet(a.appId);
        if (a.kind === 'request' && a.requestId && (state.requests || []).some((r) => r.id === a.requestId)) return requestSheet(a.requestId);
        if (a.kind === 'cert') { closeSheet(); return switchTab('certs'); }
        if (a.kind === 'user' && a.userId && state.users.some((u) => u.id === a.userId)) return userSheet(a.userId);
        if (a.kind === 'security' && isStaff()) return securityLogSheet();
        if (a.kind === 'signed' && a.signedId && state.signed.some((x) => x.id === a.signedId)) return signedSheet(a.signedId);
        if (a.kind === 'signed' && a.appId && state.apps.some((x) => x.id === a.appId)) return appSheet(a.appId);
        if (a.kind === 'bug' && a.bugId && (state.bugs || []).some((x) => x.id === a.bugId)) return bugSheet(a.bugId);
        if (a.kind === 'storage') { closeSheet(); return switchTab('settings'); }
      };
    });
    if ($('#alClear', el)) {
      $('#alClear', el).onclick = async () => {
        try { await api('DELETE', '/api/alerts'); state.alerts = []; closeSheet(); render(); toast('Cleared'); } catch (e) { toast(e.message, true); }
      };
    }
  });
  if (unreadIds.length) {
    api('POST', '/api/alerts/read', { ids: unreadIds }).then(() => {
      for (const a of state.alerts) if (unreadIds.includes(a.id)) a.read = true;
      render();
    }).catch(() => {});
  }
}

const SIGNIN_LABEL = { login: 'Signed in', 'login-udid': 'Signed in with iPhone', 'signout-all': 'Signed out other devices', signup: 'Joined', locked: 'Locked', 'cert-download': 'Certificate sent to the iPhone app' };
function signinRow(e) {
  return `<div class="row"><span class="alert-ic">${e.ok ? (e.type === 'signout-all' ? '🚪' : '✅') : '⛔'}</span>
    <div class="row-main"><div class="row-title">${esc(e.ok ? SIGNIN_LABEL[e.type] || e.type : e.type === 'locked' ? 'Locked after wrong passwords' : 'Wrong password')}</div>
      <div class="row-sub">${esc(e.device || '')}${e.ip ? ' · ' + esc(e.ip) : ''}</div><div class="row-sub muted small">${ago(e.at)}${e.detail && e.ok ? ' · ' + esc(e.detail) : ''}</div></div></div>`;
}
function mySecuritySheet() {
  openSheet(`
    <h2>🛡 Sign-ins &amp; security</h2>
    <p class="muted small" style="margin-top:-6px">Recent sign-ins to your account. If you see one that wasn't you, sign out everywhere and ${isOwner() ? 'change APP_PASSWORD on Railway' : 'change your password'}.</p>
    ${state.mySignins.length ? `<div class="list">${state.mySignins.map(signinRow).join('')}</div>` : '<p class="hint">No sign-ins recorded yet.</p>'}
    <div class="actions" style="margin-top:12px">
      <button class="btn block" id="msOut">Sign out everywhere else</button>
      ${!isOwner() ? '<button class="btn block" id="msPw">Change Password</button>' : ''}
    </div>
    <p class="hint" style="margin:8px 4px 0">Signing out everywhere else keeps you signed in here. Accounts lock for 15 minutes after ${8} wrong passwords in a row.</p>`, (el) => {
    $('#msOut', el).onclick = async () => {
      if (!confirm('Sign out every other phone and browser?')) return;
      try { await api('POST', '/api/account/signout-others'); toast('Signed out everywhere else'); await refresh(); mySecuritySheet(); } catch (e) { toast(e.message, true); }
    };
    if ($('#msPw', el)) $('#msPw', el).onclick = changePasswordSheet;
  });
}
function securityLogSheet() {
  const log = state.securityLog;
  const failsToday = log.filter((e) => !e.ok && Date.now() - new Date(e.at) < 864e5);
  openSheet(`
    <h2>🛡 Security log</h2>
    <p class="muted small" style="margin-top:-6px">Every sign-in, wrong password, lockout and new account, newest first.${failsToday.length ? ` <b style="color:var(--red)">${failsToday.length} failed in the last day.</b>` : ''}</p>
    ${log.length ? `<div class="list">${log.slice(0, 120).map((e) => `
      <div class="row"><span class="alert-ic">${e.ok ? (e.type === 'signup' ? '👋' : e.type === 'signout-all' ? '🚪' : '✅') : '⛔'}</span>
        <div class="row-main"><div class="row-title">${esc(e.user)} <span class="muted small">${esc(e.ok ? SIGNIN_LABEL[e.type] || e.type : e.type === 'locked' ? 'locked' : 'failed')}</span></div>
          <div class="row-sub">${esc(e.device || '')}${e.ip ? ' · ' + esc(e.ip) : ''}</div>
          <div class="row-sub muted small">${ago(e.at)}${e.detail ? ' · ' + esc(e.detail) : ''}</div></div></div>`).join('')}</div>
      <button class="btn block" id="slClear" style="margin-top:12px">Clear log</button>` : '<p class="hint">Nothing yet.</p>'}`, (el) => {
    if ($('#slClear', el)) {
      $('#slClear', el).onclick = async () => {
        if (!confirm('Clear the security log?')) return;
        try { await api('DELETE', '/api/security-log'); await refresh(); securityLogSheet(); } catch (e) { toast(e.message, true); }
      };
    }
  });
}

// ---------- owner tools ----------
function barChart(days, series) {
  const W = 340, H = 120, n = days.length, bw = W / n;
  const max = Math.max(1, ...days.map((_, i) => series.reduce((t, s) => t + s.values[i], 0)));
  let bars = '';
  days.forEach((d, i) => {
    let y = H;
    for (const s of series) {
      const h = (s.values[i] / max) * (H - 4);
      if (h > 0) { y -= h; bars += `<rect x="${(i * bw + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.color}"><title>${d}: ${s.values[i]} ${s.name}</title></rect>`; }
    }
  });
  return `<svg viewBox="0 0 ${W} ${H + 16}" class="chart" role="img" aria-label="Last 30 days">
    <line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--line)"/>${bars}
    <text x="0" y="${H + 13}" class="chart-lbl">${days[0].slice(5)}</text><text x="${W}" y="${H + 13}" text-anchor="end" class="chart-lbl">today</text>
    <text x="0" y="10" class="chart-lbl">${max}</text></svg>
    <div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.name} ${s.values.reduce((a, b) => a + b, 0)}</span>`).join('')}</div>`;
}
async function statsSheet() {
  let st;
  try { st = await api('GET', '/api/stats'); } catch (e) { return toast(e.message, true); }
  const t = st.totals;
  const ACT = { install: '📲', sign: '✍️', user: '👋', request: '🙋' };
  openSheet(`
    <h2>📊 Stats &amp; activity</h2>
    <div class="stat-grid">
      <div><b>${t.users}</b><span>users</span></div>
      <div><b>${t.activeUsers7d}</b><span>active this week</span></div>
      <div><b>${t.installs30d}</b><span>installs (30d)</span></div>
      <div><b>${t.signs30d}</b><span>signs (30d)</span></div>
      <div><b>${t.apps}</b><span>apps · ${t.cloudApps} cloud</span></div>
      <div><b>${t.installsAll}</b><span>installs all time</span></div>
    </div>
    <div class="section-title">Last 30 days</div>
    <div class="card">${barChart(st.days, [{ name: 'installs', values: st.installs, color: 'var(--mango)' }, { name: 'signs', values: st.signs, color: '#5aa0ff' }, { name: 'new users', values: st.signups, color: 'var(--leaf)' }])}</div>
    ${st.topApps.length ? `<div class="section-title">Most installed (30 days)</div><div class="list">${st.topApps.map((x, i) => {
      const a = state.apps.find((y) => y.id === x.appId);
      return `<button class="row" ${a ? `data-open="${a.id}"` : ''}><span class="rank">${i + 1}</span>${a ? appIcon(a) : ''}<span class="row-main"><span class="row-title">${esc(x.name)}</span></span><span class="value">${x.count}</span></button>`;
    }).join('')}</div>` : ''}
    <div class="section-title">Recent activity</div>
    ${st.activity.length ? `<div class="list">${st.activity.map((x) => `<div class="row"><span class="alert-ic">${ACT[x.kind] || '•'}</span><div class="row-main"><div class="row-title" style="font-weight:500">${esc(x.text)}</div><div class="row-sub muted small">${ago(x.at)}</div></div></div>`).join('')}</div>` : '<p class="hint">Nothing yet.</p>'}`, (el) => {
    el.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => appSheet(b.dataset.open); });
  });
}
function broadcastSheet() {
  const n = state.users.filter((u) => !u.disabled).length;
  openSheet(`
    <h2>📣 Message everyone</h2>
    <p class="muted small" style="margin-top:-6px">Sends a 🔔 alert to all ${n} user${n === 1 ? '' : 's'}. For a banner everyone sees at the top of the app, use 📣 Announcement in Settings › Library instead.</p>
    <div class="field"><label>Title</label><input type="text" id="bcTitle" maxlength="100" placeholder="e.g. New certificate next week"></div>
    <div class="field"><label>Message</label><textarea id="bcBody" rows="4" maxlength="400" placeholder="Optional details"></textarea></div>
    <button class="btn primary big block" id="bcSend">Send to ${n} user${n === 1 ? '' : 's'}</button>`, (el) => {
    $('#bcSend', el).onclick = async () => {
      try { const { sent } = await api('POST', '/api/broadcast', { title: $('#bcTitle', el).value, body: $('#bcBody', el).value }); closeSheet(); toast(`Sent to ${sent} user${sent === 1 ? '' : 's'}`); } catch (e) { toast(e.message, true); }
    };
  });
}
function backupSheet() {
  const onServer = state.apps.filter((a) => !a.cloud).length;
  openSheet(`
    <h2>💾 Backup &amp; restore</h2>
    <p class="muted small" style="margin-top:-6px">A backup is one .zip with your settings, users, library details, categories, collections, certificates, tweaks and icons. Keep it somewhere private — it has everyone's certificates in it.</p>
    ${onServer ? `<p class="warning">${onServer} app${onServer === 1 ? ' is' : 's are'} stored on this server. Their .ipa files aren't included (they're too big) — move them to GitHub storage first if you want them safe.</p>` : ''}
    <a class="btn primary big block" id="bkGet" href="/api/backup" download>Download backup</a>
    <div class="section-title">Restore</div>
    <p class="hint" style="margin:0 4px 10px">Replaces everything on this server with the backup, then restarts (about 30 seconds). Use it to move to a new Railway project or undo a mistake.</p>
    <button class="btn block danger" id="bkRestore">Restore from a backup…</button>
    <div id="addProgress"></div>`, (el) => {
    $('#bkGet', el).onclick = () => { api('PATCH', '/api/settings', { lastBackup: true }).then((d) => { state.settings = d.settings; }).catch(() => {}); toast('Downloading backup…'); };
    $('#bkRestore', el).onclick = async () => {
      const f = await pickFile('');
      if (!f) return;
      if (!/\.zip$/i.test(f.name)) return toast('Pick a Mango backup .zip', true);
      if (!confirm('Replace everything on this server with this backup? This can\'t be undone.')) return;
      const box = $('#addProgress', el);
      box.innerHTML = '<p class="muted small center">Uploading…</p>';
      try {
        const up = await uploadFile(f);
        box.innerHTML = '<p class="muted small center">Restoring…</p>';
        const r = await api('POST', '/api/restore', { uploadId: up.uploadId });
        box.innerHTML = `<p class="muted small center">Restored ${r.apps} apps and ${r.users} users. Restarting…</p>`;
        setTimeout(() => location.reload(), 9000);
      } catch (e) { box.innerHTML = ''; toast(e.message, true); }
    };
  });
}

// ---------- background tasks ----------
// Scans, checks, imports and signing run on the server. The ⏳ pill shows what's going on, and the
// Activity screen (from the pill or Settings) shows everything: running, waiting in line and just finished.
const ACTIVE = ['running', 'queued'];
const fmtDur = (ms) => { const sec = Math.max(0, Math.round(ms / 1000)); if (sec < 60) return `${sec}s`; const m = Math.floor(sec / 60); if (m < 60) return `${m}m`; return `${Math.floor(m / 60)}h ${m % 60}m`; };
const resultLine = (r) => (r ? [r.added && `${r.added} new`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`, r.failed && `${r.failed} failed`].filter(Boolean).join(' · ') || 'Nothing new' : '');
async function pollTasks(force) {
  clearTimeout(pollTasks.timer);
  pollTasks.timer = null;
  if (!state.account) return;
  if (pollTasks.busy) { pollTasks.timer = setTimeout(() => pollTasks(), 1500); return; }
  pollTasks.busy = true;
  const wasActive = (state.tasks || []).some((j) => ACTIVE.includes(j.status));
  try {
    const d = await api('GET', '/api/jobs');
    state.tasks = d.jobs;
    state.checks = d.checks;
    pollTasks.fails = 0;
  } catch { pollTasks.fails = (pollTasks.fails || 0) + 1; /* offline: keep what we had and try again */ } finally { pollTasks.busy = false; }
  const active = (state.tasks || []).some((j) => ACTIVE.includes(j.status));
  if (wasActive && !active) { pollTasks.doneAt = Date.now(); refresh().catch(() => {}); }
  drawTaskPill();
  // While a scan or check is adding apps, refresh the library now and then so new apps show up.
  if (active && state.tasks.some((j) => j.isCheck && j.status === 'running') && $('#sheet').classList.contains('hidden') && Date.now() - (pollTasks.lastRefresh || 0) > 20000) {
    pollTasks.lastRefresh = Date.now();
    api('GET', '/api/state').then((d) => { Object.assign(state, d); render(); }).catch(() => {});
  }
  const sheetOpen = !!$('#sheetBody .tasks-list');
  // Fast while something runs or the Activity screen is open; slow otherwise (to notice hourly checks).
  const wait = active ? (sheetOpen ? 2500 : 4000) : sheetOpen || force ? 8000 : 60000;
  pollTasks.timer = setTimeout(() => pollTasks(), Math.min(60000, wait * (1 + Math.min(4, pollTasks.fails || 0))));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.account) pollTasks(); });
function drawTaskPill() {
  let pill = $('#taskPill');
  if (!pill) {
    pill = document.createElement('button');
    pill.id = 'taskPill';
    pill.className = 'task-pill hidden';
    pill.onclick = () => tasksSheet();
    document.body.appendChild(pill);
  }
  const active = (state.tasks || []).filter((j) => ACTIVE.includes(j.status));
  const justDone = !active.length && pollTasks.doneAt && Date.now() - pollTasks.doneAt < 6000;
  pill.classList.toggle('hidden', !active.length && !justDone);
  pill.classList.toggle('done', !!justDone);
  if (justDone) {
    const last = (state.tasks || [])[0];
    pill.innerHTML = `<span class="pill-ok">${last && last.status === 'error' ? '⚠️' : '✓'}</span><span>${last && last.status === 'error' ? `${esc(last.title)} failed` : 'All done'}</span>`;
    clearTimeout(drawTaskPill.hide);
    drawTaskPill.hide = setTimeout(drawTaskPill, 6100);
  } else if (active.length) {
    const j = active.find((x) => x.status === 'running') || active[0];
    const pct = j.progress != null ? ` ${Math.round(j.progress * 100)}%` : j.counter ? ` ${j.counter.done.toLocaleString()}${j.counter.total ? '/' + j.counter.total.toLocaleString() : ''}` : '';
    const waiting = active.filter((x) => x.status === 'queued').length;
    pill.innerHTML = `<span class="mini-spin"></span><span>${esc(j.status === 'queued' ? `Waiting: ${j.title}` : j.title)}${pct}${waiting && j.status === 'running' ? ` · ${waiting} waiting` : active.length > 1 ? ` · +${active.length - 1}` : ''}</span>`;
  }
  if ($('#sheetBody .tasks-list')) tasksSheet(true);
}
function taskRowHtml(j) {
  const now = Date.now();
  const badge = { running: 'Running', queued: j.position ? `Waiting · #${j.position}` : 'Waiting', done: 'Done', error: 'Failed', cancelled: 'Stopped' }[j.status] || j.status;
  let sub = '';
  if (j.status === 'running') sub = `${j.counter ? `${j.counter.done.toLocaleString()}${j.counter.total ? ' / ' + j.counter.total.toLocaleString() : ''} ${esc(j.counter.label)} · ` : ''}running ${fmtDur(now - j.started)}`;
  else if (j.status === 'queued') sub = j.waitingFor ? `Starts after ${esc(j.waitingFor)}` : 'Starts in a moment';
  else sub = `${j.status === 'done' && j.result ? esc(resultLine(j.result)) + ' · ' : ''}${j.endedAt ? `${fmtDur(now - j.endedAt)} ago` : ''}`;
  return `<div class="row task-row" data-job="${j.id}">
    <div class="row-main">
      <div class="row-title">${esc(j.title)} <span class="badge ${j.status === 'done' ? 'good' : j.status === 'error' ? 'bad' : j.status === 'running' ? 'mango' : ''}">${badge}</span></div>
      ${j.progress != null && j.status === 'running' ? `<div class="bar" style="margin:6px 0 2px"><div style="width:${Math.round(j.progress * 100)}%"></div></div>` : ''}
      <div class="row-sub">${sub}</div>
      ${j.status === 'error' && j.error ? `<div class="row-sub bad-text">${esc(j.error)}</div>` : j.status === 'running' && j.last ? `<div class="row-sub task-last">${esc(j.last)}</div>` : ''}
    </div>
    ${j.cancellable ? `<button class="pill danger-pill" data-stop="${j.id}">${j.status === 'queued' ? 'Cancel' : 'Stop'}</button>` : '<span class="value muted">›</span>'}
  </div>`;
}
function tasksSheet(redraw) {
  const list = state.tasks || [];
  const run = list.filter((j) => j.status === 'running');
  const wait = list.filter((j) => j.status === 'queued');
  const done = list.filter((j) => !ACTIVE.includes(j.status));
  const c = state.checks;
  const section = (title, items) => (items.length ? `<div class="section-title">${title} <span class="count">${items.length}</span></div><div class="list">${items.map(taskRowHtml).join('')}</div>` : '');
  const html = `
    <h2>⏳ Activity</h2>
    <p class="muted small" style="margin-top:-6px">Everything here runs on your server, so it keeps going even if you close the app. Tap one to see its full log.</p>
    ${c ? `<div class="card act-card">
      <div class="row-main"><div class="row-title">${c.running ? 'Checking for updates now' : 'Update checks'}</div>
        <div class="row-sub">${c.sources} channel${c.sources === 1 ? '' : 's'}, repo${c.sources === 1 ? '' : 's'} &amp; source${c.sources === 1 ? '' : 's'} · one at a time · ${c.running || c.waiting ? `${c.waiting} waiting` : `next automatic check in ${fmtDur(Math.max(0, c.nextAuto - Date.now()))}`}</div></div>
      <div class="card-actions"><button class="btn" id="actAll" ${c.sources ? '' : 'disabled'}>Check all now</button>${run.length + wait.length ? '<button class="btn danger" id="actStop">Stop all</button>' : ''}</div>
    </div>` : ''}
    <div class="tasks-list">
      ${section('Running', run)}${section('Waiting in line', wait)}${section('Finished', done)}
      ${list.length ? '' : '<div class="empty" style="padding:24px 10px"><h3>Nothing going on</h3><p>Checks, scans, imports and signing show up here while they run.</p></div>'}
    </div>`;
  if (redraw === true && $('#sheetBody .tasks-list')) {
    const y = $('#sheetBody').scrollTop;
    $('#sheetBody').innerHTML = html; bindTasks($('#sheetBody')); $('#sheetBody').scrollTop = y;
    return;
  }
  openSheet(html, bindTasks);
  pollTasks(true);
}
function bindTasks(el) {
  el.querySelectorAll('[data-stop]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true; b.textContent = '…';
      try { await api('POST', `/api/jobs/${b.dataset.stop}/cancel`); toast('Stopping…'); } catch (err) { toast(err.message, true); }
      pollTasks(true);
    };
  });
  el.querySelectorAll('[data-job]').forEach((r) => { r.onclick = () => jobLogSheet(r.dataset.job); r.style.cursor = 'pointer'; });
  if ($('#actAll', el)) $('#actAll', el).onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { const { queued } = await api('POST', '/api/checks/run-all'); toast(queued ? `Lined up ${queued} check${queued === 1 ? '' : 's'}` : 'Everything is already being checked'); } catch (err) { toast(err.message, true); }
    pollTasks(true);
  };
  if ($('#actStop', el)) $('#actStop', el).onclick = async () => {
    if (!confirm('Stop everything that\'s running and cancel everything waiting? Apps already added are kept.')) return;
    try { const { stopped } = await api('POST', '/api/jobs/cancel-all'); toast(`Stopped ${stopped}`); } catch (err) { toast(err.message, true); }
    pollTasks(true);
  };
}
// One task's full log, updating live while it runs.
function jobLogSheet(jobId) {
  const draw = (j) => {
    const body = $('#sheetBody');
    if (!body || !$('#jlLog', body)) return false;
    $('#jlStatus', body).innerHTML = taskRowHtml({ ...((state.tasks || []).find((x) => x.id === jobId) || {}), ...j, id: jobId });
    const log = $('#jlLog', body);
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.textContent = (j.log || []).join('\n') || 'No details yet.';
    if (atEnd) log.scrollTop = log.scrollHeight;
    bindTasks($('#jlStatus', body));
    $('#jlStatus .task-row', body).onclick = null;
    return true;
  };
  openSheet(`<h2>Details</h2><div id="jlStatus" class="list"></div><div class="log" id="jlLog" style="margin-top:12px">Loading…</div>
    <button class="btn block" id="jlBack" style="margin-top:12px">Back to Activity</button>`, (el) => { $('#jlBack', el).onclick = () => tasksSheet(); });
  const tick = async () => {
    let j;
    try { j = await api('GET', `/api/jobs/${jobId}`); } catch (e) {
      if (e.status === 404) { const l = $('#jlLog'); if (l) l.textContent = 'This one is no longer on the server (it finished a while ago, or the server restarted).'; return; }
      setTimeout(tick, 3000); return;
    }
    const t = (state.tasks || []).find((x) => x.id === jobId);
    if (!draw({ ...(t || {}), ...j, title: (t && t.title) || j.title })) return;
    if (ACTIVE.includes(j.status)) setTimeout(tick, document.visibilityState === 'visible' ? 1500 : 4000);
  };
  tick();
}
// A small "being checked" note for a channel or source page, so you can see it and jump to it.
function srcTaskHtml(srcId) {
  const j = (state.tasks || []).find((x) => x.srcId === srcId && ACTIVE.includes(x.status));
  if (!j) return '';
  return `<div class="hint-card" data-act="tasks" style="cursor:pointer"><span class="mini-spin"></span><span>${j.status === 'queued' ? `Waiting in line${j.waitingFor ? ` behind ${esc(j.waitingFor)}` : ''}` : `${esc(j.title)}${j.counter ? ` · ${j.counter.done.toLocaleString()} ${esc(j.counter.label)}` : ''}`}</span><span class="value muted">View ›</span></div>`;
}

// ---------- tweaks library ----------
function tweaksSheet() {
  const sub = state.substrate || {};
  const needSub = state.tweaks.some((t) => t.files.some((f) => f.needsSubstrate));
  openSheet(`
    <h2>🧩 Tweaks</h2>
    <p class="muted small" style="margin-top:-6px">Tweaks you add here can be ticked on when anyone signs an app, or set as an app's default. Upload a jailbreak <b>.deb</b> or a <b>.dylib</b>.</p>
    <div class="card sub-card">
      <div class="row-main"><div class="row-title">Substrate ${sub.installed ? '<span class="badge good">Ready</span>' : needSub ? '<span class="badge bad">Missing</span>' : '<span class="badge">Not set</span>'}</div>
      <div class="row-sub">${sub.installed ? `${esc(sub.name)} · ${fmtSize(sub.size)} · added to apps that need it` : 'Most jailbreak tweaks need it to run. Upload ElleKit (.deb) or a CydiaSubstrate.framework (.zip) once.'}</div></div>
      <div class="card-actions"><button class="btn" id="twSub">${sub.installed ? 'Replace' : 'Upload Substrate'}</button>${sub.installed ? '<button class="btn danger" id="twSubDel">Remove</button>' : ''}</div>
    </div>
    <button class="file-btn" id="twAdd">${ICONS.plus}<div class="row-main"><div class="row-title">Add tweaks</div><div class="row-sub">.deb or .dylib · pick several at once</div></div></button>
    <div id="addProgress"></div>
    ${state.tweaks.length ? `<div class="section-title">${state.tweaks.length} tweak${state.tweaks.length === 1 ? '' : 's'}</div><div class="list">${state.tweaks.map((t) => `
      <button class="row" data-tw="${t.id}"><span class="app-icon tw-icon">🧩</span>
        <span class="row-main"><span class="row-title">${esc(t.name)}${t.version ? ` <span class="muted small">${esc(t.version)}</span>` : ''}</span>
        <span class="row-sub">${t.warnings.length ? `⚠️ ${t.warnings.length} warning${t.warnings.length === 1 ? '' : 's'}` : esc(t.author || `${t.files.length} file${t.files.length === 1 ? '' : 's'}`)}${t.published ? '' : ' · hidden'}</span></span>
        <span class="value muted">›</span></button>`).join('')}</div>` : ''}
    <p class="hint" style="margin:10px 4px 0">Not every jailbreak tweak works on a non-jailbroken iPhone — ones that change the system (Springboard, Control Center, lock screen) won't. Tweaks for a specific app (like YouTube or Instagram tweaks) usually do.</p>`, (el) => {
    el.querySelectorAll('[data-tw]').forEach((b) => { b.onclick = () => tweakSheet(b.dataset.tw); });
    $('#twAdd', el).onclick = async () => {
      const files = ((await pickFile('', true)) || []).filter((f) => {
        if (/\.(deb|dylib)$/i.test(f.name)) return true;
        toast(`${f.name} isn't a .deb or .dylib`, true);
        return false;
      });
      if (!files.length) return;
      const box = $('#addProgress', el);
      let added = 0;
      for (const [i, f] of files.entries()) {
        box.innerHTML = `<p class="muted small center">Adding ${i + 1} of ${files.length}: ${esc(f.name)}…</p>`;
        try {
          const up = await uploadFile(f);
          await api('POST', '/api/tweaks', { uploadId: up.uploadId, fileName: f.name });
          added++;
        } catch (e) { toast(`${f.name}: ${e.message}`, true); }
      }
      await refresh();
      if (added) toast(`Added ${added} tweak${added === 1 ? '' : 's'}`);
      tweaksSheet();
    };
    $('#twSub', el).onclick = async () => {
      const f = await pickFile('');
      if (!f) return;
      if (!/\.(deb|zip|dylib)$/i.test(f.name)) return toast('Pick a .deb, .zip or .dylib', true);
      $('#addProgress', el).innerHTML = '<p class="muted small center">Setting up Substrate…</p>';
      try {
        const up = await uploadFile(f);
        await api('PUT', '/api/substrate', { uploadId: up.uploadId, fileName: f.name });
        await refresh();
        toast('Substrate is ready');
      } catch (e) { toast(e.message, true); }
      tweaksSheet();
    };
    if ($('#twSubDel', el)) {
      $('#twSubDel', el).onclick = async () => {
        if (!confirm('Remove Substrate? Tweaks that need it will crash the apps they are added to.')) return;
        try { await api('DELETE', '/api/substrate'); await refresh(); toast('Removed'); } catch (e) { toast(e.message, true); }
        tweaksSheet();
      };
    }
  });
}

function tweakSheet(tid) {
  const t = state.tweaks.find((x) => x.id === tid);
  if (!t) return tweaksSheet();
  const usedBy = state.apps.filter((a) => ((a.signDefaults || {}).tweakIds || []).includes(t.id));
  openSheet(`
    <div class="sheet-head"><span class="app-icon big tw-icon">🧩</span><div class="row-main"><h2>${esc(t.name)}</h2><div class="row-sub">${esc([t.version, t.author].filter(Boolean).join(' · ') || 'Tweak')}</div></div></div>
    ${t.warnings.map((w) => `<p class="warning">${esc(w)}</p>`).join('')}
    <dl class="kv card" style="margin:0">
      ${t.package ? `<dt>Package</dt><dd class="mono small-break">${esc(t.package)}</dd>` : ''}
      <dt>Files</dt><dd>${t.files.map((f) => `${esc(f.name)} <span class="muted small">${fmtSize(f.size)}</span>`).join('<br>')}</dd>
      <dt>Needs Substrate</dt><dd>${t.files.some((f) => f.needsSubstrate) ? (state.substrate.installed ? 'Yes · bundled for you' : 'Yes · ⚠️ not set up') : 'No'}</dd>
      <dt>Default for</dt><dd>${usedBy.length ? usedBy.map((a) => esc(a.name)).join(', ') : '—'}</dd>
    </dl>
    <div class="field" style="margin-top:12px"><label>Name</label><input type="text" id="twName" value="${esc(t.name)}" maxlength="80"></div>
    <div class="field"><label>Description</label><textarea id="twDesc" rows="3" placeholder="What it does (shown when signing)">${esc(t.description || '')}</textarea></div>
    <div class="group">${toggle('twPub', 'Available to everyone', 'Off = only you can pick it when signing', t.published)}</div>
    <div class="actions">
      <button class="btn primary block" id="twSave">Save</button>
      <button class="btn block" id="twBack">Back to Tweaks</button>
      <button class="btn block danger" id="twDel">Delete</button>
    </div>`, (el) => {
    $('#twBack', el).onclick = tweaksSheet;
    $('#twSave', el).onclick = async () => {
      try {
        await api('PATCH', `/api/tweaks/${t.id}`, { name: $('#twName', el).value, description: $('#twDesc', el).value, published: $('#twPub', el).checked });
        await refresh(); toast('Saved'); tweaksSheet();
      } catch (e) { toast(e.message, true); }
    };
    $('#twDel', el).onclick = async () => {
      if (!confirm(`Delete ${t.name}?${usedBy.length ? ` It's a default for ${usedBy.length} app${usedBy.length === 1 ? '' : 's'}, which will stop adding it.` : ''}`)) return;
      try { await api('DELETE', `/api/tweaks/${t.id}`); await refresh(); toast('Deleted'); tweaksSheet(); } catch (e) { toast(e.message, true); }
    };
  });
}

// ---------- duplicates ----------
function duplicateGroups() {
  const by = new Map();
  for (const a of state.apps) {
    if (!a.bundleId || a.missing) continue;
    const k = a.bundleId.toLowerCase();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(a);
  }
  return [...by.values()].filter((g) => g.length > 1);
}
// Which copy a cleanup keeps (same rule as the server): copies from the place you prefer, then the newest
// version, then the most installed, then the one you had first.
function verCmp(a, b) {
  const pa = String(a || '').split(/[^0-9]+/).filter(Boolean).map(Number), pb = String(b || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
function dupKeeper(group, prefer) {
  const isMine = (a) => !isSrcApp(a);
  const srcName = prefer && prefer !== 'newest' && prefer !== 'mine' ? ((state.sources || []).find((x) => x.id === prefer) || {}).name : null;
  const pref = prefer === 'mine' ? group.filter(isMine) : srcName ? group.filter((a) => isSrcApp(a) && a.sourceName === srcName) : [];
  const pool = pref.length ? pref : group;
  return [...pool].sort((x, y) => verCmp(y.version, x.version) || (y.installCount || 0) - (x.installCount || 0) || String(x.addedAt).localeCompare(String(y.addedAt)))[0];
}
function duplicatesSheet(prefer = duplicatesSheet.prefer || 'newest') {
  duplicatesSheet.prefer = prefer;
  // Copies you picked yourself (bundle ID -> app id). They win over the "keep" rule above.
  const picks = (duplicatesSheet.picks = duplicatesSheet.picks || {});
  const groups = duplicateGroups();
  const keeperOf = (g) => g.find((a) => a.id === picks[g[0].bundleId.toLowerCase()]) || dupKeeper(g, prefer);
  const extra = groups.reduce((n, g) => n + g.length - 1, 0);
  const picked = groups.filter((g) => g.some((a) => a.id === picks[g[0].bundleId.toLowerCase()])).length;
  const places = (state.sources || []).filter((src) => groups.some((g) => g.some((a) => isSrcApp(a) && a.sourceName === src.name)));
  const byVersion = (g) => [...g].sort((x, y) => verCmp(y.version, x.version));
  openSheet(`
    <h2>🔁 Duplicates</h2>
    <p class="muted small" style="margin-top:-6px">Apps that share a bundle ID — usually the same app added twice, or once from a source and once by you.</p>
    ${groups.length ? `
    <div class="card" style="margin:0 0 6px">
      <p style="margin:0 0 10px"><b>${groups.length}</b> app${groups.length === 1 ? ' has' : 's have'} copies · <b>${extra}</b> extra cop${extra === 1 ? 'y' : 'ies'}${picked ? ` · <b>${picked}</b> picked by you` : ''}</p>
      <div class="field" style="margin:0 0 10px"><label>For apps you haven't picked, keep</label>
        <select id="dpPrefer">
          <option value="newest" ${prefer === 'newest' ? 'selected' : ''}>The newest version</option>
          <option value="mine" ${prefer === 'mine' ? 'selected' : ''}>The one I added myself</option>
          ${places.map((src) => `<option value="${src.id}" ${prefer === src.id ? 'selected' : ''}>The one from ${esc(src.name)}</option>`).join('')}
        </select>
        <div class="hint">Tap <b>Keep</b> on any copy below to choose it yourself. If an app has no copy from your choice, its newest version is kept. Deleted copies won't come back when their channel or source refreshes.</div></div>
      <button class="btn primary block" id="dpAll">Clean up all — delete ${extra} extra cop${extra === 1 ? 'y' : 'ies'}</button>
      ${picked ? '<button class="link-btn block" id="dpReset" type="button">Undo my picks</button>' : ''}
    </div>` : ''}
    ${groups.length ? groups.map((g) => { const keep = keeperOf(g); const mine = keep.id === picks[g[0].bundleId.toLowerCase()]; return `
      <div class="section-title dup-head"><span>${esc(g[0].name)} <span class="muted mono" style="text-transform:none">${esc(g[0].bundleId)}</span></span>
        <button class="link-btn inline" data-only="${esc(g[0].bundleId)}" type="button">Keep ✓, delete ${g.length - 1}</button></div>
      <div class="list">${byVersion(g).map((a) => `
        <div class="row dup-row ${a === keep ? 'keeps' : ''}" data-open="${a.id}">${appIcon(a)}
          <div class="row-main"><div class="row-title"><span class="ver-big">v${esc(shownVersion(a) || '?')}</span> ${a === keep ? `<span class="badge good">✓ Keeps${mine ? ' · your pick' : ''}</span>` : ''}</div>
            <div class="row-sub">${esc(isSrcApp(a) ? a.sourceName || 'source' : a.cloud === 'github' ? 'GitHub' : a.cloud === 'link' ? 'link' : 'Added by you')} · ${fmtSize(a.size)} · ${a.installCount || 0} installs</div>
            <div class="row-sub">${esc(a.name)} · ${a.updatedAt && a.updatedAt !== a.addedAt ? 'updated' : 'added'} ${ago(a.updatedAt || a.addedAt)}</div></div>
          <div class="row-btns">
            ${a === keep ? '' : `<button class="pill" data-pick="${a.id}">Keep</button>`}
            <button class="pill danger-pill" data-del="${a.id}" aria-label="Delete this copy">✕</button>
          </div>
        </div>`).join('')}</div>`; }).join('') : '<div class="empty" style="padding:30px 10px"><h3>No duplicates 🎉</h3></div>'}`, (el) => {
    const run = async (body, msg) => {
      const r = await api('POST', '/api/apps/dedupe', { prefer: duplicatesSheet.prefer, picks, ...body });
      await refresh();
      toast(msg(r));
      duplicatesSheet();
    };
    if ($('#dpPrefer', el)) $('#dpPrefer', el).onchange = (e) => duplicatesSheet(e.target.value);
    if ($('#dpReset', el)) $('#dpReset', el).onclick = () => { duplicatesSheet.picks = {}; duplicatesSheet(); };
    if ($('#dpAll', el)) $('#dpAll', el).onclick = async (e) => {
      if (!confirm(`Delete ${extra} extra cop${extra === 1 ? 'y' : 'ies'} and keep the ✓ one of each app? People who installed a deleted copy keep it on their phone.`)) return;
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Cleaning up…';
      try { await run({}, (r) => `Deleted ${r.deleted} duplicate${r.deleted === 1 ? '' : 's'} ✓`); } catch (err) { b.disabled = false; b.textContent = 'Clean up all'; toast(err.message, true); }
    };
    // Keep: choose this copy for its app (nothing is deleted until you clean up).
    el.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const a = state.apps.find((x) => x.id === b.dataset.pick);
        if (a) picks[a.bundleId.toLowerCase()] = a.id;
        const y = $('#sheetBody').scrollTop;
        duplicatesSheet();
        $('#sheetBody').scrollTop = y;
      };
    });
    // Just this app: keep the ✓ copy and delete its other copies now.
    el.querySelectorAll('[data-only]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try { await run({ only: b.dataset.only }, (r) => `Kept 1, deleted ${r.deleted}`); } catch (err) { b.disabled = false; toast(err.message, true); }
      };
    });
    el.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => appSheet(b.dataset.open); b.style.cursor = 'pointer'; });
    el.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const a = state.apps.find((x) => x.id === b.dataset.del);
        if (!a || !confirm(`Delete this copy of ${a.name} (v${shownVersion(a) || '?'})?`)) return;
        try { await api('DELETE', `/api/apps/${a.id}`); await refresh(); toast('Deleted'); duplicatesSheet(); } catch (e) { toast(e.message, true); }
      };
    });
  });
}

// ---------- add many links ----------
function bulkLinksSheet() {
  openSheet(`
    <h2>Add several links</h2>
    <p class="muted small" style="margin-top:-6px">Paste direct .ipa download links, one per line. They're added one after another.</p>
    <div class="field"><textarea id="blUrls" rows="7" placeholder="https://…/app1.ipa&#10;https://…/app2.ipa" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea></div>
    <div class="group">${toggle('blLink', 'Link only (uses no storage)', 'Recommended. Only the info and icon are saved.', true)}</div>
    <button class="btn primary block" id="blGo" style="margin-top:12px">Add links</button>
    <div id="blList"></div>`, (el) => {
    $('#blGo', el).onclick = async () => {
      const urls = [...new Set($('#blUrls', el).value.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 50);
      if (!urls.length) return toast('Paste at least one link', true);
      const linkOnly = $('#blLink', el).checked;
      el.querySelectorAll('button, textarea, input').forEach((x) => { x.disabled = true; });
      closeSheet.locked = true;
      $('#sheet').classList.add('locked');
      const rows = urls.map((u) => ({ u, s: 'Waiting…' }));
      const draw = () => {
        $('#blList', el).innerHTML = `<div class="list" style="margin-top:12px">${rows.map((r) => `<div class="row"><div class="row-main"><div class="row-title small-break">${esc(r.name || decodeURIComponent(r.u.split('/').pop().split('?')[0]) || r.u)}</div><div class="row-sub">${esc(r.s)}</div></div></div>`).join('')}</div>`;
      };
      draw();
      let ok = 0;
      for (const r of rows) {
        r.s = 'Reading…'; draw();
        try {
          const { jobId } = await api('POST', linkOnly ? '/api/apps/link' : '/api/apps/import', { url: r.u });
          const res = await waitJob(jobId, (j) => { if (j.progress != null) { r.s = `${linkOnly ? 'Reading' : 'Downloading'} ${Math.round(j.progress * 100)}%`; draw(); } });
          r.name = res.app.name; r.s = `✓ Added ${res.app.version || ''}`; ok++;
        } catch (e) { r.s = `✕ ${e.message}`; }
        draw();
      }
      closeSheet.locked = false;
      $('#sheet').classList.remove('locked');
      await refresh().catch(() => {});
      toast(`Added ${ok} of ${rows.length}`);
      $('#blList', el).insertAdjacentHTML('beforeend', '<button class="btn block" id="blDone" style="margin-top:12px">Done</button>');
      $('#blDone', el).onclick = closeSheet;
    };
  });
}

// ---------- adding & updating apps ----------
function uploadProgressHtml() {
  return `<div class="bar"><div></div></div><p class="muted small" id="addMsg">Starting…</p><p class="hint" id="addSub"></p>${cancelBtnHtml()}`;
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
    <div class="field"><input type="url" id="ipaUrl" placeholder="https://example.com/app.ipa" autocapitalize="off" autocorrect="off"><div class="hint">Any website's direct .ipa link works (like example.com/app.ipa). Dropbox links work too (dl=0 is fixed for you).</div></div>
    <div id="ghFollow" class="hint-card hidden"><span>This is a GitHub release. Follow the repo instead and new versions show up by themselves.</span><button class="btn small-btn" id="ghFollowBtn" type="button">Follow repo</button></div>
    <div class="group">${toggle('linkOnly', 'Link only (uses no storage)', "Only the app's info and icon are saved. The file is downloaded fresh each time someone signs it.", true)}</div>
    <button class="btn block" id="importUrl" style="margin-top:10px">Add from link</button>
    <button class="link-btn block" id="goBulk" type="button">🔗 Add several links at once</button>
    <button class="link-btn block" id="goSources" type="button">☁ Add a whole source (AltStore / ESign repo) instead</button>
    <div id="addProgress"></div>`, (el) => {
    $('#goSources', el).onclick = addSourceSheet;
    $('#goBulk', el).onclick = bulkLinksSheet;
    // A GitHub release link: offer to follow the whole repo, so it keeps updating.
    const ghRepoOf = (v) => { const m = String(v).match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/releases\b/i); return m ? `https://github.com/${m[1]}/${m[2]}` : null; };
    $('#ipaUrl', el).oninput = () => $('#ghFollow', el).classList.toggle('hidden', !ghRepoOf($('#ipaUrl', el).value.trim()));
    $('#ghFollowBtn', el).onclick = () => addSourceSheet(ghRepoOf($('#ipaUrl', el).value.trim()));
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
      let url = $('#ipaUrl', el).value.trim();
      if (!url) return toast('Paste a link first', true);
      if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
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
    toast(e.cancelled ? 'Cancelled' : e.message, !e.cancelled);
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

// A newer build of a source app that the source hasn't posted yet.
function addVersionSheet(a) {
  const gh = state.github && state.github.connected;
  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>Add a newer version</h2><div class="row-sub">${esc(a.name)} · now ${esc(shownVersion(a) || '—')}</div></div></div>
    <p class="muted small">It becomes the newest version for everyone, like ${esc(a.sourceName || 'the source')} had posted it. The source's versions stay under "Other versions". If the source posts this version later, its copy takes over and yours is removed.</p>
    <button class="file-btn" id="vPick" ${gh ? '' : 'disabled'}>${ICONS.file}<div class="row-main"><div class="row-title">Choose .ipa</div><div class="row-sub">${gh ? 'Saved to your GitHub storage, not this server' : 'Connect GitHub storage first (Settings › Cloud Library)'}</div></div></button>
    <div class="section-title">Or from a link</div>
    <div class="field"><input type="url" id="vUrl" placeholder="https://example.com/app.ipa" autocapitalize="off" autocorrect="off"></div>
    <div class="group">${toggle('vLink', 'Link only (uses no storage)', 'Keeps just the link. Turn off to copy the file to your GitHub storage.', true)}</div>
    <div class="field" style="margin-top:12px"><label>What's new (optional)</label><textarea id="vNotes" rows="3" placeholder="What changed in this version"></textarea></div>
    <button class="btn primary block" id="vAdd">Add from link</button>
    <div id="addProgress"></div>`, (el) => {
    const done = (app) => { toast(`${app.name} is now ${app.version}`); appSheet(app.id); };
    const follow = (setProgress) => async (r) => waitJob(r.jobId, (j) => setProgress(j.progress, j.progress != null ? `Saving ${Math.round(j.progress * 100)}%` : (j.log.slice(-1)[0] || 'Working…')));
    $('#vPick', el).onclick = async () => {
      const file = await pickFile('');
      if (!file) return;
      if (!/\.ipa$/i.test(file.name)) return toast('Pick an .ipa file', true);
      await runWithProgress(el, async (setProgress, setSub) => {
        const up = await uploadFile(file, (p) => setProgress(p, `Uploading ${Math.round(p * 100)}%`), setSub);
        setProgress(0, 'Reading app info…'); setSub('');
        return follow(setProgress)(await api('POST', `/api/apps/${a.id}/versions`, { uploadId: up.uploadId, notes: $('#vNotes', el).value }));
      }, done);
    };
    $('#vAdd', el).onclick = async () => {
      const url = $('#vUrl', el).value.trim();
      if (!url) return toast('Paste a link first', true);
      const linkOnly = $('#vLink', el).checked;
      if (!linkOnly && !gh) return toast('Connect GitHub storage first, or keep Link only on', true);
      await runWithProgress(el, async (setProgress) => follow(setProgress)(await api('POST', `/api/apps/${a.id}/versions`, { url, linkOnly, notes: $('#vNotes', el).value })), done);
    };
  });
}

function appSheet(appId) {
  const a = state.apps.find((x) => x.id === appId);
  if (!a) return;
  const owner = isStaff();
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
    <button class="btn primary big block" id="aGet">${hasUpdate(a) ? `Update to ${esc(shownVersion(a))}` : isStopped(a) ? 'Sign Again to Fix' : a.installed ? 'Get Again' : 'Get'}</button>
    ${a.installed ? installedNoteHtml(a) : ''}
    ${defaults.length ? `<p class="hint center" style="margin-top:${a.installed ? 2 : 8}px">Comes set up with: ${esc(defaults.join(' · '))}</p>` : ''}
    <button class="link-btn block" id="aOptions" type="button">Sign with options…</button>
    ${seesTesterApps() && !isOwner() ? '<button class="link-btn block" id="aBug" type="button" style="margin-top:-8px">🐞 Report a bug in this app</button>' : ''}

    ${shotList.length ? `<div class="shots">${shotList.map((src, i) => `<button class="shot" data-shot="${i}"><img class="fade-img" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.add('loaded')" onerror="this.closest('.shot').remove()" src="${esc(src)}" alt="Screenshot ${i + 1}"></button>`).join('')}</div>` : ''}

    <div class="vote-row">
      <button class="vote fav ${isFav(a) ? 'on' : ''}" id="aFav" aria-label="Favorite">${isFav(a) ? '♥' : '♡'}</button>
      <span class="muted small">Do you like it?</span>
      <button class="vote ${a.myVote > 0 ? 'on' : ''}" data-vote="1">👍 <b>${a.likes}</b></button>
      <button class="vote down ${a.myVote < 0 ? 'on' : ''}" data-vote="-1">👎 <b>${a.dislikes}</b></button>
    </div>

    ${(a.tags || []).length ? `<div class="tag-row">${a.tags.map((t) => `<button class="tag" data-tag="${esc(t)}"># ${esc(t)}</button>`).join('')}</div>` : ''}
    ${a.description ? `<div class="section-title">About</div><p class="desc">${esc(a.description)}</p>` : ''}
    ${a.notes ? `<div class="section-title">What's changed / notes</div><p class="desc">${esc(cleanNotes(a.notes))}</p>` : ''}
    ${owner && versions[0] && versions[0].manualId ? `<p class="hint" style="margin:10px 4px 0">⬆ ${esc(versions[0].version)} was added by you${versions.length > 1 ? `. ${esc(a.sourceName || 'The source')}'s versions are under Other versions.` : '.'} <button class="link-btn inline" data-delver="${versions[0].manualId}" type="button">Remove it</button></p>` : ''}
    ${!a.notes && versions[0] && versions[0].notes ? `<div class="section-title">What's new in ${esc(versions[0].version || 'this version')}</div><p class="desc">${esc(cleanNotes(versions[0].notes))}</p>` : ''}
    ${versions.length > 1 ? `<div class="section-title">Other versions <span class="count">${versions.length - 1}</span></div>
      <div class="list">${versions.slice(1).map((v, n) => `
        <div class="row ver-row">
          <div class="row-main">
            <div class="row-title">${esc(v.version || 'Version ' + (n + 2))}${v.channel && v.channel !== 'stable' ? ` <span class="badge">${esc(v.channel)}</span>` : ''}</div>
            <div class="row-sub">${[v.date ? esc(String(v.date).slice(0, 10)) : '', v.size ? fmtSize(v.size) : ''].filter(Boolean).join(' · ')}</div>
            ${v.notes ? `<div class="row-sub ver-notes" role="button" tabindex="0">${esc(cleanNotes(v.notes))}</div>` : ''}
          </div>
          ${owner && v.manualId ? `<button class="pill danger-pill" data-delver="${v.manualId}" aria-label="Remove this version">✕</button>` : ''}
          <button class="pill" data-ver="${v.vi ?? n + 1}">Get</button>
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
      ${isSrcApp(a) ? `<dt>${a.cloud === 'telegram' ? 'Telegram' : 'Source'}</dt><dd>${a.cloud === 'telegram' ? '✈️' : '☁'} ${esc(a.sourceName || '—')}</dd>` : ''}
      ${owner ? `<dt>Stored on</dt><dd>${esc(storedLabel(a))}</dd>` : ''}
      ${owner && a.remoteUrl ? `<dt>Link</dt><dd class="mono small-break">${esc(a.remoteUrl)}</dd>` : ''}
    </dl>
    ${owner ? `
    <div class="group" style="margin-top:14px">
      ${toggle('aPub', 'Show in App Library', 'Everyone you invite can sign and install it', a.published)}
      ${toggle('aFeat', 'Featured', 'Pinned to the top of the library', a.featured)}
      ${toggle('aTest', 'Testers only', 'Only testers (and admins) can see it — a 🧪 For testers list shows at the top of their library', !!a.testersOnly)}
    </div>
    <div class="actions">
      <button class="btn block" id="aEdit">Edit details, tags &amp; sign settings</button>
      <button class="btn block" id="aShots">Screenshots (${shots.length})</button>
      <button class="btn block" id="aCols">Add to collection</button>
      ${a.cloud === 'source' ? `<button class="btn block" id="aAddVer">⬆ Add a newer version</button><p class="hint center" style="margin-top:2px">For when you have a newer build than ${esc(a.sourceName || 'the source')}. Its older versions stay available.</p>` : ''}
      ${isSrcApp(a) ? `<p class="hint center">Updates come in by themselves when ${esc(a.sourceName || 'the source')} ${a.cloud === 'telegram' ? 'posts' : 'adds'} a new version.</p>` : '<button class="btn block" id="aUpdate">Update IPA (new version)</button>'}
      ${!a.cloud && isOwner() && state.github.connected ? `<button class="btn block" id="aMoveGh">☁ Move to GitHub (frees ${fmtSize(a.size)})</button>` : ''}
      <a class="btn block" href="/api/apps/${a.id}/download">Download original .ipa</a>
      <button class="btn block danger" id="aDelete">Delete</button>
    </div>` : ''}`, (el) => {
    $('#aGet', el).onclick = () => quickGet(a.id);
    // Long version notes show 3 lines; tap to read all of it.
    el.querySelectorAll('.ver-notes').forEach((n) => { n.onclick = () => n.classList.toggle('open'); });
    bindInstalledNote(el, a, () => appSheet(a.id));
    $('#aOptions', el).onclick = () => signSheet(a.id);
    if ($('#aBug', el)) $('#aBug', el).onclick = () => reportBugSheet(a.id);
    el.querySelectorAll('[data-shot]').forEach((b) => { b.onclick = () => shotViewer(a, Number(b.dataset.shot)); });
    el.querySelectorAll('[data-ver]').forEach((b) => {
      b.onclick = () => {
        if (!state.certs.length) { closeSheet(); toast('Add your certificate first', true); return switchTab('certs'); }
        runSign(a, { ...signOptsFromDefaults(a), versionIndex: Number(b.dataset.ver) }, { icon: null, dylibs: [] });
      };
    });
    $('#aFav', el).onclick = async () => {
      const on = !isFav(a);
      try {
        await api('POST', `/api/apps/${a.id}/favorite`, { on });
        state.favorites = on ? [...state.favorites, a.id] : state.favorites.filter((x) => x !== a.id);
        toast(on ? '♥ Added to Favorites' : 'Removed from Favorites');
        appSheet(a.id); render();
      } catch (e) { toast(e.message, true); }
    };
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
    flip('#aTest', 'testersOnly', 'Only testers can see it now 🧪', 'Not just for testers anymore');
    $('#aEdit', el).onclick = () => editAppSheet(a);
    $('#aShots', el).onclick = () => screenshotsSheet(a);
    $('#aCols', el).onclick = () => addToCollectionSheet(a);
    if ($('#aUpdate', el)) $('#aUpdate', el).onclick = () => updateIpaSheet(a);
    if ($('#aAddVer', el)) $('#aAddVer', el).onclick = () => addVersionSheet(a);
    el.querySelectorAll('[data-delver]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('Remove this version? Its file is deleted from your GitHub storage.')) return;
        try { await api('DELETE', `/api/apps/${a.id}/versions/${b.dataset.delver}`); await refresh(); toast('Version removed'); appSheet(a.id); } catch (err) { toast(err.message, true); }
      };
    });
    if ($('#aMoveGh', el)) $('#aMoveGh', el).onclick = () => moveToGithubSheet([a.id], a.name);
    $('#aDelete', el).onclick = async () => {
      if (!confirm(`Delete ${a.name} from the library? People who already installed it keep it.${isSrcApp(a) ? `\n\n${a.sourceName || 'Its source'} won't add it back when it refreshes. You can restore it from the ${a.cloud === 'telegram' ? 'channel' : 'source'}'s page.` : ''}`)) return;
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
    weakDylibs: !!d.weakDylibs,
    injectExtensions: !!d.injectExtensions,
    tweakIds: (d.tweakIds || []).filter((tid) => state.tweaks.some((t) => t.id === tid)),
  };
}

// A signed copy is reusable if it's for this app, still on the server, signed with your default cert, and newer than the app.
function reusableSigned(a) {
  const cert = state.certs.find((c) => c.isDefault) || state.certs[0];
  if (!cert) return null;
  return state.signed.find((s) => s.appId === a.id && s.fileAvailable && s.certId === cert.id
    && new Date(s.signedAt) >= new Date(a.updatedAt || a.addedAt) && !(s.options && (s.options.dylibs || []).length) && !(s.options && s.options.icon)
    && !(s.options && s.options.versionIndex)
    && [...((s.options && s.options.tweakIds) || [])].sort().join() === [...signOptsFromDefaults(a).tweakIds].sort().join()) || null;
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
    ${isStaff() ? '<button class="btn block" id="cEdit" style="margin-top:12px">Edit collection</button>' : ''}`, (el) => {
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
    <p class="hint" style="margin-top:-6px">Ask for an app to be added to the library. You'll see the answer in ${isStaff() ? 'Users' : 'Account'} › Requests.</p>
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
      <div class="row-sub">${isStaff() ? `${esc(r.username || '?')} · ` : ''}${ago(r.createdAt)}${r.reply ? ` · “${esc(r.reply)}”` : ''}</div></div>
    <span class="badge ${cls}">${label}</span></div>`;
}

function requestSheet(rid) {
  const r = state.requests.find((x) => x.id === rid);
  if (!r) return;
  const app = r.appId && state.apps.find((a) => a.id === r.appId);
  openSheet(`
    <h2>${esc(r.name)}</h2>
    <dl class="kv">
      ${isStaff() ? `<dt>From</dt><dd>${esc(r.username || '?')}</dd>` : ''}
      <dt>Asked</dt><dd>${ago(r.createdAt)}</dd>
      <dt>Status</dt><dd>${REQ_STATUS[r.status][0]}</dd>
      ${r.link ? `<dt>Link</dt><dd><a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.link)}</a></dd>` : ''}
    </dl>
    ${r.note ? `<p class="desc">${esc(r.note)}</p>` : ''}
    ${r.reply ? `<p class="setup-note">💬 ${esc(r.reply)}</p>` : ''}
    ${app ? `<button class="btn primary block" id="rqOpen">Open ${esc(app.name)}</button>` : ''}
    ${isStaff() ? `
      <div class="field" style="margin-top:12px"><label>Reply (optional)</label><input type="text" id="rqReply" value="${esc(r.reply || '')}" placeholder="e.g. Added! Turn on JIT first"></div>
      <div class="field"><label>Link it to a library app (optional)</label><select id="rqApp"><option value="">—</option>${state.apps.map((a) => `<option value="${a.id}" ${a.id === r.appId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="card-actions">
        <button class="btn" id="rqAdded">✅ Mark added</button>
        <button class="btn" id="rqDecline">✕ Decline</button>
      </div>` : ''}
    ${isStaff() || r.status === 'pending' ? '<button class="btn block danger" id="rqDel" style="margin-top:8px">Delete request</button>' : ''}`, (el) => {
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
    ${state.tweaks.length ? `<div class="section-title">Default tweaks</div>${tweakPickerHtml('d', (a.signDefaults || {}).tweakIds || [])}` : ''}

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
          signDefaults: { ...collect(), minOS: $('#eMin', el).value.trim(), tweakIds: pickedTweaks(el, 'd') },
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

// Auto-sort: every app without a category (or every app, with all). Runs on the server, so it can keep going
// after you close the screen. Apple only allows a few App Store lookups a minute, so big batches take a while.
async function autoSortRun(all, back) {
  if (all && !confirm('Re-sort every app? Apps you put in a category yourself stay where they are.')) return;
  try {
    const { jobId, count } = await api('POST', '/api/apps/auto-categorize', { all });
    if (!count) return toast('Nothing to sort');
    closeSheet.locked = true; $('#sheet').classList.add('locked');
    let bg = false;
    openSheet(`<div class="progress-wrap"><div class="spinner"></div><h2 style="margin:0 0 4px">Sorting ${count} app${count === 1 ? '' : 's'}…</h2>
      <div class="bar" id="asBar"><div></div></div><div class="log" id="asLog"></div>
      <p class="hint center">Apps the App Store has to look up take a few seconds each.</p>
      <button class="btn block" id="asBg" type="button">Keep going in the background</button>
      <button class="link-btn block" id="asStop" type="button">Stop</button></div>`, (el) => {
      $('#asBg', el).onclick = () => { bg = true; closeSheet.locked = false; $('#sheet').classList.remove('locked'); closeSheet(); toast('Still sorting on the server. Refresh in a bit to see it.'); };
      $('#asStop', el).onclick = () => api('POST', `/api/jobs/${jobId}/cancel`).catch(() => {});
    });
    const body = $('#sheetBody');
    let r;
    try {
      r = await waitJob(jobId, (j) => {
        if (bg) return;
        $('#asBar > div', body).style.width = `${Math.round((j.progress || 0) * 100)}%`;
        const l = $('#asLog', body); l.textContent = j.log.join('\n'); l.scrollTop = l.scrollHeight;
      });
    } catch (e) { if (!bg) throw e; return; }
    closeSheet.locked = false; $('#sheet').classList.remove('locked');
    await refresh();
    if (bg) return toast(`Sorting finished: ${r.sorted} app${r.sorted === 1 ? '' : 's'} sorted`);
    const how = [[r.byAppStore, 'App Store'], [r.bySimilar, 'like apps you sorted'], [r.byKeyword, 'by name'], [r.bySource, 'by source'], [r.byRule, 'your rules']].filter(([n]) => n).map(([n, l]) => `${n} ${l}`).join(', ');
    toast(`Sorted ${r.sorted}${how ? ` (${how})` : ''}${r.unknown ? ` · ${r.unknown} still need you` : ''}`);
    if (back) back(); else if (r.unknown) quickSortSheet(); else closeSheet();
  } catch (e) { closeSheet.locked = false; $('#sheet').classList.remove('locked'); await refresh().catch(() => {}); toast(e.cancelled ? 'Stopped. Apps sorted so far keep their category.' : e.message, !e.cancelled); if (e.cancelled) closeSheet(); }
}

// Sort by hand: one app without a category at a time, with Mango's best guess on top. Tap a category and the next app comes up.
async function quickSortSheet(back) {
  const queue = state.apps.filter((a) => !catById(a.categoryId)).map((a) => a.id);
  if (!queue.length) { toast('Every app has a category 🎉'); return back && back(); }
  let guesses = {};
  try { guesses = (await api('POST', '/api/apps/category-guesses', { ids: queue })).guesses || {}; } catch { /* guesses are a bonus */ }
  const total = queue.length;
  let i = 0, done = 0, deleted = 0;
  const history = [];
  const next = () => { while (i < queue.length && !state.apps.find((a) => a.id === queue[i])) i++; };
  const draw = () => {
    next();
    if (i >= queue.length) {
      openSheet(`<div class="empty"><div class="empty-icon">🎉</div><h3>All done</h3><p>${done} sorted${deleted ? `, ${deleted} deleted` : ''}${total - done - deleted ? `, ${total - done - deleted} skipped` : ''}.</p></div>
        ${history.length ? '<button class="btn block" id="qsUndo">↩ Undo the last one</button>' : ''}
        <button class="btn primary block" id="qsClose" style="margin-top:8px">${back ? 'Back' : 'Close'}</button>`, (el) => {
        if ($('#qsUndo', el)) $('#qsUndo', el).onclick = undo;
        $('#qsClose', el).onclick = () => (back ? back() : closeSheet());
      });
      return;
    }
    const a = state.apps.find((x) => x.id === queue[i]);
    const g = guesses[a.id];
    const guessCat = g && g.categoryId && catById(g.categoryId);
    const sub = [a.developer, a.bundleId, a.sourceName ? `${a.cloud === 'telegram' ? '✈️' : '☁'} ${a.sourceName}` : ''].filter(Boolean).join(' · ');
    const about = String(a.description || a.notes || '').replace(/\s+/g, ' ').slice(0, 160);
    openSheet(`
      <p class="muted small center" style="margin:-4px 0 10px">${i + 1} of ${queue.length} · ${done} sorted${deleted ? ` · ${deleted} deleted` : ''}</p>
      <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>${esc(a.name)}</h2><div class="row-sub">${esc(sub)}</div></div></div>
      ${about ? `<p class="muted small" style="margin:-4px 0 12px">${esc(about)}${about.length >= 160 ? '…' : ''}</p>` : ''}
      ${guessCat ? `<button class="btn primary big block" data-qcat="${guessCat.id}">${esc(guessCat.emoji)} ${esc(guessCat.name)}<span class="qs-why">Best guess: ${esc(g.why)}</span></button>`
        : g && g.newCategory ? `<button class="btn primary big block" data-qnew="${esc(g.newCategory)}">+ ${esc(g.newCategory)} (new)<span class="qs-why">Best guess: ${esc(g.why)}</span></button>` : ''}
      <div class="qs-grid">${state.categories.filter((c) => !guessCat || c.id !== guessCat.id).map((c) => `<button class="btn" data-qcat="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`).join('')}
        <button class="btn" data-qnew="">+ New…</button></div>
      <div class="actions" style="margin-top:12px">
        <button class="btn block" id="qsSkip">Skip for now</button>
        <button class="btn block danger" id="qsDel">🗑 Delete from library</button>
        ${history.length ? '<button class="link-btn block" id="qsUndo" type="button">↩ Undo the last one</button>' : ''}
        <button class="link-btn block" id="qsOpen" type="button">Open the app's page</button>
        <button class="link-btn block" id="qsDone" type="button">${back ? 'Back' : 'Done'}</button>
      </div>`, (el) => {
      const put = async (cid) => {
        el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          await api('PATCH', `/api/apps/${a.id}`, { categoryId: cid });
          a.categoryId = cid;
          history.push(a.id);
          done++; i++;
          draw();
        } catch (e) { toast(e.message, true); draw(); }
      };
      el.querySelectorAll('[data-qcat]').forEach((b) => { b.onclick = () => put(b.dataset.qcat); });
      el.querySelectorAll('[data-qnew]').forEach((b) => {
        b.onclick = async () => {
          let cat;
          if (b.dataset.qnew) {
            try { ({ category: cat } = await api('POST', '/api/categories', { name: b.dataset.qnew, emoji: '📁' })); state.categories.push(cat); } catch (e) { return toast(e.message, true); }
          } else cat = await promptNewCategory();
          if (cat) put(cat.id);
        };
      });
      $('#qsSkip', el).onclick = () => { i++; draw(); };
      $('#qsDel', el).onclick = async () => {
        if (!confirm(`Delete ${a.name} from the library? People who installed it keep it.${isSrcApp(a) ? ` ${a.sourceName || 'Its source'} won't add it back.` : ''} This can't be undone.`)) return;
        el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          await api('DELETE', `/api/apps/${a.id}`);
          state.apps = state.apps.filter((x) => x.id !== a.id);
          deleted++; i++;
          draw();
        } catch (e) { toast(e.message, true); draw(); }
      };
      if ($('#qsUndo', el)) $('#qsUndo', el).onclick = undo;
      $('#qsOpen', el).onclick = () => appSheet(a.id);
      $('#qsDone', el).onclick = async () => { await refresh(); if (back) back(); else closeSheet(); };
    });
  };
  const undo = async () => {
    const aid = history.pop();
    if (!aid) return;
    try {
      await api('PATCH', `/api/apps/${aid}`, { categoryId: null });
      const a = state.apps.find((x) => x.id === aid);
      if (a) a.categoryId = null;
      done--;
      i = queue.indexOf(aid);
      draw();
    } catch (e) { toast(e.message, true); }
  };
  draw();
  refresh().catch(() => {});
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
      <button class="btn primary block" id="cNew" style="margin-top:12px">+ New category</button>
      <div class="section-title">✨ Sort automatically</div>
      <p class="hint" style="margin:0 4px 10px">Mango checks your keyword rules, the App Store, apps you already sorted that look the same (YouTube++ goes where YouTube is), giveaway words in the name (emulator, IPTV, VPN…) and where most apps from the same source or channel are. It also fills in a missing developer, description and screenshots. Re-sorting never moves apps you put in a category yourself.</p>
      <div class="actions" style="margin-top:0">
        <button class="btn block" id="cAuto">✨ Auto-sort apps without a category (${state.apps.filter((a) => !catById(a.categoryId)).length})</button>
        <button class="btn block" id="cQuick">Sort them by hand, one by one</button>
        <button class="btn block" id="cAutoAll">Re-sort every app</button>
        <button class="btn block" id="cRules">Keyword rules (${(state.settings.catRules || []).length})</button>
      </div>`, (el) => {
      const runAuto = (all) => autoSortRun(all, draw);
      $('#cAuto', el).onclick = () => runAuto(false);
      $('#cQuick', el).onclick = () => quickSortSheet(draw);
      $('#cAutoAll', el).onclick = () => runAuto(true);
      $('#cRules', el).onclick = () => catRulesSheet(draw);
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

// Keyword rules: "if the name or post mentions any of these words, put it in this category".
function catRulesSheet(back) {
  const rules = (state.settings.catRules || []).map((r) => ({ ...r }));
  const draw = () => {
    openSheet(`
      <h2>Keyword rules</h2>
      <p class="muted small" style="margin-top:-6px">Checked before the App Store, against the app's name, file name and the Telegram post. The first rule that matches wins.</p>
      <div id="crList">${rules.map((r, i) => `
        <div class="card rule-card">
          <div class="field" style="margin:0 0 8px"><label>If it mentions</label><input type="text" data-w="${i}" value="${esc(r.words)}" placeholder="emulator, emu" autocapitalize="off"></div>
          <div class="rule-row">${categorySelectHtml(r.categoryId).replace('id="eCat"', `data-c="${i}"`).replace('<option value="__new">+ New category…</option>', '').replace('<option value="">Uncategorized</option>', '')}
            <button class="mini danger" data-rm="${i}">✕</button></div>
        </div>`).join('') || '<p class="hint">No rules yet.</p>'}</div>
      <button class="btn block" id="crAdd" style="margin-top:10px">+ Add rule</button>
      <button class="btn primary big block" id="crSave" style="margin-top:10px">Save rules</button>
      <button class="link-btn block" id="crBack" type="button">Back</button>`, (el) => {
      const sync = () => {
        el.querySelectorAll('[data-w]').forEach((x) => { rules[+x.dataset.w].words = x.value; });
        el.querySelectorAll('[data-c]').forEach((x) => { rules[+x.dataset.c].categoryId = x.value; });
      };
      el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { sync(); rules.splice(+b.dataset.rm, 1); draw(); }; });
      $('#crAdd', el).onclick = () => {
        sync();
        if (!state.categories.length) return toast('Make a category first', true);
        rules.push({ words: '', categoryId: state.categories[0].id });
        draw();
      };
      $('#crBack', el).onclick = back;
      $('#crSave', el).onclick = async () => {
        sync();
        try { state.settings = (await api('PATCH', '/api/settings', { catRules: rules })).settings; toast('Rules saved'); back(); } catch (e) { toast(e.message, true); }
      };
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
      <select id="sVer">${a.versions.map((v, i) => `<option value="${v.vi ?? i}" ${(v.vi ?? i) === (Number(defaults.versionIndex) || 0) ? 'selected' : ''}>${esc(v.version || 'Version ' + (i + 1))}${i === 0 ? ' (newest)' : ''}${v.channel && /^(beta|alpha|pre)/i.test(v.channel) ? ' · beta' : ''}${v.date ? ' · ' + esc(String(v.date).slice(0, 10)) : ''}</option>`).join('')}</select></div>` : ''}
    ${state.presets.length ? `<div class="field"><label>Preset</label>
      <select id="sPreset"><option value="">${overrides && overrides.presetId ? 'App defaults' : 'None (app defaults)'}</option>${state.presets.map((p) => `<option value="${p.id}" ${overrides && overrides.presetId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>` : ''}
    ${summary.length ? `<p class="setup-note">✨ ${overrides && overrides.presetId ? 'From your preset' : 'Set up for you'}: ${esc(summary.join(' · '))}</p>` : ''}
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
      ${tweakPickerHtml('s', defaults.tweakIds || [])}
      <button class="file-btn" id="sDylib" style="margin-top:${state.tweaks.length ? 10 : 0}px">${ICONS.plus}<div class="row-main"><div class="row-title">Add your own .dylib or .deb</div><div class="row-sub">Jailbreak tweaks work too — Mango pulls the tweak out of the .deb</div></div></button>
      <div class="chips" id="sDylibs"></div>
      <div class="group" style="margin-top:10px">
        ${toggle('sWeak', 'Weak injection', 'App still opens if a tweak fails to load', !!defaults.weakDylibs)}
        ${toggle('sInjExt', 'Inject into extensions', 'Also load tweaks in widgets and share extensions', !!defaults.injectExtensions)}
      </div>
      <button class="btn primary big block" id="sGo2" style="margin-top:16px">Sign App</button>
      <button class="link-btn block" id="sSavePreset" type="button">💾 Save these settings as a preset</button>
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
        if (!/\.(dylib|deb)$/i.test(f.name)) { toast(`${f.name} isn't a .dylib or .deb`, true); continue; }
        extra.dylibs.push(f);
      }
      drawDylibs();
    };

    if ($('#sPreset', el)) {
      $('#sPreset', el).onchange = (e) => {
        const p = state.presets.find((x) => x.id === e.target.value);
        signSheet(a.id, p ? { ...p.options, presetId: p.id } : undefined);
      };
    }
    const formOptions = () => {
      const o = collect();
      return {
        minOS: $('#sMin', el).value.trim(), entitlements: o.entitlements, plist: o.plist,
        weakDylibs: $('#sWeak', el).checked, injectExtensions: $('#sInjExt', el).checked,
        removeExtensions: !!o.removeExtensions, removeWatch: !!o.removeWatch, removeUISD: !!o.removeUISD, enableDocs: !!o.enableDocs,
        tweakIds: pickedTweaks(el, 's'),
      };
    };
    $('#sSavePreset', el).onclick = async () => {
      const current = overrides && overrides.presetId ? (state.presets.find((p) => p.id === overrides.presetId) || {}).name : '';
      const name = prompt('Name this preset (using an existing name updates it):', current || '');
      if (!name || !name.trim()) return;
      try {
        const { preset, replaced } = await api('POST', '/api/presets', { name: name.trim(), options: formOptions() });
        await refresh();
        toast(replaced ? `Updated “${preset.name}”` : `Saved “${preset.name}”`);
      } catch (e) { toast(e.message, true); }
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
        tweakIds: pickedTweaks(el, 's'),
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
      <button class="btn block hidden" id="pBg" type="button" style="margin-top:12px">Keep going in the background</button>
      ${cancelBtnHtml('Cancel signing')}
    </div>`);
  const body = $('#sheetBody');
  const setTitle = (t, s) => { $('#pTitle', body).textContent = t; if (s !== undefined) $('#pSub', body).textContent = s; };
  const setBar = (p) => { $('#pBar', body).classList.remove('hidden'); $('#pBar > div', body).style.width = `${Math.round(p * 100)}%`; };
  // "Keep going in the background": close this screen; the server sends an alert when it's ready.
  let background = false;
  let jobId = null;
  $('#pBg', body).onclick = async () => {
    background = true;
    closeSheet.locked = false;
    $('#sheet').classList.remove('locked');
    closeSheet();
    if (jobId) api('POST', `/api/jobs/${jobId}/notify`).catch(() => {});
    toast(`Signing ${a.name} in the background — you'll get an alert when it's ready`);
  };

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
      ({ jobId } = await api('POST', '/api/sign', opts));
      if (!background) $('#pBg', body).classList.remove('hidden');
      else api('POST', `/api/jobs/${jobId}/notify`).catch(() => {});
      const result = await waitJob(jobId, (j) => {
        if (background) return;
        if (j.status === 'queued') setTitle('Waiting in line…', 'Someone else is signing right now');
        else setTitle('Signing…', 'Big apps can take a minute');
        const log = $('#pLog', body);
        if (j.log.length) { log.classList.remove('hidden'); log.textContent = j.log.join('\n'); log.scrollTop = log.scrollHeight; }
      });
      await refresh().catch(() => {});
      if (background) { render(); return; } // the alert tells them it's ready
      closeSheet.locked = false;
      $('#sheet').classList.remove('locked');
      showSigned(result.signed, opts);
    } catch (e) {
      if (background) { refresh().catch(() => {}); return; } // the alert says it failed
      closeSheet.locked = false;
      $('#sheet').classList.remove('locked');
      if (e.cancelled) { closeSheet(); toast('Signing cancelled'); return; }
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
      if (st.sent !== tick.lastSentSeen) { tick.lastSentSeen = st.sent; tick.movedAt = now; }
      const stuck = now - (tick.movedAt || now) > 30000;
      sub.textContent = stuck ? `Stuck at ${fmtSize(st.sent)} of ${fmtSize(st.size)}` : `${fmtSize(st.sent)} of ${fmtSize(st.size)}${rate > 1024 ? ` · ${fmtSize(rate)}/s · ${fmtTime((st.size - st.sent) / rate)} left` : ''}`;
      hint(stuck ? "Nothing's moved for 30 seconds. Check your iPhone has enough free space and a good connection, then tap Try again." : '');
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
    <button class="file-btn" id="cZip">${ICONS.file}<div class="row-main"><div class="row-title">Got a .zip? Import it in one go</div><div class="row-sub">The .p12, profile and password are found for you</div></div></button>
    <div class="section-title">Or pick the files</div>
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
    $('#cZip', el).onclick = async () => {
      const f = await pickFile('');
      if (!f) return;
      if (!/\.zip$/i.test(f.name)) return toast("That's not a .zip file", true);
      const btn = $('#cZip', el);
      btn.disabled = true;
      $('#cMsg', el).textContent = 'Uploading…';
      try {
        const up = await uploadFile(f);
        $('#cMsg', el).textContent = 'Looking inside…';
        const { cert, passwordFound } = await api('POST', '/api/certs/zip', { uploadId: up.uploadId, password: $('#cPass', el).value, label: $('#cLabel', el).value });
        closeSheet();
        toast(`Added ${cert.label}${passwordFound ? ' (password found in the zip)' : ''}`);
        await refresh();
      } catch (e) {
        btn.disabled = false;
        $('#cMsg', el).textContent = '';
        toast(e.message + (/password/i.test(e.message) ? ' (type it in the Password box below, then import again)' : ''), true);
      }
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
    <div class="field"><label>Expires</label>
      <select id="iExp">${[[0, 'Never'], [1, 'In 1 day'], [7, 'In 7 days'], [30, 'In 30 days']].map(([n, l]) => `<option value="${n}" ${n === 7 ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    ${isOwner() ? `<div class="field"><label>Role for everyone who joins with it</label>
      <select id="iRank">${[['', 'Member'], ['tester', '🧪 Tester'], ['admin', '⭐ Admin']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <div class="hint" id="iRankHint">They join as a regular member.</div></div>` : ''}
    <button class="btn primary big block" id="iMake">Create Invite</button>`, (el) => {
    const rankHint = { '': 'They join as a regular member.', tester: 'They join as testers right away: a 🧪 badge and the apps you mark for testers. Nothing else changes for them.', admin: '⚠️ They join as admins right away and can manage the library and users. Only use this for people you trust, and keep uses low.' };
    if ($('#iRank', el)) $('#iRank', el).onchange = (e) => { $('#iRankHint', el).textContent = rankHint[e.target.value]; };
    $('#iMake', el).onclick = async () => {
      try {
        const { invite, signupUrl } = await api('POST', '/api/invites', { note: $('#iNote', el).value, maxUses: Number($('#iUses', el).value), expiresDays: Number($('#iExp', el).value), rank: $('#iRank', el) ? $('#iRank', el).value : '' });
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
    ${inv.rank ? `<p class="center" style="margin:-4px 0 6px"><span class="badge ${inv.rank === 'tester' ? 'tester' : 'warn'}">Joins as ${inv.rank === 'admin' ? '⭐ Admin' : '🧪 Tester'}</span></p>` : ''}
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
      <dt>Signs today</dt><dd>${u.signsToday || 0}</dd>
    </dl>
    ${isOwner() ? `<div class="list" style="margin-top:12px">
      <div class="setting"><span>Role<br><span class="hint">Admins help run the library and users. Testers get a 🧪 badge and see the apps you mark for testers.</span></span>
        <select id="uRank">${[['', 'Member'], ['tester', '🧪 Tester'], ['admin', '⭐ Admin']].map(([v, l]) => `<option value="${v}" ${(u.rank || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>` : u.rank ? `<p class="hint" style="margin:10px 4px 0">${RANK_LABEL[u.rank]}${u.rank === 'admin' ? ' · only the owner can change admins' : ''}</p>` : ''}
    ${u.rank === 'admin' && !isOwner() ? '' : `<div class="list" style="margin-top:12px">
      <div class="setting"><span>Signs per day</span>
        <select id="uLimit">${[['', `Everyone's limit (${Number(state.settings.signsPerDay ?? state.settings.everyoneSignsPerDay) || 'none'})`], ['0', 'No limit'], ['3', '3'], ['5', '5'], ['10', '10'], ['20', '20'], ['50', '50']].map(([v, l]) => `<option value="${v}" ${String(u.signLimit ?? '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>`}
    ${(u.recentSignins || []).length ? `<div class="section-title">Recent sign-ins</div><div class="list">${u.recentSignins.map(signinRow).join('')}</div>` : ''}
    ${u.rank === 'admin' && !isOwner() ? `${u.udid ? '<div class="actions" style="margin-top:12px"><button class="btn block" id="uCopy">Copy UDID</button></div>' : ''}` : `<div class="actions" style="margin-top:12px">
      ${u.udid ? '<button class="btn block" id="uCopy">Copy UDID</button>' : ''}
      <button class="btn block" id="uReset">Reset password</button>
      <button class="btn block" id="uSignOut">Sign them out everywhere</button>
      ${u.udid ? '<button class="btn block" id="uUnlink">Unlink iPhone</button>' : ''}
      <button class="btn block" id="uToggle">${u.disabled ? 'Turn account on' : 'Turn account off'}</button>
      <button class="btn block danger" id="uDelete">Delete account</button>
    </div>`}`, (el) => {
    const patch = async (body, msg) => {
      try { await api('PATCH', `/api/users/${u.id}`, body); toast(msg); closeSheet(); await refresh(); } catch (e) { toast(e.message, true); }
    };
    if ($('#uCopy', el)) $('#uCopy', el).onclick = () => copy(u.udid, 'UDID copied');
    if ($('#uRank', el)) {
      $('#uRank', el).onchange = (e) => {
        const rank = e.target.value || null;
        patch({ rank }, rank ? `${u.username} is now ${rank === 'admin' ? 'an admin ⭐' : 'a tester 🧪'}` : `${u.username} is a member again`);
      };
    }
    if (!$('#uReset', el)) return; // an admin looking at another admin: nothing to change
    $('#uReset', el).onclick = () => {
      const pw = prompt(`New password for ${u.username} (6+ characters)`);
      if (pw) patch({ password: pw }, 'Password reset — they\'ll need to sign in again');
    };
    if ($('#uUnlink', el)) $('#uUnlink', el).onclick = () => patch({ unlinkDevice: true }, 'iPhone unlinked');
    $('#uSignOut', el).onclick = () => patch({ signOut: true }, `${u.username} is signed out on every device`);
    $('#uLimit', el).onchange = async (e) => {
      try { await api('PATCH', `/api/users/${u.id}`, { signLimit: e.target.value === '' ? null : Number(e.target.value) }); await refresh(); toast('Saved'); } catch (err) { toast(err.message, true); }
    };
    $('#uToggle', el).onclick = () => patch({ disabled: !u.disabled }, u.disabled ? 'Account turned on' : 'Account turned off');
    $('#uDelete', el).onclick = async () => {
      if (!confirm(`Delete ${u.username}? Their certificates and signed apps are removed too.`)) return;
      try { await api('DELETE', `/api/users/${u.id}`); closeSheet(); toast('Account deleted'); await refresh(); } catch (e) { toast(e.message, true); }
    };
  });
}

// ---------- bug reports (testers & admins send them; you and admins answer) ----------
const BUG_STATUS = { open: ['🐞 Open', ''], fixed: ['✅ Fixed', 'good'], wontfix: ['✕ Won\'t fix', 'bad'] };
function bugRow(b) {
  const [label, cls] = BUG_STATUS[b.status] || BUG_STATUS.open;
  return `<button class="row" data-act="bug" data-id="${b.id}">
    <span class="row-main"><span class="row-title">${esc(b.appName || 'General')}</span>
      <span class="row-sub">${isStaff() ? `${esc(b.username || '?')} · ` : ''}${ago(b.createdAt)} · ${esc(b.text.split('\n')[0].slice(0, 80))}</span></span>
    <span class="badge ${cls}">${label}</span></button>`;
}
function reportBugSheet(appId) {
  const a = appId && state.apps.find((x) => x.id === appId);
  openSheet(`
    <h2>🐞 Report a bug</h2>
    <p class="hint" style="margin-top:-6px">It goes straight to the owner${isAdmin() ? '' : ' and admins'}. Say what you did and what went wrong.</p>
    <div class="field"><label>App</label>
      <select id="bgApp"><option value="">Mango Signer itself / general</option>${state.apps.map((x) => `<option value="${x.id}" ${a && a.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
    <div class="field"><label>What happened?</label><textarea id="bgText" placeholder="e.g. Crashes when I open the settings page"></textarea></div>
    <button class="btn primary big block" id="bgSend">Send Report</button>`, (el) => {
    $('#bgSend', el).onclick = async () => {
      try {
        await api('POST', '/api/bugs', { text: $('#bgText', el).value, appId: $('#bgApp', el).value || null });
        closeSheet(); toast('Thanks! Report sent 🐞'); await refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
}
function bugSheet(id) {
  const b = (state.bugs || []).find((x) => x.id === id);
  if (!b) return;
  const app = b.appId && state.apps.find((x) => x.id === b.appId);
  openSheet(`
    <h2>🐞 ${esc(b.appName || 'General')}</h2>
    <dl class="kv">
      ${isStaff() ? `<dt>From</dt><dd>${esc(b.username || '?')}</dd>` : ''}
      <dt>Sent</dt><dd>${ago(b.createdAt)}</dd>
      <dt>Status</dt><dd>${(BUG_STATUS[b.status] || BUG_STATUS.open)[0]}</dd>
      ${b.device ? `<dt>Device</dt><dd>${esc(b.device)}</dd>` : ''}
    </dl>
    <p class="desc">${esc(b.text)}</p>
    ${b.reply ? `<p class="setup-note">💬 ${esc(b.reply)}</p>` : ''}
    ${app ? `<button class="btn block" id="bgOpen">Open ${esc(app.name)}</button>` : ''}
    ${isStaff() ? `
      <div class="field" style="margin-top:12px"><label>Reply (optional)</label><input type="text" id="bgReply" value="${esc(b.reply || '')}" placeholder="e.g. Fixed in the next version"></div>
      <div class="card-actions">
        <button class="btn" id="bgFixed">✅ Fixed</button>
        <button class="btn" id="bgWont">✕ Won't fix</button>
        <button class="btn" id="bgReopen">Reopen</button>
      </div>` : ''}
    <button class="btn block danger" id="bgDel" style="margin-top:8px">Delete report</button>`, (el) => {
    if ($('#bgOpen', el)) $('#bgOpen', el).onclick = () => appSheet(app.id);
    const set = async (status) => {
      try { await api('PATCH', `/api/bugs/${b.id}`, { status, reply: $('#bgReply', el).value }); await refresh(); toast('Saved'); closeSheet(); } catch (e) { toast(e.message, true); }
    };
    if ($('#bgFixed', el)) $('#bgFixed', el).onclick = () => set('fixed');
    if ($('#bgWont', el)) $('#bgWont', el).onclick = () => set('wontfix');
    if ($('#bgReopen', el)) $('#bgReopen', el).onclick = () => set('open');
    $('#bgDel', el).onclick = async () => {
      if (!confirm('Delete this report?')) return;
      try { await api('DELETE', `/api/bugs/${b.id}`); await refresh(); toast('Deleted'); closeSheet(); } catch (e) { toast(e.message, true); }
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
    ownerpw: ['The owner account signs in with the password only (iPhone sign-in is for customers)', true],
    verify: ["Couldn't confirm that was really your iPhone, so sign in with your username and password this time", true],
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

// Keep alerts and the library fresh while the app is open (skipped while a sheet or upload is open).
setInterval(() => {
  if (document.visibilityState === 'visible' && !$('#app').classList.contains('hidden') && $('#sheet').classList.contains('hidden') && !uploadFile.active) refresh().catch(() => {});
}, 3 * 60_000);

checkForUpdate();
boot().catch((e) => toast(e.message, true));
