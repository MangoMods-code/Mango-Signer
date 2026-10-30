// Mango Signer — front end
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = {
  tab: 'library', account: null, apps: [], certs: [], signed: [], users: [], invites: [], settings: {}, server: {},
  udidState: null,
};
const isOwner = () => state.account && state.account.role === 'owner';

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
      if (xhr.status === 401) { showLogin(); return reject(new Error('Please sign in')); }
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

function iconHtml(src, name, big = false) {
  const letter = esc((name || '?').trim().charAt(0).toUpperCase());
  const cls = 'app-icon' + (big ? ' big' : '');
  if (!src) return `<div class="${cls}">${letter}</div>`;
  return `<img class="${cls}" src="${esc(src)}" alt="" onerror="this.outerHTML='<div class=&quot;${cls}&quot;>${letter}</div>'">`;
}
const appIcon = (a, big) => iconHtml(a.hasIcon ? `/api/apps/${a.id}/icon` : null, a.name, big);
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
};
const TAB_ICONS = {
  library: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
  signed: '<svg viewBox="0 0 24 24"><path d="M12 3v11m0 0-4-4m4 4 4-4"/><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3"/></svg>',
  certs: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z"/><path d="m8.8 12 2.2 2.2 4.4-4.4"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20c0-2.8-1.6-4.9-4-5.7"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
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
function tabsFor() {
  return isOwner()
    ? [['library', 'Library'], ['signed', 'Signed'], ['certs', 'Certificates'], ['users', 'Users'], ['settings', 'Settings']]
    : [['library', 'Apps'], ['signed', 'Signed'], ['certs', 'Certificates'], ['settings', 'Account']];
}

function renderTabs() {
  const tabs = tabsFor();
  const nav = $('#tabs');
  nav.style.setProperty('--tab-count', tabs.length);
  nav.innerHTML = tabs.map(([key, label]) => `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}">${TAB_ICONS[key]}<span>${label}</span></button>`).join('');
  nav.querySelectorAll('button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
}

function render() {
  if (!tabsFor().some(([k]) => k === state.tab)) state.tab = 'library';
  const title = Object.fromEntries(tabsFor())[state.tab];
  $('#pageTitle').textContent = state.tab === 'library' && !isOwner() ? 'App Library' : title;
  renderTabs();
  const top = $('#topAction');
  const actions = {
    library: isOwner() ? addAppSheet : null,
    certs: addCertSheet,
    users: newInviteSheet,
  };
  top.innerHTML = actions[state.tab] ? ICONS.plus : '';
  top.onclick = actions[state.tab] || null;
  const view = $('#view');
  view.innerHTML = { library: renderLibrary, signed: renderSigned, certs: renderCerts, users: renderUsers, settings: renderSettings }[state.tab]();
  bindView(view);
}

function renderLibrary() {
  if (!state.apps.length) {
    return isOwner()
      ? `<div class="empty">${ICONS.box}<h3>No apps yet</h3><p>Add an .ipa from Files or paste a download link. Apps you add show up in the App Library for everyone you invite.</p>
        <button class="btn primary" data-act="add-app">Add App</button></div>`
      : `<div class="empty">${ICONS.box}<h3>No apps yet</h3><p>The owner hasn't added any apps. Check back soon!</p></div>`;
  }
  const setup = !isOwner() && !state.certs.length
    ? `<p class="warning" data-act="go-certs" style="margin:0 0 12px;cursor:pointer">Add your certificate in the Certificates tab to start signing →</p>` : '';
  return setup + `<div class="list">${state.apps.map((a) => `
    <div class="row" data-act="app" data-id="${a.id}">
      ${appIcon(a)}
      <div class="row-main">
        <div class="row-title">${esc(a.name)}${isOwner() && !a.published ? '<span class="badge">Hidden</span>' : ''}</div>
        <div class="row-sub">${esc(a.version || '—')} · ${esc(a.description ? a.description.split('\n')[0] : a.bundleId)}</div>
        <div class="row-sub">${fmtSize(a.size)}</div>
      </div>
      <button class="pill" data-act="sign" data-id="${a.id}">Sign</button>
    </div>`).join('')}</div>`;
}

function renderSigned() {
  if (!state.signed.length) {
    return `<div class="empty">${ICONS.down}<h3>Nothing signed yet</h3><p>Signed apps show up here, ready to install.</p>
      <button class="btn primary" data-act="go-library">Go to ${isOwner() ? 'Library' : 'App Library'}</button></div>`;
  }
  const limit = !isOwner() ? `<p class="hint" style="margin:0 4px 10px">Your newest ${state.settings.maxSignedPerUser || 10} signed apps are kept.</p>` : '';
  return limit + `<div class="list">${state.signed.map((s) => `
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
    const leftBadge = left === null || left < 0 ? '' : `<span class="badge ${left < 14 ? 'warn' : 'mango'}">${left} days left</span>`;
    let deviceNote = '';
    if (c.deviceIncluded === false) deviceNote = '<p class="warning bad">Your iPhone isn\'t in this profile, so apps signed with it won\'t install on it. Add your UDID to the profile in your Apple Developer account.</p>';
    else if (c.deviceIncluded === null && !state.account.udid && c.profile.type !== 'Enterprise') deviceNote = '<p class="hint" style="margin-top:8px">Link your iPhone in ' + (isOwner() ? 'Settings' : 'Account') + ' to check if it\'s in this profile.</p>';
    return `<div class="card">
      <div class="card-head"><h3>${esc(c.label)}</h3>${c.isDefault ? '<span class="badge mango">Default</span>' : ''}</div>
      <div class="badges">${certStatusBadge(c)}<span class="badge">${esc(c.profile.type)}</span>${leftBadge}${c.deviceIncluded === true && c.profile.type !== 'Enterprise' ? '<span class="badge good">Your iPhone ✓</span>' : ''}</div>
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
      ${deviceNote}
      <div class="card-actions">
        <button class="btn" data-act="check-cert" data-id="${c.id}">Check</button>
        ${c.isDefault ? '' : `<button class="btn" data-act="default-cert" data-id="${c.id}">Make Default</button>`}
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
  return `<div class="section-title" style="margin-top:4px">Invite codes</div>${invites}<div class="section-title">People (${state.users.length})</div>${users}`;
}

function accountSection() {
  const a = state.account;
  return `
    <div class="section-title">Account</div>
    <div class="list">
      <div class="setting"><span>Username</span><span class="value">${esc(a.username)}</span></div>
      <div class="setting"><span>iPhone</span><span class="value">${a.udid ? `${esc(a.deviceName || 'iPhone')}<br><span class="mono">${esc(shortUdid(a.udid))}</span>` : 'Not linked'}</span></div>
      ${a.udid ? '<button class="row" data-act="unlink-device"><span class="row-main" style="color:var(--red);font-weight:600">Unlink iPhone</span></button>'
        : '<a class="row" href="/udid/profile.mobileconfig?intent=link" style="text-decoration:none"><span class="row-main" style="color:var(--mango);font-weight:600">Link this iPhone</span></a>'}
      ${!isOwner() ? '<button class="row" data-act="change-password"><span class="row-main" style="font-weight:600">Change Password</span></button>' : ''}
      ${state.server.passwordSet !== false ? '<button class="row" data-act="logout"><span class="row-main" style="color:var(--red);font-weight:600">Log Out</span></button>' : ''}
    </div>
    <p class="hint" style="margin:8px 4px 0">${a.udid ? 'Your iPhone can sign in without a password, and Mango checks whether it\'s in your profiles.' : 'Linking downloads a quick profile: open Settings › Profile Downloaded › Install, and you\'ll come back here.'}</p>`;
}

function renderSettings() {
  if (!isOwner()) {
    return `${accountSection()}<p class="footer-note">🥭 Mango Signer ${esc(state.server.version || '')}</p>`;
  }
  const s = state.server;
  const z = state.settings.zipLevel ?? 6;
  return `
    ${!s.https ? '<p class="warning bad">Your server isn\'t on HTTPS, so iOS will refuse to install apps. On Railway, generate a public domain for the service.</p>' : ''}
    ${!s.passwordSet ? '<p class="warning">No APP_PASSWORD is set, so anyone with your link has owner access. Add an APP_PASSWORD variable on Railway.</p>' : ''}
    <div class="section-title">Server</div>
    <div class="list">
      <div class="setting"><span>Address</span><span class="value">${esc(s.baseUrl)}</span></div>
      <div class="setting"><span>Signing engine</span><span class="value">${s.zsign ? 'zsign ' + esc(s.zsign) : '<span style="color:var(--red)">Not installed</span>'}</span></div>
      <div class="setting"><span>Storage used</span><span class="value">${fmtSize(s.storage)}</span></div>
      <div class="setting"><span>Version</span><span class="value">${esc(s.version)}</span></div>
    </div>
    <div class="section-title">Signing</div>
    <div class="list">
      <div class="setting"><span>IPA compression</span>
        <select data-act="zip-level">${[0, 1, 3, 6, 9].map((n) => `<option value="${n}" ${n === Number(z) ? 'selected' : ''}>${n === 0 ? 'None (fastest)' : n === 9 ? 'Max (smallest)' : 'Level ' + n}</option>`).join('')}</select>
      </div>
    </div>
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
      <div class="setting"><span>Your signed apps</span><span class="value">${state.signed.length}</span></div>
      <div class="setting"><span>Users</span><span class="value">${state.users.length}</span></div>
    </div>
    ${accountSection()}
    <p class="footer-note">🥭 Mango Signer · signing powered by zsign</p>`;
}

function bindView(view) {
  view.querySelectorAll('[data-stop]').forEach((el) => el.addEventListener('click', (e) => e.stopPropagation()));
  view.querySelectorAll('[data-act]').forEach((el) => {
    const act = el.dataset.act;
    const idv = el.dataset.id;
    const saveSetting = (body, msg = 'Saved') => api('PATCH', '/api/settings', body).then((d) => { state.settings = d.settings; toast(msg); }).catch((e) => toast(e.message, true));
    if (act === 'zip-level') { el.onchange = () => saveSetting({ zipLevel: Number(el.value) }); return; }
    if (act === 'max-signed') { el.onchange = () => saveSetting({ maxSignedPerUser: Number(el.value) }); return; }
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
        'check-cert': () => checkCert(idv, el),
        'default-cert': () => makeDefault(idv),
        'delete-cert': () => deleteCert(idv),
        'new-invite': newInviteSheet,
        invite: () => inviteSheet(idv),
        user: () => userSheet(idv),
        'unlink-device': unlinkDevice,
        'change-password': changePasswordSheet,
        logout,
      }[act] || (() => {}))();
    };
  });
}

function switchTab(tab) {
  state.tab = tab;
  render();
  window.scrollTo(0, 0);
}

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
  const owner = isOwner();
  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>${esc(a.name)}</h2><div class="row-sub">${esc(a.bundleId)}</div></div></div>
    ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ''}
    <dl class="kv">
      <dt>Version</dt><dd>${esc(a.version || '—')}${a.build && a.build !== a.version ? ` (${esc(a.build)})` : ''}</dd>
      <dt>Minimum iOS</dt><dd>${esc(a.minOS || '—')}</dd>
      <dt>Size</dt><dd>${fmtSize(a.size)}</dd>
      <dt>Extensions</dt><dd>${a.extensions || 0}${a.hasWatch ? ' + Watch app' : ''}</dd>
      <dt>Added</dt><dd>${ago(a.addedAt)}</dd>
    </dl>
    ${owner ? `<div class="group" style="margin-top:12px">${toggle('aPub', 'Show in App Library', 'Everyone you invite can sign and install it', a.published)}</div>` : ''}
    <div class="actions">
      <button class="btn primary big" id="aSign">Sign</button>
      ${owner ? `<button class="btn block" id="aEdit">Edit name &amp; description</button>
      <a class="btn block" href="/api/apps/${a.id}/download">Download original .ipa</a>
      <button class="btn block danger" id="aDelete">Delete</button>` : ''}
    </div>`, (el) => {
    $('#aSign', el).onclick = () => signSheet(a.id);
    if (!owner) return;
    $('#aPub', el).onchange = async (e) => {
      try { await api('PATCH', `/api/apps/${a.id}`, { published: e.target.checked }); a.published = e.target.checked; toast(e.target.checked ? 'Shown in App Library' : 'Hidden from App Library'); render(); } catch (err) { toast(err.message, true); }
    };
    $('#aEdit', el).onclick = () => editAppSheet(a);
    $('#aDelete', el).onclick = async () => {
      if (!confirm(`Delete ${a.name} from the library? People who already installed it keep it.`)) return;
      try { await api('DELETE', `/api/apps/${a.id}`); closeSheet(); toast('Deleted'); await refresh(); } catch (e) { toast(e.message, true); }
    };
  });
}

function editAppSheet(a) {
  openSheet(`
    <h2>Edit ${esc(a.name)}</h2>
    <div class="field"><label>Name in the library</label><input type="text" id="eName" value="${esc(a.name)}"></div>
    <div class="field"><label>Description</label><textarea id="eDesc" placeholder="What it is, what's tweaked, any tips…">${esc(a.description || '')}</textarea></div>
    <button class="btn primary big block" id="eSave">Save</button>`, (el) => {
    $('#eSave', el).onclick = async () => {
      try {
        await api('PATCH', `/api/apps/${a.id}`, { name: $('#eName', el).value, description: $('#eDesc', el).value });
        closeSheet(); toast('Saved'); await refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// ---------- signing ----------
function toggle(id, label, sub = '', checked = false) {
  return `<label class="toggle-row"><div class="row-main">${label}${sub ? `<div class="row-sub" style="white-space:normal">${sub}</div>` : ''}<div class="ent-warn hidden" id="${id}Warn"></div></div>
    <span class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></span></label>`;
}

const ENT_PRESETS = [
  { id: 'eJit', key: 'get-task-allow', label: 'JIT support', sub: 'Lets StikDebug and other JIT tools attach to the app' },
  { id: 'eMem', key: 'com.apple.developer.kernel.increased-memory-limit', label: 'Increased memory limit', sub: 'GetMoreRam — more RAM for emulators and games' },
  { id: 'eVA', key: 'com.apple.developer.kernel.extended-virtual-addressing', label: 'Extended virtual addressing', sub: 'Bigger memory space, used by some emulators' },
];
const PLIST_PRESETS = [
  { id: 'p120', key: 'CADisableMinimumFrameDurationOnPhone', label: '120Hz ProMotion', sub: 'Unlocks 120fps on ProMotion iPhones' },
  { id: 'pGame', key: 'GCSupportsGameMode', label: 'Game Mode', sub: 'Lower latency for controllers and AirPods' },
  { id: 'pFull', key: 'UIRequiresFullScreen', label: 'Require full screen', sub: 'Turns off iPad split view for the app' },
];

function editorRow(kind, i, row) {
  const types = kind === 'plist'
    ? [['bool', 'Yes / No'], ['string', 'Text'], ['number', 'Number'], ['delete', 'Remove key']]
    : [['bool', 'Yes / No'], ['string', 'Text']];
  const valueInput = row.type === 'bool'
    ? `<select data-f="value"><option value="true" ${row.value !== false ? 'selected' : ''}>YES</option><option value="false" ${row.value === false ? 'selected' : ''}>NO</option></select>`
    : row.type === 'delete' ? '<span class="hint">Key will be removed</span>'
      : `<input type="${row.type === 'number' ? 'number' : 'text'}" data-f="value" value="${esc(row.value ?? '')}" placeholder="Value" autocapitalize="off" autocorrect="off">`;
  return `<div class="editor-row" data-kind="${kind}" data-i="${i}">
    <input type="text" data-f="key" value="${esc(row.key)}" placeholder="${kind === 'plist' ? 'Info.plist key, e.g. UIFileSharingEnabled' : 'Entitlement, e.g. com.apple.developer.…'}" autocapitalize="off" autocorrect="off">
    <div class="split">
      <select data-f="type">${types.map(([v, l]) => `<option value="${v}" ${row.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${valueInput}
      <button class="x" data-f="remove" aria-label="Remove">×</button>
    </div>
  </div>`;
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
  const custom = { ent: [], plist: [] };

  openSheet(`
    <div class="sheet-head">${appIcon(a, true)}<div class="row-main"><h2>Sign ${esc(a.name)}</h2><div class="row-sub">${esc(a.version)} · ${fmtSize(a.size)}</div></div></div>

    <div class="field"><label>Certificate</label>
      <select id="sCert">${state.certs.map((c) => `<option value="${c.id}" ${c.id === def.id ? 'selected' : ''}>${esc(c.label)} · ${esc(c.profile.type)}</option>`).join('')}</select>
      <div class="hint" id="sCertHint"></div>
    </div>

    <div class="section-title">App details</div>
    <div class="field"><label>Name</label><input type="text" id="sName" placeholder="${esc(a.name)}"></div>
    <div class="field"><label>Bundle ID</label><input type="text" id="sBundle" placeholder="${esc(a.bundleId)}" autocapitalize="off" autocorrect="off"><div class="hint">Change it to install a second copy next to the original.</div></div>
    <div class="field"><label>Version</label><input type="text" id="sVersion" placeholder="${esc(a.version)}" autocapitalize="off"></div>
    <div class="field"><label>Minimum iOS</label><input type="text" id="sMin" placeholder="${esc(a.minOS || 'unchanged')}" inputmode="decimal"></div>

    <div class="section-title">Icon</div>
    <button class="file-btn" id="sIcon">${ICONS.file}<div class="row-main"><div class="row-title">Change icon</div><div class="row-sub" id="sIconName">Optional · square PNG</div></div></button>

    <div class="section-title">Entitlements</div>
    <div class="group">${ENT_PRESETS.map((p) => toggle(p.id, p.label, p.sub)).join('')}</div>
    <div id="entRows"></div>
    <button class="btn add-key" id="addEnt">+ Add custom entitlement</button>

    <div class="section-title">Info.plist</div>
    <div class="group">${PLIST_PRESETS.map((p) => toggle(p.id, p.label, p.sub)).join('')}</div>
    <div id="plistRows"></div>
    <button class="btn add-key" id="addPlist">+ Add custom Info.plist key</button>

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
    const cert = () => state.certs.find((x) => x.id === $('#sCert', el).value);

    // Warn when the profile doesn't allow a requested entitlement.
    const allowed = (key) => {
      const c = cert();
      const vals = c.profile.entitlementValues;
      if (vals) return vals[key] === true || (Array.isArray(vals[key]) && vals[key].length > 0) || (typeof vals[key] === 'string' && vals[key] !== '');
      return (c.profile.entitlements || []).includes(key);
    };
    const updateEntWarnings = () => {
      for (const p of ENT_PRESETS) {
        const on = $('#' + p.id, el).checked;
        const w = $('#' + p.id + 'Warn', el);
        const ok = allowed(p.key);
        w.textContent = on && !ok ? "Your profile doesn't allow this, so the app may not install. Turn on this capability for your App ID in your Apple Developer account." : '';
        w.classList.toggle('hidden', !(on && !ok));
      }
    };
    ENT_PRESETS.forEach((p) => { $('#' + p.id, el).onchange = updateEntWarnings; });

    const certHint = () => {
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
      $('#sCertHint', el).textContent = bits.join(' ');
      updateEntWarnings();
    };
    $('#sCert', el).onchange = certHint;
    certHint();

    // Custom key editors
    const drawRows = (kind) => {
      const box = $(kind === 'plist' ? '#plistRows' : '#entRows', el);
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
    $('#addEnt', el).onclick = () => { custom.ent.push({ key: '', type: 'bool', value: true }); drawRows('ent'); };
    $('#addPlist', el).onclick = () => { custom.plist.push({ key: '', type: 'bool', value: true }); drawRows('plist'); };

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

    $('#sGo', el).onclick = () => {
      const entitlements = ENT_PRESETS.filter((p) => $('#' + p.id, el).checked).map((p) => ({ key: p.key, type: 'bool', value: true }))
        .concat(custom.ent.filter((r) => r.key));
      const plistEdits = PLIST_PRESETS.filter((p) => $('#' + p.id, el).checked).map((p) => ({ key: p.key, type: 'bool', value: true }))
        .concat(custom.plist.filter((r) => r.key));
      const opts = {
        appId: a.id,
        certId: $('#sCert', el).value,
        name: $('#sName', el).value.trim(),
        bundleId: $('#sBundle', el).value.trim(),
        version: $('#sVersion', el).value.trim(),
        minOS: $('#sMin', el).value.trim(),
        entitlements,
        plist: plistEdits,
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
        if (j.status === 'queued') setTitle('Waiting in line…', 'Someone else is signing right now');
        else setTitle('Signing…', 'Big apps can take a minute');
        const log = $('#pLog', body);
        if (j.log.length) { log.classList.remove('hidden'); log.textContent = j.log.join('\n'); log.scrollTop = log.scrollHeight; }
      });
      closeSheet.locked = false;
      await refresh().catch(() => {});
      showSigned(result.signed, opts);
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
  const extras = [...(o.entitlements || []).map((k) => k.split('.').pop()), ...(o.plist || [])];
  openSheet(`
    <div class="sheet-head">${signedIcon(s, true)}<div class="row-main"><h2>${esc(s.name)}</h2><div class="row-sub">${esc(s.bundleId)}</div></div></div>
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
      <a class="btn primary big block" href="${esc(s.installUrl)}">Install</a>
      <button class="btn block" id="gShare">Copy install link</button>
      <a class="btn block" href="${esc(s.downloadUrl)}">Download signed .ipa</a>
      <button class="btn block" id="gResign">Sign again</button>
      <button class="btn block" id="gRelink">Reset install link</button>
      <button class="btn block danger" id="gDelete">Delete</button>
    </div>`, (el) => {
    $('#gShare', el).onclick = () => copy(s.shareUrl, 'Install link copied');
    $('#gResign', el).onclick = () => {
      if (!state.apps.find((a) => a.id === s.appId)) return toast('That app is no longer in the library', true);
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
  if (udid || invite) history.replaceState(null, '', '/');
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
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#app').classList.contains('hidden') && $('#sheet').classList.contains('hidden')) refresh().catch(() => {});
});

boot().catch((e) => toast(e.message, true));
