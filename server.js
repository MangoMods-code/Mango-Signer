// Mango Signer — a self-hosted iOS app signer, installer and App Library.
// Zero npm dependencies: Node built-ins + the zsign, openssl, zip and unzip command-line tools.
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const Store = require('./lib/store');
const ipa = require('./lib/ipa');
const plist = require('./lib/plist');
const { parseProvision, profileEntitlements, parseP12, run } = require('./lib/certs');
const { drawAppIcon } = require('./lib/png');
const { qrSvg } = require('./lib/qr');
const sources = require('./lib/sources');
const github = require('./lib/github');

const WHATS_NEW = require('./lib/whats-new');
const VERSION = WHATS_NEW[0].version; // the real version of this code
// Changes whenever any app file changes, so open apps know to refresh even if the version label is the same.
const BUILD_ID = crypto.createHash('sha256')
  .update([VERSION, ...['server.js', 'public/app.js', 'public/styles.css', 'public/index.html'].map((f) => {
    try { return fs.readFileSync(path.join(__dirname, f)); } catch { return ''; }
  })].join('|'))
  .digest('hex').slice(0, 10);
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
if (store.settings.signedRetentionDays === undefined) store.settings.signedRetentionDays = 7;
if (store.settings.deleteAfterInstall === undefined) store.settings.deleteAfterInstall = true;
if (!store.categories.length && !store.settings.categoriesSeeded) {
  [['🎮', 'Games'], ['🕹️', 'Emulators'], ['💬', 'Social'], ['🎵', 'Music & Video'], ['🧰', 'Utilities'], ['✨', 'Tweaked']]
    .forEach(([emoji, name], i) => store.categories.push({ id: crypto.randomBytes(8).toString('hex'), name, emoji, order: i }));
  store.settings.categoriesSeeded = true;
}
for (const a of store.apps) {
  if (a.categoryId === undefined) a.categoryId = null;
  if (a.featured === undefined) a.featured = false;
  if (!a.signDefaults) a.signDefaults = {};
  if (!Array.isArray(a.tags)) a.tags = [];
  if (!Array.isArray(a.screenshots)) a.screenshots = [];
  if (!a.votes || typeof a.votes !== 'object') a.votes = {};
  if (typeof a.installCount !== 'number') a.installCount = 0;
}
store.save();

const displayVersion = () => VERSION;
delete store.settings.versionLabel;

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
  let data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  const extra = {};
  // Big JSON (a library with whole app sources in it) is gzipped — about 20x smaller over cell data.
  const req = res.req;
  if (!isBuf && typeof body !== 'string' && data.length > 8192 && req && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    data = zlib.gzipSync(data, { level: 6 });
    extra['Content-Encoding'] = 'gzip';
    extra.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, {
    'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    ...extra,
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

async function serveFile(req, res, file, { type, download, cache = 'no-store', onBytes, onDone } = {}) {
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
    return pipeline(fs.createReadStream(file, { start, end }), counter(onBytes, onDone), res).catch(() => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(file), counter(onBytes, onDone), res).catch(() => {});
}
// Counts bytes as they're sent, and reports when the whole file has been handed to the connection.
function counter(onBytes, onEnd) {
  return new Transform({
    transform(chunk, _enc, cb) { if (onBytes) onBytes(chunk.length); cb(null, chunk); },
    flush(cb) {
      try { if (onEnd) onEnd(); } catch (e) { console.error('install tracking:', e); }
      cb();
    },
  });
}

// Temp uploads belong to whoever uploaded them. Chunked uploads track how much has arrived.
const uploads = new Map(); // id -> { owner, size (expected, or null), received }
function tmpPath(uploadId, account) {
  if (!/^[a-f0-9]{16}$/.test(uploadId || '')) throw httpError(400, 'Missing or invalid upload');
  const u = uploads.get(uploadId);
  const p = path.join(dirs.tmp, uploadId);
  if (!u || u.owner !== account.id || !fs.existsSync(p)) throw httpError(400, 'Upload expired — please pick the file again');
  if (u.size != null && u.received !== u.size) throw httpError(400, 'Upload isn\'t finished yet');
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

// ---------- disk space ----------
// Railway volumes have a fixed size (5 GB on Hobby), so check free space before big jobs.
function diskInfo() {
  try {
    const st = fs.statfsSync(DATA_DIR);
    return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch { return null; }
}
const gb = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`);
const storageFullMessage = () => {
  const d = diskInfo();
  return `Your server's storage is full${d ? ` (${gb(d.total - d.free)} of ${gb(d.total)} used)` : ''}. Delete old signed apps or library apps in Settings › Storage, then try again.`;
};
const isNoSpace = (e) => e && (e.code === 'ENOSPC' || e.code === 'EDQUOT' || /ENOSPC|no space left/i.test(String(e.message)));

// Deletes a signed copy (file, icon and record).
async function removeSigned(s) {
  const i = store.signed.indexOf(s);
  if (i >= 0) store.signed.splice(i, 1);
  await rmQuiet(path.join(dirs.signed, s.id + '.ipa'));
  await rmQuiet(path.join(dirs.signed, s.id + '.png'));
}

// Each person keeps only one signed copy of each app — the newest one.
async function dedupeSigned() {
  const seen = new Set();
  let removed = 0;
  for (const s of [...store.signed].sort((a, b) => String(b.signedAt).localeCompare(String(a.signedAt)))) {
    const key = `${s.ownerId}:${s.appId}`;
    if (seen.has(key)) { await removeSigned(s); removed++; } else seen.add(key);
  }
  if (removed) { store.save(); console.log(`Removed ${removed} duplicate signed cop${removed === 1 ? 'y' : 'ies'}`); }
}
dedupeSigned().catch((e) => console.error('dedupe:', e));

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
  const votes = Object.values(a.votes || {});
  const mine = [...store.installLog].reverse().find((l) => l.ownerId === acc.id && l.appId === a.id);
  const extra = {
    likes: votes.filter((v) => v > 0).length,
    dislikes: votes.filter((v) => v < 0).length,
    myVote: (a.votes || {})[acc.id] || 0,
    installed: mine ? { version: mine.shownVersion || mine.version, at: mine.at } : null,
  };
  const { votes: _v, remote, ...base } = a;
  if (remote) {
    const src = remote.sourceId && store.sources.find((x) => x.id === remote.sourceId);
    extra.cloud = remote.kind; // 'link' | 'source' | 'github'
    extra.sourceName = src ? src.name : null;
    extra.missing = !!remote.missing;
    extra.versions = (remote.versions || []).map((v) => ({ version: v.version, date: v.date, size: v.size, notes: (v.notes || '').slice(0, 400), channel: v.channel }));
    extra.remoteScreens = remote.screenshots || [];
    if (isOwner(acc)) extra.remoteUrl = remote.kind === 'github' ? null : remote.url;
  }
  if (isOwner(acc)) return { ...base, ...extra };
  const { fileName, source, ...rest } = base;
  return { ...rest, ...extra };
}
const shownAppVersion = (a) => a.versionOverride || a.version || '';
function signedView(s, req) {
  const base = baseUrl(req);
  const manifest = `${base}/i/${s.token}/manifest.plist`;
  return {
    ...s,
    fileAvailable: !s.fileDeleted,
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
const visibleApps = (acc) => (isOwner(acc) ? store.apps : store.apps.filter((a) => a.published && !(a.remote && a.remote.missing)));

// ---------- routing ----------
// access: 'open' (anyone), 'user' (any logged-in account), 'owner'
const routes = [];
const route = (method, pattern, handler, access = 'user') => routes.push({ method, pattern, handler, access });

// ----- session -----
route('GET', /^\/api\/session$/, (req, res) => {
  const acc = getAccount(req);
  json(res, { authed: !!acc, account: acc ? accountView(acc) : null, passwordSet: !!APP_PASSWORD, udidLogin: !!store.settings.udidLogin, version: displayVersion() });
}, 'open');

route('GET', /^\/api\/version$/, (req, res) => json(res, { version: displayVersion(), build: BUILD_ID }), 'open');
route('GET', /^\/api\/whats-new$/, (req, res) => json(res, { version: displayVersion(), codeVersion: VERSION, versions: WHATS_NEW }), 'open');

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
async function dirSize(dir) {
  let total = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}
const storageUsed = () => dirSize(DATA_DIR);
async function storageBreakdown() {
  return {
    library: await dirSize(dirs.apps),
    signed: await dirSize(dirs.signed),
    certs: await dirSize(dirs.certs),
    temp: (await dirSize(dirs.tmp)) + (await dirSize(dirs.work)),
  };
}

// Signed .ipa files are only needed to install, so old ones are deleted to save space.
// The record stays so people can see it and tap "Sign again".
async function cleanupSignedFiles(maxAgeDays = Number(store.settings.signedRetentionDays)) {
  let n = 0;
  for (const s of store.signed) {
    if (s.fileDeleted) continue;
    // Once an app finished installing, its signed file isn't needed any more (kept 15 minutes in case iOS retries).
    const installedLongEnough = store.settings.deleteAfterInstall && s.installedAt && Date.now() - new Date(s.installedAt) > 15 * 60 * 1000;
    const tooOld = maxAgeDays && Date.now() - new Date(s.signedAt) >= maxAgeDays * 864e5;
    if (!installedLongEnough && !tooOld) continue;
    await rmQuiet(path.join(dirs.signed, s.id + '.ipa'));
    s.fileDeleted = true;
    n++;
  }
  if (n) store.save();
  return n;
}
setInterval(() => cleanupSignedFiles().catch(() => {}), 5 * 60 * 1000).unref();

route('GET', /^\/api\/state$/, async (req, res, m, acc) => {
  const base = baseUrl(req);
  const out = {
    account: accountView(acc),
    apps: visibleApps(acc).map((a) => appView(a, acc)),
    categories: sortedCategories(),
    certs: myCerts(acc).map((c) => certView(c, acc)),
    signed: mySigned(acc).map((s) => signedView(s, req)),
    collections: sortedCollections().filter((c) => isOwner(acc) || c.appIds.some((aid) => visibleApps(acc).some((a) => a.id === aid))),
    requests: (isOwner(acc) ? store.requests : store.requests.filter((r) => r.ownerId === acc.id)).slice(-200).reverse(),
    installs: store.installLog.filter((l) => l.ownerId === acc.id).slice(-60).reverse(),
    announcement: store.settings.announcement && store.settings.announcement.text ? store.settings.announcement : null,
    server: { baseUrl: base, https: base.startsWith('https://'), version: displayVersion(), codeVersion: VERSION },
  };
  if (isOwner(acc)) {
    const { github: _gh, ...ownerSettings } = store.settings; // the GitHub token never leaves the server, even encrypted
    out.settings = ownerSettings;
    out.users = store.users.map(userView);
    out.invites = store.invites;
    out.sources = store.sources.map(sourceView);
    out.github = ghView();
    out.server = { ...out.server, zsign: zsignVersion, passwordSet: !!APP_PASSWORD, storage: await storageUsed(), storageBreakdown: await storageBreakdown(), disk: diskInfo() };
  } else {
    out.settings = { maxSignedPerUser: store.settings.maxSignedPerUser, signedRetentionDays: store.settings.signedRetentionDays };
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
  uploads.set(uid, { owner: acc.id, size: null, received: size });
  json(res, { uploadId: uid, size });
});

// Resumable, parallel uploads: the file is split into numbered pieces that can arrive in any order,
// several at once. If the connection drops, the phone asks which pieces are missing and sends just those.
route('POST', /^\/api\/upload\/start$/, async (req, res, m, acc) => {
  const { size, chunkSize } = await readJson(req);
  const total = Number(size);
  const limit = isOwner(acc) ? MAX_UPLOAD : MAX_USER_UPLOAD;
  if (!Number.isFinite(total) || total <= 0) return fail(res, 400, 'Empty file');
  if (total > limit) return fail(res, 413, 'File is too large');
  const disk = diskInfo();
  if (disk && total + 64 * 1048576 > disk.free) {
    return fail(res, 507, `Not enough space on your server for this file (it's ${gb(total)}, ${gb(disk.free)} is free). Delete old signed apps or library apps in Settings › Storage first.`);
  }
  const piece = Math.min(32, Math.max(1, Math.round(Number(chunkSize) / 1048576) || 8)) * 1048576;
  const uid = id();
  const file = path.join(dirs.tmp, uid);
  await fsp.writeFile(file, Buffer.alloc(0));
  await fsp.truncate(file, total); // reserve the full size so pieces can be written anywhere
  const count = Math.ceil(total / piece);
  uploads.set(uid, { owner: acc.id, size: total, chunkSize: piece, count, done: new Set(), active: new Set(), received: 0 });
  json(res, { uploadId: uid, chunkSize: piece, count });
});

function ownUpload(acc, uid) {
  const u = /^[a-f0-9]{16}$/.test(uid) && uploads.get(uid);
  if (!u || u.owner !== acc.id) throw httpError(404, 'Upload expired — please pick the file again');
  return u;
}

route('GET', /^\/api\/upload\/([a-f0-9]{16})$/, (req, res, m, acc) => {
  const u = ownUpload(acc, m[1]);
  json(res, { received: u.received, size: u.size, done: [...(u.done || [])] });
});

route('PUT', /^\/api\/upload\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const u = ownUpload(acc, m[1]);
  const index = Number(req.query.get('index'));
  const reject = async (status, body) => {
    // Read and throw away the body first, so the phone gets a clean answer instead of a dropped connection.
    req.resume();
    await new Promise((r) => { req.on('end', r); req.on('error', r); req.on('close', r); });
    json(res, { received: u.received, ...body }, status);
  };
  if (!u.done || !Number.isInteger(index) || index < 0 || index >= u.count) return reject(400, { error: 'Bad piece number' });
  if (u.done.has(index)) return reject(200, { already: true, done: u.received === u.size });
  if (u.active.has(index)) return reject(409, { busy: true });
  u.active.add(index);
  const start = index * u.chunkSize;
  const expected = Math.min(u.chunkSize, u.size - start);
  const file = path.join(dirs.tmp, m[1]);
  let got = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      if (got > expected) return cb(httpError(413, 'Piece too large'));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(file, { flags: 'r+', start }));
    if (got !== expected) throw httpError(400, 'Piece was cut off — sending it again');
    u.done.add(index);
    u.received += got;
  } finally {
    u.active.delete(index);
  }
  json(res, { received: u.received, done: u.received === u.size });
});

// ----- app library (owner manages, everyone browses) -----
function metaFields(meta) {
  return {
    bundleId: meta.bundleId, version: meta.version, build: meta.build, minOS: meta.minOS,
    extensions: meta.extensions, hasWatch: meta.hasWatch, size: meta.size, hasIcon: !!meta.icon,
  };
}

async function inspectOrFail(file) {
  try {
    return await ipa.inspect(file);
  } catch (e) {
    await rmQuiet(file);
    throw httpError(400, e.message || 'Not a valid .ipa');
  }
}

async function addAppFromFile(file, fileName, source) {
  const meta = await inspectOrFail(file);
  const appId = id();
  await fsp.rename(file, path.join(dirs.apps, appId + '.ipa'));
  if (meta.icon) await fsp.writeFile(path.join(dirs.apps, appId + '.png'), meta.icon);
  const now = new Date().toISOString();
  const rec = {
    id: appId, fileName: fileName || `${meta.name}.ipa`, source: source || 'upload', addedAt: now, updatedAt: now,
    name: meta.name, originalName: meta.name, ...metaFields(meta),
    published: true, featured: false, categoryId: null, description: '', notes: '', developer: '',
    customIcon: false, useIconWhenSigning: true, signDefaults: {},
    tags: [], screenshots: [], votes: {}, installCount: 0,
  };
  store.apps.unshift(rec);
  store.save();
  return rec;
}

// Swap in a new .ipa for an existing library app, keeping its name, category, notes and defaults.
async function replaceAppFile(app, file) {
  const meta = await inspectOrFail(file);
  const oldVersion = app.version;
  await fsp.rename(file, path.join(dirs.apps, app.id + '.ipa'));
  if (meta.icon) await fsp.writeFile(path.join(dirs.apps, app.id + '.png'), meta.icon);
  const oldShown = app.versionOverride || oldVersion;
  Object.assign(app, metaFields(meta), { updatedAt: new Date().toISOString(), previousVersion: oldShown, versionOverride: null });
  if (!app.customIcon) app.hasIcon = !!meta.icon;
  store.save();
  return app;
}

async function downloadToTmp(u, job) {
  const dest = path.join(dirs.tmp, id());
  job.log.push(`Downloading ${u.hostname}…`);
  const r = await fetch(u, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`Download failed (HTTP ${r.status})`);
  const type = r.headers.get('content-type') || '';
  if (/text\/html/i.test(type)) throw new Error("That link opens a web page, not a file. Use a direct download link (for Dropbox, change dl=0 to dl=1).");
  const total = Number(r.headers.get('content-length')) || 0;
  let got = 0;
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => {
    got += c.length;
    job.progress = total ? got / total : null;
    if (got > MAX_UPLOAD) body.destroy(new Error('File is too large'));
  });
  try {
    await pipeline(body, fs.createWriteStream(dest));
  } catch (e) {
    await rmQuiet(dest);
    throw e;
  }
  return dest;
}

function parseLink(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw httpError(400, 'Enter a valid link'); }
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'Link must start with http or https');
  // Friendly fix for Dropbox share links
  if (/(^|\.)dropbox\.com$/.test(u.hostname) && u.searchParams.get('dl') === '0') u.searchParams.set('dl', '1');
  return u;
}

route('POST', /^\/api\/apps$/, async (req, res, m, acc) => {
  const { uploadId, fileName } = await readJson(req);
  const rec = await addAppFromFile(tmpPath(uploadId, acc), String(fileName || '').slice(0, 200), 'upload');
  const g = ghSettings();
  if (!g || g.storeUploads === false || !ghClient()) return json(res, { app: appView(rec, acc) });
  // GitHub storage is on: send the file there and free the space on this server.
  const job = newJob(acc);
  json(res, { jobId: job.id });
  try {
    await moveToGithub(rec, job);
    job.log.push('Saved to GitHub ✓');
  } catch (e) {
    job.log.push(`Couldn't send it to GitHub (${e.message}), so it's kept on the server.`);
  }
  job.result = { app: appView(rec, acc) };
  job.status = 'done';
}, 'owner');

route('POST', /^\/api\/apps\/import$/, async (req, res, m, acc) => {
  const { url } = await readJson(req);
  const u = parseLink(url);
  const job = newJob(acc);
  json(res, { jobId: job.id });
  (async () => {
    try {
      const dest = await downloadToTmp(u, job);
      job.log.push('Reading app info…');
      const name = decodeURIComponent(path.basename(u.pathname)) || 'download.ipa';
      const rec = await addAppFromFile(dest, name, 'url');
      job.result = { app: appView(rec, acc) };
      job.status = 'done';
    } catch (e) {
      job.error = isNoSpace(e) ? storageFullMessage() : e.message;
      job.status = 'error';
    }
  })();
}, 'owner');

route('POST', /^\/api\/apps\/([a-f0-9]{16})\/replace$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const { uploadId, url, linkOnly } = await readJson(req);
  if (app.remote && app.remote.kind === 'source') return fail(res, 400, 'Apps from a source update themselves when the source does');
  if (uploadId) {
    const oldRemote = app.remote;
    delete app.remote;
    try { await replaceAppFile(app, tmpPath(uploadId, acc)); } catch (e) { if (oldRemote) app.remote = oldRemote; throw e; }
    if (oldRemote && oldRemote.kind === 'github') { const gh = ghClient(); if (gh) gh.deleteAsset(oldRemote.assetId).catch(() => {}); }
    const g = ghSettings();
    if (g && g.storeUploads !== false && ghClient()) {
      const job = newJob(acc);
      json(res, { jobId: job.id });
      try { await moveToGithub(app, job); } catch (e) { job.log.push(`Kept on the server (${e.message})`); }
      job.result = { app: appView(app, acc) };
      job.status = 'done';
      return;
    }
    return json(res, { app: appView(app, acc) });
  }
  const u = parseLink(url);
  if (linkOnly === true || (linkOnly === undefined && app.remote && app.remote.kind === 'link')) {
    const job = newJob(acc);
    json(res, { jobId: job.id });
    (async () => {
      try {
        const meta = await inspectLink(u.toString(), null, job);
        const oldShown = app.versionOverride || app.version;
        Object.assign(app, metaFields(meta), { updatedAt: new Date().toISOString(), previousVersion: oldShown, versionOverride: null });
        if (meta.icon && !app.customIcon) await fsp.writeFile(path.join(dirs.apps, app.id + '.png'), meta.icon);
        await rmQuiet(path.join(dirs.apps, app.id + '.ipa'));
        app.remote = { kind: 'link', url: u.toString() };
        store.save();
        job.result = { app: appView(app, acc) };
        job.status = 'done';
      } catch (e) { job.error = e.message; job.status = 'error'; }
    })();
    return;
  }
  const job = newJob(acc);
  json(res, { jobId: job.id });
  (async () => {
    try {
      const dest = await downloadToTmp(u, job);
      job.log.push('Reading app info…');
      const oldRemote = app.remote;
      delete app.remote;
      try { await replaceAppFile(app, dest); } catch (e) { if (oldRemote) app.remote = oldRemote; throw e; }
      if (oldRemote && oldRemote.kind === 'github') { const gh = ghClient(); if (gh) gh.deleteAsset(oldRemote.assetId).catch(() => {}); }
      job.result = { app: appView(app, acc) };
      job.status = 'done';
    } catch (e) {
      job.error = e.message;
      job.status = 'error';
    }
  })();
}, 'owner');

function cleanSignDefaults(d) {
  if (!d || typeof d !== 'object') return {};
  const out = {
    entitlements: cleanEdits(d.entitlements, 'entitlement'),
    plist: cleanEdits(d.plist, 'Info.plist'),
  };
  for (const k of ['removeExtensions', 'removeWatch', 'removeUISD', 'enableDocs', 'weakDylibs', 'injectExtensions']) {
    if (d[k] !== undefined) out[k] = !!d[k];
  }
  if (typeof d.minOS === 'string' && /^(\d+(\.\d+){0,2})?$/.test(d.minOS.trim())) out.minOS = d.minOS.trim();
  return out;
}

route('PATCH', /^\/api\/apps\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const b = await readJson(req);
  if (app.remote && app.remote.kind === 'source') {
    // Remember what you changed so the next source sync doesn't undo it.
    const changed = ['name', 'description', 'developer', 'notes', 'published', 'categoryId'].filter((k) => b[k] !== undefined && b[k] !== app[k]);
    if (changed.length) lockFields(app, changed);
  }
  if (typeof b.name === 'string' && b.name.trim()) app.name = b.name.trim().slice(0, 80);
  if (typeof b.description === 'string') app.description = b.description.trim().slice(0, 1500);
  if (typeof b.notes === 'string') app.notes = b.notes.trim().slice(0, 1500);
  if (typeof b.developer === 'string') app.developer = b.developer.trim().slice(0, 80);
  if (typeof b.published === 'boolean') app.published = b.published;
  if (typeof b.featured === 'boolean') app.featured = b.featured;
  if (typeof b.useIconWhenSigning === 'boolean') app.useIconWhenSigning = b.useIconWhenSigning;
  if (b.versionOverride !== undefined) {
    const v = String(b.versionOverride || '').trim();
    if (v && !/^[\w.\-+ ()]{1,30}$/.test(v)) return fail(res, 400, 'Version can use letters, numbers, dots, dashes and spaces (30 max)');
    app.versionOverride = v || null;
  }
  if (typeof b.useVersionWhenSigning === 'boolean') app.useVersionWhenSigning = b.useVersionWhenSigning;
  if (Array.isArray(b.tags)) {
    app.tags = [...new Set(b.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean))].slice(0, 10);
  }
  if (b.categoryId !== undefined) {
    if (b.categoryId && !store.categories.some((c) => c.id === b.categoryId)) return fail(res, 400, 'Category not found');
    app.categoryId = b.categoryId || null;
  }
  if (b.signDefaults !== undefined) app.signDefaults = cleanSignDefaults(b.signDefaults);
  if (b.iconUploadId) {
    const f = tmpPath(b.iconUploadId, acc);
    const head = await fsp.readFile(f).then((x) => x.subarray(0, 8)).catch(() => Buffer.alloc(0));
    if (!head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) { await rmQuiet(f); return fail(res, 400, 'Icon must be a PNG image'); }
    await fsp.rename(f, path.join(dirs.apps, app.id + '-custom.png'));
    app.customIcon = true;
    app.iconVersion = Date.now();
  }
  if (b.resetIcon) {
    await rmQuiet(path.join(dirs.apps, app.id + '-custom.png'));
    app.customIcon = false;
    app.iconVersion = Date.now();
  }
  app.updatedAt = new Date().toISOString();
  store.save();
  json(res, { app: appView(app, acc) });
}, 'owner');

async function deleteApp(appId, { keepRemote = false } = {}) {
  const i = store.apps.findIndex((a) => a.id === appId);
  if (i < 0) return false;
  const app = store.apps[i];
  if (!keepRemote && app.remote && app.remote.kind === 'github') {
    const gh = ghClient();
    if (gh) await gh.deleteAsset(app.remote.assetId).catch((e) => console.error('GitHub delete:', e.message));
  }
  store.apps.splice(i, 1);
  for (const suffix of ['.ipa', '.png', '-custom.png']) await rmQuiet(path.join(dirs.apps, appId + suffix));
  await rmQuiet(path.join(dirs.apps, appId + '-shots'));
  for (const c of store.collections) c.appIds = c.appIds.filter((x) => x !== appId);
  return true;
}

route('DELETE', /^\/api\/apps\/([a-f0-9]{16})$/, async (req, res, m) => {
  if (!(await deleteApp(m[1]))) return fail(res, 404, 'App not found');
  store.save();
  json(res, { ok: true });
}, 'owner');

route('POST', /^\/api\/apps\/bulk$/, async (req, res) => {
  const { ids = [], action, categoryId = null } = await readJson(req);
  const apps = store.apps.filter((a) => Array.isArray(ids) && ids.includes(a.id));
  if (!apps.length) return fail(res, 400, 'Pick at least one app');
  if (action === 'category' && categoryId && !store.categories.some((c) => c.id === categoryId)) return fail(res, 400, 'Category not found');
  for (const a of apps) {
    if (action === 'category') a.categoryId = categoryId || null;
    else if (action === 'show') a.published = true;
    else if (action === 'hide') a.published = false;
    else if (action === 'feature') a.featured = true;
    else if (action === 'unfeature') a.featured = false;
    else if (action === 'delete') await deleteApp(a.id);
    else return fail(res, 400, 'Unknown action');
  }
  store.save();
  json(res, { ok: true, count: apps.length });
}, 'owner');

route('GET', /^\/api\/apps\/([a-f0-9]{16})\/icon$/, (req, res, m, acc) => {
  const app = visibleApps(acc).find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'Not found');
  const file = app.customIcon ? path.join(dirs.apps, m[1] + '-custom.png') : path.join(dirs.apps, m[1] + '.png');
  if (!app.customIcon && app.iconURL && !fs.existsSync(file)) {
    res.writeHead(302, { Location: app.iconURL, 'Cache-Control': 'private, max-age=3600' });
    return res.end();
  }
  return serveFile(req, res, file, { cache: 'private, max-age=86400' });
});

route('GET', /^\/api\/apps\/([a-f0-9]{16})\/download$/, async (req, res, m) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  if (app.remote) {
    const dl = remoteDownload(app);
    if (!dl.headers) { res.writeHead(302, { Location: dl.url }); return res.end(); }
    // Private GitHub file: pass it through so the token stays on the server.
    const r = await fetchAuthed(dl.url, dl.headers);
    if (!r.ok || !r.body) return fail(res, 502, `Couldn't get the file (HTTP ${r.status})`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${`${app.name} ${app.version}.ipa`.replace(/[^\w.\- ]/g, '_')}"`,
      ...(r.headers.get('content-length') ? { 'Content-Length': r.headers.get('content-length') } : {}),
    });
    return pipeline(Readable.fromWeb(r.body), res).catch(() => {});
  }
  return serveFile(req, res, path.join(dirs.apps, m[1] + '.ipa'), { download: `${app.name} ${app.version}.ipa` });
}, 'owner');

// ----- cloud library: link-only apps, sources and GitHub storage -----
// Link-only apps keep just a download link (and a small icon). The .ipa is fetched only while signing.
function remoteDownload(app, versionIndex = 0) {
  const r = app.remote;
  if (r.kind === 'github') {
    const gh = ghClient();
    if (!gh) throw httpError(400, 'GitHub storage is not connected. Reconnect it in Settings › GitHub storage.');
    return { ...gh.download(r.assetId), size: app.size, version: app.version };
  }
  if (r.kind === 'source' && Array.isArray(r.versions) && r.versions.length) {
    const v = r.versions[Math.min(versionIndex, r.versions.length - 1)];
    return { url: v.url, headers: null, size: v.size || (versionIndex ? 0 : app.size), version: v.version };
  }
  return { url: r.url, headers: null, size: app.size, version: app.version };
}

// Fetches a link that may need a login header. The header is only sent to the first address:
// if it redirects (GitHub sends you to a short-lived download link), the next hop gets no token.
async function fetchAuthed(url, headers) {
  if (!headers) return fetch(url, { headers: { 'User-Agent': 'Mango-Signer' }, redirect: 'follow' });
  const first = await fetch(url, { headers: { 'User-Agent': 'Mango-Signer', ...headers }, redirect: 'manual' });
  if (first.status >= 300 && first.status < 400 && first.headers.get('location')) {
    first.body && first.body.cancel().catch(() => {});
    return fetch(new URL(first.headers.get('location'), url), { headers: { 'User-Agent': 'Mango-Signer' }, redirect: 'follow' });
  }
  return first;
}

async function fetchToFile(url, headers, dest, job, label) {
  if (job && label) job.log.push(label);
  const r = await fetchAuthed(url, headers);
  if (!r.ok || !r.body) throw new Error(`Download failed (HTTP ${r.status}). The link may have moved or expired.`);
  if (/text\/html/i.test(r.headers.get('content-type') || '')) {
    r.body.cancel().catch(() => {});
    throw new Error('That link opens a web page, not an app file. Use a direct download link.');
  }
  const total = Number(r.headers.get('content-length')) || 0;
  let got = 0;
  let lastLog = 0;
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => {
    got += c.length;
    if (job) {
      job.progress = total ? got / total : null;
      if (total && Date.now() - lastLog > 3000) { lastLog = Date.now(); job.log.push(`Downloaded ${Math.floor((100 * got) / total)}%`); }
    }
    if (got > MAX_UPLOAD) body.destroy(new Error('File is too large'));
  });
  try {
    await pipeline(body, fs.createWriteStream(dest));
  } catch (e) {
    await rmQuiet(dest);
    throw e;
  }
  return got;
}

// Reads app info from a link without downloading the whole file (falls back to a full download if the server can't do that).
async function inspectLink(url, headers, job) {
  try {
    return await ipa.inspect({ url, headers: headers || undefined });
  } catch (e) {
    if (!e.noRange) throw e;
    const tmp = path.join(dirs.tmp, id());
    try {
      await fetchToFile(url, headers, tmp, job, "This link can't be read in parts — downloading it once to read the app info…");
      return await ipa.inspect(tmp);
    } finally { await rmQuiet(tmp); }
  }
}

function newLibraryRecord(meta, extra = {}) {
  const now = new Date().toISOString();
  return {
    id: id(), addedAt: now, updatedAt: now,
    name: meta.name, originalName: meta.name,
    bundleId: meta.bundleId || '', version: meta.version || '', build: meta.build || '', minOS: meta.minOS || '',
    extensions: meta.extensions || 0, hasWatch: !!meta.hasWatch, size: meta.size || 0, hasIcon: !!meta.icon,
    published: true, featured: false, categoryId: null, description: '', notes: '', developer: '',
    customIcon: false, useIconWhenSigning: true, signDefaults: {},
    tags: [], screenshots: [], votes: {}, installCount: 0,
    ...extra,
  };
}

// Owner edits "lock" a field so syncing a source never overwrites it.
function lockFields(app, fields) {
  app.locked = [...new Set([...(app.locked || []), ...fields])];
}

route('POST', /^\/api\/apps\/link$/, async (req, res, m, acc) => {
  const { url } = await readJson(req);
  const u = parseLink(url);
  const job = newJob(acc);
  json(res, { jobId: job.id });
  (async () => {
    try {
      job.log.push(`Reading app info from ${u.hostname}…`);
      const meta = await inspectLink(u.toString(), null, job);
      const rec = newLibraryRecord(meta, { fileName: decodeURIComponent(path.basename(u.pathname)) || 'app.ipa', source: 'link', remote: { kind: 'link', url: u.toString() } });
      if (meta.icon) await fsp.writeFile(path.join(dirs.apps, rec.id + '.png'), meta.icon);
      store.apps.unshift(rec);
      store.save();
      job.result = { app: appView(rec, acc) };
      job.status = 'done';
    } catch (e) {
      job.error = isNoSpace(e) ? storageFullMessage() : e.message;
      job.status = 'error';
    }
  })();
}, 'owner');

// ----- sources -----
async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mango-Signer', Accept: 'application/json' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) throw new Error(`Couldn't load the source (HTTP ${r.status})`);
    const len = Number(r.headers.get('content-length')) || 0;
    if (len > 25 * 1048576) throw new Error('That source is too big');
    const text = await r.text();
    if (text.length > 25 * 1048576) throw new Error('That source is too big');
    try { return JSON.parse(text); } catch { throw new Error("That link isn't a source (it isn't JSON)"); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The source took too long to load');
    throw e;
  } finally { clearTimeout(t); }
}

function categoryIdFor(name) {
  const c = sources.categoryFor(name);
  if (!c) return null;
  let cat = store.categories.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
  if (!cat) {
    cat = { id: id(), name: c.name.slice(0, 30), emoji: c.emoji || '📁', order: store.categories.length };
    store.categories.push(cat);
  }
  return cat.id;
}

async function syncSource(src) {
  const parsed = sources.parseSource(await fetchJson(src.url));
  const mine = store.apps.filter((a) => a.remote && a.remote.kind === 'source' && a.remote.sourceId === src.id);
  const byKey = new Map(mine.map((a) => [a.remote.key, a]));
  const seen = new Set();
  let added = 0, updated = 0;
  for (const s of parsed.apps) {
    seen.add(s.key);
    const v = s.versions[0];
    const fields = {
      name: s.name, developer: s.developer, description: s.description,
      bundleId: s.bundleId, version: v.version, size: v.size, minOS: v.minOS,
    };
    const remote = { kind: 'source', sourceId: src.id, key: s.key, url: v.url, versions: s.versions, screenshots: s.screenshots };
    let app = byKey.get(s.key);
    if (!app) {
      app = newLibraryRecord({ name: s.name, bundleId: s.bundleId, version: v.version, minOS: v.minOS, size: v.size }, {
        source: 'source', remote, developer: s.developer, description: s.description,
        iconURL: s.iconURL || '', hasIcon: !!s.iconURL, published: src.showInLibrary !== false,
        categoryId: categoryIdFor(s.category), notes: v.notes || '',
      });
      store.apps.push(app);
      added++;
      continue;
    }
    const locked = new Set(app.locked || []);
    const oldVersion = app.version;
    for (const [k, val] of Object.entries(fields)) if (!locked.has(k) && val !== undefined && val !== '' && val !== 0) app[k] = val;
    if (!locked.has('notes') && v.notes) app.notes = v.notes;
    app.iconURL = s.iconURL || app.iconURL;
    app.hasIcon = app.hasIcon || !!app.iconURL;
    app.remote = remote;
    if (oldVersion && v.version && oldVersion !== v.version) {
      app.previousVersion = app.versionOverride || oldVersion;
      app.updatedAt = new Date().toISOString();
      updated++;
    }
  }
  let removed = 0;
  for (const a of mine) {
    if (!seen.has(a.remote.key)) { if (!a.remote.missing) removed++; a.remote.missing = true; } else delete a.remote.missing;
  }
  Object.assign(src, {
    name: src.customName || parsed.name, iconURL: parsed.iconURL, subtitle: parsed.subtitle,
    appCount: parsed.apps.length, lastSync: new Date().toISOString(), lastError: null,
  });
  store.save();
  return { added, updated, removed, total: parsed.apps.length };
}

const sourceView = (src) => ({ ...src, apps: store.apps.filter((a) => a.remote && a.remote.sourceId === src.id && !a.remote.missing).length });

route('POST', /^\/api\/sources$/, async (req, res) => {
  const b = await readJson(req);
  let url;
  try { url = sources.normalizeSourceUrl(b.url); } catch (e) { return fail(res, 400, e.message); }
  if (store.sources.some((x) => x.url === url)) return fail(res, 400, 'That source is already added');
  const src = { id: id(), url, name: 'Source', showInLibrary: b.showInLibrary !== false, addedAt: new Date().toISOString() };
  try {
    store.sources.push(src);
    const result = await syncSource(src);
    json(res, { source: sourceView(src), result });
  } catch (e) {
    store.sources.splice(store.sources.indexOf(src), 1);
    store.save();
    fail(res, 400, e.message);
  }
}, 'owner');

route('POST', /^\/api\/sources\/([a-f0-9]{16})\/sync$/, async (req, res, m) => {
  const src = store.sources.find((x) => x.id === m[1]);
  if (!src) return fail(res, 404, 'Source not found');
  try {
    const result = await syncSource(src);
    json(res, { source: sourceView(src), result });
  } catch (e) {
    src.lastError = e.message;
    store.save();
    fail(res, 502, e.message);
  }
}, 'owner');

route('PATCH', /^\/api\/sources\/([a-f0-9]{16})$/, async (req, res, m) => {
  const src = store.sources.find((x) => x.id === m[1]);
  if (!src) return fail(res, 404, 'Source not found');
  const b = await readJson(req);
  if (typeof b.showInLibrary === 'boolean') {
    src.showInLibrary = b.showInLibrary;
    for (const a of store.apps) if (a.remote && a.remote.sourceId === src.id && !(a.locked || []).includes('published')) a.published = b.showInLibrary;
  }
  if (typeof b.name === 'string' && b.name.trim()) { src.customName = b.name.trim().slice(0, 60); src.name = src.customName; }
  store.save();
  json(res, { source: sourceView(src) });
}, 'owner');

route('DELETE', /^\/api\/sources\/([a-f0-9]{16})$/, async (req, res, m) => {
  const i = store.sources.findIndex((x) => x.id === m[1]);
  if (i < 0) return fail(res, 404, 'Source not found');
  for (const a of store.apps.filter((x) => x.remote && x.remote.sourceId === m[1])) await deleteApp(a.id);
  store.sources.splice(i, 1);
  store.save();
  json(res, { ok: true });
}, 'owner');

// Keep sources fresh: check them every 6 hours.
setInterval(async () => {
  for (const src of store.sources) {
    try { await syncSource(src); } catch (e) { src.lastError = e.message; store.save(); }
  }
}, 6 * 60 * 60 * 1000).unref();

// ----- GitHub storage -----
function ghSettings() { return store.settings.github || null; }
function ghClient() {
  const g = ghSettings();
  if (!g || !g.tokenEnc || !g.owner || !g.repo) return null;
  try { return github.client({ owner: g.owner, repo: g.repo, token: decrypt(g.tokenEnc) }); } catch { return null; }
}
const ghView = () => {
  const g = ghSettings();
  if (!g) return { connected: false };
  return {
    connected: !!(g.tokenEnc && g.releaseId), owner: g.owner, repo: g.repo, tag: g.tag, private: g.private,
    lastSync: g.lastSync || null, lastError: g.lastError || null, storeUploads: g.storeUploads !== false,
    apps: store.apps.filter((a) => a.remote && a.remote.kind === 'github').length,
  };
};

async function ghSync() {
  const g = ghSettings();
  const gh = ghClient();
  if (!gh || !g.releaseId) throw httpError(400, 'Connect GitHub storage first');
  const assets = (await gh.listAssets(g.releaseId)).filter((x) => /\.ipa$/i.test(x.name));
  const existing = store.apps.filter((a) => a.remote && a.remote.kind === 'github');
  const byAsset = new Map(existing.map((a) => [String(a.remote.assetId), a]));
  let added = 0, failed = [];
  for (const asset of assets) {
    if (byAsset.has(String(asset.id))) { byAsset.delete(String(asset.id)); continue; }
    try {
      const dl = gh.download(asset.id);
      const meta = await inspectLink(dl.url, dl.headers);
      const rec = newLibraryRecord({ ...meta, size: asset.size }, { fileName: asset.name, source: 'github', remote: { kind: 'github', assetId: asset.id, name: asset.name } });
      if (meta.icon) await fsp.writeFile(path.join(dirs.apps, rec.id + '.png'), meta.icon);
      store.apps.unshift(rec);
      added++;
    } catch (e) { failed.push(`${asset.name}: ${e.message}`); }
  }
  // Files deleted from GitHub disappear from the library too.
  let removed = 0;
  for (const app of byAsset.values()) { await deleteApp(app.id, { keepRemote: true }); removed++; }
  g.lastSync = new Date().toISOString();
  g.lastError = failed.length ? failed.slice(0, 3).join('; ') : null;
  store.save();
  return { added, removed, failed: failed.length, total: assets.length };
}

// Sends a local .ipa to the GitHub release and turns the library app into a link-only one.
async function moveToGithub(app, job) {
  const g = ghSettings();
  const gh = ghClient();
  if (!gh || !g.releaseId) throw new Error('Connect GitHub storage first');
  const file = path.join(dirs.apps, app.id + '.ipa');
  if (!fs.existsSync(file)) throw new Error('No local file to move');
  const size = (await fsp.stat(file)).size;
  const safe = `${(app.originalName || app.name).replace(/[^\w.\-]+/g, '_')}-${app.version || 'app'}-${app.id.slice(0, 6)}.ipa`;
  if (job) job.log.push(`Sending ${app.name} to GitHub…`);
  const asset = await gh.uploadAsset(g.releaseId, safe, file, size, (p) => { if (job) job.progress = p; });
  app.remote = { kind: 'github', assetId: asset.id, name: asset.name };
  app.size = size;
  store.save();
  await rmQuiet(file);
  return app;
}

route('PUT', /^\/api\/github$/, async (req, res) => {
  const b = await readJson(req);
  const owner = String(b.owner || '').trim();
  const repo = String(b.repo || '').trim().replace(/\.git$/, '');
  const tag = String(b.tag || 'mango-library').trim() || 'mango-library';
  const prev = ghSettings() || {};
  const token = String(b.token || '').trim() || (prev.tokenEnc ? decrypt(prev.tokenEnc) : '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return fail(res, 400, 'Enter the repo as owner and name, e.g. MangoMods-code and mango-ipas');
  if (!token) return fail(res, 400, 'Paste your GitHub token');
  if (!/^[\w.-]+$/.test(tag)) return fail(res, 400, 'Release tag can only use letters, numbers, dots and dashes');
  const gh = github.client({ owner, repo, token });
  try {
    const info = await gh.getRepo();
    const rel = await gh.ensureRelease(tag);
    store.settings.github = {
      ...prev, owner, repo, tag, tokenEnc: encrypt(token), releaseId: rel.id, private: !!info.private,
      storeUploads: prev.storeUploads !== false, lastError: null,
    };
    store.save();
    const result = await ghSync().catch((e) => ({ error: e.message }));
    json(res, { github: ghView(), result });
  } catch (e) {
    fail(res, 400, e.message);
  }
}, 'owner');

route('PATCH', /^\/api\/github$/, async (req, res) => {
  const g = ghSettings();
  if (!g) return fail(res, 400, 'Connect GitHub storage first');
  const b = await readJson(req);
  if (typeof b.storeUploads === 'boolean') g.storeUploads = b.storeUploads;
  store.save();
  json(res, { github: ghView() });
}, 'owner');

route('DELETE', /^\/api\/github$/, (req, res) => {
  delete store.settings.github;
  store.save();
  json(res, { github: ghView() });
}, 'owner');

route('POST', /^\/api\/github\/sync$/, async (req, res) => {
  try { json(res, { github: ghView(), result: await ghSync() }); } catch (e) { fail(res, e.status || 502, e.message); }
}, 'owner');

route('POST', /^\/api\/github\/move$/, async (req, res, m, acc) => {
  const { ids } = await readJson(req);
  const list = store.apps.filter((a) => !a.remote && (!Array.isArray(ids) || ids.includes(a.id)));
  if (!ghClient()) return fail(res, 400, 'Connect GitHub storage first');
  if (!list.length) return fail(res, 400, 'Nothing to move — every app is already off the server');
  const job = newJob(acc);
  json(res, { jobId: job.id, count: list.length });
  (async () => {
    let moved = 0, freed = 0;
    const errors = [];
    for (const [i, app] of list.entries()) {
      try {
        job.log.push(`(${i + 1}/${list.length}) ${app.name}`);
        const size = app.size;
        await moveToGithub(app, job);
        moved++; freed += size;
      } catch (e) { errors.push(`${app.name}: ${e.message}`); job.log.push(`✕ ${app.name}: ${e.message}`); }
    }
    job.result = { moved, freed, errors };
    job.status = moved || !errors.length ? 'done' : 'error';
    if (job.status === 'error') job.error = errors[0];
  })();
}, 'owner');

// ----- screenshots -----
const IMG_TYPES = [
  { ext: 'png', type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', type: 'image/webp', test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
route('POST', /^\/api\/apps\/([a-f0-9]{16})\/screenshots$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  if ((app.screenshots || []).length >= 8) return fail(res, 400, 'Up to 8 screenshots per app');
  const { uploadId } = await readJson(req);
  const f = tmpPath(uploadId, acc);
  const head = await fsp.readFile(f).then((x) => x.subarray(0, 16));
  const kind = IMG_TYPES.find((t) => t.test(head));
  if (!kind) { await rmQuiet(f); return fail(res, 400, 'Screenshots must be PNG, JPEG or WebP images'); }
  if ((await fsp.stat(f)).size > 15 * 1024 * 1024) { await rmQuiet(f); return fail(res, 400, 'Screenshots must be under 15 MB'); }
  const dir = path.join(dirs.apps, app.id + '-shots');
  await fsp.mkdir(dir, { recursive: true });
  const sid = id();
  await fsp.rename(f, path.join(dir, `${sid}.${kind.ext}`));
  app.screenshots = [...(app.screenshots || []), { id: sid, ext: kind.ext }];
  store.save();
  json(res, { app: appView(app, acc) });
}, 'owner');

route('DELETE', /^\/api\/apps\/([a-f0-9]{16})\/screenshots\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  const shot = app && (app.screenshots || []).find((x) => x.id === m[2]);
  if (!shot) return fail(res, 404, 'Screenshot not found');
  app.screenshots = app.screenshots.filter((x) => x.id !== m[2]);
  await rmQuiet(path.join(dirs.apps, app.id + '-shots', `${shot.id}.${shot.ext}`));
  store.save();
  json(res, { app: appView(app, acc) });
}, 'owner');

route('POST', /^\/api\/apps\/([a-f0-9]{16})\/screenshots\/order$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const { ids = [] } = await readJson(req);
  app.screenshots = [...(app.screenshots || [])].sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
  store.save();
  json(res, { app: appView(app, acc) });
}, 'owner');

route('GET', /^\/api\/apps\/([a-f0-9]{16})\/screenshots\/([a-f0-9]{16})$/, (req, res, m, acc) => {
  const app = visibleApps(acc).find((a) => a.id === m[1]);
  const shot = app && (app.screenshots || []).find((x) => x.id === m[2]);
  if (!shot) return fail(res, 404, 'Not found');
  const kind = IMG_TYPES.find((t) => t.ext === shot.ext);
  return serveFile(req, res, path.join(dirs.apps, app.id + '-shots', `${shot.id}.${shot.ext}`), { type: kind && kind.type, cache: 'private, max-age=604800' });
});

// ----- ratings -----
route('POST', /^\/api\/apps\/([a-f0-9]{16})\/vote$/, async (req, res, m, acc) => {
  const app = visibleApps(acc).find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const { value } = await readJson(req);
  const v = Number(value) > 0 ? 1 : Number(value) < 0 ? -1 : 0;
  app.votes = app.votes || {};
  if (v) app.votes[acc.id] = v; else delete app.votes[acc.id];
  store.save();
  json(res, { app: appView(app, acc) });
});

// ----- collections -----
const sortedCollections = () => [...store.collections].sort((a, b) => a.order - b.order);
function cleanCollection(b, c = {}) {
  if (typeof b.name === 'string') c.name = b.name.trim().slice(0, 40);
  if (typeof b.emoji === 'string' && b.emoji.trim()) c.emoji = b.emoji.trim().slice(0, 8);
  if (typeof b.description === 'string') c.description = b.description.trim().slice(0, 500);
  if (Array.isArray(b.appIds)) c.appIds = [...new Set(b.appIds.filter((x) => store.apps.some((a) => a.id === x)))].slice(0, 30);
  return c;
}
route('POST', /^\/api\/collections$/, async (req, res) => {
  const c = cleanCollection(await readJson(req), { id: id(), emoji: '📦', description: '', appIds: [], order: store.collections.length });
  if (!c.name) return fail(res, 400, 'Give the collection a name');
  store.collections.push(c);
  store.save();
  json(res, { collection: c });
}, 'owner');
route('PATCH', /^\/api\/collections\/([a-f0-9]{16})$/, async (req, res, m) => {
  const c = store.collections.find((x) => x.id === m[1]);
  if (!c) return fail(res, 404, 'Collection not found');
  cleanCollection(await readJson(req), c);
  if (!c.name) c.name = 'Collection';
  store.save();
  json(res, { collection: c });
}, 'owner');
route('DELETE', /^\/api\/collections\/([a-f0-9]{16})$/, (req, res, m) => {
  const i = store.collections.findIndex((x) => x.id === m[1]);
  if (i < 0) return fail(res, 404, 'Collection not found');
  store.collections.splice(i, 1);
  sortedCollections().forEach((c, n) => { c.order = n; });
  store.save();
  json(res, { ok: true });
}, 'owner');

// ----- app requests -----
route('POST', /^\/api\/requests$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return fail(res, 400, 'Which app do you want?');
  const open = store.requests.filter((r) => r.ownerId === acc.id && r.status === 'pending');
  if (!isOwner(acc) && open.length >= 10) return fail(res, 400, 'You have 10 open requests — wait for some to be answered');
  const r = {
    id: id(), ownerId: acc.id, username: acc.username, name,
    link: String(b.link || '').trim().slice(0, 500), note: String(b.note || '').trim().slice(0, 500),
    status: 'pending', reply: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  store.requests.push(r);
  if (store.requests.length > 1000) store.requests.splice(0, store.requests.length - 1000);
  store.save();
  json(res, { request: r });
});
route('PATCH', /^\/api\/requests\/([a-f0-9]{16})$/, async (req, res, m) => {
  const r = store.requests.find((x) => x.id === m[1]);
  if (!r) return fail(res, 404, 'Request not found');
  const b = await readJson(req);
  if (['pending', 'added', 'declined'].includes(b.status)) r.status = b.status;
  if (typeof b.reply === 'string') r.reply = b.reply.trim().slice(0, 300);
  if (typeof b.appId === 'string' && store.apps.some((a) => a.id === b.appId)) r.appId = b.appId;
  r.updatedAt = new Date().toISOString();
  store.save();
  json(res, { request: r });
}, 'owner');
route('DELETE', /^\/api\/requests\/([a-f0-9]{16})$/, (req, res, m, acc) => {
  const i = store.requests.findIndex((x) => x.id === m[1] && (isOwner(acc) || (x.ownerId === acc.id && x.status === 'pending')));
  if (i < 0) return fail(res, 404, 'Request not found');
  store.requests.splice(i, 1);
  store.save();
  json(res, { ok: true });
});

// ----- announcement -----
route('PUT', /^\/api\/announcement$/, async (req, res) => {
  const b = await readJson(req);
  const text = String(b.text || '').trim().slice(0, 400);
  store.settings.announcement = text
    ? { id: id(), text, style: ['info', 'success', 'warning', 'party'].includes(b.style) ? b.style : 'info', at: new Date().toISOString() }
    : null;
  store.save();
  json(res, { announcement: store.settings.announcement });
}, 'owner');

// ----- categories -----
const sortedCategories = () => [...store.categories].sort((a, b) => a.order - b.order);

route('POST', /^\/api\/categories$/, async (req, res) => {
  const { name, emoji } = await readJson(req);
  const n = String(name || '').trim().slice(0, 30);
  if (!n) return fail(res, 400, 'Give the category a name');
  if (store.categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) return fail(res, 400, 'That category already exists');
  const cat = { id: id(), name: n, emoji: String(emoji || '📁').trim().slice(0, 8) || '📁', order: store.categories.length };
  store.categories.push(cat);
  store.save();
  json(res, { category: cat });
}, 'owner');

route('PATCH', /^\/api\/categories\/([a-f0-9]{16})$/, async (req, res, m) => {
  const cat = store.categories.find((c) => c.id === m[1]);
  if (!cat) return fail(res, 404, 'Category not found');
  const { name, emoji } = await readJson(req);
  if (typeof name === 'string' && name.trim()) cat.name = name.trim().slice(0, 30);
  if (typeof emoji === 'string' && emoji.trim()) cat.emoji = emoji.trim().slice(0, 8);
  store.save();
  json(res, { category: cat });
}, 'owner');

route('DELETE', /^\/api\/categories\/([a-f0-9]{16})$/, (req, res, m) => {
  const i = store.categories.findIndex((c) => c.id === m[1]);
  if (i < 0) return fail(res, 404, 'Category not found');
  store.categories.splice(i, 1);
  for (const a of store.apps) if (a.categoryId === m[1]) a.categoryId = null;
  sortedCategories().forEach((c, n) => { c.order = n; });
  store.save();
  json(res, { ok: true });
}, 'owner');

route('POST', /^\/api\/categories\/order$/, async (req, res) => {
  const { ids = [] } = await readJson(req);
  ids.forEach((cid, n) => { const c = store.categories.find((x) => x.id === cid); if (c) c.order = n; });
  store.save();
  json(res, { categories: sortedCategories() });
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
  const versionIndex = Math.max(0, Math.min(14, Number(b.versionIndex) || 0));
  if (app.remote && app.remote.missing) return fail(res, 410, 'This app was removed from its source');

  const iconFile = b.iconUploadId ? tmpPath(b.iconUploadId, acc) : null;
  const dylibFiles = (Array.isArray(b.dylibs) ? b.dylibs : []).slice(0, 20).map((d) => ({
    file: tmpPath(d.uploadId, acc),
    name: String(d.name || 'tweak.dylib').replace(/[^\w.\-+]/g, '_').replace(/^\.+/, '') || 'tweak.dylib',
  }));

  // Already signing this app for you? Follow that job instead of starting a second copy.
  const runKey = `${acc.id}:${app.id}`;
  const running = signingNow.get(runKey);
  if (running && jobs.has(running) && ['running', 'queued'].includes(jobs.get(running).status)) {
    for (const f of [iconFile, ...dylibFiles.map((d) => d.file)].filter(Boolean)) await rmQuiet(f);
    return json(res, { jobId: running, alreadyRunning: true });
  }

  const job = newJob(acc);
  signingNow.set(runKey, job.id);
  json(res, { jobId: job.id });

  enqueueSign(job, async () => {
    const work = path.join(dirs.work, job.id);
    const previous = () => store.signed.filter((x) => x.ownerId === acc.id && x.appId === app.id);
    const signedId = id();
    const out = path.join(dirs.signed, signedId + '.ipa');
    try {
      // Signing unpacks the app and writes a new copy, so it needs roughly twice the app's size free
      // (three times for link-only apps, which are downloaded first).
      const dl = app.remote ? remoteDownload(app, versionIndex) : null;
      const appSize = (dl && dl.size) || app.size || 0;
      const need = Math.round(appSize * (dl ? 3.3 : 2.3)) + 64 * 1048576;
      let disk = diskInfo();
      if (disk && disk.free < need && previous().length) {
        job.log.push('Making room: replacing your previous signed copy first…');
        for (const old of previous()) await removeSigned(old);
        store.save();
        disk = diskInfo();
      }
      if (disk && disk.free < need) {
        throw new Error(`Not enough space on your server to sign this app (it needs about ${gb(need)} free, ${gb(disk.free)} is free). Delete old signed apps or library apps in Settings › Storage, then try again.`);
      }
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
      const libVersion = app.versionOverride && app.useVersionWhenSigning !== false && /^[0-9A-Za-z.\-]+$/.test(app.versionOverride) ? app.versionOverride : '';
      if (opts.version || libVersion) args.push('-r', opts.version || libVersion);
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
      } else if (app.customIcon && app.useIconWhenSigning !== false) {
        const iconPath = path.join(work, 'icon.png');
        await fsp.copyFile(path.join(dirs.apps, app.id + '-custom.png'), iconPath);
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
      if (dl) {
        // Link-only app: download it just for this signing. It's deleted with the work folder afterwards.
        input = path.join(work, 'original.ipa');
        await fetchToFile(dl.url, dl.headers, input, job, `Downloading ${app.name}${dl.version ? ' ' + dl.version : ''}…`);
        job.progress = null;
      }
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
      else if (app.hasIcon) await fsp.copyFile(path.join(dirs.apps, app.id + '.png'), path.join(dirs.signed, signedId + '.png')).catch(() => {});

      const rec = {
        id: signedId, ownerId: acc.id, token: token(), appId: app.id, certId: cert.id, certLabel: cert.label,
        name: meta.name, bundleId: meta.bundleId, version: meta.version, build: meta.build,
        size: meta.size, hasIcon: !!meta.icon || fs.existsSync(path.join(dirs.signed, signedId + '.png')), signedAt: new Date().toISOString(),
        expires: cert.profile.expires,
        options: {
          ...opts, icon: !!iconFile, dylibs: dylibFiles.map((d) => d.name), versionIndex: versionIndex || 0,
          entitlements: entEdits.map((e) => e.key), plist: plistEdits.map((e) => e.key),
        },
      };
      store.signed.unshift(rec);
      // Replace any older signed copy of this app (only one copy per app per person).
      for (const old of previous().filter((x) => x.id !== rec.id)) await removeSigned(old);
      trimSigned(acc);
      store.save();
      job.result = { signed: signedView(rec, req), replaced: true };
      job.status = 'done';
      job.log.push('Done!');
    } catch (e) {
      await rmQuiet(out);
      const full = isNoSpace(e) || job.log.some((l) => /no space left|ENOSPC/i.test(l));
      job.error = full ? storageFullMessage() : e.message;
      job.status = 'error';
    } finally {
      await rmQuiet(work);
      if (signingNow.get(runKey) === job.id) signingNow.delete(runKey);
    }
  });
});
const signingNow = new Map(); // "owner:app" -> job id

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
  await removeSigned(s);
  store.save();
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
  if (b.deleteAfterInstall !== undefined) store.settings.deleteAfterInstall = !!b.deleteAfterInstall;
  if (b.signedRetentionDays !== undefined) store.settings.signedRetentionDays = Math.min(365, Math.max(0, Number(b.signedRetentionDays) || 0));
  store.save();
  const { github: _gh, ...settings } = store.settings;
  json(res, { settings });
}, 'owner');

route('POST', /^\/api\/maintenance$/, async (req, res) => {
  const { action } = await readJson(req);
  if (action === 'clear-temp') {
    for (const f of await fsp.readdir(dirs.tmp).catch(() => [])) { await rmQuiet(path.join(dirs.tmp, f)); uploads.delete(f); }
    return json(res, { message: 'Temporary files cleared' });
  }
  if (action === 'purge-signed') {
    const n = await cleanupSignedFiles(1);
    return json(res, { message: n ? `Removed ${n} signed file${n === 1 ? '' : 's'} older than a day` : 'Nothing to clean up' });
  }
  return fail(res, 400, 'Unknown action');
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
  for (const a of store.apps) if (a.votes) delete a.votes[u.id];
  store.data.requests = store.requests.filter((r) => r.ownerId !== u.id);
  store.save();
  json(res, { ok: true });
}, 'owner');

// ----- public install endpoints (iOS fetches these without cookies) -----
const findByToken = (t) => store.signed.find((s) => s.token === t);

// Live install progress. iOS can't tell a website when an install finishes, but we can see it ask
// for the install details (after the confirmation pop-up appears) and download the app from us.
const installs = new Map(); // signed id -> { phase, startedAt, manifestAt, downloadAt, sent, size, doneAt }
function installState(s) {
  let st = installs.get(s.id);
  if (!st) { st = { phase: 'idle', sent: 0, size: s.size }; installs.set(s.id, st); }
  return st;
}
function resetInstall(s) {
  const st = { phase: 'waiting', startedAt: Date.now(), sent: 0, size: s.size };
  installs.set(s.id, st);
  return st;
}
function installView(st) {
  return {
    phase: st.phase, sent: Math.min(st.sent, st.size || st.sent), size: st.size,
    progress: st.size ? Math.min(1, st.sent / st.size) : 0,
    startedAt: st.startedAt || null, manifestAt: st.manifestAt || null, downloadAt: st.downloadAt || null, doneAt: st.doneAt || null,
  };
}
setInterval(() => {
  for (const [k, v] of installs) if (Date.now() - (v.doneAt || v.downloadAt || v.manifestAt || v.startedAt || 0) > 60 * 60 * 1000) installs.delete(k);
}, 10 * 60 * 1000).unref();

route('GET', /^\/i\/([\w-]{20,40})\/manifest\.plist$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s || s.fileDeleted) return fail(res, 404, 'Link expired');
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
  const st = installState(s);
  if (st.phase === 'idle' || st.phase === 'done') Object.assign(st, { startedAt: Date.now(), sent: 0, doneAt: null });
  Object.assign(st, { phase: 'confirm', manifestAt: Date.now() });
  send(res, 200, body, { 'Content-Type': 'text/xml; charset=utf-8' });
}, 'open');

route('GET', /^\/i\/([\w-]{20,40})\/app\.ipa$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s || s.fileDeleted) return fail(res, 404, 'Link expired');
  if (req.method === 'HEAD') return serveFile(req, res, path.join(dirs.signed, s.id + '.ipa'));
  const st = installState(s);
  // A range request continues an earlier download; a plain request starts from zero.
  const range = (req.headers.range || '').match(/^bytes=(\d+)-/);
  if (st.phase !== 'downloading' || !range) Object.assign(st, { phase: 'downloading', downloadAt: Date.now(), sent: 0, doneAt: null });
  if (range) st.sent = Math.max(st.sent, Number(range[1]));
  return serveFile(req, res, path.join(dirs.signed, s.id + '.ipa'), {
    download: `${s.name}.ipa`,
    // Done as soon as the last byte goes out. (Waiting for the stream to close is unreliable:
    // iPhones often hang up the moment they have the whole file.)
    onBytes: (n) => {
      st.sent += n;
      if (st.sent >= st.size && st.phase !== 'done') {
        Object.assign(st, { phase: 'done', doneAt: Date.now(), sent: st.size });
        try { recordInstall(s); } catch (e) { console.error('install tracking:', e); }
      }
    },
  });
}, 'open');

function recordInstall(s) {
  const app = store.apps.find((a) => a.id === s.appId);
  store.installLog.push({
    id: id(), signedId: s.id, ownerId: s.ownerId, appId: s.appId, name: s.name, version: s.version,
    shownVersion: app ? shownAppVersion(app) : s.version, certLabel: s.certLabel, at: new Date().toISOString(),
  });
  if (store.installLog.length > 5000) store.installLog.splice(0, store.installLog.length - 5000);
  if (app) app.installCount = (app.installCount || 0) + 1;
  s.installedAt = new Date().toISOString();
  store.save();
}

// The app tells us an install is starting, then checks progress.
route('POST', /^\/api\/signed\/([a-f0-9]{16})\/install$/, (req, res, m, acc) => {
  const s = store.signed.find((x) => x.id === m[1] && x.ownerId === acc.id);
  if (!s) return fail(res, 404, 'Not found');
  if (s.fileDeleted) return fail(res, 410, 'This signed file was cleaned up — sign it again');
  const cur = installs.get(s.id);
  // If the iPhone already asked for the app a moment ago, keep that progress instead of resetting it.
  const fresh = cur && Date.now() - Math.max(cur.manifestAt || 0, cur.downloadAt || 0) < 5000;
  json(res, { install: installView(fresh ? cur : resetInstall(s)) });
});
route('GET', /^\/api\/signed\/([a-f0-9]{16})\/install$/, (req, res, m, acc) => {
  const s = store.signed.find((x) => x.id === m[1] && x.ownerId === acc.id);
  if (!s) return fail(res, 404, 'Not found');
  json(res, { install: installView(installState(s)) });
});
// Same for shared install pages (anyone with the link).
route('POST', /^\/i\/([\w-]{20,40})\/status$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s || s.fileDeleted) return fail(res, 404, 'Link expired');
  const cur = installs.get(s.id);
  const fresh = cur && Date.now() - Math.max(cur.manifestAt || 0, cur.downloadAt || 0) < 5000;
  json(res, { install: installView(fresh ? cur : resetInstall(s)) });
}, 'open');
route('GET', /^\/i\/([\w-]{20,40})\/status$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s || s.fileDeleted) return fail(res, 404, 'Link expired');
  json(res, { install: installView(installState(s)) });
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
  if (!s || s.fileDeleted) {
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

// ----- QR codes (for install links) -----
route('GET', /^\/api\/qr$/, (req, res) => {
  const text = String(req.query.get('text') || '').slice(0, 200);
  if (!text) return fail(res, 400, 'Nothing to encode');
  let svg;
  try { svg = qrSvg(text); } catch (e) { return fail(res, 400, e.message); }
  send(res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=86400' });
});

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
    const isFile = fs.existsSync(file) && fs.statSync(file).isFile();
    if (isFile && !file.endsWith(path.sep + 'index.html')) return serveFile(req, res, file, { cache: 'no-cache' });
    // The app page carries the version so scripts load fresh after every update.
    const page = (await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')).replace(/__VERSION__/g, displayVersion()).replace(/__BUILD__/g, BUILD_ID).replace(/__CODE_VERSION__/g, VERSION);
    return send(res, 200, page, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (isNoSpace(e)) { if (!res.headersSent) fail(res, 507, storageFullMessage()); return; }
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
  console.log(`Mango Signer ${VERSION} (build ${BUILD_ID}) running on port ${PORT} (data: ${DATA_DIR})`);
  if (!APP_PASSWORD) console.log('WARNING: APP_PASSWORD is not set — anyone with the link has owner access.');
});
