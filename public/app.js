// Mango Signer — front end
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = { tab: 'library', apps: [], certs: [], signed: [], settings: {}, server: {} };

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
  if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Please log in'); }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status === 401) { showLogin(); return reject(new Error('Please log in')); }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — check your connection'));
    xhr.send(file);
  });
}

async function waitJob(jobId, onUpdate) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 900));
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
function daysLeft(iso) {
  if (!iso) return null;
  return Math.floor((new Date(iso) - Date.now()) / 864e5);
}
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }

function iconHtml(src, name, big = false) {
  const letter = esc((name || '?').trim().charAt(0).toUpperCase());
  const cls = 'app-icon' + (big ? ' big' : '');
  if (!src) return `<div class="${cls}">${letter}</div>`;
  return `<img class="${cls}" src="${esc(src)}" alt="" onerror="this.outerHTML='<div class=&quot;${cls}&quot;>${letter}</div>'">`;
}
const appIcon = (a, big) => iconHtml(a.hasIcon ? `/api/apps/${a.id}/icon` : null, a.name, big);
const signedIcon = (s, big) => iconHtml(s.hasIcon ? `/i/${s.token}/icon.png` : null, s.name, big);

async function copy(text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch {
    prompt('Copy this:', text);
  }
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
};

// ---------- sheet ----------
function openSheet(html, onMount) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  $('#sheetBackdrop').classList.remove('hidden');
  $('#sheet').scrollTop = 0;
  onMount && onMount($('#sheetBody'));
}
function closeSheet() {
  if (closeSheet.locked) return;
  $('#sheet').classList.add('hidden');
  $('#sheetBackdrop').classList.add('hidden');
  $('#sheetBody').innerHTML = '';
}
$('#sheetBackdrop').onclick = closeSheet;

// ---------- render ----------
const TITLES = { library: 'Library', signed: 'Signed', certs: 'Certificates', settings: 'Settings' };

function render() {
  $('#pageTitle').textContent = TITLES[state.tab];
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const top = $('#topAction');
  top.innerHTML = state.tab === 'library' || state.tab === 'certs' ? ICONS.plus : '';
  top.onclick = state.tab === 'library' ? addAppSheet : state.tab === 'certs' ? addCertSheet : null;
  const view = $('#view');
  view.innerHTML = { library: renderLibrary, signed: renderSigned, certs: renderCerts, settings: renderSettings }[state.tab]();
  bindView(view);
}

function renderLibrary() {
  if (!state.apps.length) {
    return `<div class="empty">${ICONS.box}<h3>No apps yet</h3><p>Add an .ipa from Files or paste a download link.</p>
      <button class="btn primary" data-act="add-app">Add App</button></div>`;
  }
  return `<div class="list">${state.apps.map((a) => `
    <div class="row" data-act="app" data-id="${a.id}">
      ${appIcon(a)}
      <div class="row-main">
        <div class="row-title">${esc(a.name)}</div>
        <div class="row-sub">${esc(a.version || '—')} · ${esc(a.bundleId)}</div>
        <div class="row-sub">${fmtSize(a.size)}</div>
      </div>
      <button class="pill" data-act="sign" data-id="${a.id}">Sign</button>
    </div>`).join('')}</div>`;
}

function renderSigned() {
  if (!state.signed.length) {
    return `<div class="empty">${ICONS.down}<h3>Nothing signed yet</h3><p>Signed apps show up here, ready to install.</p>
      <button class="btn primary" data-act="go-library">Go to Library</button></div>`;
  }
  return `<div class="list">${state.signed.map((s) => `
    <div class="row" data-act="signed" data-id="${s.id}">
      ${signedIcon(s)}
      <div class="row-main">
        <div class="row-title">${esc(s.name)}</div>
        <div class="row-sub">${esc(s.version || '—')} · ${esc(s.certLabel)}</div>
        <div class="row-sub">Signed ${ago(s.signedAt)}</div>
      </div>
      <a class="pill" href="${esc(s.installUrl)}" data-stop>Get</a>
    </div>`).join('')}</div>`;
}

function certStatusBadge(c) {
  const left = daysLeft(certExpiry(c));
  if (left !== null && left < 0) return '<span class="badge bad">Expired</span>';
  const st = c.check && c.check.status;
  if (st === 'revoked') return '<span class="badge bad">Revoked</span>';
  if (st === 'valid') return '<span class="badge good">Valid</span>';
  return '<span class="badge">Status unknown</span>';
}

function renderCerts() {
  if (!state.certs.length) {
    return `<div class="empty">${ICONS.shield}<h3>No certificates</h3><p>Add your .p12 and .mobileprovision to start signing.</p>
      <button class="btn primary" data-act="add-cert">Add Certificate</button></div>`;
  }
  return state.certs.map((c) => {
    const exp = certExpiry(c);
    const left = daysLeft(exp);
    const leftBadge = left === null ? '' : left < 0 ? '' : `<span class="badge ${left < 14 ? 'warn' : 'mango'}">${left} days left</span>`;
    return `<div class="card">
      <div class="card-head"><h3>${esc(c.label)}</h3>${c.isDefault ? '<span class="badge mango">Default</span>' : ''}</div>
      <div class="badges">${certStatusBadge(c)}<span class="badge">${esc(c.profile.type)}</span>${leftBadge}</div>
      <dl class="kv">
        <dt>Certificate</dt><dd>${esc(c.p12.commonName)}</dd>
        <dt>Team</dt><dd>${esc(c.profile.teamName || '—')} ${c.profile.teamId ? `(${esc(c.profile.teamId)})` : ''}</dd>
        <dt>App ID</dt><dd>${esc(c.profile.appId || '—')}</dd>
        ${c.profile.type === 'Enterprise' ? '' : `<dt>Devices</dt><dd>${c.profile.deviceCount}</dd>`}
        <dt>Expires</dt><dd>${fmtDate(exp)}</dd>
        ${c.check && c.check.checkedAt ? `<dt>Checked</dt><dd>${ago(c.check.checkedAt)}</dd>` : ''}
      </dl>
      ${c.matches === false ? '<p class="warning bad">This .p12 isn\'t listed in the provisioning profile, so signed apps won\'t install. Use the profile made for this certificate.</p>' : ''}
      ${c.profile.type === 'App Store' ? '<p class="warning">App Store profiles can\'t install apps directly. Use a Development, Ad Hoc or Enterprise profile.</p>' : ''}
      <div class="card-actions">
        <button class="btn" data-act="check-cert" data-id="${c.id}">Check</button>
        ${c.isDefault ? '' : `<button class="btn" data-act="default-cert" data-id="${c.id}">Make Default</button>`}
        <button class="btn danger" data-act="delete-cert" data-id="${c.id}">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function renderSettings() {
  const s = state.server;
  const z = state.settings.zipLevel ?? 6;
  return `
    ${!s.https ? '<p class="warning bad">Your server isn\'t on HTTPS, so iOS will refuse to install apps. On Railway, generate a public domain for the service.</p>' : ''}
    ${!s.passwordSet ? '<p class="warning">No password is set, so anyone with your link can use your certificates. Add an APP_PASSWORD variable on Railway.</p>' : ''}
    <div class="section-title">Server</div>
    <div class="list">
      <div class="setting"><span>Address</span><span class="value">${esc(s.baseUrl)}</span></div>
      <div class="setting"><span>Signing engine</span><span class="value">${s.zsign ? 'zsign ' + esc(s.zsign) : '<span style="color:var(--red)">Not installed</span>'}</span></div>
      <div class="setting"><span>Storage used</span><span class="value">${fmtSize(s.storage)}</span></div>
    </div>
    <div class="section-title">Signing</div>
    <div class="list">
      <div class="setting"><span>IPA compression</span>
        <select data-act="zip-level">${[0, 1, 3, 6, 9].map((n) => `<option value="${n}" ${n === Number(z) ? 'selected' : ''}>${n === 0 ? 'None (fastest)' : n === 9 ? 'Max (smallest)' : 'Level ' + n}</option>`).join('')}</select>
      </div>
    </div>
    <div class="section-title">Library</div>
    <div class="list">
      <div class="setting"><span>Apps</span><span class="value">${state.apps.length}</span></div>
      <div class="setting"><span>Signed apps</span><span class="value">${state.signed.length}</span></div>
      <div class="setting"><span>Certificates</span><span class="value">${state.certs.length}</span></div>
    </div>
    ${s.passwordSet ? '<div class="section-title">Account</div><div class="list"><button class="row" data-act="logout"><span class="row-main" style="color:var(--red);font-weight:600">Log Out</span></button></div>' : ''}
    <p class="footer-note">🥭 Mango Signer · signing powered by zsign</p>`;
}

function bindView(view) {
  view.querySelectorAll('[data-stop]').forEach((el) => el.addEventListener('click', (e) => e.stopPropagation()));
  view.querySelectorAll('[data-act]').forEach((el) => {
    const act = el.dataset.act;
    const idv = el.dataset.id;
    if (act === 'zip-level') {
      el.onchange = async () => {
        try { await api('PATCH', '/api/settings', { zipLevel: Number(el.value) }); state.settings.zipLevel = Number(el.value); toast('Saved'); } catch (e) { toast(e.message, true); }
      };
      return;
    }
    el.onclick = (e) => {
      e.stopPropagation();
      ({
        'add-app': addAppSheet,
        'add-cert': addCertSheet,
        'go-library': () => switchTab('library'),
        app: () => appSheet(idv),
        sign: () => signSheet(idv),
        signed: () => signedSheet(idv),
        'check-cert': () => checkCert(idv, el),
        'default-cert': () => makeDefault(idv),
        'delete-cert': () => deleteCert(idv),
        logout: logout,
      }[act] || (() => {}))();
    };
  });
}

function switchTab(tab) {
  state.tab = tab;
  render();
  window.scrollTo(0, 0);
}
document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

// ---------- library ----------
function addAppSheet() {
  openSheet(`
    <h2>Add App</h2>
    <div class="actions">
      <button class="file-btn" id="pickIpa">${ICONS.file}<div class="row-main"><div class="row-title">Choose .ipa file</div><div class="row-sub">From Files, iCloud Drive or Downloads</div></div></button>
    </div>
    <div class="section-title">Or import from a link</div>
    <div class="field"><input type="url" id="ipaUrl" placeholder="https://example.com/app.ipa" autocapitalize="off" autocorrect="off"></div>
    <button class="btn block" id="importUrl">Import</button>
    <div id="addProgress"></div>`, (el) => {
    $('#pickIpa', el).onclick = async () => {
      const file = await pickFile('');
      if (!file) return;
      if (!/\.ipa$/i.test(file.name)) return toast('Pick an .ipa file', true);
      await runAddApp(el, async (setProgress) => {
        const up = await uploadFile(file, (p) => setProgress(p, `Uploading ${Math.round(p * 100)}%`));
        setProgress(1, 'Reading app info…');
        return api('POST', '/api/apps', { uploadId: up.uploadId, fileName: file.name });
      });
    };
    $('#importUrl', el).onclick = async () => {
      const url = $('#ipaUrl', el).value.trim();
      if (!url) return toast('Paste a link first', true);
      await runAddApp(el, async (setProgress) => {
        const { jobId } = await api('POST', '/api/apps/import', { url });
        return waitJob(jobId, (j) => setProgress(j.progress, j.progress != null ? `Downloading ${Math.round(j.progress * 100)}%` : (j.log.slice(-1)[0] || 'Downloading…')));
      });
    };
  });
}

async function runAddApp(el, work) {
  const box = $('#addProgress', el);
  el.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
  closeSheet.locked = true;
  box.innerHTML = `<div class="bar"><div></div></div><p class="muted small" id="addMsg">Starting…</p>`;
  const setProgress = (p, msg) => {
    if (p != null) $('.bar > div', box).style.width = `${Math.round(p * 100)}%`;
    if (msg) $('#addMsg', box).textContent = msg;
  };
  try {
    const { app } = await work(setProgress);
    closeSheet.locked = false;
    closeSheet();
    toast(`Added ${app.name}`);
    await refresh();
  } catch (e) {
    closeSheet.locked = false;
    el.querySelectorAll('button, input').forEach((b) => { b.disabled = false; });
    box.innerHTML = '';
    toast(e.message, true);
  }
}

function appSheet(appId) {
  const a = state.apps.find((x) => x.id === appId);
  if (!a) return;
  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>${esc(a.name)}</h2><div class="row-sub">${esc(a.bundleId)}</div></div></div>
    <dl class="kv">
      <dt>Version</dt><dd>${esc(a.version || '—')}${a.build && a.build !== a.version ? ` (${esc(a.build)})` : ''}</dd>
      <dt>Minimum iOS</dt><dd>${esc(a.minOS || '—')}</dd>
      <dt>Size</dt><dd>${fmtSize(a.size)}</dd>
      <dt>Extensions</dt><dd>${a.extensions || 0}${a.hasWatch ? ' + Watch app' : ''}</dd>
      <dt>Added</dt><dd>${ago(a.addedAt)}</dd>
    </dl>
    <div class="actions">
      <button class="btn primary big" id="aSign">Sign</button>
      <a class="btn block" href="/api/apps/${a.id}/download">Download original .ipa</a>
      <button class="btn block" id="aRename">Rename</button>
      <button class="btn block danger" id="aDelete">Delete</button>
    </div>`, (el) => {
    $('#aSign', el).onclick = () => signSheet(a.id);
    $('#aRename', el).onclick = async () => {
      const name = prompt('App name in your library', a.name);
      if (!name) return;
      try { await api('PATCH', `/api/apps/${a.id}`, { name }); closeSheet(); await refresh(); } catch (e) { toast(e.message, true); }
    };
    $('#aDelete', el).onclick = async () => {
      if (!confirm(`Delete ${a.name} from your library?`)) return;
      try { await api('DELETE', `/api/apps/${a.id}`); closeSheet(); toast('Deleted'); await refresh(); } catch (e) { toast(e.message, true); }
    };
  });
}

// ---------- signing ----------
function toggle(id, label, sub = '', checked = false) {
  return `<label class="toggle-row"><div class="row-main">${label}${sub ? `<div class="row-sub" style="white-space:normal">${sub}</div>` : ''}</div>
    <span class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></span></label>`;
}

function signSheet(appId) {
  const a = state.apps.find((x) => x.id === appId);
  if (!a) return;
  if (!state.certs.length) {
    closeSheet();
    toast('Add a certificate first', true);
    return switchTab('certs');
  }
  const def = state.certs.find((c) => c.isDefault) || state.certs[0];
  const extra = { icon: null, dylibs: [] };

  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>Sign ${esc(a.name)}</h2><div class="row-sub">${esc(a.version)} · ${fmtSize(a.size)}</div></div></div>

    <div class="field"><label>Certificate</label>
      <select id="sCert">${state.certs.map((c) => `<option value="${c.id}" ${c.id === def.id ? 'selected' : ''}>${esc(c.label)} · ${esc(c.profile.type)}</option>`).join('')}</select>
      <div class="hint" id="sCertHint"></div>
    </div>

    <div class="section-title">App details</div>
    <div class="field"><label>Name</label><input type="text" id="sName" placeholder="${esc(a.name)}"></div>
    <div class="field"><label>Bundle ID</label><input type="text" id="sBundle" placeholder="${esc(a.bundleId)}" autocapitalize="off" autocorrect="off"><div class="hint" id="sBundleHint">Change it to install a second copy next to the original.</div></div>
    <div class="field"><label>Version</label><input type="text" id="sVersion" placeholder="${esc(a.version)}" autocapitalize="off"></div>
    <div class="field"><label>Minimum iOS</label><input type="text" id="sMin" placeholder="${esc(a.minOS || 'unchanged')}" inputmode="decimal"></div>

    <div class="section-title">Icon</div>
    <button class="file-btn" id="sIcon">${ICONS.file}<div class="row-main"><div class="row-title">Change icon</div><div class="row-sub" id="sIconName">Optional · square PNG</div></div></button>

    <div class="section-title">Tweaks</div>
    <button class="file-btn" id="sDylib">${ICONS.plus}<div class="row-main"><div class="row-title">Add .dylib</div><div class="row-sub">Inject tweaks or frameworks into the app</div></div></button>
    <div class="chips" id="sDylibs"></div>
    <div class="group" style="margin-top:10px">
      ${toggle('sWeak', 'Weak injection', 'App still opens if a tweak fails to load')}
      ${toggle('sInjExt', 'Inject into extensions', 'Also load tweaks in widgets and share extensions')}
    </div>

    <div class="section-title">Options</div>
    <div class="group">
      ${toggle('sRmExt', 'Remove extensions', a.extensions ? `${a.extensions} found · fixes installs on profiles without matching App IDs` : 'None found in this app')}
      ${a.hasWatch ? toggle('sRmWatch', 'Remove Watch app', 'Smaller install, avoids Watch signing errors', true) : ''}
      ${toggle('sRmUISD', 'Remove device limits', 'Lets apps install on devices they weren\'t built for')}
      ${toggle('sDocs', 'Show in Files app', 'Turns on file sharing and document browser')}
    </div>

    <button class="btn primary big block" id="sGo">Sign App</button>
    <div style="height:6px"></div>`, (el) => {
    const certHint = () => {
      const c = state.certs.find((x) => x.id === $('#sCert', el).value);
      const left = daysLeft(certExpiry(c));
      const bits = [];
      if (c.check && c.check.status === 'revoked') bits.push('⚠️ This certificate is revoked — apps won\'t open.');
      if (left !== null && left < 0) bits.push('⚠️ This certificate has expired.');
      else if (left !== null) bits.push(`Expires in ${left} days.`);
      if (!c.profile.wildcard && c.profile.appId) {
        bits.push(`This profile only signs ${c.profile.appId}.`);
        if (!$('#sBundle', el).value) $('#sBundle', el).value = c.profile.appId;
      }
      $('#sCertHint', el).textContent = bits.join(' ');
    };
    $('#sCert', el).onchange = certHint;
    certHint();

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
        if (!/\.(dylib|framework\.zip)$/i.test(f.name) && !/\.dylib$/i.test(f.name)) { toast(`${f.name} isn't a .dylib`, true); continue; }
        extra.dylibs.push(f);
      }
      drawDylibs();
    };

    $('#sGo', el).onclick = () => {
      const opts = {
        appId: a.id,
        certId: $('#sCert', el).value,
        name: $('#sName', el).value.trim(),
        bundleId: $('#sBundle', el).value.trim(),
        version: $('#sVersion', el).value.trim(),
        minOS: $('#sMin', el).value.trim(),
        weakDylibs: $('#sWeak', el).checked,
        injectExtensions: $('#sInjExt', el).checked,
        removeExtensions: $('#sRmExt', el).checked,
        removeWatch: !!($('#sRmWatch', el) && $('#sRmWatch', el).checked),
        removeUISD: $('#sRmUISD', el).checked,
        enableDocs: $('#sDocs', el).checked,
      };
      runSign(a, opts, extra);
    };
  });
}

function runSign(a, opts, extra) {
  closeSheet.locked = true;
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
      if (extra.icon) {
        setTitle('Uploading icon…');
        const up = await uploadFile(extra.icon, setBar);
        opts.iconUploadId = up.uploadId;
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
        const log = $('#pLog', body);
        if (j.log.length) { log.classList.remove('hidden'); log.textContent = j.log.join('\n'); log.scrollTop = log.scrollHeight; }
      });
      closeSheet.locked = false;
      await refresh().catch(() => {});
      showSigned(result.signed);
    } catch (e) {
      closeSheet.locked = false;
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
    }
  })();
}

function showSigned(s) {
  const https = state.server.https;
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
  openSheet(`
    <div class="sheet-head">${signedIcon(s, true)}<div class="row-main"><h2>${esc(s.name)}</h2><div class="row-sub">${esc(s.bundleId)}</div></div></div>
    <dl class="kv">
      <dt>Version</dt><dd>${esc(s.version || '—')}</dd>
      <dt>Certificate</dt><dd>${esc(s.certLabel)}</dd>
      <dt>Signed</dt><dd>${ago(s.signedAt)}</dd>
      <dt>Works until</dt><dd>${fmtDate(s.expires)}${left !== null ? ` (${left < 0 ? 'expired' : left + ' days'})` : ''}</dd>
      <dt>Size</dt><dd>${fmtSize(s.size)}</dd>
      ${s.options && s.options.dylibs && s.options.dylibs.length ? `<dt>Tweaks</dt><dd>${esc(s.options.dylibs.join(', '))}</dd>` : ''}
    </dl>
    <div class="actions">
      <a class="btn primary big block" href="${esc(s.installUrl)}">Install</a>
      <button class="btn block" id="gShare">Copy install link</button>
      <a class="btn block" href="${esc(s.downloadUrl)}">Download signed .ipa</a>
      <button class="btn block" id="gResign">Sign again</button>
      <button class="btn block" id="gRelink">Reset install link</button>
      <button class="btn block danger" id="gDelete">Delete</button>
    </div>`, (el) => {
    $('#gShare', el).onclick = () => copy(s.shareUrl, 'Install link copied');
    $('#gResign', el).onclick = () => {
      if (!state.apps.find((a) => a.id === s.appId)) return toast('The original app was deleted from your library', true);
      signSheet(s.appId);
    };
    $('#gRelink', el).onclick = async () => {
      if (!confirm('Old install links will stop working. Continue?')) return;
      try { await api('POST', `/api/signed/${s.id}/relink`); closeSheet(); toast('New link created'); await refresh(); } catch (e) { toast(e.message, true); }
    };
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
    <p class="hint">Your password is stored encrypted on your server and only used for signing.</p>`, (el) => {
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

async function deleteCert(cid) {
  const c = state.certs.find((x) => x.id === cid);
  if (!confirm(`Delete ${c ? c.label : 'this certificate'}? Apps you already installed keep working.`)) return;
  try { await api('DELETE', `/api/certs/${cid}`); toast('Deleted'); await refresh(); } catch (e) { toast(e.message, true); }
}

async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
}

// ---------- login / boot ----------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  closeSheet.locked = false;
  closeSheet();
}

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('POST', '/api/login', { password: $('#loginPassword').value });
    $('#loginPassword').value = '';
    await boot();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
};

async function boot() {
  const s = await api('GET', '/api/session');
  if (!s.authed) return showLogin();
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await refresh();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#app').classList.contains('hidden') && $('#sheet').classList.contains('hidden')) refresh().catch(() => {});
});

boot().catch((e) => toast(e.message, true));
