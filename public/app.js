// Mango Signer — front end
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = {
  tab: 'library', account: null, apps: [], categories: [], certs: [], signed: [], users: [], invites: [], settings: {}, server: {},
  udidState: null,
  lib: { q: '', cat: 'all', sort: 'smart', select: false, selected: new Set() },
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
      ${versions.map((v, i) => whatsNewHtml(v, i === 0)).join('')}
      <button class="btn primary big block" id="wnDone" style="margin-top:14px">Got it</button>`, (el) => {
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

// Uploads a file in resumable chunks. If the connection drops it waits and continues where it left off.
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
    const { uploadId } = await api('POST', '/api/upload/start', { size: file.size });
    let received = 0;
    let failures = 0;
    const started = Date.now();
    while (received < file.size) {
      const end = Math.min(file.size, received + CHUNK);
      try {
        const { status, data } = await xhrSend('PUT', `/api/upload/${uploadId}?offset=${received}`, file.slice(received, end), (n) => {
          const done = received + n;
          onProgress && onProgress(done / file.size);
          if (onStatus) {
            const secs = (Date.now() - started) / 1000;
            const rate = done / Math.max(1, secs);
            const left = (file.size - done) / Math.max(1, rate);
            onStatus(`${fmtSize(done)} of ${fmtSize(file.size)} · ${fmtSize(rate)}/s · ${fmtTime(left)} left`);
          }
        });
        if (status === 409 && data.busy) { await sleep(1500); continue; }
        received = data.received;
        failures = 0;
      } catch (e) {
        if (e.fatal) throw e;
        failures++;
        if (failures > 30) throw new Error('Upload keeps failing — check your connection and try again');
        onStatus && onStatus(`Connection dropped — retrying (${failures})…`);
        await sleep(Math.min(15000, 1000 * failures));
        try { received = (await api('GET', `/api/upload/${uploadId}`)).received; } catch (err) { if (err.status === 404) throw err; }
      }
    }
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
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), isError ? 4200 : 2400);
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
  return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;${cls}&quot;>${letter}</div>'">`;
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

function openSheet(html, onMount) {
  const sheet = $('#sheet');
  const wasOpen = !sheet.classList.contains('hidden');
  resetSheetPosition();
  $('#sheetBody').innerHTML = html;
  sheet.classList.toggle('locked', !!closeSheet.locked);
  sheet.classList.remove('hidden');
  $('#sheetBackdrop').classList.remove('hidden');
  if (wasOpen) sheet.classList.add('no-anim'); else sheet.classList.remove('no-anim');
  sheet.scrollTop = 0;
  lockPage();
  onMount && onMount($('#sheetBody'));
}
function closeSheet() {
  if (closeSheet.locked) return;
  resetSheetPosition();
  $('#sheet').classList.add('hidden');
  $('#sheetBackdrop').classList.add('hidden');
  $('#sheetBody').innerHTML = '';
  unlockPage();
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
      setTimeout(() => { backdrop.style.transition = ''; closeSheet(); }, 210);
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
  view.innerHTML = { library: renderLibrary, signed: renderSigned, certs: renderCerts, users: renderUsers, settings: renderSettings }[state.tab]();
  bindView(view);
  if (state.tab === 'library') bindLibrary(view);
}

// ---------- library ----------
function filteredApps() {
  const { q, cat, sort } = state.lib;
  let apps = state.apps.slice();
  if (q) {
    const needle = q.toLowerCase();
    apps = apps.filter((a) => [a.name, a.bundleId, a.description, a.developer, a.notes, shownVersion(a), catLabel(a.categoryId)].some((f) => (f || '').toLowerCase().includes(needle)));
  }
  if (cat === 'featured') apps = apps.filter((a) => a.featured);
  else if (cat === 'none') apps = apps.filter((a) => !a.categoryId || !catById(a.categoryId));
  else if (cat === 'hidden') apps = apps.filter((a) => !a.published);
  else if (cat !== 'all') apps = apps.filter((a) => a.categoryId === cat);
  const by = {
    smart: (x, y) => (y.featured - x.featured) || x.name.localeCompare(y.name),
    name: (x, y) => x.name.localeCompare(y.name),
    newest: (x, y) => String(y.updatedAt || y.addedAt).localeCompare(String(x.updatedAt || x.addedAt)),
    size: (x, y) => y.size - x.size,
  };
  return apps.sort(by[sort] || by.smart);
}

function appRow(a) {
  const sel = state.lib.select;
  const checked = state.lib.selected.has(a.id);
  const sub2 = [a.developer, fmtSize(a.size)].filter(Boolean).join(' · ');
  const defaults = defaultsSummary(a.signDefaults);
  return `
    <div class="row ${checked ? 'selected' : ''}" data-act="${sel ? 'toggle-select' : 'app'}" data-id="${a.id}">
      ${sel ? `<span class="check ${checked ? 'on' : ''}">${checked ? ICONS.check : ''}</span>` : ''}
      ${appIcon(a)}
      <div class="row-main">
        <div class="row-title">${esc(a.name)}${a.featured ? '<span class="star">★</span>' : ''}${isOwner() && !a.published ? '<span class="badge">Hidden</span>' : ''}</div>
        <div class="row-sub">${esc(shownVersion(a) || '—')} · ${esc(a.description ? a.description.split('\n')[0] : a.bundleId)}</div>
        <div class="row-sub">${esc(sub2)}${defaults.length ? ` · <span class="mango-text">${esc(defaults.slice(0, 2).join(', '))}${defaults.length > 2 ? '…' : ''}</span>` : ''}</div>
      </div>
      ${sel ? '' : `<button class="pill" data-act="sign" data-id="${a.id}">Sign</button>`}
    </div>`;
}

function libraryListHtml() {
  const apps = filteredApps();
  const { q, cat } = state.lib;
  if (!state.apps.length) {
    return isOwner()
      ? `<div class="empty">${ICONS.box}<h3>No apps yet</h3><p>Add an .ipa from Files or paste a download link. Apps you add show up in the App Library for everyone you invite.</p>
        <button class="btn primary" data-act="add-app">Add App</button></div>`
      : `<div class="empty">${ICONS.box}<h3>No apps yet</h3><p>The owner hasn't added any apps. Check back soon!</p></div>`;
  }
  if (!apps.length) return `<div class="empty" style="padding:30px 20px">${ICONS.search}<h3>Nothing found</h3><p>${q ? `No apps match “${esc(q)}”.` : 'No apps in this category yet.'}</p></div>`;

  // Grouped view: featured shelf + one section per category, in your order.
  if (cat === 'all' && !q && state.lib.sort === 'smart' && !state.lib.select) {
    const featured = apps.filter((a) => a.featured);
    let html = '';
    if (featured.length) {
      html += `<div class="section-title" style="margin-top:6px">★ Featured</div><div class="shelf">${featured.map((a) => `
        <button class="shelf-card" data-act="app" data-id="${a.id}">${appIcon(a, true)}<span class="shelf-name">${esc(a.name)}</span><span class="shelf-sub">${esc(catLabel(a.categoryId))}</span></button>`).join('')}</div>`;
    }
    const groups = state.categories.map((c) => ({ title: `${c.emoji} ${c.name}`, apps: apps.filter((a) => a.categoryId === c.id) }));
    groups.push({ title: 'Other', apps: apps.filter((a) => !catById(a.categoryId)) });
    for (const g of groups.filter((x) => x.apps.length)) {
      html += `<div class="section-title">${esc(g.title)} <span class="count">${g.apps.length}</span></div><div class="list">${g.apps.map(appRow).join('')}</div>`;
    }
    return html;
  }
  return `<div class="section-title" style="margin-top:6px">${apps.length} app${apps.length === 1 ? '' : 's'}</div><div class="list">${apps.map(appRow).join('')}</div>`;
}

function renderLibrary() {
  const { q, cat, sort } = state.lib;
  const chips = [['all', 'All'], ['featured', '★ Featured'], ...state.categories.map((c) => [c.id, `${c.emoji} ${c.name}`])];
  if (isOwner()) chips.push(['none', 'Uncategorized'], ['hidden', 'Hidden']);
  const counts = (key) => {
    if (key === 'all') return state.apps.length;
    if (key === 'featured') return state.apps.filter((a) => a.featured).length;
    if (key === 'none') return state.apps.filter((a) => !catById(a.categoryId)).length;
    if (key === 'hidden') return state.apps.filter((a) => !a.published).length;
    return state.apps.filter((a) => a.categoryId === key).length;
  };
  const setup = !isOwner() && !state.certs.length
    ? `<p class="warning" data-act="go-certs" style="margin:0 0 12px;cursor:pointer">Add your certificate in the Certificates tab to start signing →</p>` : '';
  return `${setup}
    ${state.apps.length ? `
    <div class="searchbar">${ICONS.search}<input type="search" id="libSearch" placeholder="Search ${state.apps.length} apps" value="${esc(q)}" autocapitalize="off" autocorrect="off"></div>
    <div class="chips-row" id="libChips">
      ${chips.filter(([k]) => k === 'all' || counts(k) > 0 || (isOwner() && !['featured', 'none', 'hidden'].includes(k))).map(([k, l]) => `<button class="fchip ${cat === k ? 'on' : ''}" data-cat="${k}">${esc(l)} <span>${counts(k)}</span></button>`).join('')}
      ${isOwner() ? '<button class="fchip ghost" data-act="manage-cats">⚙︎ Edit</button>' : ''}
    </div>
    <div class="lib-tools">
      <select id="libSort">
        ${[['smart', 'Grouped'], ['name', 'A–Z'], ['newest', 'Newest'], ['size', 'Biggest']].map(([k, l]) => `<option value="${k}" ${sort === k ? 'selected' : ''}>Sort: ${l}</option>`).join('')}
      </select>
      ${isOwner() ? `<button class="btn small-btn" data-act="toggle-select-mode">${state.lib.select ? 'Done' : 'Select'}</button>` : ''}
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
  view.querySelectorAll('.fchip[data-cat]').forEach((b) => {
    b.onclick = () => { state.lib.cat = b.dataset.cat; saveLibPrefs(); render(); };
  });
  const sort = $('#libSort', view);
  if (sort) sort.onchange = () => { state.lib.sort = sort.value; saveLibPrefs(); render(); };
  view.querySelectorAll('[data-bulk]').forEach((b) => { b.onclick = () => bulkAction(b.dataset.bulk); });
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

function renderSigned() {
  if (!state.signed.length) {
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
      ${s.fileAvailable ? `<a class="pill" href="${esc(s.installUrl)}" data-stop>Get</a>` : `<button class="pill dim" data-act="resign" data-id="${s.id}">Re-sign</button>`}
    </div>`;
  };
  return `${notes.length ? `<p class="hint" style="margin:0 4px 10px">${notes.join(' ')}</p>` : ''}
    ${ready.length ? `<div class="section-title" style="margin-top:4px">Ready to install <span class="count">${ready.length}</span></div><div class="list">${ready.map(row).join('')}</div>` : ''}
    ${old.length ? `<div class="section-title">File removed <span class="count">${old.length}</span></div><div class="list">${old.map(row).join('')}</div>` : ''}`;
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
  return `<div class="section-title" style="margin-top:4px">Invite codes</div>${invites}<div class="section-title">People <span class="count">${state.users.length}</span></div>${users}`;
}

function accountSection() {
  const a = state.account;
  return `
    <div class="section-title">Account</div>
    <div class="list">
      <button class="row" data-act="whats-new"><span class="row-main" style="font-weight:600">✨ What's New</span><span class="value muted">V${esc(CLIENT_VERSION || state.server.version || '')} ›</span></button>
      <div class="setting"><span>Username</span><span class="value">${esc(a.username)}</span></div>
      <div class="setting"><span>iPhone</span><span class="value">${a.udid ? `${esc(a.deviceName || 'iPhone')}<br><span class="mono">${esc(shortUdid(a.udid))}</span>` : 'Not linked'}</span></div>
      ${a.udid ? '<button class="row" data-act="copy-udid"><span class="row-main" style="font-weight:600">Copy my UDID</span></button><button class="row" data-act="unlink-device"><span class="row-main" style="color:var(--red);font-weight:600">Unlink iPhone</span></button>'
        : '<a class="row" href="/udid/profile.mobileconfig?intent=link" style="text-decoration:none"><span class="row-main" style="color:var(--mango);font-weight:600">Link this iPhone</span></a>'}
      ${!isOwner() ? '<button class="row" data-act="change-password"><span class="row-main" style="font-weight:600">Change Password</span></button>' : ''}
      ${state.server.passwordSet !== false ? '<button class="row" data-act="logout"><span class="row-main" style="color:var(--red);font-weight:600">Log Out</span></button>' : ''}
    </div>
    <p class="hint" style="margin:8px 4px 0">${a.udid ? 'Your iPhone can sign in without a password, and Mango checks whether it\'s in your profiles.' : 'Linking downloads a quick profile: open Settings › Profile Downloaded › Install, and you\'ll come back here.'}</p>`;
}

function renderSettings() {
  if (!isOwner()) {
    return `${accountSection()}<p class="footer-note">🥭 Mango Signer ${esc(state.server.version || '')}<br>© 2026 MangoMods · All rights reserved</p>`;
  }
  const s = state.server;
  const b = s.storageBreakdown || {};
  const z = state.settings.zipLevel ?? 6;
  const total = s.storage || 1;
  const bar = (n, cls) => `<div class="${cls}" style="width:${Math.max(0.5, (100 * (n || 0)) / total)}%"></div>`;
  return `
    ${!s.https ? '<p class="warning bad">Your server isn\'t on HTTPS, so iOS will refuse to install apps. On Railway, generate a public domain for the service.</p>' : ''}
    ${!s.passwordSet ? '<p class="warning">No APP_PASSWORD is set, so anyone with your link has owner access. Add an APP_PASSWORD variable on Railway.</p>' : ''}
    <div class="section-title">Server</div>
    <div class="list">
      <div class="setting"><span>Address</span><span class="value">${esc(s.baseUrl)}</span></div>
      <div class="setting"><span>Signing engine</span><span class="value">${s.zsign ? 'zsign ' + esc(s.zsign) : '<span style="color:var(--red)">Not installed</span>'}</span></div>
      <div class="setting"><span>Version</span><span class="value">${esc(s.version)}</span></div>
    </div>
    <div class="section-title">Storage · ${fmtSize(s.storage)}</div>
    <div class="card">
      <div class="stack-bar">${bar(b.library, 's-lib')}${bar(b.signed, 's-signed')}${bar(b.certs, 's-certs')}${bar(b.temp, 's-temp')}</div>
      <div class="legend">
        <span><i class="s-lib"></i>Library ${fmtSize(b.library)}</span>
        <span><i class="s-signed"></i>Signed ${fmtSize(b.signed)}</span>
        <span><i class="s-certs"></i>Certs ${fmtSize(b.certs)}</span>
        <span><i class="s-temp"></i>Temp ${fmtSize(b.temp)}</span>
      </div>
      <div class="card-actions">
        <button class="btn" data-act="purge-signed">Clean signed files</button>
        <button class="btn" data-act="clear-temp">Clear temp</button>
      </div>
    </div>
    <div class="section-title">Signing</div>
    <div class="list">
      <div class="setting"><span>IPA compression</span>
        <select data-act="zip-level">${[0, 1, 3, 6, 9].map((n) => `<option value="${n}" ${n === Number(z) ? 'selected' : ''}>${n === 0 ? 'None (fastest)' : n === 9 ? 'Max (smallest)' : 'Level ' + n}</option>`).join('')}</select>
      </div>
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
        signed: () => signedSheet(idv),
        resign: () => resignFromSigned(idv),
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
  state.tab = tab;
  state.lib.select = false;
  state.lib.selected.clear();
  render();
  window.scrollTo(0, 0);
}

async function maintenance(action) {
  try { const { message } = await api('POST', '/api/maintenance', { action }); toast(message); await refresh(); } catch (e) { toast(e.message, true); }
}

// ---------- adding & updating apps ----------
function uploadProgressHtml() {
  return `<div class="bar"><div></div></div><p class="muted small" id="addMsg">Starting…</p><p class="hint" id="addSub"></p>`;
}

function addAppSheet() {
  openSheet(`
    <h2>Add App</h2>
    <div class="actions">
      <button class="file-btn" id="pickIpa">${ICONS.file}<div class="row-main"><div class="row-title">Choose .ipa file</div><div class="row-sub">From Files, iCloud Drive or Downloads. Big files resume if your connection drops.</div></div></button>
    </div>
    <div class="section-title">Or import from a link (fastest for big games)</div>
    <div class="field"><input type="url" id="ipaUrl" placeholder="https://example.com/app.ipa" autocapitalize="off" autocorrect="off"><div class="hint">Direct download links only. Dropbox links work (dl=0 is fixed for you).</div></div>
    <button class="btn block" id="importUrl">Import</button>
    <div id="addProgress"></div>`, (el) => {
    $('#pickIpa', el).onclick = async () => {
      const file = await pickFile('');
      if (!file) return;
      if (!/\.ipa$/i.test(file.name)) return toast('Pick an .ipa file', true);
      await runWithProgress(el, async (setProgress, setSub) => {
        const up = await uploadFile(file, (p) => setProgress(p, `Uploading ${Math.round(p * 100)}%`), setSub);
        setProgress(1, 'Reading app info…');
        setSub('');
        return api('POST', '/api/apps', { uploadId: up.uploadId, fileName: file.name });
      }, (app) => { toast(`Added ${app.name}`); editAppSheet(app, true); });
    };
    $('#importUrl', el).onclick = async () => {
      const url = $('#ipaUrl', el).value.trim();
      if (!url) return toast('Paste a link first', true);
      await runWithProgress(el, async (setProgress) => {
        const { jobId } = await api('POST', '/api/apps/import', { url });
        return waitJob(jobId, (j) => setProgress(j.progress, j.progress != null ? `Downloading ${Math.round(j.progress * 100)}%` : (j.log.slice(-1)[0] || 'Downloading…')));
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
  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>Update ${esc(a.name)}</h2><div class="row-sub">Now ${esc(shownVersion(a) || '—')}</div></div></div>
    <p class="muted small">Swap in a new .ipa. The name, category, description, notes, icon and default sign settings all stay the same.</p>
    <button class="file-btn" id="uPick">${ICONS.file}<div class="row-main"><div class="row-title">Choose new .ipa</div><div class="row-sub">Resumes if your connection drops</div></div></button>
    <div class="section-title">Or from a link</div>
    <div class="field"><input type="url" id="uUrl" placeholder="https://example.com/app.ipa" autocapitalize="off" autocorrect="off"></div>
    <button class="btn block" id="uImport">Update from link</button>
    <div id="addProgress"></div>`, (el) => {
    const done = (app) => { toast(`Updated to ${app.version || 'new version'}`); appSheet(app.id); };
    $('#uPick', el).onclick = async () => {
      const file = await pickFile('');
      if (!file) return;
      if (!/\.ipa$/i.test(file.name)) return toast('Pick an .ipa file', true);
      await runWithProgress(el, async (setProgress, setSub) => {
        const up = await uploadFile(file, (p) => setProgress(p, `Uploading ${Math.round(p * 100)}%`), setSub);
        setProgress(1, 'Reading app info…');
        return api('POST', `/api/apps/${a.id}/replace`, { uploadId: up.uploadId });
      }, done);
    };
    $('#uImport', el).onclick = async () => {
      const url = $('#uUrl', el).value.trim();
      if (!url) return toast('Paste a link first', true);
      await runWithProgress(el, async (setProgress) => {
        const { jobId } = await api('POST', `/api/apps/${a.id}/replace`, { url });
        return waitJob(jobId, (j) => setProgress(j.progress, j.progress != null ? `Downloading ${Math.round(j.progress * 100)}%` : (j.log.slice(-1)[0] || 'Downloading…')));
      }, done);
    };
  });
}

function appSheet(appId) {
  const a = state.apps.find((x) => x.id === appId);
  if (!a) return;
  const owner = isOwner();
  const defaults = defaultsSummary(a.signDefaults);
  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>${esc(a.name)}</h2><div class="row-sub">${esc(a.developer || a.bundleId)}</div></div></div>
    <div class="badges" style="margin-top:0">
      <span class="badge mango">${esc(catLabel(a.categoryId))}</span>
      ${a.featured ? '<span class="badge warn">★ Featured</span>' : ''}
      ${owner && !a.published ? '<span class="badge">Hidden</span>' : ''}
      <span class="badge">v${esc(shownVersion(a) || '?')}</span>
      <span class="badge">${fmtSize(a.size)}</span>
    </div>
    <button class="btn primary big block" id="aSign">Sign &amp; Install</button>
    ${defaults.length ? `<p class="hint center" style="margin-top:8px">Comes set up with: ${esc(defaults.join(' · '))}</p>` : ''}
    ${a.description ? `<div class="section-title">About</div><p class="desc">${esc(a.description)}</p>` : ''}
    ${a.notes ? `<div class="section-title">What's changed / notes</div><p class="desc">${esc(a.notes)}</p>` : ''}
    <div class="section-title">Info</div>
    <dl class="kv card" style="margin:0">
      <dt>Version</dt><dd>${esc(shownVersion(a) || '—')}${!a.versionOverride && a.build && a.build !== a.version ? ` (${esc(a.build)})` : ''}${a.versionOverride && isOwner() ? `<br><span class="muted small">file says ${esc(a.version || '?')}</span>` : ''}${a.previousVersion && a.previousVersion !== a.version ? `<br><span class="muted small">was ${esc(a.previousVersion)}</span>` : ''}</dd>
      <dt>Bundle ID</dt><dd class="mono">${esc(a.bundleId)}</dd>
      <dt>Minimum iOS</dt><dd>${esc(a.minOS || '—')}</dd>
      <dt>Size</dt><dd>${fmtSize(a.size)}</dd>
      <dt>Extensions</dt><dd>${a.extensions || 0}${a.hasWatch ? ' + Watch app' : ''}</dd>
      <dt>${a.updatedAt && a.updatedAt !== a.addedAt ? 'Updated' : 'Added'}</dt><dd>${ago(a.updatedAt || a.addedAt)}</dd>
    </dl>
    ${owner ? `
    <div class="group" style="margin-top:14px">
      ${toggle('aPub', 'Show in App Library', 'Everyone you invite can sign and install it', a.published)}
      ${toggle('aFeat', 'Featured', 'Pinned to the top of the library', a.featured)}
    </div>
    <div class="actions">
      <button class="btn block" id="aEdit">Edit details &amp; sign settings</button>
      <button class="btn block" id="aUpdate">Update IPA (new version)</button>
      <a class="btn block" href="/api/apps/${a.id}/download">Download original .ipa</a>
      <button class="btn block danger" id="aDelete">Delete</button>
    </div>` : ''}`, (el) => {
    $('#aSign', el).onclick = () => signSheet(a.id);
    if (!owner) return;
    const flip = (id, field, on, off) => {
      $(id, el).onchange = async (e) => {
        try { await api('PATCH', `/api/apps/${a.id}`, { [field]: e.target.checked }); a[field] = e.target.checked; toast(e.target.checked ? on : off); render(); } catch (err) { toast(err.message, true); }
      };
    };
    flip('#aPub', 'published', 'Shown in App Library', 'Hidden from App Library');
    flip('#aFeat', 'featured', 'Featured ★', 'No longer featured');
    $('#aEdit', el).onclick = () => editAppSheet(a);
    $('#aUpdate', el).onclick = () => updateIpaSheet(a);
    $('#aDelete', el).onclick = async () => {
      if (!confirm(`Delete ${a.name} from the library? People who already installed it keep it.`)) return;
      try { await api('DELETE', `/api/apps/${a.id}`); closeSheet(); toast('Deleted'); await refresh(); } catch (e) { toast(e.message, true); }
    };
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
    ${summary.length ? `<p class="setup-note">✨ Set up for you: ${esc(summary.join(' · '))}</p>` : ''}
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
        <a class="btn primary big block" href="${esc(s.installUrl)}">Install</a>
        <button class="btn block" id="okShare">Copy install link</button>
        <button class="btn block" id="okDone">Done</button>
      </div>
      ${jit ? '<p class="warning" style="text-align:left">JIT is allowed for this app. Open StikDebug (or your JIT tool) and turn on JIT for it each time you launch it.</p>' : ''}
      <p class="hint" style="margin-top:12px">After tapping Install, go to your home screen to watch it download. For enterprise certs you may need to trust it in Settings › General › VPN &amp; Device Management.</p>
    </div>`, (el) => {
    $('#okShare', el).onclick = () => copy(s.shareUrl, 'Install link copied');
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
      ${s.fileAvailable ? `<a class="btn primary big block" href="${esc(s.installUrl)}">Install</a>
      <button class="btn block" id="gShare">Copy install link</button>
      <a class="btn block" href="${esc(s.downloadUrl)}">Download signed .ipa</a>` : ''}
      <button class="btn ${s.fileAvailable ? '' : 'primary big'} block" id="gResign">Sign again</button>
      ${s.fileAvailable ? '<button class="btn block" id="gRelink">Reset install link</button>' : ''}
      <button class="btn block danger" id="gDelete">Delete</button>
    </div>`, (el) => {
    if ($('#gShare', el)) $('#gShare', el).onclick = () => copy(s.shareUrl, 'Install link copied');
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
  await refresh();
  maybeShowWhatsNew();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#app').classList.contains('hidden') && $('#sheet').classList.contains('hidden') && !uploadFile.active) refresh().catch(() => {});
});

checkForUpdate();
boot().catch((e) => toast(e.message, true));
