// Mango Signer — a self-hosted iOS app signer, installer and App Library.
// Zero npm dependencies: Node built-ins + the zsign, openssl, zip and unzip command-line tools.
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const Store = require('./lib/store');
const ipa = require('./lib/ipa');
const plist = require('./lib/plist');
const { parseProvision, profileEntitlements, parseP12, run } = require('./lib/certs');
const { drawAppIcon } = require('./lib/png');

const VERSION = '1.1.0';
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : './data'));
const ZSIGN = process.env.ZSIGN_PATH || 'zsign';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024;
const MAX_USER_UPLOAD = 300 * 1024 * 1024; // users only upload certs, icons and tweaks
const MAX_CONCURRENT_SIGNS = Number(process.env.MAX_CONCURRENT_SIGNS || 2);

const dirs = {
  apps: path.join(DATA_DIR, 'apps'),
  certs: path.join(DATA_DIR, 'certs'),
  signed: path.join(DATA_DIR, 'signed'),
  tmp: path.join(DATA_DIR, 'tmp'),
  work: path.join(DATA_DIR, 'work'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
fs.rmSync(dirs.work, { recursive: true, force: true });
fs.mkdirSync(dirs.work, { recursive: true });

const store = new Store(path.join(DATA_DIR, 'db.json'));

// Upgrade data from older versions.
for (const c of store.certs) if (!c.ownerId) c.ownerId = 'owner';
for (const s of store.signed) if (!s.ownerId) s.ownerId = 'owner';
for (const a of store.apps) if (a.published === undefined) a.published = true;
if (store.settings.maxSignedPerUser === undefined) store.settings.maxSignedPerUser = 10;
if (store.settings.udidLogin === undefined) store.settings.udidLogin = true;
store.save();

// ---------- secrets ----------
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();
const ENC_KEY = crypto.createHash('sha256').update('mango-p12:' + SECRET).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const id = () => crypto.randomBytes(8).toString('hex');
const token = () => crypto.randomBytes(18).toString('base64url');

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
function checkPassword(pw, user) {
  const { hash } = hashPassword(pw, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- accounts & sessions ----------
const SESSION_DAYS = 90;
const OWNER = () => ({
  id: 'owner', username: 'owner', role: 'owner',
  udid: store.settings.ownerUdid || null, deviceName: store.settings.ownerDeviceName || null, sv: 0,
});
const findUser = (uid) => store.users.find((u) => u.id === uid);
function accountById(uid) {
  if (uid === 'owner') return OWNER();
  const u = findUser(uid);
  return u && !u.disabled ? { ...u, role: 'user' } : null;
}

function sign(data) { return crypto.createHmac('sha256', SECRET).update(data).digest('base64url'); }
function makeSession(account) {
  const payload = `${account.id}.${account.sv || 0}.${Date.now().toString(36)}`;
  return `${payload}.${sign('session:' + payload)}`;
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getAccount(req) {
  if (!APP_PASSWORD) return OWNER();
  const value = cookies(req).mango_session;
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [uid, sv, issued, sig] = parts;
  if (!safeEqual(sig, sign(`session:${uid}.${sv}.${issued}`))) return null;
  if (Date.now() - parseInt(issued, 36) > SESSION_DAYS * 864e5) return null;
  const acc = accountById(uid);
  if (!acc || String(acc.sv || 0) !== sv) return null;
  return acc;
}
function sessionCookie(req, account) {
  const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
  return `mango_session=${makeSession(account)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
const loginFails = new Map();
function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const f = loginFails.get(ip) || { n: 0, t: 0 };
  if (Date.now() - f.t > 60_000) f.n = 0;
  return { limited: f.n >= 6, fail: () => loginFails.set(ip, { n: f.n + 1, t: Date.now() }), ok: () => loginFails.delete(ip) };
}

// ---------- helpers ----------
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}
const json = (res, body, status = 200) => send(res, status, body);
const fail = (res, status, message) => send(res, status, { error: message });
const httpError = (status, message) => Object.assign(new Error(message), { status });
const redirect = (res, location, status = 302) => { res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' }); res.end(); };

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'Invalid JSON'); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.ipa': 'application/octet-stream', '.plist': 'text/xml; charset=utf-8',
};

async function serveFile(req, res, file, { type, download, cache = 'no-store' } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { return fail(res, 404, 'Not found'); }
  if (!st.isFile()) return fail(res, 404, 'Not found');
  const headers = {
    'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download.replace(/[^\w.\- ]/g, '_')}"`;
  const range = req.headers.range && req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(file), res).catch(() => {});
}

// Temp uploads belong to whoever uploaded them.
const uploads = new Map();
function tmpPath(uploadId, account) {
  if (!/^[a-f0-9]{16}$/.test(uploadId || '')) throw httpError(400, 'Missing or invalid upload');
  const owner = uploads.get(uploadId);
  const p = path.join(dirs.tmp, uploadId);
  if (!owner || owner !== account.id || !fs.existsSync(p)) throw httpError(400, 'Upload expired — please pick the file again');
  uploads.delete(uploadId);
  return p;
}

async function rmQuiet(p) { await fsp.rm(p, { recursive: true, force: true }).catch(() => {}); }

// ---------- zsign ----------
let zsignVersion = null;
(async () => {
  const r = await run(ZSIGN, ['-v'], { timeout: 10000 });
  if (r.code === -1) { console.log('WARNING: zsign not found — signing will not work'); return; }
  const out = (r.stdout.toString() + r.stderr).replace(/\x1b\[[0-9;]*m/g, '').trim();
  const v = out.match(/version[:\s]+v?([\w.\-]+)/i) || out.match(/(\d+\.\d+(?:\.\d+)?[\w.-]*)/);
  zsignVersion = v ? v[1] : 'installed';
  if (/^[0-9a-f]{7,40}$/i.test(zsignVersion)) zsignVersion = `build ${zsignVersion.slice(0, 7)}`;
  console.log(`zsign ready (${zsignVersion})`);
})();

function runLogged(cmd, args, job, { timeout = 20 * 60 * 1000, cwd = dirs.work } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    const timer = setTimeout(() => { job.log.push('Timed out.'); child.kill('SIGKILL'); }, timeout);
    const onData = (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (clean) job.log.push(clean.slice(0, 400));
      }
      if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); job.log.push(e.message); resolve(-1); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

function parseCheckOutput(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/\x1b\[[0-9;]*m/g, '').match(/^>>>\s*([A-Za-z ]+):\s*(.*)$/);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  const ocsp = fields.OCSP || '';
  let status = 'unknown';
  if (/revoked/i.test(ocsp)) status = 'revoked';
  else if (/valid|good/i.test(ocsp)) status = 'valid';
  return { status, ocsp, fields };
}

// ---------- jobs (with a small signing queue) ----------
const jobs = new Map();
function newJob(account) {
  const job = { id: id(), owner: account.id, status: 'running', log: [], result: null, error: null, started: Date.now() };
  jobs.set(job.id, job);
  setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref();
  return job;
}
let activeSigns = 0;
const signQueue = [];
function enqueueSign(job, work) {
  const start = async () => {
    activeSigns++;
    job.status = 'running';
    try { await work(); } finally {
      activeSigns--;
      const next = signQueue.shift();
      if (next) next();
      signQueue.forEach((fn, i) => { fn.job.log = [`Waiting in line (${i + 1} ahead of you)…`]; });
    }
  };
  if (activeSigns < MAX_CONCURRENT_SIGNS) return start();
  start.job = job;
  job.status = 'queued';
  job.log.push(`Waiting in line (${signQueue.length + 1} ahead of you)…`);
  signQueue.push(start);
}

// ---------- views ----------
const isOwner = (acc) => acc && acc.role === 'owner';
const deviceInProfile = (profile, udid) => {
  if (profile.type === 'Enterprise') return true;
  if (!udid || !Array.isArray(profile.devices)) return null;
  return profile.devices.some((d) => String(d).toLowerCase() === udid.toLowerCase());
};
function certView(c, acc) {
  return {
    id: c.id, label: c.label, createdAt: c.createdAt, isDefault: defaultCertId(acc) === c.id,
    p12: c.p12, profile: { ...c.profile, devices: undefined }, check: c.check || null, matches: c.matches,
    deviceIncluded: deviceInProfile(c.profile, acc.udid),
  };
}
function appView(a, acc) {
  if (isOwner(acc)) return { ...a };
  const { fileName, source, ...rest } = a;
  return rest;
}
function signedView(s, req) {
  const base = baseUrl(req);
  const manifest = `${base}/i/${s.token}/manifest.plist`;
  return {
    ...s,
    installUrl: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`,
    shareUrl: `${base}/i/${s.token}`,
    downloadUrl: `${base}/i/${s.token}/app.ipa`,
  };
}
function userView(u) {
  return {
    id: u.id, username: u.username, udid: u.udid || null, deviceName: u.deviceName || null,
    createdAt: u.createdAt, lastLogin: u.lastLogin || null, disabled: !!u.disabled, invite: u.invite || null,
    certCount: store.certs.filter((c) => c.ownerId === u.id).length,
    signedCount: store.signed.filter((s) => s.ownerId === u.id).length,
  };
}
function accountView(acc) {
  return { id: acc.id, username: acc.username, role: acc.role, udid: acc.udid || null, deviceName: acc.deviceName || null };
}
function defaultCertId(acc) {
  if (isOwner(acc)) return store.settings.defaultCertId;
  const u = findUser(acc.id);
  return u && u.defaultCertId;
}
function setDefaultCert(acc, certId) {
  if (isOwner(acc)) store.settings.defaultCertId = certId;
  else { const u = findUser(acc.id); if (u) u.defaultCertId = certId; }
}
const myCerts = (acc) => store.certs.filter((c) => c.ownerId === acc.id);
const mySigned = (acc) => store.signed.filter((s) => s.ownerId === acc.id);
const visibleApps = (acc) => (isOwner(acc) ? store.apps : store.apps.filter((a) => a.published));

// ---------- routing ----------
// access: 'open' (anyone), 'user' (any logged-in account), 'owner'
const routes = [];
const route = (method, pattern, handler, access = 'user') => routes.push({ method, pattern, handler, access });

// ----- session -----
route('GET', /^\/api\/session$/, (req, res) => {
  const acc = getAccount(req);
  json(res, { authed: !!acc, account: acc ? accountView(acc) : null, passwordSet: !!APP_PASSWORD, udidLogin: !!store.settings.udidLogin, version: VERSION });
}, 'open');

route('POST', /^\/api\/login$/, async (req, res) => {
  const rl = rateLimited(req);
  if (rl.limited) return fail(res, 429, 'Too many tries — wait a minute');
  const { username = '', password = '' } = await readJson(req);
  const name = String(username).trim().toLowerCase();

  if ((!name || name === 'owner') && APP_PASSWORD && safeEqual(password, APP_PASSWORD)) {
    rl.ok();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, OWNER()) });
  }
  const u = store.users.find((x) => x.username === name);
  if (u && !u.disabled && checkPassword(password, u)) {
    rl.ok();
    u.lastLogin = new Date().toISOString();
    store.save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, { ...u }) });
  }
  rl.fail();
  if (u && u.disabled) return fail(res, 403, 'This account is turned off');
  return fail(res, 401, name ? 'Wrong username or password' : 'Wrong password');
}, 'open');

route('POST', /^\/api\/signup$/, async (req, res) => {
  const rl = rateLimited(req);
  if (rl.limited) return fail(res, 429, 'Too many tries — wait a minute');
  const { username = '', password = '', invite = '', udidState = '' } = await readJson(req);
  const name = String(username).trim().toLowerCase();
  const code = String(invite).trim().toUpperCase();
  const inv = store.invites.find((i) => i.code === code);
  if (!inv || inv.uses >= inv.maxUses) { rl.fail(); return fail(res, 400, 'That invite code is invalid or used up'); }
  if (!/^[a-z0-9_.]{3,24}$/.test(name)) return fail(res, 400, 'Username must be 3–24 letters, numbers, dots or underscores');
  if (name === 'owner' || name === 'admin' || store.users.some((u) => u.username === name)) return fail(res, 400, 'That username is taken');
  if (String(password).length < 6) return fail(res, 400, 'Password must be at least 6 characters');

  let udid = null, deviceName = null;
  const st = udidState && udidStates.get(String(udidState));
  if (st && st.udid && !udidOwner(st.udid)) { udid = st.udid; deviceName = st.deviceName; udidStates.delete(String(udidState)); }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: id(), username: name, salt, hash, sv: 0, udid, deviceName,
    createdAt: new Date().toISOString(), lastLogin: new Date().toISOString(), invite: code, disabled: false,
  };
  store.users.push(user);
  inv.uses += 1;
  inv.usedBy = [...(inv.usedBy || []), name];
  store.save();
  rl.ok();
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, user) });
}, 'open');

route('POST', /^\/api\/logout$/, (req, res) => send(res, 200, { ok: true }, {
  'Set-Cookie': 'mango_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
}), 'open');

route('PATCH', /^\/api\/account$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  if (isOwner(acc)) {
    if (b.unlinkDevice) { delete store.settings.ownerUdid; delete store.settings.ownerDeviceName; }
    store.save();
    return json(res, { account: accountView(OWNER()) });
  }
  const u = findUser(acc.id);
  if (b.newPassword !== undefined) {
    if (!checkPassword(b.currentPassword || '', u)) return fail(res, 400, 'Current password is wrong');
    if (String(b.newPassword).length < 6) return fail(res, 400, 'New password must be at least 6 characters');
    Object.assign(u, hashPassword(b.newPassword));
    u.sv = (u.sv || 0) + 1;
    store.save();
    return send(res, 200, { account: accountView(u) }, { 'Set-Cookie': sessionCookie(req, u) });
  }
  if (b.unlinkDevice) { u.udid = null; u.deviceName = null; }
  store.save();
  json(res, { account: accountView({ ...u, role: 'user' }) });
});

// ----- UDID via iOS profile service -----
const udidStates = new Map();
function udidOwner(udid) {
  const low = String(udid).toLowerCase();
  if (store.settings.ownerUdid && store.settings.ownerUdid.toLowerCase() === low) return 'owner';
  const u = store.users.find((x) => x.udid && x.udid.toLowerCase() === low);
  return u ? u.id : null;
}
setInterval(() => {
  for (const [k, v] of udidStates) if (Date.now() - v.created > 20 * 60 * 1000) udidStates.delete(k);
}, 5 * 60 * 1000).unref();

route('GET', /^\/udid\/profile\.mobileconfig$/, (req, res) => {
  const intent = req.query.get('intent') === 'link' ? 'link' : 'login';
  const acc = getAccount(req);
  if (intent === 'link' && !acc) return redirect(res, '/');
  if (intent === 'login' && !store.settings.udidLogin) return redirect(res, '/?udid=off');
  const state = token();
  udidStates.set(state, { intent, uid: acc ? acc.id : null, created: Date.now() });
  const base = baseUrl(req);
  const body = plist.build({
    PayloadContent: {
      URL: `${base}/udid/callback?s=${state}`,
      DeviceAttributes: ['UDID', 'PRODUCT', 'VERSION', 'DEVICE_NAME'],
      Challenge: state,
    },
    PayloadOrganization: 'Mango Signer',
    PayloadDisplayName: 'Mango Signer — Device ID',
    PayloadDescription: 'Lets Mango Signer read this iPhone\'s UDID so you can sign in and check your certificates. Nothing is installed on your device.',
    PayloadVersion: 1,
    PayloadUUID: crypto.randomUUID().toUpperCase(),
    PayloadIdentifier: `site.mangosigner.udid.${state.slice(0, 8)}`,
    PayloadType: 'Profile Service',
  });
  send(res, 200, body, {
    'Content-Type': 'application/x-apple-aspen-config',
    'Content-Disposition': 'attachment; filename="MangoSigner.mobileconfig"',
  });
}, 'open');

route('POST', /^\/udid\/callback$/, async (req, res) => {
  const state = req.query.get('s') || '';
  const st = udidStates.get(state);
  const base = baseUrl(req);
  try {
    const buf = await readBody(req, 256 * 1024);
    const start = buf.indexOf('<?xml');
    const end = buf.indexOf('</plist>');
    if (!st || start < 0 || end < 0) throw new Error('bad');
    const data = plist.parse(buf.subarray(start, end + 8));
    if (data.CHALLENGE !== state || !/^[0-9A-Fa-f-]{20,48}$/.test(data.UDID || '')) throw new Error('bad');
    st.udid = data.UDID.toUpperCase();
    st.deviceName = data.DEVICE_NAME || data.PRODUCT || 'iPhone';
    st.product = data.PRODUCT || '';
    st.osVersion = data.VERSION || '';
  } catch {
    return redirect(res, `${base}/?udid=error`, 301);
  }
  redirect(res, `${base}/udid/done?s=${state}`, 301);
}, 'open');

route('GET', /^\/udid\/done$/, (req, res) => {
  const state = req.query.get('s') || '';
  const st = udidStates.get(state);
  if (!st || !st.udid) return redirect(res, '/?udid=error');
  const holder = udidOwner(st.udid);

  if (st.intent === 'link') {
    if (holder && holder !== st.uid) { udidStates.delete(state); return redirect(res, '/?udid=taken'); }
    if (st.uid === 'owner') { store.settings.ownerUdid = st.udid; store.settings.ownerDeviceName = st.deviceName; }
    else {
      const u = findUser(st.uid);
      if (!u) return redirect(res, '/?udid=error');
      u.udid = st.udid; u.deviceName = st.deviceName;
    }
    store.save();
    udidStates.delete(state);
    return redirect(res, '/?udid=linked');
  }

  // login
  if (holder) {
    const acc = accountById(holder);
    udidStates.delete(state);
    if (!acc) return redirect(res, '/?udid=disabled');
    if (holder !== 'owner') { findUser(holder).lastLogin = new Date().toISOString(); store.save(); }
    res.writeHead(302, { Location: '/?udid=welcome', 'Set-Cookie': sessionCookie(req, acc), 'Cache-Control': 'no-store' });
    return res.end();
  }
  return redirect(res, `/?udid=new&s=${encodeURIComponent(state)}`);
}, 'open');

route('GET', /^\/api\/udid\/pending$/, (req, res) => {
  const st = udidStates.get(req.query.get('s') || '');
  json(res, st && st.udid ? { udid: st.udid, deviceName: st.deviceName } : { udid: null });
}, 'open');

// ----- state -----
async function storageUsed() {
  let total = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(DATA_DIR);
  return total;
}

route('GET', /^\/api\/state$/, async (req, res, m, acc) => {
  const base = baseUrl(req);
  const out = {
    account: accountView(acc),
    apps: visibleApps(acc).map((a) => appView(a, acc)),
    certs: myCerts(acc).map((c) => certView(c, acc)),
    signed: mySigned(acc).map((s) => signedView(s, req)),
    server: { baseUrl: base, https: base.startsWith('https://'), version: VERSION },
  };
  if (isOwner(acc)) {
    out.settings = store.settings;
    out.users = store.users.map(userView);
    out.invites = store.invites;
    out.server = { ...out.server, zsign: zsignVersion, passwordSet: !!APP_PASSWORD, storage: await storageUsed() };
  } else {
    out.settings = { maxSignedPerUser: store.settings.maxSignedPerUser };
  }
  json(res, out);
});

// ----- uploads -----
route('POST', /^\/api\/upload$/, async (req, res, m, acc) => {
  const limit = isOwner(acc) ? MAX_UPLOAD : MAX_USER_UPLOAD;
  const uid = id();
  const dest = path.join(dirs.tmp, uid);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > limit) return cb(httpError(413, 'File is too large'));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(dest));
  } catch (e) {
    await rmQuiet(dest);
    throw e;
  }
  if (!size) { await rmQuiet(dest); return fail(res, 400, 'Empty file'); }
  uploads.set(uid, acc.id);
  json(res, { uploadId: uid, size });
});

// ----- app library (owner manages, everyone browses) -----
async function addAppFromFile(file, fileName, source) {
  let meta;
  try {
    meta = await ipa.inspect(file);
  } catch (e) {
    await rmQuiet(file);
    throw httpError(400, e.message || 'Not a valid .ipa');
  }
  const appId = id();
  await fsp.rename(file, path.join(dirs.apps, appId + '.ipa'));
  if (meta.icon) await fsp.writeFile(path.join(dirs.apps, appId + '.png'), meta.icon);
  const rec = {
    id: appId, fileName: fileName || `${meta.name}.ipa`, source: source || 'upload', addedAt: new Date().toISOString(),
    name: meta.name, bundleId: meta.bundleId, version: meta.version, build: meta.build, minOS: meta.minOS,
    extensions: meta.extensions, hasWatch: meta.hasWatch, size: meta.size, hasIcon: !!meta.icon,
    published: true, description: '',
  };
  store.apps.unshift(rec);
  store.save();
  return rec;
}

route('POST', /^\/api\/apps$/, async (req, res, m, acc) => {
  const { uploadId, fileName } = await readJson(req);
  const rec = await addAppFromFile(tmpPath(uploadId, acc), String(fileName || '').slice(0, 200), 'upload');
  json(res, { app: appView(rec, acc) });
}, 'owner');

route('POST', /^\/api\/apps\/import$/, async (req, res, m, acc) => {
  const { url } = await readJson(req);
  let u;
  try { u = new URL(String(url)); } catch { return fail(res, 400, 'Enter a valid link'); }
  if (!/^https?:$/.test(u.protocol)) return fail(res, 400, 'Link must start with http or https');
  const job = newJob(acc);
  json(res, { jobId: job.id });
  (async () => {
    const dest = path.join(dirs.tmp, id());
    try {
      job.log.push(`Downloading ${u.hostname}…`);
      const r = await fetch(u, { redirect: 'follow' });
      if (!r.ok || !r.body) throw new Error(`Download failed (HTTP ${r.status})`);
      const total = Number(r.headers.get('content-length')) || 0;
      let got = 0;
      const body = Readable.fromWeb(r.body);
      body.on('data', (c) => {
        got += c.length;
        job.progress = total ? got / total : null;
        if (got > MAX_UPLOAD) body.destroy(new Error('File is too large'));
      });
      await pipeline(body, fs.createWriteStream(dest));
      job.log.push('Reading app info…');
      const name = decodeURIComponent(path.basename(u.pathname)) || 'download.ipa';
      const rec = await addAppFromFile(dest, name, 'url');
      job.result = { app: appView(rec, acc) };
      job.status = 'done';
    } catch (e) {
      await rmQuiet(dest);
      job.error = e.message;
      job.status = 'error';
    }
  })();
}, 'owner');

route('PATCH', /^\/api\/apps\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const b = await readJson(req);
  if (typeof b.name === 'string' && b.name.trim()) app.name = b.name.trim().slice(0, 80);
  if (typeof b.description === 'string') app.description = b.description.trim().slice(0, 500);
  if (typeof b.published === 'boolean') app.published = b.published;
  store.save();
  json(res, { app: appView(app, acc) });
}, 'owner');

route('DELETE', /^\/api\/apps\/([a-f0-9]{16})$/, async (req, res, m) => {
  const i = store.apps.findIndex((a) => a.id === m[1]);
  if (i < 0) return fail(res, 404, 'App not found');
  store.apps.splice(i, 1);
  store.save();
  await rmQuiet(path.join(dirs.apps, m[1] + '.ipa'));
  await rmQuiet(path.join(dirs.apps, m[1] + '.png'));
  json(res, { ok: true });
}, 'owner');

route('GET', /^\/api\/apps\/([a-f0-9]{16})\/icon$/, (req, res, m, acc) => {
  const app = visibleApps(acc).find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'Not found');
  return serveFile(req, res, path.join(dirs.apps, m[1] + '.png'), { cache: 'private, max-age=86400' });
});

route('GET', /^\/api\/apps\/([a-f0-9]{16})\/download$/, (req, res, m) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  return serveFile(req, res, path.join(dirs.apps, m[1] + '.ipa'), { download: `${app.name} ${app.version}.ipa` });
}, 'owner');

// ----- certificates (each account has its own) -----
const ownCert = (acc, certId) => store.certs.find((c) => c.id === certId && c.ownerId === acc.id);

async function checkCert(c) {
  const dir = path.join(dirs.certs, c.id);
  const r = await run(ZSIGN, ['-C', path.join(dir, 'cert.p12'), '-p', decrypt(c.password)], { timeout: 30000 });
  if (r.code === -1) return { status: 'unavailable', ocsp: 'zsign not installed', fields: {}, checkedAt: new Date().toISOString() };
  const parsed = parseCheckOutput(r.stdout.toString() + '\n' + r.stderr);
  return { ...parsed, checkedAt: new Date().toISOString() };
}

route('POST', /^\/api\/certs$/, async (req, res, m, acc) => {
  const { p12UploadId, provUploadId, password = '', label } = await readJson(req);
  if (!isOwner(acc) && myCerts(acc).length >= 5) return fail(res, 400, 'You can have up to 5 certificates — delete one first');
  const p12File = tmpPath(p12UploadId, acc);
  const provFile = tmpPath(provUploadId, acc);

  let profile, p12;
  try {
    profile = parseProvision(await fsp.readFile(provFile));
    p12 = await parseP12(p12File, String(password));
  } catch (e) {
    await rmQuiet(p12File); await rmQuiet(provFile);
    return fail(res, 400, e.message);
  }

  const matches = profile.certs.length ? profile.certs.some((c) => c.sha1 === p12.sha1) : null;
  const certId = id();
  const dir = path.join(dirs.certs, certId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.rename(p12File, path.join(dir, 'cert.p12'));
  await fsp.rename(provFile, path.join(dir, 'profile.mobileprovision'));

  const rec = {
    id: certId, ownerId: acc.id,
    label: String(label || '').trim().slice(0, 60) || profile.teamName || p12.commonName,
    createdAt: new Date().toISOString(),
    password: encrypt(String(password)),
    p12, profile, matches,
  };
  store.certs.push(rec);
  if (!defaultCertId(acc) || !ownCert(acc, defaultCertId(acc))) setDefaultCert(acc, certId);
  store.save();

  rec.check = await checkCert(rec).catch(() => null);
  store.save();
  json(res, { cert: certView(rec, acc) });
});

route('POST', /^\/api\/certs\/([a-f0-9]{16})\/check$/, async (req, res, m, acc) => {
  const c = ownCert(acc, m[1]);
  if (!c) return fail(res, 404, 'Certificate not found');
  c.check = await checkCert(c);
  store.save();
  json(res, { cert: certView(c, acc) });
});

route('PATCH', /^\/api\/certs\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const c = ownCert(acc, m[1]);
  if (!c) return fail(res, 404, 'Certificate not found');
  const body = await readJson(req);
  if (typeof body.label === 'string' && body.label.trim()) c.label = body.label.trim().slice(0, 60);
  if (body.makeDefault) setDefaultCert(acc, c.id);
  store.save();
  json(res, { cert: certView(c, acc) });
});

async function deleteCertRecord(c) {
  const i = store.certs.indexOf(c);
  if (i >= 0) store.certs.splice(i, 1);
  await rmQuiet(path.join(dirs.certs, c.id));
}

route('DELETE', /^\/api\/certs\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const c = ownCert(acc, m[1]);
  if (!c) return fail(res, 404, 'Certificate not found');
  await deleteCertRecord(c);
  if (defaultCertId(acc) === c.id) setDefaultCert(acc, myCerts(acc)[0] ? myCerts(acc)[0].id : null);
  store.save();
  json(res, { ok: true });
});

// ----- signing -----
const KEY_RE = /^[A-Za-z0-9._\-]{1,120}$/;
function cleanEdits(list, kind) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).map((e) => {
    const key = String(e.key || '').trim();
    if (!KEY_RE.test(key)) throw httpError(400, `"${key || '(blank)'}" isn't a valid ${kind} key`);
    const type = ['bool', 'string', 'number', 'delete'].includes(e.type) ? e.type : 'string';
    let value = e.value;
    if (type === 'bool') value = value === true || value === 'true' || value === 'YES';
    else if (type === 'number') { value = Number(value); if (!Number.isFinite(value)) throw httpError(400, `${key} needs a number`); }
    else if (type === 'string') value = String(value ?? '').slice(0, 500);
    return { key, type, value };
  });
}
function applyEdits(dict, edits) {
  for (const e of edits) {
    if (e.type === 'delete') delete dict[e.key];
    else dict[e.key] = e.value;
  }
  return dict;
}

async function prepareModifiedIpa(srcIpa, work, plistEdits, job) {
  const extract = path.join(work, 'x');
  await fsp.mkdir(extract, { recursive: true });
  job.log.push('Unpacking app to edit Info.plist…');
  if (await runLogged('unzip', ['-qq', '-o', srcIpa, '-d', extract], job) !== 0) throw new Error("Couldn't unpack the app to edit Info.plist");
  const payload = path.join(extract, 'Payload');
  const appDir = (await fsp.readdir(payload)).find((n) => n.endsWith('.app'));
  if (!appDir) throw new Error('No .app found inside the .ipa');
  const infoPath = path.join(payload, appDir, 'Info.plist');
  const info = plist.parse(await fsp.readFile(infoPath));
  applyEdits(info, plistEdits);
  await fsp.writeFile(infoPath, plist.build(info));
  job.log.push(`Edited ${plistEdits.length} Info.plist value${plistEdits.length === 1 ? '' : 's'}.`);
  const out = path.join(work, 'modified.ipa');
  if (await runLogged('zip', ['-qry', '-0', out, 'Payload'], job, { cwd: extract }) !== 0) throw new Error("Couldn't repack the app");
  await rmQuiet(extract);
  return out;
}

function trimSigned(acc) {
  if (isOwner(acc)) return;
  const max = Number(store.settings.maxSignedPerUser) || 10;
  const mine = mySigned(acc);
  for (const s of mine.slice(max)) {
    store.signed.splice(store.signed.indexOf(s), 1);
    rmQuiet(path.join(dirs.signed, s.id + '.ipa'));
    rmQuiet(path.join(dirs.signed, s.id + '.png'));
  }
}

route('POST', /^\/api\/sign$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  const app = visibleApps(acc).find((a) => a.id === b.appId);
  if (!app) return fail(res, 404, 'App not found');
  const cert = ownCert(acc, b.certId || defaultCertId(acc));
  if (!cert) return fail(res, 400, 'Add a certificate first');
  if (!zsignVersion) return fail(res, 500, 'The signing engine is not installed on the server');

  const opts = {
    name: String(b.name || '').trim().slice(0, 80),
    bundleId: String(b.bundleId || '').trim(),
    version: String(b.version || '').trim(),
    minOS: String(b.minOS || '').trim(),
  };
  if (opts.bundleId && !/^[A-Za-z0-9.\-]+$/.test(opts.bundleId)) return fail(res, 400, 'Bundle ID can only use letters, numbers, dots and dashes');
  if (opts.version && !/^[0-9A-Za-z.\-]+$/.test(opts.version)) return fail(res, 400, 'Version looks invalid');
  if (opts.minOS && !/^\d+(\.\d+){0,2}$/.test(opts.minOS)) return fail(res, 400, 'Minimum iOS should look like 14.0');
  const entEdits = cleanEdits(b.entitlements, 'entitlement');
  const plistEdits = cleanEdits(b.plist, 'Info.plist');

  const iconFile = b.iconUploadId ? tmpPath(b.iconUploadId, acc) : null;
  const dylibFiles = (Array.isArray(b.dylibs) ? b.dylibs : []).slice(0, 20).map((d) => ({
    file: tmpPath(d.uploadId, acc),
    name: String(d.name || 'tweak.dylib').replace(/[^\w.\-+]/g, '_').replace(/^\.+/, '') || 'tweak.dylib',
  }));

  const job = newJob(acc);
  json(res, { jobId: job.id });

  enqueueSign(job, async () => {
    const work = path.join(dirs.work, job.id);
    const signedId = id();
    const out = path.join(dirs.signed, signedId + '.ipa');
    try {
      await fsp.mkdir(work, { recursive: true });
      const certDir = path.join(dirs.certs, cert.id);
      const provPath = path.join(certDir, 'profile.mobileprovision');
      const args = [
        '-f',
        '-k', path.join(certDir, 'cert.p12'),
        '-p', decrypt(cert.password),
        '-m', provPath,
        '-o', out,
        '-t', work,
        '-z', String(Math.min(9, Math.max(0, Number(store.settings.zipLevel ?? 6)))),
      ];
      if (opts.bundleId) args.push('-b', opts.bundleId);
      if (opts.name) args.push('-n', opts.name);
      if (opts.version) args.push('-r', opts.version);
      if (opts.minOS) args.push('-M', opts.minOS);
      if (entEdits.length) {
        const ent = applyEdits(profileEntitlements(await fsp.readFile(provPath)), entEdits);
        const entPath = path.join(work, 'entitlements.plist');
        await fsp.writeFile(entPath, plist.build(ent));
        args.push('-e', entPath);
        job.log.push(`Using custom entitlements (${entEdits.map((e) => e.key.split('.').pop()).join(', ')}).`);
      }
      if (iconFile) {
        const iconPath = path.join(work, 'icon.png');
        await fsp.rename(iconFile, iconPath);
        args.push('-I', iconPath);
      }
      for (const d of dylibFiles) {
        const p = path.join(work, d.name);
        await fsp.rename(d.file, p);
        args.push('-l', p);
      }
      if (dylibFiles.length && b.weakDylibs) args.push('-w');
      if (dylibFiles.length && b.injectExtensions) args.push('-P');
      if (b.removeExtensions) args.push('-E');
      if (b.removeWatch) args.push('-W');
      if (b.removeUISD) args.push('-U');
      if (b.enableDocs) args.push('-S');

      let input = path.join(dirs.apps, app.id + '.ipa');
      if (plistEdits.length) input = await prepareModifiedIpa(input, work, plistEdits, job);
      args.push(input);

      job.log.push(`Signing ${app.name} with ${cert.label}…`);
      const code = await runLogged(ZSIGN, args, job);
      if (code !== 0 || !fs.existsSync(out)) {
        const last = job.log.filter((l) => /error|fail|invalid|can't|cannot|unable/i.test(l)).pop();
        throw new Error(last || `Signing failed (code ${code})`);
      }

      job.log.push('Reading signed app…');
      const meta = await ipa.inspect(out);
      if (meta.icon) await fsp.writeFile(path.join(dirs.signed, signedId + '.png'), meta.icon);
      else if (app.hasIcon) await fsp.copyFile(path.join(dirs.apps, app.id + '.png'), path.join(dirs.signed, signedId + '.png'));

      const rec = {
        id: signedId, ownerId: acc.id, token: token(), appId: app.id, certId: cert.id, certLabel: cert.label,
        name: meta.name, bundleId: meta.bundleId, version: meta.version, build: meta.build,
        size: meta.size, hasIcon: !!meta.icon || !!app.hasIcon, signedAt: new Date().toISOString(),
        expires: cert.profile.expires,
        options: {
          ...opts, icon: !!iconFile, dylibs: dylibFiles.map((d) => d.name),
          entitlements: entEdits.map((e) => e.key), plist: plistEdits.map((e) => e.key),
        },
      };
      store.signed.unshift(rec);
      trimSigned(acc);
      store.save();
      job.result = { signed: signedView(rec, req) };
      job.status = 'done';
      job.log.push('Done!');
    } catch (e) {
      await rmQuiet(out);
      job.error = e.message;
      job.status = 'error';
    } finally {
      await rmQuiet(work);
    }
  });
});

route('GET', /^\/api\/jobs\/([a-f0-9]{16})$/, (req, res, m, acc) => {
  const job = jobs.get(m[1]);
  if (!job || job.owner !== acc.id) return fail(res, 404, 'Job not found');
  json(res, { status: job.status, log: job.log.slice(-30), error: job.error, result: job.result, progress: job.progress ?? null });
});

// ----- signed apps -----
const ownSigned = (acc, sid) => store.signed.find((s) => s.id === sid && s.ownerId === acc.id);

route('DELETE', /^\/api\/signed\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const s = ownSigned(acc, m[1]);
  if (!s) return fail(res, 404, 'Not found');
  store.signed.splice(store.signed.indexOf(s), 1);
  store.save();
  await rmQuiet(path.join(dirs.signed, s.id + '.ipa'));
  await rmQuiet(path.join(dirs.signed, s.id + '.png'));
  json(res, { ok: true });
});

route('POST', /^\/api\/signed\/([a-f0-9]{16})\/relink$/, async (req, res, m, acc) => {
  const s = ownSigned(acc, m[1]);
  if (!s) return fail(res, 404, 'Not found');
  s.token = token();
  store.save();
  json(res, { signed: signedView(s, req) });
});

// ----- owner: settings, users, invites -----
route('PATCH', /^\/api\/settings$/, async (req, res) => {
  const b = await readJson(req);
  if (b.zipLevel !== undefined) store.settings.zipLevel = Math.min(9, Math.max(0, Number(b.zipLevel) || 0));
  if (b.maxSignedPerUser !== undefined) store.settings.maxSignedPerUser = Math.min(100, Math.max(1, Number(b.maxSignedPerUser) || 10));
  if (b.udidLogin !== undefined) store.settings.udidLogin = !!b.udidLogin;
  store.save();
  json(res, { settings: store.settings });
}, 'owner');

function inviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(8)) s += chars[b % chars.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

route('POST', /^\/api\/invites$/, async (req, res) => {
  const b = await readJson(req);
  const inv = {
    code: inviteCode(), note: String(b.note || '').trim().slice(0, 60),
    maxUses: Math.min(1000, Math.max(1, Number(b.maxUses) || 1)), uses: 0, usedBy: [], createdAt: new Date().toISOString(),
  };
  store.invites.unshift(inv);
  store.save();
  json(res, { invite: inv, signupUrl: `${baseUrl(req)}/?invite=${inv.code}` });
}, 'owner');

route('DELETE', /^\/api\/invites\/([A-Z0-9-]{4,20})$/, (req, res, m) => {
  const i = store.invites.findIndex((x) => x.code === m[1]);
  if (i < 0) return fail(res, 404, 'Invite not found');
  store.invites.splice(i, 1);
  store.save();
  json(res, { ok: true });
}, 'owner');

route('PATCH', /^\/api\/users\/([a-f0-9]{16})$/, async (req, res, m) => {
  const u = findUser(m[1]);
  if (!u) return fail(res, 404, 'User not found');
  const b = await readJson(req);
  if (typeof b.disabled === 'boolean') { u.disabled = b.disabled; u.sv = (u.sv || 0) + 1; }
  if (b.password !== undefined) {
    if (String(b.password).length < 6) return fail(res, 400, 'Password must be at least 6 characters');
    Object.assign(u, hashPassword(b.password));
    u.sv = (u.sv || 0) + 1;
  }
  if (b.unlinkDevice) { u.udid = null; u.deviceName = null; }
  store.save();
  json(res, { user: userView(u) });
}, 'owner');

route('DELETE', /^\/api\/users\/([a-f0-9]{16})$/, async (req, res, m) => {
  const u = findUser(m[1]);
  if (!u) return fail(res, 404, 'User not found');
  for (const c of store.certs.filter((x) => x.ownerId === u.id)) await deleteCertRecord(c);
  for (const s of store.signed.filter((x) => x.ownerId === u.id)) {
    store.signed.splice(store.signed.indexOf(s), 1);
    await rmQuiet(path.join(dirs.signed, s.id + '.ipa'));
    await rmQuiet(path.join(dirs.signed, s.id + '.png'));
  }
  store.users.splice(store.users.indexOf(u), 1);
  store.save();
  json(res, { ok: true });
}, 'owner');

// ----- public install endpoints (iOS fetches these without cookies) -----
const findByToken = (t) => store.signed.find((s) => s.token === t);

route('GET', /^\/i\/([\w-]{20,40})\/manifest\.plist$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s) return fail(res, 404, 'Link expired');
  const base = baseUrl(req);
  const assets = [{ kind: 'software-package', url: `${base}/i/${s.token}/app.ipa` }];
  if (s.hasIcon) {
    assets.push({ kind: 'display-image', url: `${base}/i/${s.token}/icon.png` });
    assets.push({ kind: 'full-size-image', url: `${base}/i/${s.token}/icon.png` });
  }
  const body = plist.build({
    items: [{
      assets,
      metadata: { 'bundle-identifier': s.bundleId, 'bundle-version': s.version || '1.0', kind: 'software', title: s.name },
    }],
  });
  send(res, 200, body, { 'Content-Type': 'text/xml; charset=utf-8' });
}, 'open');

route('GET', /^\/i\/([\w-]{20,40})\/app\.ipa$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s) return fail(res, 404, 'Link expired');
  return serveFile(req, res, path.join(dirs.signed, s.id + '.ipa'), { download: `${s.name}.ipa` });
}, 'open');

route('GET', /^\/i\/([\w-]{20,40})\/icon\.png$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s) return fail(res, 404, 'Not found');
  return serveFile(req, res, path.join(dirs.signed, s.id + '.png'), { cache: 'public, max-age=86400' });
}, 'open');

route('GET', /^\/i\/([\w-]{20,40})\/?$/, async (req, res, m) => {
  const s = findByToken(m[1]);
  const tpl = await fsp.readFile(path.join(PUBLIC_DIR, 'install.html'), 'utf8');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fill = (vals) => tpl.replace(/{{(\w+)}}/g, (_, k) => esc(vals[k] ?? ''));
  if (!s) {
    return send(res, 404, fill({ title: 'Link expired', name: 'This link has expired', meta: 'Ask for a new install link.', icon: '/icon-180.png', install: '#', hidden: 'hidden' }), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  const v = signedView(s, req);
  send(res, 200, fill({
    title: `Install ${s.name}`, name: s.name,
    meta: `Version ${s.version || '?'} · ${(s.size / 1048576).toFixed(1)} MB`,
    icon: s.hasIcon ? `/i/${s.token}/icon.png` : '/icon-180.png',
    install: v.installUrl, hidden: '',
  }), { 'Content-Type': 'text/html; charset=utf-8' });
}, 'open');

// ----- icons -----
const iconCache = {};
route('GET', /^\/(?:apple-touch-icon(?:-precomposed)?|icon-(\d+))\.png$/, (req, res, m) => {
  const size = Math.min(1024, Math.max(32, Number(m[1]) || 180));
  iconCache[size] = iconCache[size] || drawAppIcon(size);
  send(res, 200, iconCache[size], { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
}, 'open');

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return fail(res, 400, 'Bad URL'); }
  req.query = url.searchParams;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  try {
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = pathname.match(r.pattern);
      if (!m) continue;
      let acc = null;
      if (r.access !== 'open') {
        acc = getAccount(req);
        if (!acc) return fail(res, 401, 'Please log in');
        if (r.access === 'owner' && !isOwner(acc)) return fail(res, 403, 'Only the owner can do that');
      }
      return await r.handler(req, res, m, acc);
    }
    if (pathname.startsWith('/api/')) return fail(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');

    // static files
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, 'Forbidden');
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(req, res, file, { cache: 'no-cache' });
    return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'), { cache: 'no-cache' });
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Something went wrong: ' + e.message);
    if (!e.status) console.error(e);
  }
});
server.requestTimeout = 0; // allow big uploads
server.headersTimeout = 60_000;

// Clean temp uploads older than a day.
setInterval(async () => {
  for (const f of await fsp.readdir(dirs.tmp).catch(() => [])) {
    const p = path.join(dirs.tmp, f);
    const st = await fsp.stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 864e5) { await rmQuiet(p); uploads.delete(f); }
  }
}, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Mango Signer ${VERSION} running on port ${PORT} (data: ${DATA_DIR})`);
  if (!APP_PASSWORD) console.log('WARNING: APP_PASSWORD is not set — anyone with the link has owner access.');
});
