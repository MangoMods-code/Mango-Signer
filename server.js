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
const { drawAppIcon, shrinkPng } = require('./lib/png');
const { qrSvg } = require('./lib/qr');
const sources = require('./lib/sources');
const github = require('./lib/github');
const macho = require('./lib/macho');
const deb = require('./lib/deb');
const zipLib = require('./lib/zip');
const telegram = require('./lib/telegram');
const appstore = require('./lib/appstore');

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
  tweaks: path.join(DATA_DIR, 'tweaks'),
  cache: path.join(DATA_DIR, 'cache'),
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
  udid: store.settings.ownerUdid || null, deviceName: store.settings.ownerDeviceName || null, sv: store.settings.ownerSv || 0,
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

// ---------- alerts & security log ----------
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function shortUa(ua = '') {
  const ios = ua.match(/(iPhone|iPad|iPod).*?OS (\d+)_(\d+)/);
  const browser = /CriOS/.test(ua) ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS|Edg\//.test(ua) ? 'Edge' : /Safari/.test(ua) ? 'Safari' : '';
  if (ios) return `${ios[1]} · iOS ${ios[2]}.${ios[3]}${browser ? ' · ' + browser : ''}`;
  if (/Android/.test(ua)) return `Android${browser ? ' · ' + browser : ''}`;
  if (/Macintosh/.test(ua)) return `Mac${browser ? ' · ' + browser : ''}`;
  if (/Windows/.test(ua)) return `Windows${browser ? ' · ' + browser : ''}`;
  return ua ? ua.slice(0, 40) : 'Unknown device';
}
// An alert shows up in someone's 🔔 inbox. ownerId 'owner' is you.
function addAlert(ownerId, kind, title, body = '', extra = {}) {
  store.alerts.push({ id: id(), ownerId, kind, title: String(title).slice(0, 120), body: String(body).slice(0, 400), at: new Date().toISOString(), read: false, ...extra });
  const mine = store.alerts.filter((a) => a.ownerId === ownerId);
  if (mine.length > 100) for (const old of mine.slice(0, mine.length - 100)) store.alerts.splice(store.alerts.indexOf(old), 1);
  if (store.alerts.length > 8000) store.alerts.splice(0, store.alerts.length - 8000);
}
function secEvent(req, type, user, ok, detail = '') {
  store.securityLog.push({ id: id(), at: new Date().toISOString(), type, user: user || '?', ok: !!ok, ip: req ? clientIp(req) : '', device: req ? shortUa(req.headers['user-agent']) : '', detail });
  if (store.securityLog.length > 600) store.securityLog.splice(0, store.securityLog.length - 600);
}
// Too many wrong passwords for one username locks it for 15 minutes (on top of the per-IP limit).
const userFails = new Map();
const LOCK_AFTER = 8;
const LOCK_MS = 15 * 60_000;
function accountLocked(name) {
  const f = userFails.get(name);
  return !!(f && f.n >= LOCK_AFTER && Date.now() - f.t < LOCK_MS);
}
function noteFail(req, name) {
  const f = userFails.get(name);
  const n = f && Date.now() - f.t < LOCK_MS ? f.n + 1 : 1;
  userFails.set(name, { n, t: Date.now() });
  if (n === LOCK_AFTER) {
    secEvent(req, 'locked', name, false, `${LOCK_AFTER} wrong passwords in a row`);
    addAlert('owner', 'security', `🔒 ${name === 'owner' ? 'Your owner login' : name} was locked for 15 minutes`, `${LOCK_AFTER} wrong passwords in a row from ${clientIp(req) || 'an unknown address'} (${shortUa(req.headers['user-agent'])}).`);
    const u = store.users.find((x) => x.username === name);
    if (u) addAlert(u.id, 'security', '🔒 Someone kept trying your password', `Your account was locked for 15 minutes after ${LOCK_AFTER} wrong passwords. If this wasn't you, change your password.`);
  }
}
// Tells everyone who installed an app that a new version is in the library.
function notifyUpdate(app, oldVersion) {
  const shown = app.versionOverride || app.version;
  if (!oldVersion || !shown || oldVersion === shown || app.published === false) return;
  const who = Object.entries(store.data.myApps || {})
    .filter(([, list]) => list[app.id] && !installStopped(list[app.id]) && versionCmp(app.version, list[app.id].version) > 0)
    .map(([uid]) => uid);
  for (const uid of who) {
    if (store.alerts.some((a) => a.ownerId === uid && a.kind === 'update' && a.appId === app.id && a.version === shown)) continue;
    const have = store.data.myApps[uid][app.id];
    addAlert(uid, 'update', `⬆ ${app.name} ${shown} is out`, `You have ${have.shown || have.version || oldVersion}. Tap to update.`, { appId: app.id, version: shown });
  }
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
    Object.defineProperty(job, 'child', { value: child, enumerable: false, configurable: true });
    if (job.cancelled) child.kill('SIGKILL');
    const timer = setTimeout(() => { job.log.push('Timed out.'); child.kill('SIGKILL'); }, timeout);
    const onData = (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (clean) job.log.push(clean.slice(0, 2000));
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

// ----- signed apps kept on GitHub -----
// With GitHub storage connected (private repo), every signed app is also saved to a "Mango Signed" release.
// The copy on this server is used for the first install and then removed; after that installs stream from
// GitHub. The signed app stays in the Signed tab until it's deleted (which deletes it from GitHub too),
// or until its certificate expires and it couldn't be installed anyway.
const SIGNED_TAG = 'mango-signed';
function signedToGithubOn() {
  const g = ghSettings();
  return !!(g && g.private && g.signedToGithub !== false && ghClient());
}
const signedReady = (s) => !s.fileDeleted || !!(s.gh && ghClient());
const archiveFailedForGood = (s) => (s.archiveTries || 0) >= 5;
async function signedRelease(gh) {
  const g = ghSettings();
  let r = g.signedRelease;
  // A GitHub release holds up to 1,000 files, so start a new one (mango-signed-2, -3…) before that.
  if (!r || r.count >= 950) {
    const n = r ? (r.n || 1) + 1 : 1;
    const tag = n === 1 ? SIGNED_TAG : `${SIGNED_TAG}-${n}`;
    const rel = await gh.ensureRelease(tag, { name: n === 1 ? 'Mango Signed' : `Mango Signed ${n}`, body: 'Signed apps from Mango Signer. Managed automatically: deleting an app from the Signed tab deletes it here.' });
    const count = n === 1 && !r ? (await gh.listAssets(rel.id).catch(() => [])).length : 0;
    r = g.signedRelease = { id: rel.id, tag, n, count };
    store.save();
    if (count >= 950) return signedRelease(gh);
  }
  return r;
}
let archiving = false;
// Uploads signed apps that aren't on GitHub yet, one at a time, in the background.
async function archiveSigned() {
  if (archiving || !signedToGithubOn()) return;
  archiving = true;
  try {
    for (;;) {
      const s = store.signed.find((x) => !x.gh && !x.fileDeleted && !archiveFailedForGood(x) && !(x.expires && new Date(x.expires) < Date.now()) && (!x.archiveAfter || Date.now() > x.archiveAfter));
      if (!s || !signedToGithubOn()) break;
      const file = path.join(dirs.signed, s.id + '.ipa');
      const st = await fsp.stat(file).catch(() => null);
      if (!st) { s.archiveTries = 5; continue; }
      const gh = ghClient();
      try {
        const rel = await signedRelease(gh);
        const name = `signed-${normName(s.name).slice(0, 40) || 'app'}-${(s.version || 'v').replace(/[^\w.]/g, '')}-${s.id}.ipa`;
        const asset = await gh.uploadStream(rel.id, name, Readable.toWeb(fs.createReadStream(file)), st.size, null);
        ghSettings().signedRelease.count++;
        if (!store.signed.includes(s)) { await gh.deleteAsset(asset.id).catch(() => {}); continue; } // deleted while uploading
        s.gh = { assetId: asset.id, releaseId: rel.id };
        delete s.archiveTries; delete s.archiveAfter;
        store.save();
      } catch (e) {
        s.archiveTries = (s.archiveTries || 0) + 1;
        s.archiveAfter = Date.now() + 5 * 60_000 * s.archiveTries;
        store.save();
        console.error(`Saving ${s.name} to GitHub failed:`, e.message);
        break;
      }
    }
  } finally { archiving = false; }
}
setInterval(() => archiveSigned().catch(() => {}), 10 * 60_000).unref();
setTimeout(() => archiveSigned().catch(() => {}), 60_000).unref();
async function dropSignedCopy(s) {
  if (!s.gh) return;
  const gh = ghClient();
  const assetId = s.gh.assetId;
  s.gh = null;
  if (gh) await gh.deleteAsset(assetId);
  const r = ghSettings() && ghSettings().signedRelease;
  if (r && r.count > 0) r.count--;
  store.save();
}
// Streams a signed app from GitHub to the iPhone (Range requests pass through, so resumed downloads work).
async function serveSignedFromGithub(req, res, s, onBytes) {
  const gh = ghClient();
  let link;
  try { link = await gh.directLink(s.gh.assetId); } catch (e) {
    if (e.status === 404) { s.gh = null; store.save(); }
    return fail(res, e.status === 404 ? 404 : 502, e.status === 404 ? 'This signed app is gone from GitHub. Sign it again.' : "Couldn't get the app from GitHub. Try again.");
  }
  const idle = idleSignal(null, 60_000);
  let r;
  try { r = await fetch(link, { headers: req.headers.range ? { Range: req.headers.range } : {}, signal: idle.signal }); } catch { idle.done(); return fail(res, 502, "Couldn't get the app from GitHub. Try again."); }
  if (!r.ok || !r.body) { idle.done(); return fail(res, 502, `Couldn't get the app from GitHub (HTTP ${r.status})`); }
  const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${`${s.name}.ipa`.replace(/[^\w.\- ]/g, '_')}"` };
  for (const h of ['content-length', 'content-range']) if (r.headers.get(h)) headers[h.replace(/(^|-)\w/g, (c) => c.toUpperCase())] = r.headers.get(h);
  res.writeHead(r.status, headers);
  if (req.method === 'HEAD') { idle.done(); r.body.cancel().catch(() => {}); return res.end(); }
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => { idle.kick(); if (onBytes) onBytes(c.length); });
  return pipeline(body, res).catch(() => {}).finally(() => idle.done());
}

// Deletes a signed copy (file, icon and record).
async function removeSigned(s) {
  const i = store.signed.indexOf(s);
  if (i >= 0) store.signed.splice(i, 1);
  await rmQuiet(path.join(dirs.signed, s.id + '.ipa'));
  await rmQuiet(path.join(dirs.signed, s.id + '.png'));
  dropSignedCopy(s).catch(() => {});
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
  // Cancel support: long downloads/uploads listen to this signal, and a running zsign gets killed.
  Object.defineProperty(job, 'abort', { value: new AbortController(), enumerable: false });
  job.signal = job.abort.signal;
  Object.defineProperty(job, 'signal', { enumerable: false });
  jobs.set(job.id, job);
  return job;
}
// Finished jobs are forgotten an hour after they end. Running ones are kept however long they take
// (a scan of a huge channel can run for hours).
setInterval(() => {
  for (const [jid, j] of jobs) {
    if (['running', 'queued'].includes(j.status)) continue;
    j.endedAt = j.endedAt || Date.now();
    if (Date.now() - j.endedAt > 60 * 60 * 1000) jobs.delete(jid);
  }
}, 5 * 60 * 1000).unref();
let activeSigns = 0;
const signQueue = [];
function enqueueSign(job, work) {
  const start = async () => {
    activeSigns++;
    job.status = 'running';
    try { if (!job.cancelled) await work(); } finally {
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
// ----- "My apps": what each person has installed through Mango -----
// iOS doesn't let websites see what's on a phone, so this is built from installs Mango watched finish
// in the app (not from shared links, which could be anyone's phone). People can fix it themselves
// ("not on my phone" / "already have the latest"), and an app whose certificate has expired or been
// revoked is shown as no longer opening instead of nagging for updates.
if (!store.data.myApps || typeof store.data.myApps !== 'object') {
  store.data.myApps = {};
  for (const l of store.installLog) {
    const sg = store.signed.find((x) => x.id === l.signedId);
    (store.data.myApps[l.ownerId] ||= {})[l.appId] = {
      version: l.version || '', shown: l.shownVersion || l.version || '', at: l.at, signedId: l.signedId || null,
      bundleId: sg ? sg.bundleId : null, certId: sg ? sg.certId : null, expires: sg ? certExpiry(store.certs.find((c) => c.id === sg.certId)) : null,
    };
  }
  store.save();
}
// Drop "update available" alerts that no longer apply (already updated, deleted, or the app is gone).
{
  const before = store.alerts.length;
  store.data.alerts = store.alerts.filter((x) => {
    if (x.kind !== 'update' || !x.appId) return true;
    const app = store.apps.find((a) => a.id === x.appId);
    const e = (store.data.myApps[x.ownerId] || {})[x.appId];
    return !!(app && e && versionCmp(app.version, e.version) > 0);
  });
  if (store.alerts.length !== before) store.save();
}
function certExpiry(c) {
  if (!c) return null;
  return [c.p12 && c.p12.validTo, c.profile && c.profile.expires].filter(Boolean).sort()[0] || null;
}
const myAppsOf = (uid) => (store.data.myApps[uid] ||= {});
// Why an installed app no longer opens, or null if it should still work.
function installStopped(e) {
  const c = e.certId && store.certs.find((x) => x.id === e.certId);
  const exp = (c && certExpiry(c)) || e.expires;
  if (exp && new Date(exp) < Date.now()) return 'expired';
  if (c && c.check && c.check.status === 'revoked' && (!c.check.checkedAt || new Date(c.check.checkedAt) > new Date(e.at))) return 'revoked';
  return null;
}
function installedView(a, acc) {
  const e = (store.data.myApps[acc.id] || {})[a.id];
  if (!e) return null;
  const stopped = installStopped(e);
  const cmp = a.version && e.version ? versionCmp(a.version, e.version) : 0;
  return {
    version: cmp === 0 && e.version === a.version ? shownAppVersion(a) || e.shown : e.shown || e.version,
    at: e.at, stopped,
    update: !stopped && cmp > 0,
  };
}

function appView(a, acc) {
  const votes = Object.values(a.votes || {});
  const extra = {
    likes: votes.filter((v) => v > 0).length,
    dislikes: votes.filter((v) => v < 0).length,
    myVote: (a.votes || {})[acc.id] || 0,
    installed: installedView(a, acc),
  };
  const { votes: _v, remote, ...base } = a;
  if (remote) {
    const src = remote.sourceId && store.sources.find((x) => x.id === remote.sourceId);
    extra.cloud = remote.kind; // 'link' | 'source' | 'github'
    extra.sourceName = src ? src.name : null;
    extra.missing = !!remote.missing;
    extra.versions = (remote.kind === 'source' ? mergedVersions(a) : remote.versions || []).map((v) => ({ version: v.version, date: v.date, size: v.size, notes: (v.notes || '').slice(0, 400), channel: v.channel, manualId: v.manualId || undefined }));
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
    fileAvailable: signedReady(s),
    savedOnGithub: !!s.gh,
    gh: undefined, archiveTries: undefined,
    onPhone: !!(s.appId && ((store.data.myApps[s.ownerId] || {})[s.appId] || {}).signedId === s.id),
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
    signLimit: u.signLimit ?? null, signsToday: signsToday(u.id),
    recentSignins: store.securityLog.filter((e) => e.user === u.username && /^login/.test(e.type)).slice(-5).reverse(),
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
  const who = name || 'owner';
  if (accountLocked(who)) return fail(res, 429, 'Too many wrong passwords — this account is locked for 15 minutes');

  if ((!name || name === 'owner') && APP_PASSWORD && safeEqual(password, APP_PASSWORD)) {
    rl.ok();
    userFails.delete('owner');
    secEvent(req, 'login', 'owner', true);
    store.save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, OWNER()) });
  }
  const u = store.users.find((x) => x.username === name);
  if (u && !u.disabled && checkPassword(password, u)) {
    rl.ok();
    userFails.delete(name);
    u.lastLogin = new Date().toISOString();
    secEvent(req, 'login', name, true);
    store.save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, { ...u }) });
  }
  rl.fail();
  if (name === 'owner' || !name || u) noteFail(req, who);
  secEvent(req, 'login', who, false, u && u.disabled ? 'account turned off' : u || who === 'owner' ? 'wrong password' : 'no such user');
  store.save();
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
  if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) { rl.fail(); return fail(res, 400, 'That invite code has expired'); }
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
  secEvent(req, 'signup', name, true, `invite ${code}`);
  addAlert('owner', 'user', `👋 ${name} joined`, `Used invite ${code}${inv.note ? ` (${inv.note})` : ''}.`, { userId: user.id });
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
    if (holder !== 'owner') findUser(holder).lastLogin = new Date().toISOString();
    secEvent(req, 'login-udid', acc.username, true, acc.deviceName ? `with ${acc.deviceName}` : 'with iPhone');
    store.save();
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
    library: (await dirSize(dirs.apps)) + (await dirSize(dirs.tweaks)),
    signed: await dirSize(dirs.signed),
    certs: await dirSize(dirs.certs),
    temp: (await dirSize(dirs.tmp)) + (await dirSize(dirs.work)) + (await dirSize(dirs.cache)),
  };
}

// ----- download cache -----
// Apps that live elsewhere (Telegram, GitHub, links) are downloaded each time they're signed. The last
// few downloads are kept for a while, so signing the same app again (or for someone else) skips the download.
// Kept small: 1 GB at most, 2 days at most, and nothing is cached when the server is low on space.
const CACHE_MAX = () => (Number(store.settings.ipaCacheMB) || 1024) * 1048576;
function downloadCacheKey(app, versionIndex, dl) {
  const r = app.remote || {};
  const id = [app.id, versionIndex || 0, (dl && dl.version) || app.version || '', app.updatedAt || '', r.msgId || '', r.assetId || r.ghAssetId || '', r.kind === 'link' ? r.url : ''].join('|');
  return crypto.createHash('sha1').update(id).digest('hex').slice(0, 24) + '.ipa';
}
async function cacheGet(key) {
  const p = path.join(dirs.cache, key);
  const st = await fsp.stat(p).catch(() => null);
  if (!st || !st.size) return null;
  const now = new Date();
  await fsp.utimes(p, now, now).catch(() => {});
  return p;
}
async function cachePut(file, key) {
  try {
    const d = diskInfo();
    if (d && d.free < 1.5 * 1024 ** 3) return;
    const st = await fsp.stat(file);
    if (st.size > CACHE_MAX() * 0.6) return;
    const dest = path.join(dirs.cache, key);
    await rmQuiet(dest);
    // Same disk, so a hard link costs no extra space while the work folder still has it.
    await fsp.link(file, dest).catch(() => fsp.copyFile(file, dest));
    await trimCache();
  } catch { /* caching is only a speed-up */ }
}
async function trimCache() {
  const files = [];
  for (const f of await fsp.readdir(dirs.cache).catch(() => [])) {
    const st = await fsp.stat(path.join(dirs.cache, f)).catch(() => null);
    if (st) files.push({ f, size: st.size, used: st.mtimeMs });
  }
  files.sort((a, b) => b.used - a.used);
  let total = 0;
  const d = diskInfo();
  const max = d && d.free < 1024 ** 3 ? 0 : CACHE_MAX();
  for (const x of files) {
    total += x.size;
    if (total > max || Date.now() - x.used > 2 * 864e5) await rmQuiet(path.join(dirs.cache, x.f));
  }
}
setInterval(() => trimCache().catch(() => {}), 30 * 60 * 1000).unref();

// Signed .ipa files are only needed to install, so old ones are deleted to save space.
// The record stays so people can see it and tap "Sign again".
async function cleanupSignedFiles(maxAgeDays = Number(store.settings.signedRetentionDays)) {
  let n = 0;
  for (const s of store.signed) {
    // A copy on GitHub is only useful while its certificate works. After that, remove it to keep the repo tidy.
    if (s.gh && s.expires && Date.now() - new Date(s.expires) > 864e5) { await dropSignedCopy(s).catch(() => {}); n++; }
    if (s.fileDeleted) continue;
    // Once an app finished installing, its signed file isn't needed any more (kept 15 minutes in case iOS retries).
    const installedLongEnough = store.settings.deleteAfterInstall && s.installedAt && Date.now() - new Date(s.installedAt) > 15 * 60 * 1000;
    const tooOld = maxAgeDays && Date.now() - new Date(s.signedAt) >= maxAgeDays * 864e5;
    // Saved on GitHub: the copy here is just for a quick first install, so it goes after a few hours.
    const backedUp = s.gh && Date.now() - new Date(s.signedAt) > 6 * 3600_000;
    if (!installedLongEnough && !tooOld && !backedUp) continue;
    if (signedToGithubOn() && !s.gh && !archiveFailedForGood(s) && !(s.expires && new Date(s.expires) < Date.now())) continue; // wait until it's saved
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
    tweaks: visibleTweaks(acc).map((t) => tweakView(t, acc)),
    alerts: store.alerts.filter((a) => a.ownerId === acc.id).slice(-60).reverse().map(alertView),
    favorites: store.favorites[acc.id] || [],
    mySignins: store.securityLog.filter((e) => e.user === acc.username && /^login|signout/.test(e.type)).slice(-8).reverse(),
    presets: store.presets.filter((p) => p.ownerId === acc.id).map(({ ownerId, ...p }) => p),
    substrate: substrateView(),
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
    out.telegram = tgView();
    out.securityLog = store.securityLog.slice(-200).reverse();
    out.server = { ...out.server, zsign: zsignVersion, passwordSet: !!APP_PASSWORD, storage: await storageUsed(), storageBreakdown: await storageBreakdown(), disk: diskInfo() };
  } else {
    out.settings = { maxSignedPerUser: store.settings.maxSignedPerUser, signedRetentionDays: store.settings.signedRetentionDays, signedOnGithub: signedToGithubOn(), signsPerDay: signLimitFor(acc), signsToday: signsToday(acc.id) };
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
  notifyUpdate(app, oldShown);
  store.save();
  return app;
}

async function downloadToTmp(u, job) {
  const dest = path.join(dirs.tmp, id());
  job.log.push(`Downloading ${u.hostname}…`);
  job.cancellable = true;
  const idle = idleSignal(job.signal);
  let r;
  try { r = await fetch(u, { redirect: 'follow', signal: idle.signal }); } catch (e) { idle.done(); throw idle.stalled() ? idle.signal.reason : e; }
  if (!r.ok || !r.body) { idle.done(); throw new Error(`Download failed (HTTP ${r.status})`); }
  const type = r.headers.get('content-type') || '';
  if (/text\/html/i.test(type)) { idle.done(); r.body.cancel().catch(() => {}); throw new Error("That link opens a web page, not a file. Use a direct download link (for Dropbox, change dl=0 to dl=1)."); }
  const total = Number(r.headers.get('content-length')) || 0;
  let got = 0;
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => {
    got += c.length;
    idle.kick();
    job.progress = total ? got / total : null;
    if (got > MAX_UPLOAD) body.destroy(new Error('File is too large'));
  });
  try {
    await pipeline(body, fs.createWriteStream(dest));
  } catch (e) {
    await rmQuiet(dest);
    throw idle.stalled() ? idle.signal.reason : e;
  } finally {
    idle.done();
  }
  if (total && got < total) { await rmQuiet(dest); throw new Error(`The download stopped early (${gb(got)} of ${gb(total)}). Try again.`); }
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
  job.title = `Adding from ${u.hostname}`;
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
  if (app.remote && app.remote.kind === 'telegram') return fail(res, 400, 'Apps from a Telegram channel update themselves when the channel posts a new version');
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
        notifyUpdate(app, oldShown);
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
  if (Array.isArray(d.tweakIds)) out.tweakIds = d.tweakIds.filter((x) => store.tweaks.some((t) => t.id === x)).slice(0, 20);
  return out;
}

route('PATCH', /^\/api\/apps\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const b = await readJson(req);
  {
    // Remember what you changed so the next source/channel sync or auto-categorize doesn't undo it.
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
    const was = app.versionOverride || app.version;
    app.versionOverride = v || null;
    if ((app.versionOverride || app.version) !== was) notifyUpdate(app, was);
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
    const iconBuf = await fsp.readFile(f);
    await fsp.writeFile(path.join(dirs.apps, app.id + '-custom.png'), shrinkPng(iconBuf, 512));
    await rmQuiet(f);
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

async function deleteApp(appId, { keepRemote = false, exclude = false } = {}) {
  const i = store.apps.findIndex((a) => a.id === appId);
  if (i < 0) return false;
  const app = store.apps[i];
  if (exclude) excludeFromSource(app);
  if (!keepRemote) {
    const gh = ghClient();
    for (const v of app.manualVersions || []) if (gh && v.storage && v.storage.kind === 'github') await gh.deleteAsset(v.storage.assetId).catch(() => {});
  }
  if (!keepRemote && app.remote && (app.remote.kind === 'github' || app.remote.ghAssetId)) {
    const gh = ghClient();
    if (gh) await gh.deleteAsset(app.remote.assetId || app.remote.ghAssetId).catch((e) => console.error('GitHub delete:', e.message));
  }
  store.apps.splice(i, 1);
  for (const list of Object.values(store.data.myApps || {})) delete list[appId];
  for (const suffix of ['.ipa', '.png', '-custom.png']) await rmQuiet(path.join(dirs.apps, appId + suffix));
  await rmQuiet(path.join(dirs.apps, appId + '-shots'));
  for (const c of store.collections) c.appIds = c.appIds.filter((x) => x !== appId);
  return true;
}

route('DELETE', /^\/api\/apps\/([a-f0-9]{16})$/, async (req, res, m) => {
  if (!(await deleteApp(m[1], { exclude: true }))) return fail(res, 404, 'App not found');
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
    else if (action === 'delete') await deleteApp(a.id, { exclude: true });
    else return fail(res, 400, 'Unknown action');
  }
  store.save();
  json(res, { ok: true, count: apps.length });
}, 'owner');

// Cleans up duplicates in one go: for every bundle ID in the library more than once, keeps one copy and
// deletes the rest. Which one stays: copies from the place you pick (if it has one), otherwise the newest
// version (then the most installed, then the one you had first). Deleted copies are remembered by their
// source, so a refresh doesn't bring them back.
function dedupeKeeper(group, prefer) {
  const pref = prefer && prefer !== 'newest' ? group.filter((a) => (prefer === 'mine' ? !a.remote || ['github', 'link'].includes(a.remote.kind) : a.remote && a.remote.sourceId === prefer)) : [];
  const pool = pref.length ? pref : group;
  return [...pool].sort((x, y) => versionCmp(y.version, x.version) || (y.installCount || 0) - (x.installCount || 0) || String(x.addedAt).localeCompare(String(y.addedAt)))[0];
}
function duplicateGroupsServer() {
  const by = new Map();
  for (const a of store.apps) {
    const b = normBid(a.bundleId);
    if (!b || (a.remote && a.remote.missing)) continue;
    if (!by.has(b)) by.set(b, []);
    by.get(b).push(a);
  }
  return [...by.values()].filter((g) => g.length > 1);
}
route('POST', /^\/api\/apps\/dedupe$/, async (req, res) => {
  // picks: { bundleId: appId } — copies you chose yourself. only: a bundle ID to clean up just that app.
  const { prefer = 'newest', picks = {}, only = null } = await readJson(req);
  const groups = duplicateGroupsServer().filter((g) => !only || normBid(g[0].bundleId) === normBid(only));
  let deleted = 0;
  for (const g of groups) {
    const picked = picks && picks[normBid(g[0].bundleId)];
    const keep = (picked && g.find((a) => a.id === picked)) || dedupeKeeper(g, prefer);
    for (const a of g) if (a !== keep) { await deleteApp(a.id, { exclude: true }); deleted++; }
  }
  store.save();
  json(res, { ok: true, groups: groups.length, deleted });
}, 'owner');

// Deletes every app marked "Removed from source" (optionally just one source's).
// Telegram channels are re-checked first, so only apps whose post is really gone are deleted.
route('POST', /^\/api\/apps\/delete-removed$/, async (req, res) => {
  const { sourceId = null } = await readJson(req);
  const srcs = store.sources.filter((x) => x.kind === 'telegram' && (!sourceId || x.id === sourceId));
  for (const src of srcs) {
    if (!store.apps.some((a) => a.remote && a.remote.sourceId === src.id && a.remote.missing)) continue;
    try { await tgMarkRemoved(src); } catch { /* use what we have */ }
  }
  const gone = store.apps.filter((a) => a.remote && a.remote.missing && (!sourceId || a.remote.sourceId === sourceId)).map((a) => a.id);
  for (const id of gone) await deleteApp(id);
  store.save();
  json(res, { ok: true, count: gone.length });
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
    const dl = await resolveDownload(remoteDownload(app));
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
  if (r.kind === 'telegram') {
    if (r.ghAssetId) {
      const gh = ghClient();
      if (!gh) throw httpError(400, 'GitHub storage is not connected. Reconnect it in Settings › GitHub storage.');
      return { ...gh.download(r.ghAssetId), size: app.size, version: app.version };
    }
    if (!tgReady()) throw httpError(400, 'Telegram is not connected, so apps from Telegram channels can\'t be downloaded. Connect it in Settings › Telegram.');
    return { telegram: { ref: r.ref, msgId: r.msgId }, size: app.size, version: app.version };
  }
  if (r.kind === 'github') {
    const gh = ghClient();
    if (!gh) throw httpError(400, 'GitHub storage is not connected. Reconnect it in Settings › GitHub storage.');
    return { ...gh.download(r.assetId), size: app.size, version: app.version };
  }
  if (r.kind === 'source' && (Array.isArray(r.versions) && r.versions.length || (app.manualVersions || []).length)) {
    const list = mergedVersions(app);
    const v = list[Math.min(versionIndex, list.length - 1)];
    if (v.storage && v.storage.kind === 'github') {
      const gh = ghClient();
      if (!gh) throw httpError(400, 'This version is in your GitHub storage, which is not connected. Reconnect it in Settings › GitHub storage.');
      return { ...gh.download(v.storage.assetId), size: v.size, version: v.version };
    }
    return { url: v.url || (v.storage && v.storage.url), headers: null, size: v.size || (versionIndex ? 0 : app.size), version: v.version };
  }
  return { url: r.url, headers: null, size: app.size, version: app.version };
}

// Telegram files get a fresh local URL each time (the helper may have restarted on a new port).
async function resolveDownload(dl) {
  if (!dl.telegram) return dl;
  const f = await tg.file(dl.telegram.ref, dl.telegram.msgId);
  return { ...dl, url: f.url, headers: f.headers };
}

// A signal that aborts if a transfer goes quiet for too long (or when `parent` aborts, e.g. Stop).
// Call kick() whenever data arrives and done() when finished.
function idleSignal(parent, ms = 90_000, msg = 'The download stalled (nothing came in for 90 seconds). Try again.') {
  const ctrl = new AbortController();
  let t;
  const kick = () => { clearTimeout(t); t = setTimeout(() => ctrl.abort(new Error(msg)), ms); };
  const onParent = () => ctrl.abort(parent.reason);
  if (parent) { if (parent.aborted) ctrl.abort(parent.reason); else parent.addEventListener('abort', onParent, { once: true }); }
  kick();
  return { signal: ctrl.signal, kick, done: () => { clearTimeout(t); if (parent) parent.removeEventListener('abort', onParent); }, stalled: () => ctrl.signal.aborted && !(parent && parent.aborted) };
}

// Fetches a link that may need a login header. The header is only sent to the first address:
// if it redirects (GitHub sends you to a short-lived download link), the next hop gets no token.
async function fetchAuthed(url, headers, signal) {
  if (!headers) return fetch(url, { headers: { 'User-Agent': 'Mango-Signer' }, redirect: 'follow', signal });
  const first = await fetch(url, { headers: { 'User-Agent': 'Mango-Signer', ...headers }, redirect: 'manual', signal });
  if (first.status >= 300 && first.status < 400 && first.headers.get('location')) {
    first.body && first.body.cancel().catch(() => {});
    return fetch(new URL(first.headers.get('location'), url), { headers: { 'User-Agent': 'Mango-Signer' }, redirect: 'follow', signal });
  }
  return first;
}

async function fetchToFile(url, headers, dest, job, label) {
  if (job && label) job.log.push(label);
  if (job) job.cancellable = true;
  const idle = idleSignal(job && job.signal);
  let r;
  try { r = await fetchAuthed(url, headers, idle.signal); } catch (e) { idle.done(); throw idle.stalled() ? idle.signal.reason : e; }
  if (!r.ok || !r.body) { idle.done(); throw new Error(`Download failed (HTTP ${r.status}). The link may have moved or expired.`); }
  if (/text\/html/i.test(r.headers.get('content-type') || '')) {
    idle.done();
    r.body.cancel().catch(() => {});
    throw new Error('That link opens a web page, not an app file. Use a direct download link.');
  }
  const total = Number(r.headers.get('content-length')) || 0;
  let got = 0;
  let lastLog = 0;
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => {
    got += c.length;
    idle.kick();
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
    throw idle.stalled() ? idle.signal.reason : e;
  } finally {
    idle.done();
  }
  if (total && got < total) {
    await rmQuiet(dest);
    throw new Error(`The download stopped early (${gb(got)} of ${gb(total)}). Try again.`);
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
  job.title = `Adding from ${u.hostname}`;
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

// ----- apps you deleted from a source -----
// Deleting an app that came from a source, GitHub repo or Telegram channel remembers it on that source,
// so the next refresh doesn't add it back. (Handy when two sources both have the same app.)
// It can be brought back from the source's page.
const normBid = (b) => String(b || '').trim().toLowerCase();
function excludeFromSource(app) {
  const r = app.remote;
  const src = r && r.sourceId && store.sources.find((x) => x.id === r.sourceId);
  if (!src) return;
  src.excluded = src.excluded || [];
  const bid = normBid(app.bundleId);
  if (src.excluded.some((e) => (r.key && e.key === r.key) || (bid && e.bundleId === bid))) return;
  src.excluded.push({ key: r.key || null, bundleId: bid || null, name: app.originalName || app.name, at: new Date().toISOString() });
}
// Is an app with this bundle ID already in the library from another place (another source, your uploads…)?
const haveElsewhere = (bundleId, srcId) => {
  const b = normBid(bundleId);
  return !!b && store.apps.some((a) => normBid(a.bundleId) === b && !(a.remote && a.remote.sourceId === srcId) && !(a.remote && a.remote.missing));
};
// GitHub repos you follow are for that one app, so they always add it. Other sources skip apps you already have.
const sourceSkipsHave = (src) => (src.skipHave === undefined ? src.kind !== 'ghrepo' : !!src.skipHave);
const isExcluded = (src, { key, bundleId }) => (src.excluded || []).some((e) => (key && e.key === key) || (normBid(bundleId) && e.bundleId === normBid(bundleId)));

// ----- GitHub repos as sources -----
// "Follow" a developer's GitHub repo: every release with an .ipa attached becomes a version, so new
// releases show up as updates, whatever the file is called (BuildBox-2.1.3.ipa, BuildBox-2.1.4.ipa…).
function parseGithubRepo(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repoRaw, kind] = parts;
  if (kind && !['releases', 'tags'].includes(kind)) return null; // a file inside the repo: treat as a normal source link
  if (/\.json$/i.test(u.pathname)) return null;
  const repo = repoRaw.replace(/\.git$/i, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}
async function githubApi(pathname) {
  const headers = { 'User-Agent': 'Mango-Signer', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const g = ghSettings();
  // Your GitHub token (if connected) gives a much higher hourly limit; fall back to no token if it can't read the repo.
  const token = g && g.tokenEnc ? (() => { try { return decrypt(g.tokenEnc); } catch { return null; } })() : null;
  const api = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
  for (const auth of token ? [true, false] : [false]) {
    const r = await fetch(api + pathname, { headers: auth ? { ...headers, Authorization: `Bearer ${token}` } : headers, signal: AbortSignal.timeout(30000) });
    if (auth && (r.status === 401 || r.status === 403 || r.status === 404)) { r.body && r.body.cancel().catch(() => {}); continue; }
    if (r.status === 404) throw new Error("Couldn't find that GitHub repo (or it's private)");
    if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub says to slow down. Try again in an hour (connecting GitHub storage raises the limit).');
    if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error("Couldn't read that GitHub repo");
}
// The same app across releases: the file name without its version numbers ("BuildBox-2.1.3.ipa" -> "buildbox").
const ipaVariant = (name) => String(name).replace(/\.ipa$/i, '').toLowerCase().replace(/v?\d+([._-]\d+)*/g, ' ').replace(/[^a-z]+/g, ' ').trim() || 'app';
async function githubRepoSource(src) {
  const { owner, repo } = src.repo;
  const [info, releases] = await Promise.all([
    githubApi(`/repos/${owner}/${repo}`).catch(() => null),
    githubApi(`/repos/${owner}/${repo}/releases?per_page=30`),
  ]);
  const byVariant = new Map();
  for (const rel of releases) {
    if (rel.draft) continue;
    for (const a of rel.assets || []) {
      if (!/\.ipa$/i.test(a.name)) continue;
      const key = ipaVariant(a.name);
      if (!byVariant.has(key)) byVariant.set(key, []);
      byVariant.get(key).push({
        version: String(rel.tag_name || rel.name || '').replace(/^v(?=\d)/i, '').slice(0, 60),
        date: rel.published_at || rel.created_at || '', url: a.browser_download_url, size: a.size || 0,
        notes: String(rel.body || '').slice(0, 1500), channel: rel.prerelease ? 'beta' : '', assetId: a.id, assetName: a.name,
      });
    }
  }
  if (!byVariant.size) throw new Error(`${owner}/${repo} has no releases with an .ipa file attached`);
  const known = store.apps.filter((a) => a.remote && a.remote.sourceId === src.id);
  const apps = [];
  for (const [variant, versions] of byVariant) {
    const list = versions.slice(0, 15);
    const newest = list.find((v) => !v.channel) || list[0];
    if (newest !== list[0]) { list.splice(list.indexOf(newest), 1); list.unshift(newest); }
    const key = `gh:${variant}`;
    const app = known.find((a) => a.remote.key === key);
    let meta = app && app.remote.inspected && app.remote.inspected.assetId === newest.assetId ? app.remote.inspected : null;
    if (!meta) {
      // Read the newest .ipa's name, bundle ID, real version and icon (just the bits needed, not the whole file).
      try {
        const m = await inspectLink(newest.url, null);
        meta = { assetId: newest.assetId, name: m.name, bundleId: m.bundleId, version: m.version, minOS: m.minOS, icon: m.icon || null };
      } catch (e) {
        meta = { assetId: newest.assetId, name: '', bundleId: '', version: '', error: e.message };
      }
    }
    if (meta.version) newest.version = meta.version; // the app's own version, so update checks compare like with like
    apps.push({
      key, name: meta.name || (info && info.name) || repo, bundleId: meta.bundleId || '',
      developer: owner, subtitle: '', description: String((info && info.description) || '').slice(0, 1500),
      iconURL: '', tint: '', category: '', screenshots: [],
      versions: list.map(({ assetId: _a, assetName: _n, ...v }) => ({ ...v, minOS: v === newest ? meta.minOS || '' : '' })),
      _meta: meta,
    });
  }
  return {
    name: (info && info.name) || repo, identifier: `github:${owner}/${repo}`, iconURL: (info && info.owner && info.owner.avatar_url) || '',
    subtitle: (info && info.description) || `GitHub releases from ${owner}`, apps,
  };
}

async function syncSource(src) {
  const parsed = src.kind === 'ghrepo' ? await githubRepoSource(src) : sources.parseSource(await fetchJson(src.url));
  const mine = store.apps.filter((a) => a.remote && a.remote.kind === 'source' && a.remote.sourceId === src.id);
  const byKey = new Map(mine.map((a) => [a.remote.key, a]));
  const seen = new Set();
  let added = 0, updated = 0;
  for (const s of parsed.apps) {
    seen.add(s.key);
    if (isExcluded(src, s)) continue; // you deleted it from this source
    const existing = byKey.get(s.key);
    if (!existing && sourceSkipsHave(src) && haveElsewhere(s.bundleId, src.id)) continue; // already have it from somewhere else
    if (existing) dropSupersededManual(existing, s.versions);
    // Your own newer uploads (added with "Add a newer version") count as part of the source.
    const v = existing ? mergedVersions(existing, s.versions)[0] : s.versions[0];
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
      await saveRepoMeta(app, s);
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
    await saveRepoMeta(app, s);
    if (oldVersion && v.version && oldVersion !== v.version) {
      app.previousVersion = app.versionOverride || oldVersion;
      app.updatedAt = new Date().toISOString();
      notifyUpdate(app, app.previousVersion);
      updated++;
    }
  }
  let removed = 0;
  for (const a of mine) {
    if (!seen.has(a.remote.key) && !(a.manualVersions || []).length) { if (!a.remote.missing) removed++; a.remote.missing = true; } else delete a.remote.missing;
  }
  Object.assign(src, {
    name: src.customName || parsed.name, iconURL: parsed.iconURL, subtitle: parsed.subtitle,
    appCount: parsed.apps.length, lastSync: new Date().toISOString(), lastError: null,
  });
  store.save();
  return { added, updated, removed, total: parsed.apps.length };
}

// GitHub repo apps: keep what was read from the .ipa (so it's only read again for a new release) and its icon.
async function saveRepoMeta(app, s) {
  if (!s._meta) return;
  const { icon, ...meta } = s._meta;
  if (icon && !app.customIcon && app.remote.inspected?.assetId !== meta.assetId) {
    await fsp.writeFile(path.join(dirs.apps, app.id + '.png'), shrinkPng(Buffer.from(icon), 180)).catch(() => {});
    app.hasIcon = true;
    app.iconVersion = Date.now();
  } else if (app.remote.inspected && app.remote.inspected.assetId === meta.assetId) app.hasIcon = app.hasIcon || fs.existsSync(path.join(dirs.apps, app.id + '.png'));
  app.remote.inspected = meta;
}

const sourceView = ({ done: _d, failures: _f, ...src }) => ({ ...src, apps: store.apps.filter((a) => a.remote && a.remote.sourceId === src.id && !a.remote.missing).length });

route('POST', /^\/api\/sources$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  // People often paste links without https:// (github.com/owner/repo).
  if (typeof b.url === 'string' && !/^[a-z]+:\/\//i.test(b.url.trim()) && /^[\w.-]+\.[a-z]{2,}\//i.test(b.url.trim())) b.url = 'https://' + b.url.trim();
  let url;
  const repo = parseGithubRepo(b.url);
  try { url = repo ? repo.url : sources.normalizeSourceUrl(b.url); } catch (e) { return fail(res, 400, e.message); }
  if (store.sources.some((x) => x.url.toLowerCase() === url.toLowerCase())) return fail(res, 400, 'That source is already added');
  const src = { id: id(), url, name: repo ? repo.repo : 'Source', showInLibrary: b.showInLibrary !== false, addedAt: new Date().toISOString() };
  if (repo) Object.assign(src, { kind: 'ghrepo', repo: { owner: repo.owner, repo: repo.repo } });
  // Nothing else checking: add it right away (and tell you if the link is wrong).
  if (!checkBusy()) {
    try {
      store.sources.push(src);
      const result = await syncSource(src);
      return json(res, { source: sourceView(src), result });
    } catch (e) {
      store.sources.splice(store.sources.indexOf(src), 1);
      store.save();
      return fail(res, 400, e.message);
    }
  }
  // Another check is running: add it now and let its first check wait its turn.
  store.sources.push(src);
  store.save();
  const job = sourceCheck(src, acc);
  json(res, { source: sourceView(src), jobId: job.id, waitingFor: job.waitingFor || null });
}, 'owner');

route('POST', /^\/api\/sources\/([a-f0-9]{16})\/sync$/, async (req, res, m, acc) => {
  const src = store.sources.find((x) => x.id === m[1]);
  if (!src) return fail(res, 404, 'Source not found');
  if (src.kind === 'telegram') {
    if (!tgReady()) return fail(res, 400, 'Connect Telegram first');
    if (req.url.includes('rescan=1')) { src.lastMsgId = 0; src.failures = {}; }
    const job = tgSync(src, acc);
    return json(res, { jobId: job.id, waitingFor: job.status === 'queued' ? job.waitingFor : null, source: sourceView(src) });
  }
  const job = sourceCheck(src, acc);
  json(res, { jobId: job.id, waitingFor: job.status === 'queued' ? job.waitingFor : null, source: sourceView(src) });
}, 'owner');

// Checks an AltStore-style source or a GitHub repo, in the same one-at-a-time line as Telegram.
function sourceCheck(src, acc) {
  const already = checkFor(src.id);
  if (already) return already;
  const job = newJob(acc || OWNER());
  job.title = `Checking ${src.name}`;
  job.srcId = src.id;
  job.cancellable = true;
  return runCheck(job, async () => {
    job.log.push(`Checking ${src.name}…`);
    try {
      job.result = await syncSource(src);
      job.log.push(`Done: ${job.result.added} new, ${job.result.updated} updated`);
      job.status = 'done';
    } catch (e) {
      src.lastError = e.message;
      // A source added while another check ran, whose link turns out not to work: don't keep it.
      if (!src.lastSync && !store.apps.some((a) => a.remote && a.remote.sourceId === src.id)) {
        const i = store.sources.indexOf(src);
        if (i >= 0) store.sources.splice(i, 1);
        e.message += ' (so it wasn\'t added)';
      }
      store.save();
      job.error = e.message;
      job.status = 'error';
    }
  });
}

route('PATCH', /^\/api\/sources\/([a-f0-9]{16})$/, async (req, res, m) => {
  const src = store.sources.find((x) => x.id === m[1]);
  if (!src) return fail(res, 404, 'Source not found');
  const b = await readJson(req);
  if (typeof b.showInLibrary === 'boolean') {
    src.showInLibrary = b.showInLibrary;
    for (const a of store.apps) if (a.remote && a.remote.sourceId === src.id && !(a.locked || []).includes('published')) a.published = b.showInLibrary;
  }
  if (typeof b.name === 'string' && b.name.trim()) { src.customName = b.name.trim().slice(0, 60); src.name = src.customName; }
  if (typeof b.skipHave === 'boolean' && src.kind !== 'telegram') src.skipHave = b.skipHave;
  if (src.kind === 'telegram') {
    if (b.options) src.options = cleanTgOptions(b.options, src.options);
    if (b.categoryId !== undefined) src.categoryId = ['__auto', '__none'].includes(b.categoryId) ? b.categoryId : b.categoryId && catExists(b.categoryId) ? b.categoryId : '__auto';
  }
  store.save();
  json(res, { source: sourceView(src) });
}, 'owner');

// Bring back an app you deleted from a source: it's added again on the next refresh (started right away).
route('POST', /^\/api\/sources\/([a-f0-9]{16})\/restore$/, async (req, res, m, acc) => {
  const src = store.sources.find((x) => x.id === m[1]);
  if (!src) return fail(res, 404, 'Source not found');
  const { index } = await readJson(req);
  if (!src.excluded || !src.excluded[index]) return fail(res, 404, 'Not found');
  const [gone] = src.excluded.splice(index, 1);
  store.save();
  if (src.kind === 'telegram') {
    json(res, { ok: true, restored: gone.name, note: 'It comes back the next time it\'s posted. To get it now, use Scan older posts with "Re-check posts already checked" on.' });
    return;
  }
  try { await syncSource(src); } catch (e) { src.lastError = e.message; store.save(); }
  json(res, { ok: true, restored: gone.name, source: sourceView(src) });
}, 'owner');

route('DELETE', /^\/api\/sources\/([a-f0-9]{16})$/, async (req, res, m) => {
  const i = store.sources.findIndex((x) => x.id === m[1]);
  if (i < 0) return fail(res, 404, 'Source not found');
  for (const a of store.apps.filter((x) => x.remote && x.remote.sourceId === m[1])) await deleteApp(a.id);
  store.sources.splice(i, 1);
  store.save();
  json(res, { ok: true });
}, 'owner');

// Sources are checked every hour by scheduleChecks (with Telegram channels, one at a time).

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
    signedToGithub: !!g.private && g.signedToGithub !== false, signedSaved: store.signed.filter((x) => x.gh).length,
    signedTag: (g.signedRelease && g.signedRelease.tag) || SIGNED_TAG,
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
    if (/^(tg|mv)-/.test(asset.name) || store.apps.some((a) => (a.remote && String(a.remote.ghAssetId) === String(asset.id))
      || (a.manualVersions || []).some((v) => v.storage && String(v.storage.assetId) === String(asset.id)))) continue; // a channel copy or your newer version of a source app
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
  if (job) job.cancellable = true;
  const asset = await gh.uploadAsset(g.releaseId, safe, file, size, (p) => { if (job) job.progress = p; }, job && job.signal);
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
  if (typeof b.signedToGithub === 'boolean') {
    if (b.signedToGithub && !g.private) return fail(res, 400, "Your repo is public, so anyone could download your signed apps (and install them with your certificate). Make the repo private on GitHub, then tap Change repo or token › Save.");
    g.signedToGithub = b.signedToGithub;
    if (b.signedToGithub) setTimeout(() => archiveSigned().catch(() => {}), 1000);
  }
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
  job.title = `Moving ${list.length} app${list.length === 1 ? '' : 's'} to GitHub`;
  json(res, { jobId: job.id, count: list.length });
  (async () => {
    let moved = 0, freed = 0;
    const errors = [];
    for (const [i, app] of list.entries()) {
      if (job.cancelled) break;
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

// ----- daily sign limits -----
const today = () => new Date().toISOString().slice(0, 10);
function signsToday(uid) { const c = store.data.signCounts[uid]; return c && c.day === today() ? c.n : 0; }
function countSign(uid, appId) {
  store.data.signLog = store.data.signLog || [];
  store.data.signLog.push({ at: new Date().toISOString(), uid, appId });
  if (store.data.signLog.length > 6000) store.data.signLog.splice(0, store.data.signLog.length - 6000);
  const c = store.data.signCounts[uid];
  store.data.signCounts[uid] = c && c.day === today() ? { day: c.day, n: c.n + 1 } : { day: today(), n: 1 };
}
// 0 = no limit. A per-user limit (set on their page) wins over the everyone limit.
function signLimitFor(acc) {
  if (isOwner(acc)) return 0;
  const u = findUser(acc.id);
  if (u && u.signLimit !== null && u.signLimit !== undefined) return u.signLimit;
  return Number(store.settings.signsPerDay) || 0;
}

// ----- alerts inbox -----
const alertView = ({ ownerId, ...a }) => a;
route('POST', /^\/api\/alerts\/read$/, async (req, res, m, acc) => {
  const { ids } = await readJson(req);
  for (const a of store.alerts) if (a.ownerId === acc.id && (!Array.isArray(ids) || ids.includes(a.id))) a.read = true;
  store.save();
  json(res, { ok: true });
});
route('DELETE', /^\/api\/alerts$/, (req, res, m, acc) => {
  store.data.alerts = store.alerts.filter((a) => a.ownerId !== acc.id);
  store.save();
  json(res, { ok: true });
});

// ----- favorites -----
// People fixing their own "installed" list: it's gone from their phone, or they already have the latest.
route('POST', /^\/api\/my-apps\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const { action } = await readJson(req);
  const list = myAppsOf(acc.id);
  const app = store.apps.find((a) => a.id === m[1]);
  if (action === 'remove') delete list[m[1]];
  else if (action === 'latest' || action === 'have') {
    if (!app) return fail(res, 404, 'App not found');
    // Updated some other way, so Mango doesn't know which certificate it uses anymore.
    list[m[1]] = { version: app.version || '', shown: shownAppVersion(app), at: new Date().toISOString(), signedId: null, certId: null, expires: null, manual: true };
    store.data.alerts = store.alerts.filter((x) => !(x.ownerId === acc.id && x.kind === 'update' && x.appId === m[1]));
  } else return fail(res, 400, 'Unknown action');
  store.save();
  json(res, { ok: true, installed: app ? installedView(app, acc) : null });
});
route('POST', /^\/api\/my-apps\/clean$/, async (req, res, m, acc) => {
  // Forget apps that can't open anymore (expired/revoked certificate) or were deleted from the library.
  const list = myAppsOf(acc.id);
  let n = 0;
  for (const [aid, e] of Object.entries(list)) {
    if (installStopped(e) || !store.apps.some((a) => a.id === aid)) { delete list[aid]; n++; }
  }
  store.save();
  json(res, { ok: true, removed: n });
});

route('POST', /^\/api\/apps\/([a-f0-9]{16})\/favorite$/, async (req, res, m, acc) => {
  if (!visibleApps(acc).some((a) => a.id === m[1])) return fail(res, 404, 'App not found');
  const { on } = await readJson(req);
  const list = new Set(store.favorites[acc.id] || []);
  if (on) list.add(m[1]); else list.delete(m[1]);
  store.favorites[acc.id] = [...list].slice(-500);
  store.save();
  json(res, { favorite: !!on });
});

// ----- security -----
// Signs out every other phone or browser: bumps your session version, then gives this one a fresh cookie.
route('POST', /^\/api\/account\/signout-others$/, async (req, res, m, acc) => {
  if (isOwner(acc)) store.settings.ownerSv = (store.settings.ownerSv || 0) + 1;
  else { const u = findUser(acc.id); u.sv = (u.sv || 0) + 1; }
  secEvent(req, 'signout-all', acc.username, true);
  store.save();
  const fresh = accountById(acc.id);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, fresh) });
});
route('DELETE', /^\/api\/security-log$/, (req, res) => { store.data.securityLog = []; store.save(); json(res, { ok: true }); }, 'owner');

// ----- background checks: certificates and storage -----
const CERT_THRESHOLDS = [7, 3, 1, 0];
async function certAlerts({ checkRevoked = false } = {}) {
  let changed = false;
  for (const c of store.certs) {
    const ownerId = c.ownerId;
    const dates = [c.p12 && c.p12.validTo, c.profile && c.profile.expires].filter(Boolean).sort();
    if (dates[0]) {
      const days = Math.floor((new Date(dates[0]) - Date.now()) / 864e5);
      const hit = CERT_THRESHOLDS.find((t) => days <= t && (c.alertedDays === undefined || t < c.alertedDays));
      if (hit !== undefined && days >= -1) {
        c.alertedDays = hit;
        changed = true;
        addAlert(ownerId, 'cert', days < 0 ? `⚠️ ${c.label} has expired` : days === 0 ? `⚠️ ${c.label} expires today` : `⏳ ${c.label} expires in ${days} day${days === 1 ? '' : 's'}`,
          days < 0 ? 'Apps signed with it won\'t open anymore. Add a new certificate and sign them again.' : 'Apps signed with it stop opening when it expires. Get a new certificate before then and re-sign.', { certId: c.id });
      }
    }
    if (checkRevoked && zsignVersion) {
      const before = c.check && c.check.status;
      try { c.check = await checkCert(c); changed = true; } catch { /* offline */ }
      if (c.check && c.check.status === 'revoked' && before !== 'revoked') {
        addAlert(ownerId, 'cert', `🚫 ${c.label} was revoked`, 'Apple turned this certificate off, so apps signed with it won\'t open. Add a new certificate and sign your apps again.', { certId: c.id });
      }
    }
  }
  if (changed) store.save();
}
function storageAlert() {
  const d = diskInfo();
  if (!d || d.free > 1024 ** 3) return;
  const last = store.settings.lastStorageAlert;
  if (last && Date.now() - new Date(last) < 864e5) return;
  store.settings.lastStorageAlert = new Date().toISOString();
  addAlert('owner', 'storage', `💾 Only ${gb(d.free)} free on your server`, 'Big apps need room to sign. Move apps to GitHub or clean up signed files in Settings › Storage.');
  store.save();
}
setTimeout(() => { certAlerts().catch(() => {}); storageAlert(); }, 20_000);
setInterval(() => { certAlerts().catch(() => {}); storageAlert(); }, 3 * 3600_000);
setInterval(() => certAlerts({ checkRevoked: true }).catch(() => {}), 12 * 3600_000);

// Older versions kept each app's full-size icon (often 1024px and over 1 MB). Shrinks any big
// icon still on disk down to 180px (custom icons to 512px, since they go into signed apps).
// Runs in the background a few seconds after start; files that are already small are skipped.
async function shrinkIcons() {
  let saved = 0;
  let count = 0;
  for (const dir of [dirs.apps, dirs.signed]) {
    const names = await fsp.readdir(dir).catch(() => []);
    for (const name of names) {
      if (!/\.png$/i.test(name)) continue;
      const file = path.join(dir, name);
      const st = await fsp.stat(file).catch(() => null);
      if (!st || !st.isFile() || st.size < 60 * 1024) continue;
      try {
        const buf = await fsp.readFile(file);
        const out = shrinkPng(buf, /-custom\.png$/i.test(name) ? 512 : 180);
        if (out !== buf && out.length < buf.length) {
          await fsp.writeFile(file + '.tmp', out);
          await fsp.rename(file + '.tmp', file);
          saved += buf.length - out.length;
          count++;
        }
      } catch { /* leave it */ }
      await new Promise((r) => setTimeout(r, 15)); // let requests through
    }
  }
  if (count) {
    console.log(`Shrunk ${count} icons, freed ${(saved / 1024 ** 2).toFixed(1)} MB`);
    if (saved > 20 * 1024 ** 2) addAlert('owner', 'storage', `🧹 Freed ${gb(saved)} of icon space`, `${count} app icons were saved at full size by older versions. They've been shrunk — nothing else changed.`);
  }
}
setTimeout(() => shrinkIcons().catch(() => {}), 15_000);

// ----- owner tools: stats, activity, broadcast, backup -----
const nameOf = (uid) => (uid === 'owner' ? 'you' : (findUser(uid) || {}).username || 'deleted user');
const appName = (aid) => (store.apps.find((a) => a.id === aid) || {}).name || 'deleted app';
route('GET', /^\/api\/stats$/, (req, res) => {
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  const perDay = (list) => { const m = Object.fromEntries(days.map((d) => [d, 0])); for (const x of list) { const d = String(x.at).slice(0, 10); if (d in m) m[d]++; } return days.map((d) => m[d]); };
  const since = (ms) => (x) => Date.now() - new Date(x.at) < ms;
  const signs = store.data.signLog || [];
  const installs = store.installLog;
  const signups = store.securityLog.filter((e) => e.type === 'signup');
  const top = new Map();
  for (const l of installs.filter(since(30 * 864e5))) top.set(l.appId, (top.get(l.appId) || 0) + 1);
  const active = new Set([...installs.filter(since(7 * 864e5)), ...signs.filter(since(7 * 864e5)).map((x) => ({ ownerId: x.uid }))].map((x) => x.ownerId));
  active.delete('owner');
  const activity = [
    ...installs.slice(-60).map((l) => ({ at: l.at, kind: 'install', text: `${nameOf(l.ownerId)} installed ${l.name || appName(l.appId)}${l.shownVersion || l.version ? ' ' + (l.shownVersion || l.version) : ''}` })),
    ...signs.slice(-60).map((x) => ({ at: x.at, kind: 'sign', text: `${nameOf(x.uid)} signed ${appName(x.appId)}` })),
    ...signups.slice(-20).map((e) => ({ at: e.at, kind: 'user', text: `${e.user} joined` })),
    ...store.requests.slice(-20).map((r) => ({ at: r.createdAt, kind: 'request', text: `${r.username} asked for ${r.name}` })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 60);
  json(res, {
    days, installs: perDay(installs), signs: perDay(signs), signups: perDay(signups),
    topApps: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([aid, n]) => ({ appId: aid, name: appName(aid), count: n })),
    totals: {
      users: store.users.length, activeUsers7d: active.size, apps: store.apps.length, cloudApps: store.apps.filter((a) => a.remote).length,
      installs30d: installs.filter(since(30 * 864e5)).length, signs30d: signs.filter(since(30 * 864e5)).length, installsAll: installs.length,
      certs: store.certs.length, tweaks: store.tweaks.length,
    },
    activity,
  });
}, 'owner');

route('POST', /^\/api\/broadcast$/, async (req, res) => {
  const b = await readJson(req);
  const title = String(b.title || '').trim().slice(0, 100);
  if (!title) return fail(res, 400, 'Write a title for the message');
  const users = store.users.filter((u) => !u.disabled);
  for (const u of users) addAlert(u.id, 'broadcast', `📣 ${title}`, String(b.body || '').trim().slice(0, 400));
  store.save();
  json(res, { sent: users.length });
}, 'owner');

// Everything needed to rebuild your server: settings, users, library info, certificates, tweaks and icons.
// App files stored on this server (.ipa) and signed copies are left out to keep it small.
route('GET', /^\/api\/backup$/, (req, res) => {
  store.save();
  const items = ['db.json', 'certs', 'tweaks', 'apps', '.secret'].filter((f) => fs.existsSync(path.join(DATA_DIR, f)));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="mango-backup-${stamp}.zip"`, 'Cache-Control': 'no-store' });
  const z = spawn('zip', ['-r', '-q', '-', ...items, '-x', 'apps/*.ipa'], { cwd: DATA_DIR });
  z.stdout.pipe(res);
  z.on('error', () => res.end());
}, 'owner');

route('POST', /^\/api\/restore$/, async (req, res, m, acc) => {
  const { uploadId } = await readJson(req);
  const file = tmpPath(uploadId, acc);
  const dir = path.join(dirs.work, 'restore-' + id());
  try {
    await fsp.mkdir(dir, { recursive: true });
    if (await run('unzip', ['-qq', '-o', file, '-d', dir], { timeout: 120000 }).then((r) => r.code) !== 0) throw httpError(400, "That isn't a Mango backup (.zip)");
    let db;
    try { db = JSON.parse(await fsp.readFile(path.join(dir, 'db.json'), 'utf8')); } catch { throw httpError(400, "That zip doesn't have a Mango backup in it (db.json is missing)"); }
    if (!db || !Array.isArray(db.apps) || !db.settings) throw httpError(400, "That backup's db.json doesn't look right");
    const hasSecret = fs.existsSync(path.join(dir, '.secret'));
    if (!hasSecret && !process.env.SESSION_SECRET && db.certs && db.certs.length) {
      // Encrypted values (cert passwords, tokens) need the secret they were saved with.
      const cur = path.join(DATA_DIR, '.secret');
      if (!fs.existsSync(cur)) throw httpError(400, 'This backup has no .secret file, so its certificate passwords can\'t be read here');
    }
    for (const sub of ['certs', 'tweaks', 'apps']) {
      if (!fs.existsSync(path.join(dir, sub))) continue;
      await fsp.rm(path.join(DATA_DIR, sub + '.old'), { recursive: true, force: true });
      if (fs.existsSync(path.join(DATA_DIR, sub))) {
        // Keep this server's app files (.ipa) — the backup doesn't have them.
        if (sub === 'apps') {
          for (const f of await fsp.readdir(path.join(DATA_DIR, 'apps'))) if (f.endsWith('.ipa')) await fsp.rename(path.join(DATA_DIR, 'apps', f), path.join(dir, 'apps', f)).catch(() => {});
        }
        await fsp.rename(path.join(DATA_DIR, sub), path.join(DATA_DIR, sub + '.old'));
      }
      await fsp.cp(path.join(dir, sub), path.join(DATA_DIR, sub), { recursive: true });
      await fsp.rm(path.join(DATA_DIR, sub + '.old'), { recursive: true, force: true });
    }
    if (hasSecret && !process.env.SESSION_SECRET) await fsp.copyFile(path.join(dir, '.secret'), path.join(DATA_DIR, '.secret'));
    await fsp.writeFile(path.join(DATA_DIR, 'db.json.tmp'), JSON.stringify(db, null, 2));
    await fsp.rename(path.join(DATA_DIR, 'db.json.tmp'), path.join(DATA_DIR, 'db.json'));
    json(res, { ok: true, apps: db.apps.length, users: (db.users || []).length, restarting: true });
    // Restart so everything (including the secret) is loaded fresh. Railway brings the server straight back.
    setTimeout(() => process.exit(1), 800);
  } catch (e) {
    fail(res, e.status || 400, e.message);
  } finally {
    await rmQuiet(file);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 'owner');

// ----- tweaks library -----
// Tweaks are small (.dylib files, usually under 1 MB), so they're kept on the server.
const SUBSTRATE_DIR = () => path.join(dirs.tweaks, '_substrate', 'CydiaSubstrate.framework');
const substrateInstalled = () => fs.existsSync(path.join(SUBSTRATE_DIR(), 'CydiaSubstrate'));
const substrateView = () => {
  const s = store.settings.substrate;
  return substrateInstalled() ? { installed: true, name: (s && s.name) || 'CydiaSubstrate', size: (s && s.size) || 0, addedAt: s && s.addedAt } : { installed: false };
};

function tweakView(t, acc) {
  const base = {
    id: t.id, name: t.name, version: t.version, author: t.author, description: t.description, package: t.package,
    files: t.files.map((f) => ({ name: f.name, size: f.size, needsSubstrate: f.needsSubstrate, missing: f.missing })),
    warnings: t.warnings || [], addedAt: t.addedAt, published: t.published !== false,
  };
  return isOwner(acc) ? base : { ...base, package: undefined };
}
const visibleTweaks = (acc) => store.tweaks.filter((t) => isOwner(acc) || t.published !== false);

function tweakWarnings(files, extra = {}) {
  const w = [];
  if (files.some((f) => f.needsSubstrate) && !substrateInstalled()) w.push('Needs CydiaSubstrate. Add a Substrate framework in the Tweaks library, or the app will crash on launch.');
  const missing = [...new Set(files.flatMap((f) => f.missing || []))];
  if (missing.length) w.push(`Needs ${missing.join(', ')}, which only exists on jailbroken phones. It may not work.`);
  if (extra.bundles && extra.bundles.length) w.push(`Comes with ${extra.bundles.join(', ')} (images/settings). Those aren't added to the app, so some icons or settings may be missing.`);
  if (extra.hasPrefs) w.push('Its Settings page only works on jailbroken phones.');
  return w;
}

// Reads a .deb or .dylib upload into a list of { name, buf, info } plus package details.
async function readTweakUpload(file, fileName, work) {
  if (/\.deb$/i.test(fileName)) {
    const pkg = await deb.unpack(file, path.join(work, 'deb'));
    const hookOnly = pkg.tweaks.length && pkg.tweaks.every((t) => /ellekit|substrate|substitute|libhooker/i.test(t.name));
    if (!pkg.tweaks.length || hookOnly) {
      const err = new Error(pkg.substrateFramework || hookOnly ? 'This package is a Substrate framework, not a tweak. Add it under "Substrate" instead.' : 'No tweak (.dylib) found inside this .deb');
      err.status = 400;
      throw err;
    }
    const files = [];
    for (const t of pkg.tweaks.slice(0, 10)) {
      const buf = await fsp.readFile(t.file);
      const info = macho.inspectTweak(buf);
      if (info.ok) files.push({ name: t.name, buf, info });
    }
    if (!files.length) throw httpError(400, "The .dylib files in this .deb aren't iOS libraries");
    return { files, control: pkg.control, bundles: pkg.bundles, hasPrefs: pkg.hasPrefs };
  }
  const buf = await fsp.readFile(file);
  const info = macho.inspectTweak(buf);
  if (!info.ok) throw httpError(400, info.error);
  return { files: [{ name: fileName, buf, info }], control: {}, bundles: [], hasPrefs: false };
}

const safeDylibName = (n) => (String(n || 'tweak.dylib').replace(/[^\w.\-+]/g, '_').replace(/^\.+/, '') || 'tweak').replace(/(\.dylib)?$/i, '.dylib');

route('POST', /^\/api\/tweaks$/, async (req, res, m, acc) => {
  const { uploadId, fileName } = await readJson(req);
  const file = tmpPath(uploadId, acc);
  const name = String(fileName || 'tweak.dylib').slice(0, 120);
  if (!/\.(deb|dylib)$/i.test(name)) { await rmQuiet(file); return fail(res, 400, 'Pick a .deb or .dylib file'); }
  const work = path.join(dirs.work, 'tw-' + id());
  try {
    const up = await readTweakUpload(file, name, work);
    const tid = id();
    const dir = path.join(dirs.tweaks, tid);
    await fsp.mkdir(dir, { recursive: true });
    const files = [];
    for (const f of up.files) {
      const fname = safeDylibName(f.name);
      await fsp.writeFile(path.join(dir, fname), f.buf);
      files.push({ name: fname, size: f.buf.length, needsSubstrate: f.info.needsSubstrate, missing: f.info.missing });
    }
    const c = up.control;
    const rec = {
      id: tid, name: (c.name || name.replace(/\.(deb|dylib)$/i, '')).slice(0, 80), version: (c.version || '').slice(0, 40),
      author: (c.author || '').slice(0, 80), description: (c.description || '').slice(0, 600), package: c.package || '',
      files, extra: { bundles: up.bundles, hasPrefs: up.hasPrefs }, published: true, addedAt: new Date().toISOString(),
    };
    rec.warnings = tweakWarnings(files, rec.extra);
    store.tweaks.unshift(rec);
    store.save();
    json(res, { tweak: tweakView(rec, acc) });
  } catch (e) {
    fail(res, e.status || 400, e.message);
  } finally {
    await rmQuiet(file);
    await fsp.rm(work, { recursive: true, force: true });
  }
}, 'owner');

route('PATCH', /^\/api\/tweaks\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const t = store.tweaks.find((x) => x.id === m[1]);
  if (!t) return fail(res, 404, 'Tweak not found');
  const b = await readJson(req);
  if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim().slice(0, 80);
  if (typeof b.description === 'string') t.description = b.description.slice(0, 600);
  if (typeof b.published === 'boolean') t.published = b.published;
  store.save();
  json(res, { tweak: tweakView(t, acc) });
}, 'owner');

route('DELETE', /^\/api\/tweaks\/([a-f0-9]{16})$/, async (req, res, m) => {
  const i = store.tweaks.findIndex((x) => x.id === m[1]);
  if (i < 0) return fail(res, 404, 'Tweak not found');
  store.tweaks.splice(i, 1);
  for (const a of store.apps) if (a.signDefaults && Array.isArray(a.signDefaults.tweakIds)) a.signDefaults.tweakIds = a.signDefaults.tweakIds.filter((x) => x !== m[1]);
  for (const p of store.presets) if (p.options && Array.isArray(p.options.tweakIds)) p.options.tweakIds = p.options.tweakIds.filter((x) => x !== m[1]);
  store.save();
  await fsp.rm(path.join(dirs.tweaks, m[1]), { recursive: true, force: true });
  json(res, { ok: true });
}, 'owner');

const FRAMEWORK_PLIST = () => plist.build({
  CFBundleDevelopmentRegion: 'en', CFBundleExecutable: 'CydiaSubstrate', CFBundleIdentifier: 'com.saurik.substrate',
  CFBundleInfoDictionaryVersion: '6.0', CFBundleName: 'CydiaSubstrate', CFBundlePackageType: 'FMWK',
  CFBundleShortVersionString: '1.0', CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneOS'], MinimumOSVersion: '12.0',
});

// The hooking framework most tweaks need (CydiaSubstrate, or ElleKit which acts like it).
route('PUT', /^\/api\/substrate$/, async (req, res, m, acc) => {
  const { uploadId, fileName } = await readJson(req);
  const file = tmpPath(uploadId, acc);
  const name = String(fileName || '').slice(0, 120);
  const work = path.join(dirs.work, 'sub-' + id());
  const dest = SUBSTRATE_DIR();
  const staging = dest + '.new';
  try {
    await fsp.rm(staging, { recursive: true, force: true });
    if (/\.dylib$/i.test(name) || (!/\.(deb|zip)$/i.test(name) && macho.isMachO(await fsp.readFile(file)))) {
      const buf = await fsp.readFile(file);
      if (!macho.isMachO(buf)) throw httpError(400, "That file isn't an iOS library");
      await fsp.mkdir(staging, { recursive: true });
      await fsp.writeFile(path.join(staging, 'CydiaSubstrate'), buf);
    } else {
      let root, fw;
      if (/\.deb$/i.test(name)) {
        const pkg = await deb.unpack(file, path.join(work, 'deb'));
        root = path.join(work, 'deb');
        fw = pkg.substrateFramework;
        if (!fw) {
          const lib = pkg.tweaks.find((t) => /ellekit|substrate|substitute|hooker/i.test(t.name)) || null;
          if (!lib) throw httpError(400, 'No CydiaSubstrate.framework or ElleKit library found in this .deb');
          await fsp.mkdir(staging, { recursive: true });
          await fsp.copyFile(lib.file, path.join(staging, 'CydiaSubstrate'));
        }
      } else if (/\.zip$/i.test(name)) {
        root = path.join(work, 'zip');
        await fsp.mkdir(root, { recursive: true });
        if (await deb.run('unzip', ['-qq', '-o', file, '-d', root]).then((r) => r.code) !== 0) throw httpError(400, "Couldn't open that .zip");
        const find = async (dir, depth = 0) => {
          for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory() && /^CydiaSubstrate\.framework$/i.test(ent.name)) return p;
            if (ent.isDirectory() && depth < 6) { const r = await find(p, depth + 1); if (r) return r; }
          }
          return null;
        };
        fw = await find(root);
        if (!fw) throw httpError(400, 'No CydiaSubstrate.framework folder found in this .zip');
      } else {
        throw httpError(400, 'Pick a .deb, .zip or .dylib file');
      }
      if (fw) await deb.copyFramework(root, fw, staging);
    }
    const bin = path.join(staging, 'CydiaSubstrate');
    if (!fs.existsSync(bin) || !macho.isMachO(await fsp.readFile(bin))) throw httpError(400, "The framework's CydiaSubstrate file is missing or isn't an iOS library");
    if (!fs.existsSync(path.join(staging, 'Info.plist'))) await fsp.writeFile(path.join(staging, 'Info.plist'), FRAMEWORK_PLIST());
    await fsp.rm(path.join(staging, '_CodeSignature'), { recursive: true, force: true });
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(staging, dest);
    store.settings.substrate = { name: name.replace(/\.(deb|zip|dylib)$/i, '') || 'CydiaSubstrate', size: (await fsp.stat(path.join(dest, 'CydiaSubstrate'))).size, addedAt: new Date().toISOString() };
    for (const t of store.tweaks) t.warnings = tweakWarnings(t.files, t.extra);
    store.save();
    json(res, { substrate: substrateView() });
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true });
    fail(res, e.status || 400, e.message);
  } finally {
    await rmQuiet(file);
    await fsp.rm(work, { recursive: true, force: true });
  }
}, 'owner');

route('DELETE', /^\/api\/substrate$/, async (req, res) => {
  await fsp.rm(path.dirname(SUBSTRATE_DIR()), { recursive: true, force: true });
  delete store.settings.substrate;
  for (const t of store.tweaks) t.warnings = tweakWarnings(t.files, t.extra);
  store.save();
  json(res, { substrate: substrateView() });
}, 'owner');

// ----- presets (saved sign settings, per account) -----
function cleanPresetOptions(o = {}) {
  const pick = (k) => !!o[k];
  return {
    minOS: /^\d+(\.\d+){0,2}$/.test(String(o.minOS || '')) ? String(o.minOS) : '',
    entitlements: Array.isArray(o.entitlements) ? o.entitlements.slice(0, 40) : [],
    plist: Array.isArray(o.plist) ? o.plist.slice(0, 40) : [],
    removeExtensions: pick('removeExtensions'), removeWatch: pick('removeWatch'), removeUISD: pick('removeUISD'), enableDocs: pick('enableDocs'),
    weakDylibs: pick('weakDylibs'), injectExtensions: pick('injectExtensions'),
    tweakIds: Array.isArray(o.tweakIds) ? o.tweakIds.filter((x) => /^[a-f0-9]{16}$/.test(x)).slice(0, 20) : [],
  };
}
route('POST', /^\/api\/presets$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return fail(res, 400, 'Give the preset a name');
  const mine = store.presets.filter((p) => p.ownerId === acc.id);
  if (mine.length >= 30) return fail(res, 400, 'You can have up to 30 presets');
  // Same name replaces the old one, so "Save" can be used to update a preset.
  const existing = mine.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const rec = existing || { id: id(), ownerId: acc.id, createdAt: new Date().toISOString() };
  Object.assign(rec, { name, options: cleanPresetOptions(b.options), updatedAt: new Date().toISOString() });
  if (!existing) store.presets.push(rec);
  store.save();
  json(res, { preset: rec, replaced: !!existing });
});
route('DELETE', /^\/api\/presets\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const i = store.presets.findIndex((p) => p.id === m[1] && p.ownerId === acc.id);
  if (i < 0) return fail(res, 404, 'Preset not found');
  store.presets.splice(i, 1);
  store.save();
  json(res, { ok: true });
});

// ----- automatic categories -----
// Your keyword rules win; otherwise the App Store's category is used (Games, Social Networking, …).
const AS_TTL = 30 * 864e5;
async function appStoreInfo(app) {
  const key = (app.bundleId || '').toLowerCase() || 'name:' + String(app.originalName || app.name).toLowerCase();
  const cache = (store.data.appStoreCache = store.data.appStoreCache || {});
  const hit = cache[key];
  if (hit && Date.now() - hit.at < (hit.data ? AS_TTL : 3 * 864e5)) return hit.data;
  const data = await appstore.lookup({ bundleId: app.bundleId, name: app.originalName || app.name }).catch(() => null);
  cache[key] = { at: Date.now(), data };
  const keys = Object.keys(cache);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete cache[k];
  return data;
}
function ruleCategory(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  for (const r of store.settings.catRules || []) {
    if (!store.categories.some((c) => c.id === r.categoryId)) continue;
    if (r.words.split(',').map((w) => w.trim()).filter(Boolean).some((w) => t.includes(w))) return r.categoryId;
  }
  return null;
}
async function autoCategory(app, extraText = '') {
  const byRule = ruleCategory(`${app.name} ${app.originalName || ''} ${app.fileName || ''} ${extraText}`);
  const info = await appStoreInfo(app);
  if (byRule) return { categoryId: byRule, info, how: 'rule' };
  if (info && info.genre) return { categoryId: categoryIdFor(info.genre), info, how: 'appstore' };
  return { categoryId: null, info, how: null };
}

route('POST', /^\/api\/apps\/auto-categorize$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  const list = store.apps.filter((a) => (Array.isArray(b.ids) ? b.ids.includes(a.id) : true)
    && (b.all || !a.categoryId || !store.categories.some((c) => c.id === a.categoryId))
    && !(a.locked || []).includes('categoryId'));
  const job = newJob(acc);
  json(res, { jobId: job.id, count: list.length });
  (async () => {
    const result = { sorted: 0, byRule: 0, byAppStore: 0, unknown: 0, filled: 0 };
    for (const [i, app] of list.entries()) {
      job.progress = list.length ? i / list.length : 1;
      const r = await autoCategory(app, app.notes || '');
      if (r.categoryId && r.categoryId !== app.categoryId) {
        app.categoryId = r.categoryId;
        result.sorted++;
        if (r.how === 'rule') result.byRule++; else result.byAppStore++;
        job.log.push(`${app.name} → ${(store.categories.find((c) => c.id === r.categoryId) || {}).name}`);
      } else if (!r.categoryId) { result.unknown++; job.log.push(`${app.name}: not found`); }
      // Fill in blanks from the App Store while we're at it.
      if (r.info && b.fill !== false) {
        let filled = false;
        if (!app.developer && r.info.developer && !(app.locked || []).includes('developer')) { app.developer = r.info.developer.slice(0, 80); filled = true; }
        if (!app.description && r.info.description && !(app.locked || []).includes('description')) { app.description = r.info.description.slice(0, 1500); filled = true; }
        if (app.remote && !(app.remote.screenshots || []).length && r.info.screenshots.length && !(app.screenshots || []).length) { app.remote.screenshots = r.info.screenshots; filled = true; }
        if (filled) result.filled++;
      }
      if (i % 10 === 9) store.save();
      if (r.info === undefined) await new Promise((x) => setTimeout(x, 50));
    }
    store.save();
    job.progress = 1;
    job.result = result;
    job.status = 'done';
  })().catch((e) => { job.error = e.message; job.status = 'error'; });
}, 'owner');

// ----- your own newer versions of source apps -----
// "Add a newer version" on a source app: your file goes to GitHub storage (or stays a link), becomes the
// newest version, and the source's older versions stay pickable. If the source later posts that version
// (or a newer one), the source takes over again and your copy is cleaned up.
function versionCmp(a, b) {
  const pa = String(a || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
function mergedVersions(app, sourceVersions) {
  const src = (sourceVersions || (app.remote && app.remote.versions) || []).map((v) => ({ ...v }));
  const man = (app.manualVersions || [])
    .filter((m) => !src.some((v) => versionCmp(v.version, m.version) === 0))
    .map((m) => ({ version: m.version, date: m.date, size: m.size, minOS: m.minOS, notes: m.notes, channel: 'Added by you', storage: m.storage, url: m.storage && m.storage.url, manualId: m.id }));
  return [...man, ...src].sort((x, y) => versionCmp(y.version, x.version) || String(y.date || '').localeCompare(String(x.date || '')));
}
function dropSupersededManual(app, sourceVersions) {
  if (!(app.manualVersions || []).length) return;
  const keep = [];
  for (const m of app.manualVersions) {
    if ((sourceVersions || []).some((v) => versionCmp(v.version, m.version) === 0)) {
      if (m.storage && m.storage.kind === 'github') { const gh = ghClient(); if (gh) gh.deleteAsset(m.storage.assetId).catch(() => {}); }
    } else keep.push(m);
  }
  app.manualVersions = keep;
}
function applyNewest(app) {
  const newest = mergedVersions(app)[0];
  if (!newest) return;
  const locked = new Set(app.locked || []);
  const old = app.versionOverride || app.version;
  app.version = newest.version;
  if (newest.size) app.size = newest.size;
  if (newest.minOS) app.minOS = newest.minOS;
  if (newest.notes && !locked.has('notes')) app.notes = newest.notes;
  if (old !== app.version && versionCmp(app.version, old) > 0) {
    app.previousVersion = old;
    app.updatedAt = new Date().toISOString();
    notifyUpdate(app, old);
  }
}

route('POST', /^\/api\/apps\/([a-f0-9]{16})\/versions$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  if (!app.remote || app.remote.kind !== 'source') return fail(res, 400, 'Use "Update IPA" for apps that aren\'t from a source');
  const b = await readJson(req);
  const notes = String(b.notes || '').trim().slice(0, 1500);
  let file = null, u = null;
  if (b.uploadId) file = tmpPath(b.uploadId, acc);
  else if (b.url) u = parseLink(b.url);
  else return fail(res, 400, 'Pick an .ipa or paste a link');
  const linkOnly = !file && b.linkOnly !== false;
  const g = ghSettings();
  if (!linkOnly && (!ghClient() || !g.releaseId)) {
    if (file) await rmQuiet(file);
    return fail(res, 400, 'Connect GitHub storage first (Settings › Cloud Library), or add it as a link');
  }
  const job = newJob(acc);
  job.cancellable = true;
  job.title = `Adding a version of ${app.name}`;
  json(res, { jobId: job.id });
  (async () => {
    let tmp = file;
    try {
      let meta;
      if (linkOnly) {
        job.log.push(`Reading ${u.hostname}…`);
        meta = await inspectLink(u.toString(), null, job);
      } else {
        if (!tmp) tmp = await downloadToTmp(u, job);
        job.log.push('Reading app info…');
        meta = await inspectOrFail(tmp);
      }
      // A different bundle ID is fine for mods, but a different bundle ID *and* name is almost surely the wrong file.
      const sameName = [app.name, app.originalName].some((n) => normName(n) && (normName(n).includes(normName(meta.name)) || normName(meta.name).includes(normName(n))));
      if (app.bundleId && meta.bundleId && meta.bundleId.toLowerCase() !== app.bundleId.toLowerCase() && !sameName && !b.force) {
        throw new Error(`That file is ${meta.name} (${meta.bundleId}), not ${app.name}. Check you picked the right .ipa.`);
      }
      const all = mergedVersions(app);
      if (all.some((v) => versionCmp(v.version, meta.version) === 0)) throw new Error(`Version ${meta.version} is already in the list`);
      let storage;
      if (linkOnly) storage = { kind: 'link', url: u.toString() };
      else {
        const gh = ghClient();
        const size = (await fsp.stat(tmp)).size;
        const safe = `mv-${(app.originalName || app.name).replace(/[^\w.\-]+/g, '_')}-${meta.version || 'v'}-${id().slice(0, 6)}.ipa`;
        job.log.push(`Saving ${meta.version} to GitHub…`);
        const asset = await gh.uploadAsset(g.releaseId, safe, tmp, size, (p) => { job.progress = p; }, job.signal);
        job.progress = null;
        storage = { kind: 'github', assetId: asset.id, name: asset.name };
      }
      app.manualVersions = [...(app.manualVersions || []), {
        id: id(), version: meta.version || '?', build: meta.build || '', minOS: meta.minOS || '', size: meta.size || 0,
        date: new Date().toISOString().slice(0, 10), notes, storage, addedAt: new Date().toISOString(),
      }];
      applyNewest(app);
      store.save();
      job.log.push(`✓ ${app.name} ${meta.version} added`);
      job.result = { app: appView(app, acc) };
      job.status = 'done';
    } catch (e) {
      job.error = job.cancelled ? 'Cancelled' : e.message;
      job.status = 'error';
    } finally {
      if (tmp) await rmQuiet(tmp);
    }
  })();
}, 'owner');

route('DELETE', /^\/api\/apps\/([a-f0-9]{16})\/versions\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const v = (app.manualVersions || []).find((x) => x.id === m[2]);
  if (!v) return fail(res, 404, 'Version not found');
  app.manualVersions = app.manualVersions.filter((x) => x.id !== m[2]);
  if (v.storage && v.storage.kind === 'github') { const gh = ghClient(); if (gh) await gh.deleteAsset(v.storage.assetId).catch(() => {}); }
  const before = app.version;
  applyNewest(app);
  if (app.version !== before) { app.previousVersion = null; app.updatedAt = new Date().toISOString(); }
  store.save();
  json(res, { app: appView(app, acc) });
}, 'owner');

// ----- Telegram channels -----
// Mango signs in to Telegram as you (through lib/telegram_helper.py) and watches channels for new .ipa posts.
// Files stay on Telegram (or get copied to your GitHub storage) — nothing is kept on this server.
const tg = telegram.createHelper();

// Checks which of a channel's apps still have their post, 200 at a time (Telegram's limit per call).
// Apps whose post is gone get marked removed; apps whose post is back get unmarked.
// A batch that fails to check is left alone, so a hiccup never marks apps as removed.
async function tgMarkRemoved(src) {
  const linked = store.apps.filter((a) => a.remote && a.remote.kind === 'telegram' && a.remote.sourceId === src.id && !a.remote.ghAssetId);
  let newlyGone = 0;
  for (let i = 0; i < linked.length; i += 200) {
    const batch = linked.slice(i, i + 200);
    let exists;
    try { ({ exists } = await tg.exists(src.ref, batch.map((a) => a.remote.msgId))); } catch { continue; }
    const have = new Set(exists);
    for (const a of batch) {
      const gone = !have.has(a.remote.msgId);
      if (gone && !a.remote.missing) newlyGone++;
      if (gone) a.remote.missing = true; else delete a.remote.missing;
    }
  }
  return newlyGone;
}
const tgSettings = () => store.settings.telegram || null;
const tgReady = () => !!(tgSettings() && tgSettings().sessionEnc);
function tgCreds(extra = {}) {
  const t = tgSettings();
  return { apiId: decrypt(t.apiIdEnc), apiHash: decrypt(t.apiHashEnc), session: t.sessionEnc ? decrypt(t.sessionEnc) : '', ...extra };
}
if (tgReady()) tg.start(tgCreds()).catch((e) => console.error('Telegram:', e.message));

const tgView = () => {
  const t = tgSettings();
  if (!t) return { connected: false };
  return { connected: !!t.sessionEnc, pending: !t.sessionEnc ? t.pending || 'code' : null, me: t.me || null, running: tg.running, error: t.sessionEnc && !tg.running ? tg.lastError : null };
};

route('POST', /^\/api\/telegram\/login$/, async (req, res) => {
  const b = await readJson(req);
  const apiId = String(b.apiId || '').trim();
  const apiHash = String(b.apiHash || '').trim();
  if (!/^\d{3,12}$/.test(apiId)) return fail(res, 400, 'The API ID is a number from my.telegram.org');
  if (!/^[a-f0-9]{32}$/i.test(apiHash)) return fail(res, 400, 'The API hash is 32 letters and numbers from my.telegram.org');
  tg.stop();
  try {
    await tg.start({ apiId, apiHash, session: '' });
    const r = await tg.call('POST', '/login/start', { phone: b.phone });
    store.settings.telegram = { apiIdEnc: encrypt(apiId), apiHashEnc: encrypt(apiHash), pending: 'code' };
    store.save();
    json(res, { ok: true, via: r.via, telegram: tgView() });
  } catch (e) {
    tg.stop();
    fail(res, e.status || 400, e.message);
  }
}, 'owner');

async function finishTgLogin(res, r) {
  if (r.needPassword) {
    store.settings.telegram.pending = 'password';
    store.save();
    return json(res, { needPassword: true, telegram: tgView() });
  }
  Object.assign(store.settings.telegram, { sessionEnc: encrypt(r.session), me: r.me, pending: null, connectedAt: new Date().toISOString() });
  tg.setSession(r.session);
  store.save();
  json(res, { ok: true, telegram: tgView() });
}
route('POST', /^\/api\/telegram\/code$/, async (req, res) => {
  if (!tgSettings() || !tg.running) return fail(res, 400, 'Start again: enter your API details and phone number');
  const { code } = await readJson(req);
  try { await finishTgLogin(res, await tg.call('POST', '/login/code', { code })); } catch (e) { fail(res, e.status || 400, e.message); }
}, 'owner');
route('POST', /^\/api\/telegram\/password$/, async (req, res) => {
  if (!tgSettings() || !tg.running) return fail(res, 400, 'Start again: enter your API details and phone number');
  const { password } = await readJson(req);
  try { await finishTgLogin(res, await tg.call('POST', '/login/password', { password })); } catch (e) { fail(res, e.status || 400, e.message); }
}, 'owner');
route('DELETE', /^\/api\/telegram$/, async (req, res) => {
  if (tgReady()) await tg.call('POST', '/logout').catch(() => {});
  tg.stop();
  delete store.settings.telegram;
  store.save();
  json(res, { telegram: tgView() });
}, 'owner');

const TG_DEFAULTS = { storage: 'telegram', updateMine: false, matchName: false, backfill: 10, keywords: '', autoSync: true, captionNotes: true, skipHave: true };
function cleanTgOptions(o = {}, base = TG_DEFAULTS) {
  return {
    storage: o.storage === 'github' ? 'github' : o.storage === 'telegram' ? 'telegram' : base.storage,
    updateMine: typeof o.updateMine === 'boolean' ? o.updateMine : base.updateMine,
    matchName: typeof o.matchName === 'boolean' ? o.matchName : base.matchName,
    backfill: o.backfill !== undefined ? Math.max(0, Math.min(100, Number(o.backfill) || 0)) : base.backfill,
    keywords: typeof o.keywords === 'string' ? o.keywords.slice(0, 300) : base.keywords,
    autoSync: typeof o.autoSync === 'boolean' ? o.autoSync : base.autoSync,
    captionNotes: typeof o.captionNotes === 'boolean' ? o.captionNotes : base.captionNotes,
    skipHave: typeof o.skipHave === 'boolean' ? o.skipHave : base.skipHave !== false,
  };
}

// Channel captions are full of promo lines; keep the useful part for "What's new".
function cleanCaption(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => !/tap here|t\.me\/|https?:\/\/|@\w{4,}|subscribe|join (our|the)|group chat|youtube|tiktok|channel|buy your|certificate|shop/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1500);
}
const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function tgPeek(src, post) {
  const f = await tg.file(src.ref, post.id);
  return ipa.inspect({ url: f.url, headers: f.headers });
}
// "Mortal Kombat - KamoHacks [7.4.1].ipa" and "...[7.4.0].ipa" are the same app: used to skip older reposts without reading them.
const fileKey = (name) => String(name || '').toLowerCase().replace(/\.ipa$/, '').replace(/[\[(].*?[\])]/g, ' ').replace(/v?\d+(\.\d+)+/g, ' ').replace(/[^a-z0-9]+/g, '');

async function tgImportPost(src, post, job, preMeta) {
  const opts = src.options;
  const f = await tg.file(src.ref, post.id);
  const meta = preMeta || await ipa.inspect({ url: f.url, headers: f.headers });
  if (!meta.bundleId) throw new Error("couldn't read the app inside");
  const bid = meta.bundleId.toLowerCase();
  const mine = (a) => a.remote && a.remote.kind === 'telegram' && a.remote.sourceId === src.id;
  let app = store.apps.find((a) => mine(a) && (a.bundleId || '').toLowerCase() === bid)
    || (opts.matchName ? store.apps.find((a) => mine(a) && normName(a.originalName || a.name) === normName(meta.name)) : null)
    || (opts.updateMine ? store.apps.find((a) => (a.bundleId || '').toLowerCase() === bid && (!a.remote || ['github', 'link'].includes(a.remote.kind))) : null);
  // You deleted this app from the channel: don't add it back (updating your own copy with "update mine" is still fine).
  if (!app && isExcluded(src, { bundleId: bid })) {
    job.log.push(`– ${meta.name}: skipped (you deleted it from this channel)`);
    return 'skipped';
  }
  // Already in the library from somewhere else: don't add a second copy.
  if (!app && opts.skipHave !== false && haveElsewhere(bid, src.id)) {
    job.log.push(`– ${meta.name}: skipped (already in your library from somewhere else)`);
    return 'skipped';
  }
  const notes = opts.captionNotes ? cleanCaption(post.text) : '';
  if (app && meta.version && app.version && versionCmp(meta.version, app.version) < 0) {
    job.log.push(`= ${meta.name} ${meta.version} is older than the ${app.version} you have`);
    return 'older';
  }
  if (app && app.version === meta.version && (app.build || '') === (meta.build || '')) {
    if (mine(app) && !app.remote.ghAssetId) { app.remote.msgId = post.id; app.remote.missing = false; }
    job.log.push(`= ${meta.name} ${meta.version} is already in the library`);
    return 'same';
  }
  // Where the file lives: on Telegram (just the post), or copied once to your GitHub storage.
  const remote = { kind: 'telegram', sourceId: src.id, ref: src.ref, msgId: post.id, postDate: post.date, fileKey: fileKey(post.file && post.file.name) };
  if (opts.storage === 'github') {
    const g = ghSettings();
    const gh = ghClient();
    if (!gh || !g.releaseId) throw new Error('this channel saves to GitHub, but GitHub storage is not connected');
    job.log.push(`Copying ${meta.name} ${meta.version} to GitHub…`);
    const startCtrl = new AbortController();
    const startTimer = setTimeout(() => startCtrl.abort(new Error("Telegram didn't start sending the file. Try again.")), 120000);
    let r;
    try { r = await fetchAuthed(f.url, f.headers, AbortSignal.any([job.signal, startCtrl.signal])); } finally { clearTimeout(startTimer); }
    if (!r.ok || !r.body) throw new Error(`couldn't read the file from Telegram (HTTP ${r.status})`);
    const size = Number(r.headers.get('content-length')) || meta.size;
    const safe = `tg-${normName(meta.name).slice(0, 40) || 'app'}-${meta.version || 'v'}-${id().slice(0, 6)}.ipa`;
    const asset = await gh.uploadStream(g.releaseId, safe, r.body, size, (p) => { job.progress = p; }, job.signal);
    job.progress = null;
    remote.ghAssetId = asset.id;
  }
  if (app) {
    const old = app.remote;
    const locked = new Set(app.locked || []);
    const oldShown = app.versionOverride || app.version;
    for (const [k, val] of Object.entries(metaFields(meta))) if (!locked.has(k)) app[k] = val;
    if (notes && !locked.has('notes')) app.notes = notes;
    if (app.descFromCaption && !locked.has('description')) {
      const cap = cleanCaption(String(post.text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12).join('\n')).slice(0, 600);
      if (cap) app.description = cap;
    }
    if (meta.icon && !app.customIcon) await fsp.writeFile(path.join(dirs.apps, app.id + '.png'), meta.icon);
    if (old && old.screenshots) remote.screenshots = old.screenshots;
    if ((!app.categoryId || !catExists(app.categoryId)) && !locked.has('categoryId') && (!src.categoryId || src.categoryId === '__auto')) {
      const r = await autoCategory(app, post.text);
      if (r.categoryId) app.categoryId = r.categoryId;
    }
    Object.assign(app, { remote, previousVersion: oldShown, updatedAt: new Date().toISOString(), versionOverride: locked.has('versionOverride') ? app.versionOverride : null });
    // The old copy isn't needed anymore.
    const gh = ghClient();
    if (old && gh && (old.kind === 'github' || old.ghAssetId)) gh.deleteAsset(old.assetId || old.ghAssetId).catch(() => {});
    await rmQuiet(path.join(dirs.apps, app.id + '.ipa'));
    notifyUpdate(app, oldShown);
    job.log.push(`⬆ ${app.name} ${oldShown || '?'} → ${meta.version}`);
    return 'updated';
  }
  const lines = String(post.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const rec = newLibraryRecord(meta, {
    source: 'telegram', remote, fileName: (post.file && post.file.name) || 'app.ipa',
    description: cleanCaption(lines.slice(0, 12).join('\n')).slice(0, 600), notes,
    published: src.showInLibrary !== false, categoryId: src.categoryId && catExists(src.categoryId) ? src.categoryId : null,
    descFromCaption: true,
  });
  if (!src.categoryId || src.categoryId === '__auto') {
    const r = await autoCategory(rec, post.text);
    rec.categoryId = r.categoryId;
    if (r.info) {
      rec.developer = r.info.developer.slice(0, 80);
      if (r.info.description) { rec.description = r.info.description; rec.descFromCaption = false; }
      remote.screenshots = r.info.screenshots;
    }
    if (r.categoryId) job.log.push(`  → ${(store.categories.find((c) => c.id === r.categoryId) || {}).name}${r.how === 'rule' ? ' (your rule)' : ' (App Store)'}`);
  }
  if (meta.icon) await fsp.writeFile(path.join(dirs.apps, rec.id + '.png'), meta.icon);
  store.apps.unshift(rec);
  job.log.push(`+ ${rec.name} ${rec.version}`);
  return 'added';
}
const catExists = (cid) => store.categories.some((c) => c.id === cid);

// ----- one check at a time -----
// Checking a Telegram channel, a GitHub repo or a source all wait in one line, so only one runs at a time
// (they share Telegram's and GitHub's speed limits, and running several at once makes them all crawl).
// Starting one while another runs is fine: it waits its turn and says what it's waiting for.
const checkQueue = [];
let checkRunning = null;
function runCheck(job, work) {
  if (checkRunning || checkQueue.length) {
    job.status = 'queued';
    const ahead = [checkRunning, ...checkQueue.map((c) => c.job)].filter(Boolean);
    job.waitingFor = ahead.map((j) => j.title).filter(Boolean);
    job.log.push(`⏳ Waiting for ${job.waitingFor[0] || 'another check'} to finish${ahead.length > 1 ? ` (${ahead.length} ahead)` : ''}. It starts by itself right after.`);
  }
  checkQueue.push({ job, work });
  pumpChecks();
  return job;
}
async function pumpChecks() {
  if (checkRunning) return;
  const next = checkQueue.shift();
  if (!next) return;
  const { job, work } = next;
  if (job.cancelled) { job.status = 'cancelled'; job.endedAt = Date.now(); return pumpChecks(); }
  checkRunning = job;
  job.status = 'running';
  job.waitingFor = null;
  job.started = Date.now();
  try { await work(); } catch (e) {
    if (job.status === 'running') { job.status = 'error'; job.error = e.message; }
  } finally {
    if (job.status === 'running') job.status = job.cancelled ? 'cancelled' : 'done';
    job.endedAt = Date.now();
    checkRunning = null;
    setImmediate(pumpChecks);
  }
}
const checkBusy = () => !!checkRunning || checkQueue.length > 0;
// Is this source already being checked (or waiting)? Then reuse that instead of starting another.
function checkFor(srcId) {
  return [checkRunning, ...checkQueue.map((c) => c.job)].find((j) => j && j.srcId === srcId && !j.cancelled) || null;
}

const tgSyncing = new Map();
function tgSync(src, acc) {
  const already = checkFor(src.id);
  if (already) return already;
  const job = newJob(acc || OWNER());
  job.cancellable = true;
  job.title = `Checking ${src.name}`;
  job.srcId = src.id;
  tgSyncing.set(src.id, job.id);
  return runCheck(job, async () => {
    const result = { added: 0, updated: 0, same: 0, older: 0, skipped: 0, failed: 0, removed: 0 };
    try {
      if (!tgReady()) throw new Error('Telegram is not connected');
      const opts = src.options;
      const first = !src.lastMsgId;
      job.log.push(first ? `Looking through ${src.name}'s recent posts…` : `Checking ${src.name} for new posts…`);
      const { posts } = await tg.posts(src.ref, src.lastMsgId || 0, first ? 400 : 200);
      const words = opts.keywords.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
      let ipas = posts.filter((p) => p.file && /\.ipa$/i.test(p.file.name));
      if (words.length) ipas = ipas.filter((p) => words.some((w) => `${p.file.name}\n${p.text}`.toLowerCase().includes(w)));
      result.skipped = posts.length - ipas.length;
      if (first) ipas = ipas.slice(0, opts.backfill);
      // Newest post per app wins, so older builds in the same batch are skipped.
      ipas.reverse();
      src.failures = src.failures || {};
      let maxDone = src.lastMsgId || 0;
      let blocked = false;
      for (const [i, p] of ipas.entries()) {
        if (job.cancelled) { blocked = true; maxDone = Math.min(maxDone || p.id - 1, p.id - 1); break; }
        job.log.push(`(${i + 1}/${ipas.length}) ${p.file.name}`);
        try {
          const r = await tgImportPost(src, p, job);
          result[r]++;
          delete src.failures[p.id];
          src.done = [...(src.done || []), p.id].slice(-200000);
          store.save();
        } catch (e) {
          if (job.cancelled) { blocked = true; maxDone = Math.min(maxDone || p.id - 1, p.id - 1); break; }
          src.failures[p.id] = (src.failures[p.id] || 0) + 1;
          result.failed++;
          job.log.push(`✕ ${p.file.name}: ${e.message}`);
          // Try a failed post again next time (up to 3 times), so a hiccup doesn't skip an app forever.
          if (src.failures[p.id] < 3 && !blocked) { blocked = true; maxDone = Math.min(maxDone || p.id - 1, p.id - 1); }
        }
        if (!blocked) maxDone = Math.max(maxDone, p.id);
      }
      const newest = posts.length ? Math.max(...posts.map((p) => p.id)) : 0;
      src.lastMsgId = blocked ? maxDone : Math.max(src.lastMsgId || 0, newest);
      // Posts deleted from the channel: hide those apps (unless they were copied to GitHub).
      result.removed += await tgMarkRemoved(src);
      if (job.cancelled) result.cancelled = true;
      Object.assign(src, { lastSync: new Date().toISOString(), lastError: null, lastResult: result });
      store.save();
      job.result = result;
      job.status = 'done';
    } catch (e) {
      src.lastError = e.message;
      store.save();
      job.error = e.message;
      job.status = 'error';
    }
  });
}

// Look further back through a channel's history (old posts from years ago), without touching what you already have.
// count = how many .ipa posts to look through (0 = the whole channel).
function tgDeepScan(src, count, acc, { recheck = false, quick = true } = {}) {
  const job = newJob(acc || OWNER());
  job.cancellable = true;
  job.title = `Scanning ${src.name}`;
  job.srcId = src.id;
  tgSyncing.set(src.id, job.id);
  return runCheck(job, async () => {
    const result = { added: 0, updated: 0, same: 0, older: 0, skipped: 0, failed: 0, removed: 0, known: 0 };
    try {
      if (!tgReady()) throw new Error('Telegram is not connected');
      const want = count > 0 ? count : Infinity;
      const words = src.options.keywords.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
      const found = [];
      let offset = 0;
      let looked = 0;
      job.log.push(`Looking back through ${src.name}…`);
      job.counter = { label: 'posts looked at', done: 0, total: null };
      while (found.length < want && !job.cancelled) {
        const page = await tg.posts(src.ref, 0, 200, offset);
        if (!page.scanned) break;
        looked += page.scanned;
        for (const p of page.posts) {
          if (!p.file || !/\.ipa$/i.test(p.file.name)) continue;
          if (words.length && !words.some((w) => `${p.file.name}\n${p.text}`.toLowerCase().includes(w))) { result.skipped++; continue; }
          if (found.length < want) found.push(p);
        }
        job.counter.done = looked;
        if (looked % 2000 < 200) job.log.push(`Looked at ${looked} posts, found ${found.length} .ipa files…`);
        if (!page.oldest || page.oldest <= 1) break;
        offset = page.oldest;
      }
      job.log.push(`Found ${found.length} .ipa file${found.length === 1 ? '' : 's'} in ${looked} posts.`);

      // Fast skips, newest first, before reading anything:
      //  - posts already handled by an earlier check or scan
      //  - older reposts of an app whose newer post is in this scan or already in the library
      src.done = src.done || [];
      const done = new Set(src.done);
      // A name every post shares (like "app.ipa") says nothing about which app it is, so it's ignored.
      const keyCount = new Map();
      for (const p of found) { const kk = fileKey(p.file.name); keyCount.set(kk, (keyCount.get(kk) || 0) + 1); }
      const usableKey = (kk) => quick && kk.length >= 4 && !['game', 'signed', 'modded', 'hacked', 'tweaked', 'file', 'download'].includes(kk) && keyCount.get(kk) <= Math.max(25, found.length * 0.3);
      const newestByKey = new Map();
      for (const a of store.apps) if (a.remote && a.remote.kind === 'telegram' && a.remote.sourceId === src.id && a.remote.fileKey) newestByKey.set(a.remote.fileKey, Math.max(newestByKey.get(a.remote.fileKey) || 0, a.remote.msgId));
      const todo = [];
      for (const p of found) { // newest first
        const key = usableKey(fileKey(p.file.name)) ? fileKey(p.file.name) : '';
        if (!recheck && done.has(p.id)) { result.known++; continue; }
        if (key && newestByKey.has(key) && newestByKey.get(key) > p.id) { result.older++; done.add(p.id); continue; }
        if (key && !newestByKey.has(key)) newestByKey.set(key, p.id);
        todo.push(p);
      }
      if (result.known || result.older) job.log.push(`Skipping ${result.known + result.older} post${result.known + result.older === 1 ? '' : 's'} you already have or that are older builds.`);

      // Read app info a few at a time (that's the slow part), then add them oldest first so the newest wins.
      todo.reverse();
      job.counter = { label: 'apps checked', done: 0, total: todo.length };
      const PEEK = 4;
      for (let i = 0; i < todo.length && !job.cancelled; i += PEEK) {
        const batch = todo.slice(i, i + PEEK);
        const metas = await Promise.all(batch.map((p) => tgPeek(src, p).then((meta) => ({ meta }), (error) => ({ error }))));
        for (const [n, p] of batch.entries()) {
          if (job.cancelled) break;
          job.log.push(`(${i + n + 1}/${todo.length}) ${p.file.name}`);
          try {
            if (metas[n].error) throw metas[n].error;
            result[await tgImportPost(src, p, job, metas[n].meta)]++;
            done.add(p.id);
          } catch (e) {
            if (job.cancelled) break;
            result.failed++;
            job.log.push(`✕ ${p.file.name}: ${e.message}`);
          }
          job.counter.done = i + n + 1;
          job.progress = (i + n + 1) / todo.length;
        }
        src.done = [...done].slice(-200000);
        if (i % (PEEK * 10) === 0) store.save();
      }
      if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
      job.progress = null;
      if (job.cancelled) result.cancelled = true;
      src.done = [...done].slice(-200000);
      const newest = found.length ? Math.max(...found.map((p) => p.id)) : 0;
      if (newest > (src.lastMsgId || 0) && !job.cancelled) src.lastMsgId = newest;
      Object.assign(src, { lastSync: new Date().toISOString(), lastError: null, lastResult: result, deepest: Math.max(src.deepest || 0, found.length) });
      store.save();
      job.result = result;
      job.status = 'done';
    } catch (e) {
      src.lastError = e.message;
      store.save();
      job.error = e.message;
      job.status = 'error';
    }
  });
}

route('POST', /^\/api\/sources\/([a-f0-9]{16})\/scan$/, async (req, res, m, acc) => {
  const src = store.sources.find((x) => x.id === m[1] && x.kind === 'telegram');
  if (!src) return fail(res, 404, 'Channel not found');
  if (!tgReady()) return fail(res, 400, 'Connect Telegram first');
  const busy = checkFor(src.id);
  if (busy) return fail(res, 409, `${busy.title} is already ${busy.status === 'queued' ? 'waiting to run' : 'running'}. Stop it first (⏳ button), or wait for it to finish.`);
  const { count, recheck, quick } = await readJson(req);
  const job = tgDeepScan(src, Math.max(0, Math.min(1e6, Number(count) || 0)), acc, { recheck: !!recheck, quick: quick !== false });
  json(res, { jobId: job.id, waitingFor: job.waitingFor || null });
}, 'owner');

route('POST', /^\/api\/telegram\/channels$/, async (req, res, m, acc) => {
  if (!tgReady()) return fail(res, 400, 'Connect Telegram first');
  const b = await readJson(req);
  let ch;
  try { ch = await tg.channel(b.ref); } catch (e) { return fail(res, e.status || 400, e.message); }
  const ref = ch.username || String(ch.id);
  if (store.sources.some((x) => x.kind === 'telegram' && String(x.ref).toLowerCase() === ref.toLowerCase())) return fail(res, 400, 'That channel is already added');
  const src = {
    id: id(), kind: 'telegram', ref, url: ch.username ? `https://t.me/${ch.username}` : '', name: ch.title, username: ch.username,
    showInLibrary: b.showInLibrary !== false, categoryId: ['__auto', '__none'].includes(b.categoryId) ? b.categoryId : b.categoryId && catExists(b.categoryId) ? b.categoryId : '__auto',
    options: cleanTgOptions(b.options), addedAt: new Date().toISOString(), lastMsgId: 0,
  };
  store.sources.push(src);
  store.save();
  const job = tgSync(src, acc);
  json(res, { source: sourceView(src), jobId: job.id, waitingFor: job.status === 'queued' ? job.waitingFor : null });
}, 'owner');

// Every hour, line up a check of every channel, GitHub repo and source (one at a time, see runCheck).
function scheduleChecks() {
  for (const src of store.sources) {
    if (checkFor(src.id)) continue;
    if (src.kind === 'telegram') { if (tgReady() && src.options && src.options.autoSync !== false) tgSync(src); } else sourceCheck(src);
  }
}
setTimeout(scheduleChecks, 5 * 60_000).unref();
setInterval(scheduleChecks, 60 * 60_000).unref();

// Shortly after start, re-check which channel posts still exist. Older versions only checked
// the first 200 apps per channel, so the rest were wrongly marked "Removed from source".
setTimeout(async () => {
  if (!tgReady()) return;
  let fixed = 0;
  for (const src of store.sources.filter((x) => x.kind === 'telegram')) {
    const before = store.apps.filter((a) => a.remote && a.remote.sourceId === src.id && a.remote.missing).length;
    try { await tgMarkRemoved(src); } catch { continue; }
    fixed += before - store.apps.filter((a) => a.remote && a.remote.sourceId === src.id && a.remote.missing).length;
  }
  if (fixed) { store.save(); console.log(`Un-marked ${fixed} apps that were wrongly shown as removed`); }
}, 30_000);

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
  if (!isOwner(acc)) addAlert('owner', 'request', `🙋 ${acc.username} wants ${name}`, r.note || r.link || '', { requestId: r.id });
  store.save();
  json(res, { request: r });
});
route('PATCH', /^\/api\/requests\/([a-f0-9]{16})$/, async (req, res, m) => {
  const r = store.requests.find((x) => x.id === m[1]);
  if (!r) return fail(res, 404, 'Request not found');
  const b = await readJson(req);
  const before = r.status;
  if (['pending', 'added', 'declined'].includes(b.status)) r.status = b.status;
  if (typeof b.reply === 'string') r.reply = b.reply.trim().slice(0, 300);
  if (typeof b.appId === 'string' && store.apps.some((a) => a.id === b.appId)) r.appId = b.appId;
  if (r.ownerId !== 'owner' && r.status !== before && r.status !== 'pending') {
    addAlert(r.ownerId, 'request', r.status === 'added' ? `✅ ${r.name} was added` : `✕ Your request for ${r.name} was declined`, r.reply || '', { requestId: r.id, appId: r.appId || null });
  }
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

// Saves a .p12 + .mobileprovision pair as a certificate. Throws a 400 with a friendly message if they don't work.
async function addCert(acc, p12File, provFile, password, label) {
  let profile, p12;
  try {
    profile = parseProvision(await fsp.readFile(provFile));
    p12 = await parseP12(p12File, String(password));
  } catch (e) {
    throw httpError(400, e.message);
  }
  const matches = profile.certs.length ? profile.certs.some((c) => c.sha1 === p12.sha1) : null;
  const certId = id();
  const dir = path.join(dirs.certs, certId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(p12File, path.join(dir, 'cert.p12'));
  await fsp.copyFile(provFile, path.join(dir, 'profile.mobileprovision'));
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
  return rec;
}
const certLimitHit = (acc) => !isOwner(acc) && myCerts(acc).length >= 5;

route('POST', /^\/api\/certs$/, async (req, res, m, acc) => {
  const { p12UploadId, provUploadId, password = '', label } = await readJson(req);
  if (certLimitHit(acc)) return fail(res, 400, 'You can have up to 5 certificates — delete one first');
  const p12File = tmpPath(p12UploadId, acc);
  const provFile = tmpPath(provUploadId, acc);
  try {
    const rec = await addCert(acc, p12File, provFile, password, label);
    json(res, { cert: certView(rec, acc) });
  } catch (e) {
    fail(res, e.status || 400, e.message);
  } finally {
    await rmQuiet(p12File); await rmQuiet(provFile);
  }
});

// One .zip with the .p12, the .mobileprovision and (often) a password .txt — how most cert sellers send them.
route('POST', /^\/api\/certs\/zip$/, async (req, res, m, acc) => {
  const { uploadId, password, label } = await readJson(req);
  if (certLimitHit(acc)) return fail(res, 400, 'You can have up to 5 certificates — delete one first');
  const zipFile = tmpPath(uploadId, acc);
  const work = path.join(dirs.work, 'cz-' + id());
  try {
    let entries;
    try { entries = await zipLib.listEntries(zipFile); } catch { throw httpError(400, "That isn't a .zip file"); }
    entries = entries.filter((e) => !/(^|\/)(__MACOSX|\.)/.test(e.name) && e.size < 5 * 1048576);
    const p12s = entries.filter((e) => /\.p12$/i.test(e.name));
    const provs = entries.filter((e) => /\.mobileprovision$/i.test(e.name));
    if (!p12s.length) throw httpError(400, 'No .p12 file found in the .zip');
    if (!provs.length) throw httpError(400, 'No .mobileprovision file found in the .zip');
    await fsp.mkdir(work, { recursive: true });
    // Password ideas: what you typed, then anything that looks like a password in the text files, then none.
    const guesses = [];
    if (password) guesses.push(String(password));
    for (const t of entries.filter((e) => /\.(txt|md|rtf)$/i.test(e.name) || /pass/i.test(e.name)).slice(0, 6)) {
      const text = (await zipLib.readEntry(zipFile, t, 65536)).toString('utf8').replace(/\r/g, '');
      for (const line of text.split('\n')) {
        const mm = line.match(/pass(?:word|code)?\s*(?:is)?\s*[:=\-–]\s*(.+)$/i);
        if (mm) guesses.push(mm[1].trim().replace(/^["'`]|["'`]$/g, ''));
      }
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 1) guesses.push(lines[0]);
      const base = path.basename(t.name).replace(/\.(txt|md|rtf)$/i, '');
      if (/pass/i.test(t.name) === false && base.length < 40) guesses.push(base);
    }
    for (const e of [...p12s, ...provs]) {
      const name = path.basename(e.name).replace(/\.(p12|mobileprovision)$/i, '');
      if (/pass/i.test(name)) { const mm = name.match(/pass(?:word)?[\s_\-:=]*(.+)$/i); if (mm) guesses.push(mm[1]); }
    }
    guesses.push('', '1', '123', '1234', '123456');
    const tries = [...new Set(guesses.filter((g) => g.length <= 128))];
    const provFile = path.join(work, 'profile.mobileprovision');
    await fsp.writeFile(provFile, await zipLib.readEntry(zipFile, provs[0]));
    for (const p of p12s.slice(0, 4)) {
      const p12File = path.join(work, 'cert.p12');
      await fsp.writeFile(p12File, await zipLib.readEntry(zipFile, p));
      for (const pw of tries) {
        try { await parseP12(p12File, pw); } catch { continue; }
        const rec = await addCert(acc, p12File, provFile, pw, label);
        return json(res, { cert: certView(rec, acc), passwordFound: pw !== String(password || '') });
      }
    }
    throw httpError(400, password ? "That password didn't open the .p12. Check it and try again." : "Couldn't find the .p12 password. Type it in and try again.");
  } catch (e) {
    fail(res, e.status || 400, e.message);
  } finally {
    await rmQuiet(zipFile);
    await fsp.rm(work, { recursive: true, force: true });
  }
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

// Gathers tweak .dylibs into the work folder, points Substrate links at the bundled framework,
// and says which frameworks need adding to the app.
async function collectTweaks(uploads, libTweaks, work, job) {
  const dir = path.join(work, 'tweaks');
  await fsp.mkdir(dir, { recursive: true });
  const items = [];
  for (const u of uploads) {
    if (/\.deb$/i.test(u.name)) {
      const pkg = await deb.unpack(u.file, path.join(work, 'deb-' + items.length)).catch((e) => { throw new Error(`${u.name}: ${e.message}`); });
      if (!pkg.tweaks.length) throw new Error(`${u.name}: no tweak (.dylib) inside`);
      for (const t of pkg.tweaks.slice(0, 10)) items.push({ name: t.name, buf: await fsp.readFile(t.file), from: u.name });
      if (pkg.bundles.length) job.log.push(`Note: ${u.name} has resource bundles that aren't added (some images may be missing).`);
    } else {
      items.push({ name: u.name, buf: await fsp.readFile(u.file), from: u.name });
    }
    await rmQuiet(u.file);
  }
  for (const t of libTweaks) {
    for (const f of t.files) items.push({ name: f.name, buf: await fsp.readFile(path.join(dirs.tweaks, t.id, f.name)), from: t.name });
  }
  const files = [];
  const used = new Set();
  let needsSubstrate = false;
  for (const it of items) {
    const info = macho.inspectTweak(it.buf);
    if (!info.ok) throw new Error(`${it.from}: ${info.error}`);
    if (info.needsSubstrate) {
      needsSubstrate = true;
      const r = macho.patchForSubstrate(it.buf);
      if (r.skipped.length) job.log.push(`Note: couldn't relink ${it.name} to the bundled Substrate.`);
    }
    if (info.missing.length) job.log.push(`Note: ${it.name} needs ${info.missing.join(', ')} (jailbreak-only), so it may not work.`);
    let name = safeDylibName(it.name);
    while (used.has(name.toLowerCase())) name = name.replace(/(\d*)\.dylib$/i, (_m, n) => `${(Number(n) || 1) + 1}.dylib`);
    used.add(name.toLowerCase());
    const p = path.join(dir, name);
    await fsp.writeFile(p, it.buf);
    files.push(p);
  }
  const frameworks = [];
  if (needsSubstrate) {
    if (substrateInstalled()) frameworks.push(SUBSTRATE_DIR());
    else job.log.push('Warning: a tweak needs CydiaSubstrate but none is set up in the Tweaks library, so the app may crash on launch.');
  }
  if (files.length) job.log.push(`Injecting ${files.length} tweak${files.length === 1 ? '' : 's'}: ${files.map((f) => path.basename(f)).join(', ')}`);
  return { files, frameworks };
}

async function prepareModifiedIpa(srcIpa, work, plistEdits, job, frameworks = []) {
  const extract = path.join(work, 'x');
  await fsp.mkdir(extract, { recursive: true });
  job.log.push(plistEdits.length ? 'Unpacking app to edit Info.plist…' : 'Unpacking app to add tweak support…');
  if (await runLogged('unzip', ['-qq', '-o', srcIpa, '-d', extract], job) !== 0) throw new Error("Couldn't unpack the app");
  const payload = path.join(extract, 'Payload');
  const appDir = (await fsp.readdir(payload)).find((n) => n.endsWith('.app'));
  if (!appDir) throw new Error('No .app found inside the .ipa');
  if (plistEdits.length) {
    const infoPath = path.join(payload, appDir, 'Info.plist');
    const info = plist.parse(await fsp.readFile(infoPath));
    applyEdits(info, plistEdits);
    await fsp.writeFile(infoPath, plist.build(info));
    job.log.push(`Edited ${plistEdits.length} Info.plist value${plistEdits.length === 1 ? '' : 's'}.`);
  }
  for (const fw of frameworks) {
    const dest = path.join(payload, appDir, 'Frameworks', path.basename(fw));
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(fw, dest, { recursive: true });
    job.log.push(`Added ${path.basename(fw)} so tweaks can run.`);
  }
  const out = path.join(work, 'modified.ipa');
  if (await runLogged('zip', ['-qry', '-0', out, 'Payload'], job, { cwd: extract }) !== 0) throw new Error("Couldn't repack the app");
  await rmQuiet(extract);
  return out;
}

function trimSigned(acc) {
  if (isOwner(acc)) return;
  const max = Number(store.settings.maxSignedPerUser) || 10;
  const mine = mySigned(acc);
  for (const s of mine.slice(max)) removeSigned(s).catch(() => {});
}

route('POST', /^\/api\/sign$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  const app = visibleApps(acc).find((a) => a.id === b.appId);
  if (!app) return fail(res, 404, 'App not found');
  const cert = ownCert(acc, b.certId || defaultCertId(acc));
  if (!cert) return fail(res, 400, 'Add a certificate first');
  if (!zsignVersion) return fail(res, 500, 'The signing engine is not installed on the server');
  const limit = signLimitFor(acc);
  if (limit && signsToday(acc.id) >= limit) return fail(res, 429, `You've used all ${limit} signs for today. It resets at midnight (server time).`);

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
  const libTweaks = (Array.isArray(b.tweakIds) ? b.tweakIds : []).slice(0, 20)
    .map((tid) => visibleTweaks(acc).find((t) => t.id === tid)).filter(Boolean);

  // Already signing this app for you? Follow that job instead of starting a second copy.
  const runKey = `${acc.id}:${app.id}`;
  const running = signingNow.get(runKey);
  if (running && jobs.has(running) && ['running', 'queued'].includes(jobs.get(running).status)) {
    for (const f of [iconFile, ...dylibFiles.map((d) => d.file)].filter(Boolean)) await rmQuiet(f);
    return json(res, { jobId: running, alreadyRunning: true });
  }

  const job = newJob(acc);
  job.cancellable = true;
  job.title = `Signing ${app.name}`;
  countSign(acc.id, app.id);
  job.countedFor = acc.id;
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
      const dl = app.remote ? await resolveDownload(remoteDownload(app, versionIndex)) : null;
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
        '-z', String(Math.min(9, Math.max(0, Number(store.settings.zipLevel ?? 1)))),
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
      // Tweaks: your uploaded .dylib/.deb files plus any picked from the Tweaks library.
      const inject = await collectTweaks(dylibFiles, libTweaks, work, job);
      for (const p of inject.files) args.push('-l', p);
      if (inject.files.length && b.weakDylibs) args.push('-w');
      if (inject.files.length && b.injectExtensions) args.push('-P');
      if (b.removeExtensions) args.push('-E');
      if (b.removeWatch) args.push('-W');
      if (b.removeUISD) args.push('-U');
      if (b.enableDocs) args.push('-S');

      let input = path.join(dirs.apps, app.id + '.ipa');
      if (dl) {
        // App stored elsewhere: use a recent download if there is one, otherwise download it for this signing.
        const key = downloadCacheKey(app, versionIndex, dl);
        let cached = await cacheGet(key);
        input = path.join(work, 'original.ipa');
        // zsign unpacks next to its input, so work from a link inside this job's own folder.
        if (cached && !(await fsp.link(cached, input).then(() => true, () => fsp.copyFile(cached, input).then(() => true, () => false)))) cached = null;
        if (cached) {
          job.log.push(`Using ${app.name}${dl.version ? ' ' + dl.version : ''} downloaded earlier — no download needed ✓`);
        } else {
          const t0 = Date.now();
          const got = await fetchToFile(dl.url, dl.headers, input, job, `Downloading ${app.name}${dl.version ? ' ' + dl.version : ''}…`);
          const secs = Math.max(1, (Date.now() - t0) / 1000);
          if (got > 5 * 1048576) job.log.push(`Downloaded ${gb(got)} in ${Math.round(secs)}s (${(got / 1048576 / secs).toFixed(1)} MB/s)`);
          await cachePut(input, key);
        }
        job.progress = null;
      }
      if (plistEdits.length || inject.frameworks.length) input = await prepareModifiedIpa(input, work, plistEdits, job, inject.frameworks);
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
          ...opts, icon: !!iconFile, dylibs: dylibFiles.map((d) => d.name), tweaks: libTweaks.map((t) => t.name), tweakIds: libTweaks.map((t) => t.id), versionIndex: versionIndex || 0,
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
      if (signedToGithubOn()) setTimeout(() => archiveSigned().catch(() => {}), 20_000); // after the first install has a head start
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
  if (!job || job.owner !== acc.id) return fail(res, 404, 'This task stopped because the server restarted (probably an update). Start it again.');
  const cancelled = !!job.cancelled;
  json(res, { status: cancelled ? 'cancelled' : job.status, log: job.log.slice(-300), error: cancelled ? 'Cancelled' : job.error, result: job.result, progress: cancelled ? null : job.progress ?? null, counter: job.counter || null, cancellable: !!job.cancellable && !job.cancelled });
});

// Background tasks you can come back to after leaving the app.
route('GET', /^\/api\/jobs$/, (req, res, m, acc) => {
  const list = [...jobs.values()].filter((j) => j.owner === acc.id && j.title && (['running', 'queued'].includes(j.status) || Date.now() - (j.endedAt || Date.now()) < 10 * 60 * 1000));
  json(res, {
    jobs: list.map((j) => ({
      id: j.id, title: j.title, status: j.cancelled ? 'cancelled' : j.status, progress: j.progress ?? null,
      counter: j.counter || null, last: j.log[j.log.length - 1] || '', started: j.started, error: j.error, cancellable: !!j.cancellable && !j.cancelled,
    })).sort((a, b) => b.started - a.started),
  });
});

route('POST', /^\/api\/jobs\/([a-f0-9]{16})\/cancel$/, (req, res, m, acc) => {
  const job = jobs.get(m[1]);
  if (!job || job.owner !== acc.id) return fail(res, 404, 'Job not found');
  if (job.status === 'done' || job.status === 'error') return json(res, { ok: true, status: job.status });
  job.cancelled = true;
  job.log.push(job.status === 'queued' ? '✕ Cancelled before it started' : '✕ Cancelled — stopping…');
  const qi = checkQueue.findIndex((c) => c.job === job);
  if (qi >= 0) { checkQueue.splice(qi, 1); job.status = 'cancelled'; job.endedAt = Date.now(); }
  if (job.countedFor) {
    // A cancelled sign doesn't use up one of today's signs.
    const c = store.data.signCounts[job.countedFor];
    if (c && c.n > 0) { c.n -= 1; store.save(); }
    job.countedFor = null;
  }
  try { job.abort.abort(new Error('Cancelled')); } catch { /* */ }
  if (job.child) job.child.kill('SIGKILL');
  json(res, { ok: true });
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
  if (b.lastBackup) store.settings.lastBackup = new Date().toISOString();
  if (Array.isArray(b.catRules)) {
    store.settings.catRules = b.catRules.slice(0, 40).map((r) => ({
      words: String(r.words || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 20).join(', '),
      categoryId: store.categories.some((c) => c.id === r.categoryId) ? r.categoryId : null,
    })).filter((r) => r.words && r.categoryId);
  }
  if (b.signsPerDay !== undefined) store.settings.signsPerDay = Math.min(500, Math.max(0, Number(b.signsPerDay) || 0));
  store.save();
  const { github: _gh, ...settings } = store.settings;
  json(res, { settings });
}, 'owner');

route('POST', /^\/api\/maintenance$/, async (req, res) => {
  const { action } = await readJson(req);
  if (action === 'clear-temp') {
    for (const f of await fsp.readdir(dirs.tmp).catch(() => [])) { await rmQuiet(path.join(dirs.tmp, f)); uploads.delete(f); }
    for (const f of await fsp.readdir(dirs.cache).catch(() => [])) await rmQuiet(path.join(dirs.cache, f));
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
    expiresAt: Number(b.expiresDays) > 0 ? new Date(Date.now() + Math.min(365, Number(b.expiresDays)) * 864e5).toISOString() : null,
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
  if (b.signOut) u.sv = (u.sv || 0) + 1;
  if (b.signLimit !== undefined) u.signLimit = b.signLimit === null ? null : Math.max(0, Math.min(500, Number(b.signLimit) || 0));
  store.save();
  json(res, { user: userView(u) });
}, 'owner');

route('DELETE', /^\/api\/users\/([a-f0-9]{16})$/, async (req, res, m) => {
  const u = findUser(m[1]);
  if (!u) return fail(res, 404, 'User not found');
  for (const c of store.certs.filter((x) => x.ownerId === u.id)) await deleteCertRecord(c);
  for (const s of store.signed.filter((x) => x.ownerId === u.id)) await removeSigned(s);
  store.users.splice(store.users.indexOf(u), 1);
  delete store.data.myApps[u.id];
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
  if (!s || !signedReady(s)) return fail(res, 404, 'Link expired');
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

route('GET', /^\/i\/([\w-]{20,40})\/app\.ipa$/, async (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s || !signedReady(s)) return fail(res, 404, 'Link expired');
  const local = path.join(dirs.signed, s.id + '.ipa');
  const fromGithub = s.gh && !fs.existsSync(local);
  if (req.method === 'HEAD') return fromGithub ? serveSignedFromGithub(req, res, s) : serveFile(req, res, local);
  const st = installState(s);
  // A range request continues an earlier download; a plain request starts from zero.
  const range = (req.headers.range || '').match(/^bytes=(\d+)-/);
  if (st.phase !== 'downloading' || !range) Object.assign(st, { phase: 'downloading', downloadAt: Date.now(), sent: 0, doneAt: null });
  if (range) st.sent = Math.max(st.sent, Number(range[1]));
  // Done as soon as the last byte goes out. (Waiting for the stream to close is unreliable:
  // iPhones often hang up the moment they have the whole file.)
  const onBytes = (n) => {
    st.sent += n;
    if (st.sent >= st.size && st.phase !== 'done') {
      Object.assign(st, { phase: 'done', doneAt: Date.now(), sent: st.size });
      try { recordInstall(s, st); } catch (e) { console.error('install tracking:', e); }
    }
  };
  if (fromGithub) return serveSignedFromGithub(req, res, s, onBytes);
  return serveFile(req, res, local, { download: `${s.name}.ipa`, onBytes });
}, 'open');

function recordInstall(s, st = {}) {
  const app = store.apps.find((a) => a.id === s.appId);
  // The version name people see: the app's custom name if they installed the current version, else the real one.
  const shown = app && app.version === s.version ? shownAppVersion(app) : s.version;
  const viaApp = st.via === 'app';
  store.installLog.push({
    id: id(), signedId: s.id, ownerId: s.ownerId, appId: s.appId, name: s.name, version: s.version,
    shownVersion: shown, certLabel: s.certLabel, at: new Date().toISOString(), via: viaApp ? 'app' : 'link',
  });
  // Only installs started from the app count as "on your phone". A shared link could be anyone's phone.
  if (viaApp && s.appId) {
    const list = myAppsOf(s.ownerId);
    // A phone holds one app per bundle ID, so installing this replaced any other app with the same one.
    if (s.bundleId) for (const [aid, e] of Object.entries(list)) if (aid !== s.appId && e.bundleId && e.bundleId === s.bundleId) delete list[aid];
    list[s.appId] = {
      version: s.version || '', shown, at: new Date().toISOString(), signedId: s.id, bundleId: s.bundleId || null,
      certId: s.certId || null, expires: certExpiry(store.certs.find((c) => c.id === s.certId)),
    };
    // They just installed it: clear "update available" alerts for this app if they're now up to date.
    if (!app || versionCmp(s.version, app.version) >= 0) store.data.alerts = store.alerts.filter((x) => !(x.ownerId === s.ownerId && x.kind === 'update' && x.appId === s.appId));
  }
  if (store.installLog.length > 5000) store.installLog.splice(0, store.installLog.length - 5000);
  if (app) app.installCount = (app.installCount || 0) + 1;
  s.installedAt = new Date().toISOString();
  store.save();
}

// The app tells us an install is starting, then checks progress.
route('POST', /^\/api\/signed\/([a-f0-9]{16})\/install$/, (req, res, m, acc) => {
  const s = store.signed.find((x) => x.id === m[1] && x.ownerId === acc.id);
  if (!s) return fail(res, 404, 'Not found');
  if (!signedReady(s)) return fail(res, 410, 'This signed file was cleaned up — sign it again');
  const cur = installs.get(s.id);
  // If the iPhone already asked for the app a moment ago, keep that progress instead of resetting it.
  const fresh = cur && Date.now() - Math.max(cur.manifestAt || 0, cur.downloadAt || 0) < 5000;
  const st = fresh ? cur : resetInstall(s);
  st.via = 'app';
  json(res, { install: installView(st) });
});
route('GET', /^\/api\/signed\/([a-f0-9]{16})\/install$/, (req, res, m, acc) => {
  const s = store.signed.find((x) => x.id === m[1] && x.ownerId === acc.id);
  if (!s) return fail(res, 404, 'Not found');
  json(res, { install: installView(installState(s)) });
});
// Same for shared install pages (anyone with the link).
route('POST', /^\/i\/([\w-]{20,40})\/status$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s || !signedReady(s)) return fail(res, 404, 'Link expired');
  const cur = installs.get(s.id);
  const fresh = cur && Date.now() - Math.max(cur.manifestAt || 0, cur.downloadAt || 0) < 5000;
  const st = fresh ? cur : resetInstall(s);
  if (st.via !== 'app') st.via = 'link';
  json(res, { install: installView(st) });
}, 'open');
route('GET', /^\/i\/([\w-]{20,40})\/status$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s || !signedReady(s)) return fail(res, 404, 'Link expired');
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
  if (!s || !signedReady(s)) {
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
// One background task failing (a dropped connection, a bad file) must never take the whole server down.
process.on('unhandledRejection', (e) => console.error('Background task error:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => {
  console.error('Unexpected error:', e);
  if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) process.exit(1);
  if (isNoSpace(e)) storageAlert();
});
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
