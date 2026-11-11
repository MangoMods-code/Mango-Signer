// Mango Signer — a self-hosted iOS app signer, installer and App Library.
// Zero npm dependencies: Node built-ins + the zsign, openssl, zip and unzip command-line tools.
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const zlib = require('zlib');
const net = require('net');
const dns = require('dns');
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
const tgbotLib = require('./lib/tgbot');
const translator = require('./lib/translate');

// whats-new.js lives in the main folder (older versions kept it in lib/).
const WHATS_NEW = (() => { try { return require('./whats-new'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; return require('./lib/whats-new'); } })();
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
  imports: path.join(DATA_DIR, 'imports'),
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
store.data.imports = store.data.imports || [];
store.data.translations = store.data.translations || {};
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
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* bad cookie */ } }
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
  const ip = clientIp(req);
  const f = loginFails.get(ip) || { n: 0, t: 0 };
  if (Date.now() - f.t > 60_000) f.n = 0;
  return { limited: f.n >= 6, fail: () => loginFails.set(ip, { n: f.n + 1, t: Date.now() }), ok: () => loginFails.delete(ip) };
}

// ---------- alerts & security log ----------
// The real address is the LAST one in X-Forwarded-For (added by Railway's proxy). Earlier ones are sent by the
// browser and can be made up, so they're never trusted (they'd let someone dodge the login limits).
const clientIp = (req) => {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : String(req.socket.remoteAddress || '');
};
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
// Locks are per account AND per network: 8 wrong passwords from one place lock that place out of that
// account for 15 minutes, so a stranger can't lock you out of your own account by guessing on purpose.
// A much bigger number of wrong tries from everywhere at once (someone trying from many places) locks the account itself.
const LOCK_ALL = 40;
function accountLocked(name, req) {
  const mine = userFails.get(`${name}|${clientIp(req)}`);
  const all = userFails.get(name);
  const live = (f, max) => !!(f && f.n >= max && Date.now() - f.t < LOCK_MS);
  return live(mine, LOCK_AFTER) || live(all, LOCK_ALL);
}
function clearFails(req, name) { userFails.delete(`${name}|${clientIp(req)}`); }
function noteFail(req, name) {
  const bump = (key) => {
    const f = userFails.get(key);
    const n = f && Date.now() - f.t < LOCK_MS ? f.n + 1 : 1;
    userFails.set(key, { n, t: Date.now() });
    return n;
  };
  bump(name);
  const n = bump(`${name}|${clientIp(req)}`);
  if (userFails.size > 5000) for (const [k, v] of userFails) if (Date.now() - v.t > LOCK_MS) userFails.delete(k);
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
// The address links point to (install links, invite links, the bot's buttons). Set PUBLIC_URL on Railway to your
// own domain; otherwise it's whichever address the request came in on, so a custom domain works without it too.
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = String((req && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
  if (host && !/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host)) {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${host}`;
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://${host || 'localhost'}`;
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  let data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  const extra = {};
  // Big JSON (a library with whole app sources in it) is gzipped — about 20x smaller over cell data.
  const req = res.req;
  const type = isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
  const big = !isBuf && typeof body !== 'string' && data.length > 8192 && req;
  // Big answers to GETs (the library) carry a fingerprint. An app that already has this exact answer says so,
  // and gets a tiny "nothing changed" back instead of downloading and redrawing everything.
  if (big && status === 200 && req.method === 'GET') {
    const tag = `"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 22)}"`;
    extra.ETag = tag;
    if (req.headers['if-none-match'] === tag) {
      res.writeHead(304, { 'Cache-Control': 'no-store', ETag: tag });
      return res.end();
    }
  }
  const head = (more) => ({ 'Content-Type': type, 'Cache-Control': 'no-store', ...extra, ...more, ...headers });
  // Big JSON is gzipped (about 20x smaller over cell data), off the main thread so other requests aren't held up.
  if (big && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    return zlib.gzip(data, { level: 5 }, (err, zipped) => {
      if (res.writableEnded || res.destroyed) return;
      if (err) { res.writeHead(status, head({})); return res.end(data); }
      res.writeHead(status, head({ 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }));
      res.end(zipped);
    });
  }
  res.writeHead(status, head({}));
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

// ----- your own .ipa files (the Apps tab) -----
// Anyone can import an .ipa and sign it. Only the person who imported it can see it.
// With GitHub storage connected (private repo) it's kept in a "Mango Imports" release until they delete it,
// and the copy on this server is removed. Without it, it stays on this server for IMPORT_KEEP_DAYS.
const IMPORTS_TAG = 'mango-imports';
const IMPORT_KEEP_DAYS = 3;
const IMPORTS_PER_USER = 30;
const importsToGithubOn = () => { const g = ghSettings(); return !!(g && g.private && ghClient()); };
const importFile = (imp) => path.join(dirs.imports, imp.id + '.ipa');
const importIconFile = (imp) => path.join(dirs.imports, imp.id + '.png');
const myImports = (acc) => store.data.imports.filter((x) => x.ownerId === acc.id);
const findImport = (acc, appId) => {
  const m = /^imp_([a-f0-9]{16})$/.exec(String(appId || ''));
  return m ? store.data.imports.find((x) => x.id === m[1] && x.ownerId === acc.id) || null : null;
};
function importView(imp) {
  const local = fs.existsSync(importFile(imp));
  return {
    id: 'imp_' + imp.id, importId: imp.id, isImport: true, name: imp.name, bundleId: imp.bundleId, version: imp.version, build: imp.build,
    minOS: imp.minOS, size: imp.size, extensions: imp.extensions, hasWatch: imp.hasWatch, hasIcon: imp.hasIcon,
    iconSrc: imp.hasIcon ? `/api/imports/${imp.id}/icon` : null, fileName: imp.fileName, addedAt: imp.addedAt, lastSigned: imp.lastSigned || null,
    onGithub: !!imp.gh, savingToGithub: !imp.gh && local && importsToGithubOn() && (imp.ghTries || 0) < 5,
    expires: imp.gh || (local && importsToGithubOn() && (imp.ghTries || 0) < 5) ? null : new Date(new Date(imp.addedAt).getTime() + IMPORT_KEEP_DAYS * 864e5).toISOString(),
    available: local || !!imp.gh,
  };
}
// Looks like a library app to the signing code.
function importAsApp(imp) {
  const local = fs.existsSync(importFile(imp));
  return {
    id: 'imp_' + imp.id, isImport: true, importRec: imp, name: imp.name, bundleId: imp.bundleId, version: imp.version, size: imp.size,
    minOS: imp.minOS, hasIcon: imp.hasIcon, updatedAt: imp.addedAt, localFile: local ? importFile(imp) : null, iconFile: importIconFile(imp),
    remote: !local && imp.gh ? { kind: 'github', assetId: imp.gh.assetId } : null,
  };
}
async function importsRelease(gh) {
  const g = ghSettings();
  let r = g.importsRelease;
  if (!r || r.count >= 950) {
    const n = r ? (r.n || 1) + 1 : 1;
    const tag = n === 1 ? IMPORTS_TAG : `${IMPORTS_TAG}-${n}`;
    const rel = await gh.ensureRelease(tag, { name: n === 1 ? 'Mango Imports' : `Mango Imports ${n}`, body: 'Apps people imported into Mango Signer to sign. Managed automatically: deleting an app from the Apps tab deletes it here.' });
    const count = n === 1 && !r ? (await gh.listAssets(rel.id).catch(() => [])).length : 0;
    r = g.importsRelease = { id: rel.id, tag, n, count };
    store.save();
    if (count >= 950) return importsRelease(gh);
  }
  return r;
}
let savingImports = false;
async function archiveImports() {
  if (savingImports || !importsToGithubOn()) return;
  savingImports = true;
  try {
    for (;;) {
      const imp = store.data.imports.find((x) => !x.gh && (x.ghTries || 0) < 5 && (!x.ghAfter || Date.now() > x.ghAfter) && fs.existsSync(importFile(x)));
      if (!imp || !importsToGithubOn()) break;
      const gh = ghClient();
      try {
        const st = await fsp.stat(importFile(imp));
        const rel = await importsRelease(gh);
        const name = `import-${normName(imp.name).slice(0, 40) || 'app'}-${(imp.version || 'v').replace(/[^\w.]/g, '')}-${imp.id}.ipa`;
        const asset = await gh.uploadStream(rel.id, name, Readable.toWeb(fs.createReadStream(importFile(imp))), st.size, null);
        ghSettings().importsRelease.count++;
        if (!store.data.imports.includes(imp)) { await gh.deleteAsset(asset.id).catch(() => {}); continue; } // deleted while uploading
        imp.gh = { assetId: asset.id, releaseId: rel.id };
        delete imp.ghTries; delete imp.ghAfter;
        store.save();
        // Not while it's being signed (the signing reads the file); the hourly tidy-up removes it later.
        if (![...signingNow.keys()].some((k) => k.endsWith(':imp_' + imp.id))) await rmQuiet(importFile(imp));
      } catch (e) {
        imp.ghTries = (imp.ghTries || 0) + 1;
        imp.ghAfter = Date.now() + 5 * 60_000 * imp.ghTries;
        store.save();
        console.error(`Saving ${imp.name} to GitHub failed:`, e.message);
        break;
      }
    }
  } finally { savingImports = false; }
}
async function removeImport(imp) {
  const i = store.data.imports.indexOf(imp);
  if (i >= 0) store.data.imports.splice(i, 1);
  await rmQuiet(importFile(imp));
  await rmQuiet(importIconFile(imp));
  if (imp.gh) {
    const gh = ghClient();
    if (gh) await gh.deleteAsset(imp.gh.assetId).catch(() => {});
    const r = ghSettings() && ghSettings().importsRelease;
    if (r && r.count > 0) r.count--;
  }
  store.save();
}
// Hourly: save new imports to GitHub, drop server copies already saved there, and remove old ones kept only here.
async function tidyImports() {
  for (const imp of [...store.data.imports]) {
    const local = fs.existsSync(importFile(imp));
    const busy = [...signingNow.keys()].some((k) => k.endsWith(':imp_' + imp.id));
    if (busy) continue;
    if (imp.gh && local) await rmQuiet(importFile(imp));
    else if (!imp.gh && !local) await removeImport(imp); // file is gone everywhere
    else if (!imp.gh && (!importsToGithubOn() || (imp.ghTries || 0) >= 5) && Date.now() - new Date(imp.addedAt) > IMPORT_KEEP_DAYS * 864e5) await removeImport(imp); // couldn't be saved to GitHub either
  }
  // Files left behind by a crash.
  const known = new Set(store.data.imports.map((x) => x.id));
  for (const f of await fsp.readdir(dirs.imports).catch(() => [])) if (!known.has(f.slice(0, 16))) await rmQuiet(path.join(dirs.imports, f));
  archiveImports().catch(() => {});
}
setInterval(() => tidyImports().catch(() => {}), 3600_000).unref();
setTimeout(() => tidyImports().catch(() => {}), 90_000).unref();

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
// Roles you can give people (only the owner can): admins help run the library and users (never the server
// settings, GitHub, Telegram or backups); testers see apps marked "Testers only" and beta versions first.
const RANKS = ['admin', 'tester'];
const isAdmin = (acc) => !!acc && acc.role === 'user' && acc.rank === 'admin';
const isStaff = (acc) => isOwner(acc) || isAdmin(acc);
const isTester = (acc) => !!acc && acc.role === 'user' && acc.rank === 'tester';
const seesTesterApps = (acc) => isStaff(acc) || isTester(acc);
const staffIds = () => ['owner', ...store.users.filter((u) => u.rank === 'admin' && !u.disabled).map((u) => u.id)];
// Sends an alert to you and every admin.
function alertStaff(kind, title, body, extra = {}, exceptId = null) {
  for (const uid of staffIds()) if (uid !== exceptId) addAlert(uid, kind, title, body, extra);
}
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

// ----- translating descriptions that aren't in English -----
// Translations are kept by the original text, so a source refreshing every hour doesn't translate it again,
// and the original stays as it is (an owner edit always wins, and "Show original" can show it).
const TR = store.data.translations;
const trHashes = new Map();
function thash(t) {
  let h = trHashes.get(t);
  if (!h) {
    if (trHashes.size > 40000) trHashes.clear();
    h = crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);
    trHashes.set(t, h);
  }
  return h;
}
const trCfg = () => store.settings.translate || {};
const trOn = () => !!trCfg().on;
const trText = (s) => {
  if (!s || typeof s !== 'string') return null;
  const e = TR[thash(s)];
  return e && e.t ? e : null;
};
const trShown = (s) => (trOn() && trText(s) ? trText(s).t : s);
const appTexts = (a) => [a.description, a.notes, a.subtitle, ...((a.remote && a.remote.versions) || []).slice(0, 3).map((v) => v.notes)]
  .filter((t) => typeof t === 'string' && t.trim().length > 20);
const trState = { lastError: null, pausedUntil: 0, running: false, done: 0, checked: new Map() }; // checked: hash -> language or null
function trUsage() {
  const day = new Date().toISOString().slice(0, 10);
  if (!store.data.trUsage || store.data.trUsage.day !== day) store.data.trUsage = { day, chars: 0 };
  return store.data.trUsage;
}
function trPending() {
  const todo = new Map();
  for (const a of store.apps) {
    for (const text of appTexts(a)) {
      const h = thash(text);
      if (TR[h] || todo.has(h)) continue;
      let from = trState.checked.get(h);
      if (from === undefined) { from = translator.detect(text); trState.checked.set(h, from); }
      if (from) todo.set(h, { h, text, from });
    }
  }
  return [...todo.values()];
}
async function translateTick() {
  const cfg = trCfg();
  if (!cfg.on || trState.running || Date.now() < trState.pausedUntil) return;
  trState.running = true;
  try {
    const todo = trPending();
    if (!todo.length) return;
    const key = cfg.provider === 'deepl' && cfg.keyEnc ? decrypt(cfg.keyEnc) : null;
    if (cfg.provider === 'deepl' && !key) { trState.lastError = 'Add your DeepL key, or switch to MyMemory'; return; }
    const save = (it, t, from) => { TR[it.h] = { t: t.slice(0, 3000), from: from || it.from, at: new Date().toISOString() }; trState.done++; };
    if (key) {
      // Up to 25 at a time, at most 2,000 per run.
      for (let i = 0; i < Math.min(todo.length, 2000); i += 25) {
        if (!trOn()) break;
        const batch = todo.slice(i, i + 25);
        const out = await translator.deepl(batch.map((x) => x.text), key);
        batch.forEach((it, k) => { if (out[k] && out[k].text) save(it, out[k].text, out[k].from); });
        trUsage().chars += batch.reduce((n, x) => n + x.text.length, 0);
        store.save();
      }
    } else {
      const limit = cfg.email ? 48000 : 4800; // MyMemory's daily allowance (a bit under, to be safe)
      for (const it of todo) {
        if (!trOn() || trCfg().provider === 'deepl') break;
        const u = trUsage();
        if (u.chars + it.text.length > limit) { trState.pausedUntil = new Date(u.day + 'T23:59:59Z').getTime() + 60_000; trState.lastError = null; break; }
        const t = await translator.myMemory(it.text, it.from, cfg.email || '');
        u.chars += it.text.length;
        save(it, t);
        store.save();
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    trState.lastError = null;
    // Keep the saved translations to ones still in use.
    if (Object.keys(TR).length > 30000) {
      const used = new Set(store.apps.flatMap((a) => appTexts(a).map(thash)));
      for (const h of Object.keys(TR)) if (!used.has(h)) delete TR[h];
      store.save();
    }
  } catch (e) {
    trState.lastError = e.message;
    if (e instanceof translator.QuotaError) trState.pausedUntil = Date.now() + (trCfg().provider === 'deepl' ? 6 * 3600_000 : 3 * 3600_000);
    else trState.pausedUntil = Date.now() + 10 * 60_000;
    console.error('Translating:', e.message);
  } finally { trState.running = false; }
}
setInterval(() => translateTick().catch(() => {}), 5 * 60_000).unref();
setTimeout(() => translateTick().catch(() => {}), 60_000).unref();

const realSize = (n) => (typeof n === 'number' && n > 0 && n < 2e10 ? n : null); // sources sometimes send nonsense sizes
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
    // vi is the version's real number for signing, so lists that skip some still sign the right one.
    extra.versions = (remote.kind === 'source' ? mergedVersions(a) : remote.versions || []).map((v, vi) => {
      const e = trOn() ? trText(v.notes) : null;
      return { vi, version: v.version, date: v.date, size: v.size, notes: ((e ? e.t : v.notes) || '').slice(0, 400), channel: v.channel, manualId: v.manualId || undefined };
    });
    // Beta versions are for you and admins only; everyone else (testers included) gets the rest.
    if (!isStaff(acc)) extra.versions = extra.versions.filter((v, i) => i === 0 || !/^(beta|alpha|pre)/i.test(String(v.channel || '')));
    extra.remoteScreens = remote.screenshots || [];
    if (isStaff(acc)) extra.remoteUrl = remote.kind === 'github' ? null : remote.url;
  }
  base.size = realSize(base.size);
  if (extra.versions) extra.versions = extra.versions.map((v) => ({ ...v, size: realSize(v.size) }));
  if (trOn()) {
    let from = null;
    for (const k of ['description', 'notes', 'subtitle']) {
      const e = trText(base[k]);
      if (e) { base[k] = e.t; from = from || e.from; }
    }
    if (from) extra.translatedFrom = translator.LANG_NAMES[from] || from.toUpperCase();
  }
  if (isStaff(acc)) return { ...base, ...extra };
  // Everyone else only gets what the library shows: no file names, storage details or owner bookkeeping.
  const { fileName, source, locked, manualVersions, descFromCaption, iconURL: _iu, published: _p, ...rest } = base;
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
    id: u.id, username: u.username, rank: u.rank || null, udid: u.udid || null, deviceName: u.deviceName || null,
    createdAt: u.createdAt, lastLogin: u.lastLogin || null, disabled: !!u.disabled, invite: u.invite || null,
    certCount: store.certs.filter((c) => c.ownerId === u.id).length,
    signedCount: store.signed.filter((s) => s.ownerId === u.id).length,
    signLimit: u.signLimit ?? null, signsToday: signsToday(u.id),
    recentSignins: store.securityLog.filter((e) => e.user === u.username && /^login/.test(e.type)).slice(-5).reverse(),
  };
}
function accountView(acc) {
  return { id: acc.id, username: acc.username, role: acc.role, rank: acc.role === 'owner' ? null : acc.rank || null, udid: acc.udid || null, deviceName: acc.deviceName || null };
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
const visibleApps = (acc) => {
  if (isStaff(acc)) return store.apps;
  const tester = isTester(acc);
  // "Testers only" apps show for testers (even while hidden from everyone else).
  return store.apps.filter((a) => !(a.remote && a.remote.missing) && (a.testersOnly ? tester : a.published));
};

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
  if (accountLocked(who, req)) return fail(res, 429, 'Too many wrong passwords — try again in 15 minutes');

  if ((!name || name === 'owner') && APP_PASSWORD && safeEqual(password, APP_PASSWORD)) {
    rl.ok();
    clearFails(req, 'owner');
    secEvent(req, 'login', 'owner', true);
    store.save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, OWNER()) });
  }
  const u = store.users.find((x) => x.username === name);
  if (u && !u.disabled && checkPassword(password, u)) {
    rl.ok();
    clearFails(req, name);
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
  if (inv.rank && RANKS.includes(inv.rank)) user.rank = inv.rank;
  store.users.push(user);
  inv.uses += 1;
  inv.usedBy = [...(inv.usedBy || []), name];
  secEvent(req, 'signup', name, true, `invite ${code}`);
  addAlert('owner', 'user', `👋 ${name} joined${user.rank ? ` as ${user.rank === 'admin' ? 'an admin ⭐' : 'a tester 🧪'}` : ''}`, `Used invite ${code}${inv.note ? ` (${inv.note})` : ''}.`, { userId: user.id });
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

// ----- proving an iPhone really is that iPhone -----
// When an iPhone answers the "read my device ID" profile, it signs the answer with a certificate Apple gave
// that iPhone. Checking that signature against Apple's root certificate proves the answer came from a real
// iPhone with that ID, not from someone who typed the ID in. Signing in with an iPhone needs this proof;
// without it, people sign in with their password instead (nothing breaks).
const APPLE_ROOT = process.env.APPLE_ROOT_PEM || path.join(DATA_DIR, 'apple-root-ca.pem');
let appleRootLoading = null;
async function appleRoot() {
  if (fs.existsSync(APPLE_ROOT)) return APPLE_ROOT;
  if (process.env.APPLE_ROOT_PEM) return null;
  if (!appleRootLoading) {
    appleRootLoading = (async () => {
      try {
        // Downloaded over HTTPS straight from Apple, once, then kept on the volume.
        const r = await fetch('https://www.apple.com/appleca/AppleIncRootCertificate.cer', { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const der = Buffer.from(await r.arrayBuffer());
        const pem = await run('openssl', ['x509', '-inform', 'DER', '-outform', 'PEM'], { input: der });
        const text = pem.stdout.toString();
        if (pem.code !== 0 || !text.includes('BEGIN CERTIFICATE')) throw new Error('not a certificate');
        const subj = await run('openssl', ['x509', '-noout', '-subject'], { input: Buffer.from(text) });
        if (!/Apple Root CA/.test(subj.stdout.toString())) throw new Error('not Apple Root CA');
        await fsp.writeFile(APPLE_ROOT, text);
        return APPLE_ROOT;
      } catch (e) {
        console.error("Couldn't get Apple's root certificate (iPhone sign-in will ask for passwords):", e.message);
        return null;
      } finally { appleRootLoading = null; }
    })();
  }
  return appleRootLoading;
}
setTimeout(() => appleRoot().catch(() => {}), 10_000);
// Returns the verified plist bytes, or null if the answer isn't signed by an Apple-issued iPhone certificate.
async function verifiedDeviceAnswer(buf) {
  const root = await appleRoot();
  if (!root) return null;
  const r = await run('openssl', ['cms', '-verify', '-inform', 'DER', '-CAfile', root, '-purpose', 'any', '-no_check_time'], { input: buf, timeout: 15000 });
  if (r.code !== 0 || !r.stdout.length) return null;
  return r.stdout;
}

route('POST', /^\/udid\/callback$/, async (req, res) => {
  const state = req.query.get('s') || '';
  const st = udidStates.get(state);
  const base = baseUrl(req);
  try {
    const buf = await readBody(req, 256 * 1024);
    // Use the signed contents when the signature checks out; otherwise read it, but don't trust it for sign-in.
    const verified = st ? await verifiedDeviceAnswer(buf).catch(() => null) : null;
    const body = verified || buf;
    const start = body.indexOf('<?xml');
    const end = body.indexOf('</plist>');
    if (!st || start < 0 || end < 0) throw new Error('bad');
    const data = plist.parse(body.subarray(start, end + 8));
    st.verified = !!verified;
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
    // Even with the Apple signature check, the owner account (which controls everything) only signs in with the password.
    if (holder === 'owner') { secEvent(req, 'login-udid', 'owner', false, 'iPhone sign-in is off for the owner'); store.save(); return redirect(res, '/?udid=ownerpw'); }
    if (!st.verified) { secEvent(req, 'login-udid', acc.username, false, "couldn't prove it was the real iPhone"); store.save(); return redirect(res, '/?udid=verify'); }
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
// Adding up every file is slow on a big server, so the totals are worked out at most once a minute
// (the app asks for them on every refresh). Two refreshes at once share the same count.
let storageMemo = null;
function storageTotals() {
  if (storageMemo && Date.now() - storageMemo.at < 60000) return storageMemo.p;
  const p = (async () => {
    const b = {
      library: (await dirSize(dirs.apps)) + (await dirSize(dirs.tweaks)),
      signed: await dirSize(dirs.signed),
      certs: await dirSize(dirs.certs),
      temp: (await dirSize(dirs.tmp)) + (await dirSize(dirs.work)) + (await dirSize(dirs.cache)) + (await dirSize(dirs.imports)),
    };
    return { used: await dirSize(DATA_DIR), breakdown: b };
  })();
  storageMemo = { at: Date.now(), p };
  p.catch(() => { storageMemo = null; });
  return p;
}
const storageUsed = async () => (await storageTotals()).used;
const storageBreakdown = async () => (await storageTotals()).breakdown;

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
    const since = s.restoredAt || s.signedAt; // a file put back from the iPhone app gets a fresh start
    const tooOld = maxAgeDays && Date.now() - new Date(since) >= maxAgeDays * 864e5;
    // Saved on GitHub: the copy here is just for a quick first install, so it goes after a few hours.
    const backedUp = s.gh && Date.now() - new Date(since) > 6 * 3600_000;
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
    collections: (() => {
      if (isStaff(acc)) return sortedCollections();
      // Only the apps this person can see, so hidden apps don't show up through a collection.
      const seen = new Set(visibleApps(acc).map((a) => a.id));
      return sortedCollections().map((c) => ({ ...c, appIds: c.appIds.filter((aid) => seen.has(aid)) })).filter((c) => c.appIds.length);
    })(),
    requests: (isStaff(acc) ? store.requests : store.requests.filter((r) => r.ownerId === acc.id)).slice(-200).reverse(),
    bugs: (isStaff(acc) ? store.data.bugs : store.data.bugs.filter((b) => b.ownerId === acc.id)).slice(-200).reverse(),
    installs: store.installLog.filter((l) => l.ownerId === acc.id).slice(-60).reverse(),
    tweaks: visibleTweaks(acc).map((t) => tweakView(t, acc)),
    alerts: store.alerts.filter((a) => a.ownerId === acc.id).slice(-60).reverse().map(alertView),
    favorites: store.favorites[acc.id] || [],
    mySignins: store.securityLog.filter((e) => e.user === acc.username && /^login|signout/.test(e.type)).slice(-8).reverse(),
    presets: store.presets.filter((p) => p.ownerId === acc.id).map(({ ownerId, ...p }) => p),
    imports: myImports(acc).map(importView),
    importsOnGithub: importsToGithubOn(),
    substrate: substrateView(),
    announcement: store.settings.announcement && store.settings.announcement.text ? store.settings.announcement : null,
    server: { baseUrl: base, https: base.startsWith('https://'), version: displayVersion(), codeVersion: VERSION },
  };
  if (isOwner(acc)) {
    const { github: _gh, telegram: _tg, translate: _tr, ...ownerSettings } = store.settings; // GitHub token and Telegram login never leave the server, even encrypted
    out.settings = { ...ownerSettings, translateOn: trOn() };
    out.users = store.users.map(userView);
    out.invites = store.invites;
    out.sources = store.sources.map(sourceView);
    out.github = ghView();
    out.telegram = tgView();
    out.securityLog = store.securityLog.slice(-200).reverse();
    out.server = { ...out.server, zsign: zsignVersion, passwordSet: !!APP_PASSWORD, storage: await storageUsed(), storageBreakdown: await storageBreakdown(), disk: diskInfo() };
  } else {
    out.settings = { maxSignedPerUser: store.settings.maxSignedPerUser, signedRetentionDays: store.settings.signedRetentionDays, signedOnGithub: signedToGithubOn(), signsPerDay: signLimitFor(acc), signsToday: signsToday(acc.id) };
    if (isAdmin(acc)) {
      // Admins help with the library and users, but never see the server's settings, GitHub or Telegram logins.
      out.settings.everyoneSignsPerDay = Number(store.settings.signsPerDay) || 0;
      out.users = store.users.map(userView);
      out.invites = store.invites.filter((i) => i.rank !== 'admin'); // admin invites stay with the owner
      out.sources = store.sources.map(sourceView);
      out.github = { connected: ghView().connected };
      out.telegram = { connected: tgView().connected };
      out.securityLog = store.securityLog.slice(-200).reverse();
    }
  }
  json(res, out);
});

// ----- uploads -----
route('POST', /^\/api\/upload$/, async (req, res, m, acc) => {
  const limit = isStaff(acc) ? MAX_UPLOAD : MAX_USER_UPLOAD;
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
  const { size, chunkSize, purpose } = await readJson(req);
  const total = Number(size);
  const limit = isStaff(acc) || purpose === 'ipa' ? MAX_UPLOAD : MAX_USER_UPLOAD; // anyone can import an .ipa to sign
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

// ----- translations -----
function translateView() {
  const c = trCfg();
  const pending = trPending().length;
  return {
    on: !!c.on, provider: c.provider || 'mymemory', email: c.email || '', hasKey: !!c.keyEnc,
    translated: Object.keys(TR).length, pending, usedToday: trUsage().chars,
    dailyLimit: c.provider === 'deepl' ? null : c.email ? 50000 : 5000,
    running: trState.running, lastError: trState.lastError,
    pausedUntil: trState.pausedUntil > Date.now() ? new Date(trState.pausedUntil).toISOString() : null,
  };
}
route('GET', /^\/api\/translate$/, (req, res) => json(res, { translate: translateView() }), 'owner');
route('PATCH', /^\/api\/translate$/, async (req, res) => {
  const b = await readJson(req);
  const c = store.settings.translate = { ...trCfg() };
  if (b.provider !== undefined) c.provider = b.provider === 'deepl' ? 'deepl' : 'mymemory';
  if (typeof b.email === 'string') {
    const e = b.email.trim();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return fail(res, 400, "That email doesn't look right");
    c.email = e.slice(0, 120);
  }
  let usage = null;
  if (typeof b.key === 'string') {
    const k = b.key.trim();
    if (!k) delete c.keyEnc;
    else {
      try { usage = await translator.deeplUsage(k); } catch (e) { return fail(res, 400, e.message === 'fetch failed' ? "Couldn't reach DeepL. Try again in a minute." : e.message); }
      c.keyEnc = encrypt(k);
      c.provider = 'deepl';
    }
  }
  if (b.on !== undefined) c.on = !!b.on;
  if (c.on && c.provider === 'deepl' && !c.keyEnc) return fail(res, 400, 'Add your DeepL key first, or pick MyMemory');
  store.save();
  trState.pausedUntil = 0;
  trState.lastError = null;
  if (c.on) setTimeout(() => translateTick().catch(() => {}), 500);
  json(res, { translate: translateView(), usage });
}, 'owner');
// Looks at every app again (after new apps, or apps it decided were already English).
route('POST', /^\/api\/translate\/recheck$/, (req, res) => {
  trState.checked.clear();
  trState.pausedUntil = 0;
  trState.lastError = null;
  translateTick().catch(() => {});
  json(res, { translate: translateView() });
}, 'owner');
route('POST', /^\/api\/translate\/run$/, (req, res) => {
  trState.pausedUntil = 0;
  translateTick().catch(() => {});
  json(res, { translate: translateView() });
}, 'owner');
// The original (untranslated) text of an app, for "Show original".
route('GET', /^\/api\/apps\/([a-f0-9]{16})\/original$/, (req, res, m, acc) => {
  const a = visibleApps(acc).find((x) => x.id === m[1]);
  if (!a) return fail(res, 404, 'App not found');
  json(res, { description: a.description || '', notes: a.notes || '', subtitle: a.subtitle || '' });
});

// ----- your imported .ipa files -----
// Turns an .ipa file on disk into one of this person's imported apps.
async function createImport(acc, file, fileName) {
  if (myImports(acc).length >= IMPORTS_PER_USER) { await rmQuiet(file); throw httpError(400, `You can keep ${IMPORTS_PER_USER} imported apps. Delete one you don't need first.`); }
  const meta = await inspectOrFail(file);
  const imp = {
    id: id(), ownerId: acc.id, name: meta.name || 'App', fileName: String(fileName || `${meta.name}.ipa`).slice(0, 200),
    bundleId: meta.bundleId || '', version: meta.version || '', build: meta.build || '', minOS: meta.minOS || '',
    extensions: meta.extensions, hasWatch: meta.hasWatch, size: meta.size, hasIcon: !!meta.icon, addedAt: new Date().toISOString(),
  };
  try {
    await fsp.rename(file, importFile(imp));
    if (meta.icon) await fsp.writeFile(importIconFile(imp), shrinkPng(meta.iconHd || meta.icon, 180));
  } catch (e) { await rmQuiet(file); await rmQuiet(importFile(imp)); throw e; }
  // Importing the same app and version again replaces the older copy.
  for (const old of myImports(acc).filter((x) => x.bundleId && x.bundleId === imp.bundleId && x.version === imp.version)) await removeImport(old);
  store.data.imports.unshift(imp);
  store.save();
  setTimeout(() => archiveImports().catch(() => {}), 5_000);
  return imp;
}
route('POST', /^\/api\/imports$/, async (req, res, m, acc) => {
  const { uploadId, fileName } = await readJson(req);
  const imp = await createImport(acc, tmpPath(uploadId, acc), fileName);
  json(res, { import: importView(imp) });
});
// Import straight from a download link (one at a time per person).
const linkImporting = new Set();
route('POST', /^\/api\/imports\/link$/, async (req, res, m, acc) => {
  const { url } = await readJson(req);
  const u = parseLink(url);
  if (linkImporting.has(acc.id)) return fail(res, 429, 'One download at a time. Wait for the first one to finish.');
  if (myImports(acc).length >= IMPORTS_PER_USER) return fail(res, 400, `You can keep ${IMPORTS_PER_USER} imported apps. Delete one you don't need first.`);
  const job = newJob(acc);
  job.title = `Importing from ${u.hostname}`;
  linkImporting.add(acc.id);
  json(res, { jobId: job.id });
  (async () => {
    try {
      const dest = await downloadToTmp(u, job);
      job.log.push('Reading app info…');
      const name = decodeURIComponent(path.basename(u.pathname)) || 'download.ipa';
      const imp = await createImport(acc, dest, name);
      job.result = { import: importView(imp) };
      job.status = 'done';
    } catch (e) {
      job.error = isNoSpace(e) ? storageFullMessage() : e.message;
      job.status = 'error';
    } finally { linkImporting.delete(acc.id); }
  })();
});
route('DELETE', /^\/api\/imports\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const imp = findImport(acc, 'imp_' + m[1]);
  if (!imp) return fail(res, 404, 'Already deleted');
  await removeImport(imp);
  json(res, { ok: true });
});
// The original file, for "Sign on this iPhone" in the iPhone app.
route('GET', /^\/api\/imports\/([a-f0-9]{16})\/file$/, async (req, res, m, acc) => {
  const imp = findImport(acc, 'imp_' + m[1]);
  if (!imp) return fail(res, 404, 'That app was deleted from your Apps tab');
  const name = `${imp.name}.ipa`;
  if (fs.existsSync(importFile(imp))) return serveFile(req, res, importFile(imp), { download: name });
  if (!imp.gh || !ghClient()) return fail(res, 410, 'That file is gone. Import it again.');
  return serveSignedFromGithub(req, res, { gh: imp.gh, name: imp.name });
});
route('GET', /^\/api\/imports\/([a-f0-9]{16})\/icon$/, (req, res, m, acc) => {
  const imp = findImport(acc, 'imp_' + m[1]);
  if (!imp || !imp.hasIcon) return fail(res, 404, 'No icon');
  return serveFile(req, res, importIconFile(imp), { type: 'image/png', cache: 'private, max-age=86400' });
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
  await saveAppIcon(appId, meta);
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
  await saveAppIcon(app.id, meta);
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
  try {
    // Redirects are followed by hand, so every hop is checked: a public link can't bounce the download
    // to something inside the server's own network.
    let next = u;
    for (let hop = 0; ; hop++) {
      await assertPublicHost(next);
      r = await fetch(next, { redirect: 'manual', signal: idle.signal });
      if (r.status < 300 || r.status >= 400 || !r.headers.get('location')) break;
      if (hop >= 6) throw new Error('That link redirects too many times');
      if (r.body) r.body.cancel().catch(() => {});
      next = new URL(r.headers.get('location'), next);
      if (!/^https?:$/.test(next.protocol)) throw new Error('That link leads somewhere that isn\'t a download');
    }
  } catch (e) { idle.done(); throw idle.stalled() ? idle.signal.reason : e; }
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

// Two links count as the same if they only differ in http/https, "www.", capital letters in the address,
// a trailing slash, the #part or tracking bits like ?utm_source=. Used to stop adding something twice.
function linkKey(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return String(url || '').trim().toLowerCase(); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid$|gclid$|ref$|si$|dl$)/i.test(k)).sort(([a], [b]) => a.localeCompare(b));
  let p = decodeURIComponent(u.pathname).replace(/\/+$/, '');
  if (host === 'github.com') p = p.toLowerCase().replace(/\.git$/, '').replace(/\/(releases|tags)(\/.*)?$/, '');
  const port = u.port && !['80', '443'].includes(u.port) ? `:${u.port}` : '';
  return `${host}${port}${p}${params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : ''}`;
}
// Links being added right now, so pasting the same link twice in a row (or in one batch) is caught too.
const addingLinks = new Set();

// Links the server downloads must be on the internet, not this server or the private network it runs on.
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(h) || !h.includes('.') && !h.includes(':')) return true;
  const v4 = h.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (h.includes(':')) return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return false;
}
function checkPublicUrl(u) {
  if (isPrivateHost(u.hostname)) throw httpError(400, "That link points inside your server's own network, which isn't allowed. Use a public link.");
}

// The same check, after looking the name up: a public-looking name that points at a private address is refused too.
async function assertPublicHost(u) {
  checkPublicUrl(u);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  let addrs = [];
  try { addrs = await dns.promises.lookup(host, { all: true }); } catch { throw httpError(400, `Couldn't find ${host}. Check the link.`); }
  if (addrs.some((a) => isPrivateHost(a.address))) throw httpError(400, "That link points inside your server's own network, which isn't allowed. Use a public link.");
}

function parseLink(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw httpError(400, 'Enter a valid link'); }
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'Link must start with http or https');
  checkPublicUrl(u);
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
}, 'staff');

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
}, 'staff');

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
        if (!app.customIcon) await saveAppIcon(app.id, meta);
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
}, 'staff');

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
  if (typeof b.testersOnly === 'boolean') app.testersOnly = b.testersOnly;
  if (typeof b.madeByMango === 'boolean') app.madeByMango = b.madeByMango;
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
}, 'staff');

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
  for (const suffix of ['.ipa', '.png', '-hd.png', '-custom.png']) await rmQuiet(path.join(dirs.apps, appId + suffix));
  await rmQuiet(path.join(dirs.apps, appId + '-shots'));
  for (const c of store.collections) c.appIds = c.appIds.filter((x) => x !== appId);
  return true;
}

route('DELETE', /^\/api\/apps\/([a-f0-9]{16})$/, async (req, res, m) => {
  if (!(await deleteApp(m[1], { exclude: true }))) return fail(res, 404, 'App not found');
  store.save();
  json(res, { ok: true });
}, 'staff');

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
}, 'staff');

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
}, 'staff');

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
}, 'staff');

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
}, 'staff');

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
    return { telegram: { ref: tgRefFor(r), msgId: r.msgId }, size: app.size, version: app.version };
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

// While a Telegram download is quiet, asks the helper whether Telegram told us to pause. A pause is
// shown as a countdown in the sign log (and doesn't count as a stall); returns a stop function.
function watchTelegramWait(job, idle, lastData) {
  let shown = -1;
  const t = setInterval(async () => {
    if (Date.now() - lastData() < 4000) return;
    let w = 0;
    try { w = Number((await tg.call('GET', '/wait')).wait) || 0; } catch { return; }
    if (w <= 0) return;
    idle.kick();
    if (!job) return;
    const line = `Telegram asked Mango to wait ${Math.floor(w / 60)}:${String(w % 60).padStart(2, '0')} before sending more of this file. It will carry on by itself…`;
    if (shown >= 0 && job.log[shown] && job.log[shown].startsWith('Telegram asked Mango to wait')) job.log[shown] = line;
    else { job.log.push(line); shown = job.log.length - 1; }
  }, 3000);
  t.unref && t.unref();
  return () => clearInterval(t);
}

async function fetchToFile(url, headers, dest, job, label, opts = {}) {
  if (job && label) job.log.push(label);
  if (job) job.cancellable = true;
  const idle = idleSignal(job && job.signal);
  let lastData = Date.now();
  const stopWatch = opts.telegram ? watchTelegramWait(job, idle, () => lastData) : () => {};
  let r;
  try { r = await fetchAuthed(url, headers, idle.signal); } catch (e) { idle.done(); stopWatch(); throw idle.stalled() ? idle.signal.reason : e; }
  if (!r.ok || !r.body) {
    idle.done(); stopWatch();
    // The Telegram helper explains what went wrong (e.g. the post was deleted, or a long rate limit).
    let why = '';
    if (opts.telegram) { try { why = (await r.json()).error || ''; } catch { /* */ } }
    throw new Error(why || `Download failed (HTTP ${r.status}). The link may have moved or expired.`);
  }
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
    lastData = Date.now();
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
    stopWatch();
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

// Only you and admins can sign or download beta versions (they're hidden from everyone else).
function checkVersionAllowed(app, acc, versionIndex) {
  if (!versionIndex || isStaff(acc) || !app.remote) return;
  const list = app.remote.kind === 'source' ? mergedVersions(app) : (app.remote.versions || []);
  const v = list[versionIndex];
  if (v && /^(beta|alpha|pre)/i.test(String(v.channel || ''))) throw httpError(403, "That version isn't available to you");
}

// An app's icon (180px, for the library) plus a sharper copy (up to 512px) for big pictures like Telegram posts.
async function saveAppIcon(appId, meta) {
  if (!meta || !meta.icon) return;
  await fsp.writeFile(path.join(dirs.apps, appId + '.png'), meta.icon);
  if (meta.iconHd && meta.iconHd.length > meta.icon.length) await fsp.writeFile(path.join(dirs.apps, appId + '-hd.png'), meta.iconHd);
  else await rmQuiet(path.join(dirs.apps, appId + '-hd.png'));
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
  const key = linkKey(u.toString());
  const have = store.apps.find((a) => a.remote && a.remote.url && linkKey(a.remote.url) === key);
  if (have) return fail(res, 409, `That link is already in your library as ${have.name}`);
  if (addingLinks.has(key)) return fail(res, 409, 'That link is already being added');
  addingLinks.add(key);
  const job = newJob(acc);
  job.title = `Adding from ${u.hostname}`;
  json(res, { jobId: job.id });
  (async () => {
    try {
      job.log.push(`Reading app info from ${u.hostname}…`);
      const meta = await inspectLink(u.toString(), null, job);
      const rec = newLibraryRecord(meta, { fileName: decodeURIComponent(path.basename(u.pathname)) || 'app.ipa', source: 'link', remote: { kind: 'link', url: u.toString() } });
      await saveAppIcon(rec.id, meta);
      store.apps.unshift(rec);
      store.save();
      job.result = { app: appView(rec, acc) };
      job.status = 'done';
    } catch (e) {
      job.error = isNoSpace(e) ? storageFullMessage() : e.message;
      job.status = 'error';
    } finally {
      addingLinks.delete(key);
    }
  })();
}, 'staff');

// ----- sources -----
async function fetchJson(url) {
  const text = await fetchText(url);
  try { return JSON.parse(text); } catch { throw new Error("That link isn't a source (it isn't JSON)"); }
}
async function fetchText(url, accept = 'application/json, text/html;q=0.9, */*;q=0.8') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    checkPublicUrl(new URL(url));
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Mango-Signer)', Accept: accept }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) throw new Error(`Couldn't load the source (HTTP ${r.status})`);
    const len = Number(r.headers.get('content-length')) || 0;
    if (len > 25 * 1048576) throw new Error('That source is too big');
    // Read it in pieces so a source without a size can't be endless.
    const chunks = [];
    let got = 0;
    for await (const c of r.body) {
      got += c.length;
      if (got > 25 * 1048576) { ctrl.abort(); throw new Error('That source is too big'); }
      chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length > 25 * 1048576) throw new Error('That source is too big');
    return text;
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
const sourceSkipsHave = (src) => (src.skipHave === undefined ? !['ghrepo', 'webpage'].includes(src.kind) : !!src.skipHave);
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
  // Newest first by when each release came out (GitHub's own list order isn't by date; it can follow tag names).
  const relDate = (r) => String(r.published_at || r.created_at || '');
  for (const rel of releases.slice().sort((x, y) => relDate(y).localeCompare(relDate(x)))) {
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
  let parsed;
  if (src.kind === 'ghrepo') parsed = await githubRepoSource(src);
  else if (src.kind === 'webpage') parsed = await webPageSource(src);
  else {
    const text = await fetchText(src.url);
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    if (data !== undefined) parsed = sources.parseSource(data);
    else if (/<(html|a|body)[\s>]/i.test(text)) { parsed = await webPageSource(src, text); src.kind = 'webpage'; } // a website's downloads page
    else throw new Error("That link isn't a source (it isn't JSON) or a web page with .ipa links");
  }
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
  for (const a of [...mine]) {
    // Leftovers from sources that didn't name their apps (they showed as "Untitled", once per version).
    // The same apps now come in under their real names, so these copies go.
    if (!seen.has(a.remote.key) && /^name:untitled(#\d+)?$/.test(a.remote.key || '') && !(a.manualVersions || []).length) {
      await deleteApp(a.id).catch(() => {});
      continue;
    }
    if (!seen.has(a.remote.key) && !(a.manualVersions || []).length) { if (!a.remote.missing) removed++; a.remote.missing = true; } else delete a.remote.missing;
  }
  Object.assign(src, {
    name: src.customName || parsed.name, iconURL: parsed.iconURL, subtitle: parsed.subtitle,
    appCount: parsed.apps.length, lastSync: new Date().toISOString(), lastError: null,
  });
  store.save();
  return { added, updated, removed, total: parsed.apps.length };
}

// ----- a website's downloads page as a source -----
// For apps whose developer posts the .ipa on their own site instead of GitHub. Every hour Mango reads the
// page, and any .ipa link it hasn't seen before is read (name, version, icon) and added as the newest
// version. Links it saw before are kept as older versions, even after the page drops them.
function ipaLinksIn(html, base) {
  const out = new Set();
  const add = (raw) => {
    try {
      const u = new URL(raw.replace(/&amp;/g, '&'), base);
      if (/^https?:$/.test(u.protocol) && /\.ipa$/i.test(decodeURIComponent(u.pathname))) { u.hash = ''; out.add(u.toString()); }
    } catch { /* not a link */ }
  };
  for (const m of html.matchAll(/(?:href|src|data-url|data-href)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>()]+?\.ipa\b(?:\?[^\s"'<>]*)?/gi)) add(m[0]);
  return [...out];
}
async function webPageSource(src, html) {
  if (html === undefined) html = await fetchText(src.url, 'text/html,*/*;q=0.8');
  const links = ipaLinksIn(html, src.url);
  if (!links.length) throw new Error("No .ipa download links on that page. (If the page only shows its links after you tap something, paste the .ipa link itself instead.)");
  const title = ((html.match(/<title[^>]*>([^<]{1,120})<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  src.seen = src.seen || {}; // variant -> [{ url, version, size, date, notes, name, bundleId, minOS }]
  const known = store.apps.filter((a) => a.remote && a.remote.sourceId === src.id);
  const fresh = new Map(); // variant -> meta of a newly found newest link (with icon)
  for (const url of links) {
    const fileName = decodeURIComponent(new URL(url).pathname.split('/').pop());
    const variant = ipaVariant(fileName);
    const list = (src.seen[variant] = src.seen[variant] || []);
    if (list.some((v) => v.url === url)) continue;
    let meta;
    try { meta = await inspectLink(url, null); } catch (e) { if (!list.length && links.length === 1) throw new Error(`Found ${fileName} on the page, but couldn't read it (${e.message})`); continue; }
    list.push({ url, version: meta.version || '', size: meta.size || 0, date: new Date().toISOString(), notes: '', name: meta.name, bundleId: meta.bundleId, minOS: meta.minOS || '' });
    list.sort((x, y) => versionCmp(y.version, x.version));
    if (list.length > 15) list.length = 15;
    if (list[0].url === url) fresh.set(variant, { assetId: url, name: meta.name, bundleId: meta.bundleId, version: meta.version, minOS: meta.minOS, icon: meta.icon || null });
  }
  const apps = Object.entries(src.seen).filter(([, list]) => list.length).map(([variant, list]) => {
    const key = `web:${variant}`;
    const app = known.find((a) => a.remote.key === key);
    const newest = list[0];
    const meta = fresh.get(variant) || (app && app.remote.inspected) || { assetId: newest.url, name: newest.name, bundleId: newest.bundleId, version: newest.version, minOS: newest.minOS };
    return {
      key, name: newest.name || title || new URL(src.url).hostname, bundleId: newest.bundleId || '', developer: new URL(src.url).hostname.replace(/^www\./, ''),
      subtitle: '', description: '', iconURL: '', tint: '', category: '', screenshots: [],
      versions: list.map(({ name: _n, bundleId: _b, ...v }) => v), _meta: meta,
    };
  });
  return { name: title || new URL(src.url).hostname, identifier: `web:${src.url}`, iconURL: '', subtitle: `Downloads page · ${new URL(src.url).hostname}`, apps };
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

const sourceView = ({ done: _d, failures: _f, seen: _s, ...src }) => ({ ...src, apps: store.apps.filter((a) => a.remote && a.remote.sourceId === src.id && !a.remote.missing).length });

route('POST', /^\/api\/sources$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  // People often paste links without https:// (github.com/owner/repo).
  if (typeof b.url === 'string' && !/^[a-z]+:\/\//i.test(b.url.trim()) && /^[\w.-]+\.[a-z]{2,}\//i.test(b.url.trim())) b.url = 'https://' + b.url.trim();
  let url;
  const repo = parseGithubRepo(b.url);
  try { if (!repo && /\.ipa$/i.test(new URL(b.url).pathname)) return fail(res, 400, "That's a link to one app, not a source. Add it with + › Add App › Or add from a link."); } catch { /* checked below */ }
  try { url = repo ? repo.url : sources.normalizeSourceUrl(b.url); } catch (e) { return fail(res, 400, e.message); }
  const same = store.sources.find((x) => x.kind !== 'telegram' && (linkKey(x.url) === linkKey(url)
    || (repo && x.repo && x.repo.owner.toLowerCase() === repo.owner.toLowerCase() && x.repo.repo.toLowerCase() === repo.repo.toLowerCase())));
  if (same) return fail(res, 409, `That ${repo ? 'GitHub repo' : 'source'} is already added (${same.name})`);
  if (addingLinks.has(linkKey(url))) return fail(res, 409, 'That source is already being added');
  const src = { id: id(), url, name: repo ? repo.repo : 'Source', showInLibrary: b.showInLibrary !== false, addedAt: new Date().toISOString() };
  if (repo) Object.assign(src, { kind: 'ghrepo', repo: { owner: repo.owner, repo: repo.repo } });
  // Nothing else checking: add it right away (and tell you if the link is wrong).
  if (!checkBusy()) {
    addingLinks.add(linkKey(url));
    try {
      store.sources.push(src);
      const result = await syncSource(src);
      return json(res, { source: sourceView(src), result });
    } catch (e) {
      store.sources.splice(store.sources.indexOf(src), 1);
      store.save();
      return fail(res, 400, e.message);
    } finally {
      addingLinks.delete(linkKey(url));
    }
  }
  // Another check is running: add it now and let its first check wait its turn.
  store.sources.push(src);
  store.save();
  const job = sourceCheck(src, acc);
  json(res, { source: sourceView(src), jobId: job.id, waitingFor: job.waitingFor || null });
}, 'staff');

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
}, 'staff');

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
  if (typeof b.pinned === 'boolean') src.pinned = b.pinned; // kept at the top of Settings
  if (src.kind === 'telegram') {
    if (b.options) src.options = cleanTgOptions(b.options, src.options);
    if (b.categoryId !== undefined) src.categoryId = ['__auto', '__none'].includes(b.categoryId) ? b.categoryId : b.categoryId && catExists(b.categoryId) ? b.categoryId : '__auto';
  }
  store.save();
  json(res, { source: sourceView(src) });
}, 'staff');

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
}, 'staff');

route('DELETE', /^\/api\/sources\/([a-f0-9]{16})$/, async (req, res, m) => {
  const i = store.sources.findIndex((x) => x.id === m[1]);
  if (i < 0) return fail(res, 404, 'Source not found');
  for (const a of store.apps.filter((x) => x.remote && x.remote.sourceId === m[1])) await deleteApp(a.id);
  store.sources.splice(i, 1);
  store.save();
  json(res, { ok: true });
}, 'staff');

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
      await saveAppIcon(rec.id, meta);
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
function countSign(uid, appId, name) {
  store.data.signLog = store.data.signLog || [];
  store.data.signLog.push({ at: new Date().toISOString(), uid, appId, ...(String(appId).startsWith('imp_') ? { name } : {}) });
  if (store.data.signLog.length > 6000) store.data.signLog.splice(0, store.data.signLog.length - 6000);
  const c = store.data.signCounts[uid];
  store.data.signCounts[uid] = c && c.day === today() ? { day: c.day, n: c.n + 1 } : { day: today(), n: 1 };
}
// 0 = no limit. A per-user limit (set on their page) wins over the everyone limit.
function signLimitFor(acc) {
  if (isOwner(acc) || isAdmin(acc)) return 0; // no daily limit for you and admins (testers have the normal limit)
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
    ...signs.slice(-60).map((x) => ({ at: x.at, kind: 'sign', text: `${nameOf(x.uid)} signed ${x.name ? `${x.name} (own file)` : appName(x.appId)}` })),
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
}, 'staff');

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
    extras: (t.extras || []).map((f) => ({ name: f.name, size: f.size })), toDocuments: t.toDocuments !== false,
    warnings: t.warnings || [], addedAt: t.addedAt, published: t.published !== false,
  };
  return isStaff(acc) ? base : { ...base, package: undefined };
}
const visibleTweaks = (acc) => store.tweaks.filter((t) => isStaff(acc) || t.published !== false);

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
}, 'staff');

// ----- settings files that go with a tweak -----
// Some tweaks read a settings file (a .plist, .json and so on). These are put inside the app next to the tweak
// when signing, and (with the MangoFiles helper) copied into the app's Documents folder the first time it opens.
const MAX_EXTRA_FILE = 5 * 1024 * 1024;
const MAX_EXTRA_FILES = 20;
const HELPER_DYLIB = path.join(__dirname, 'lib', 'MangoFiles.dylib');
const helperInstalled = () => fs.existsSync(HELPER_DYLIB);
const RESERVED_EXTRA = /^(info\.plist|embedded\.mobileprovision|pkginfo|coderesources|_codesignature|mangofiles|frameworks|plugins|sc_info|itunesmetadata\.plist)$/i;
function safeExtraName(n) {
  const name = path.basename(String(n || '').replace(/\\/g, '/')).replace(/[^\w.\-+ ()]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 100);
  if (!name) throw httpError(400, 'That file has no name');
  if (/\.(dylib|deb|ipa|app|appex|framework)$/i.test(name)) throw httpError(400, `${name} isn't a settings file. Add tweaks (.dylib or .deb) with the tweak button instead.`);
  if (RESERVED_EXTRA.test(name)) throw httpError(400, `${name} is one of the app's own files and can't be replaced`);
  return name;
}

route('POST', /^\/api\/tweaks\/([a-f0-9]{16})\/files$/, async (req, res, m, acc) => {
  const t = store.tweaks.find((x) => x.id === m[1]);
  const { uploadId, fileName } = await readJson(req);
  const file = tmpPath(uploadId, acc);
  try {
    if (!t) return fail(res, 404, 'Tweak not found');
    const name = safeExtraName(fileName);
    const st = await fsp.stat(file);
    if (st.size > MAX_EXTRA_FILE) return fail(res, 400, `${name} is too big (settings files can be up to 5 MB)`);
    t.extras = (t.extras || []).filter((f) => f.name.toLowerCase() !== name.toLowerCase());
    if (t.extras.length >= MAX_EXTRA_FILES) return fail(res, 400, `A tweak can have up to ${MAX_EXTRA_FILES} settings files`);
    const dir = path.join(dirs.tweaks, t.id, 'extras');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(file, path.join(dir, name));
    t.extras.push({ name, size: st.size });
    store.save();
    json(res, { tweak: tweakView(t, acc) });
  } catch (e) {
    fail(res, e.status || 400, e.message);
  } finally {
    await rmQuiet(file);
  }
}, 'staff');

route('DELETE', /^\/api\/tweaks\/([a-f0-9]{16})\/files\/([^/]+)$/, async (req, res, m, acc) => {
  const t = store.tweaks.find((x) => x.id === m[1]);
  if (!t) return fail(res, 404, 'Tweak not found');
  const name = decodeURIComponent(m[2]);
  const f = (t.extras || []).find((x) => x.name === name);
  if (!f) return fail(res, 404, 'File not found');
  t.extras = t.extras.filter((x) => x !== f);
  store.save();
  await rmQuiet(path.join(dirs.tweaks, t.id, 'extras', f.name));
  json(res, { tweak: tweakView(t, acc) });
}, 'staff');

route('GET', /^\/api\/tweaks\/([a-f0-9]{16})\/files\/([^/]+)$/, async (req, res, m) => {
  const t = store.tweaks.find((x) => x.id === m[1]);
  const name = decodeURIComponent(m[2]);
  const f = t && (t.extras || []).find((x) => x.name === name);
  if (!f) return fail(res, 404, 'File not found');
  const buf = await fsp.readFile(path.join(dirs.tweaks, t.id, 'extras', f.name));
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${f.name.replace(/[^\w.\-]/g, '_')}"`, 'Content-Length': buf.length });
  res.end(buf);
}, 'staff');

route('PATCH', /^\/api\/tweaks\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const t = store.tweaks.find((x) => x.id === m[1]);
  if (!t) return fail(res, 404, 'Tweak not found');
  const b = await readJson(req);
  if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim().slice(0, 80);
  if (typeof b.description === 'string') t.description = b.description.slice(0, 600);
  if (typeof b.published === 'boolean') t.published = b.published;
  if (typeof b.toDocuments === 'boolean') t.toDocuments = b.toDocuments;
  store.save();
  json(res, { tweak: tweakView(t, acc) });
}, 'staff');

route('DELETE', /^\/api\/tweaks\/([a-f0-9]{16})$/, async (req, res, m) => {
  const i = store.tweaks.findIndex((x) => x.id === m[1]);
  if (i < 0) return fail(res, 404, 'Tweak not found');
  store.tweaks.splice(i, 1);
  for (const a of store.apps) if (a.signDefaults && Array.isArray(a.signDefaults.tweakIds)) a.signDefaults.tweakIds = a.signDefaults.tweakIds.filter((x) => x !== m[1]);
  for (const p of store.presets) if (p.options && Array.isArray(p.options.tweakIds)) p.options.tweakIds = p.options.tweakIds.filter((x) => x !== m[1]);
  store.save();
  await fsp.rm(path.join(dirs.tweaks, m[1]), { recursive: true, force: true });
  json(res, { ok: true });
}, 'staff');

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
}, 'staff');

route('DELETE', /^\/api\/substrate$/, async (req, res) => {
  await fsp.rm(path.dirname(SUBSTRATE_DIR()), { recursive: true, force: true });
  delete store.settings.substrate;
  for (const t of store.tweaks) t.warnings = tweakWarnings(t.files, t.extra);
  store.save();
  json(res, { substrate: substrateView() });
}, 'staff');

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
// In order: your keyword rules; the App Store (by bundle ID); apps you already sorted that look the same
// (same bundle ID, or the same name with "++", "Plus", versions… taken off); built-in words (emulator,
// IPTV, VPN…); the App Store by name; and finally what most apps from the same source or channel are in.
const AS_TTL = 30 * 864e5;
// opts.cachedOnly: only use what's saved (no waiting on Apple). opts.fresh: ask again about apps that weren't
// found before. Throws { busy } when Apple says slow down, so a "try later" is never saved as "not found".
async function appStoreInfo(app, opts = {}) {
  const key = (app.bundleId || '').toLowerCase() || 'name:' + String(app.originalName || app.name).toLowerCase();
  const cache = (store.data.appStoreCache = store.data.appStoreCache || {});
  const hit = cache[key];
  if (hit && hit.data && Date.now() - hit.at < AS_TTL) return hit.data;
  if (hit && !hit.data && !opts.fresh && Date.now() - hit.at < 3 * 864e5) return null;
  if (opts.cachedOnly) return hit && hit.data ? hit.data : undefined;
  const data = await appstore.lookup({ bundleId: app.bundleId, name: app.originalName || app.name });
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

// Words that give an app away, for apps the App Store doesn't know (mods, emulators, IPTV…).
const CATEGORY_WORDS = [
  ['Emulators', /\b(emulators?|emu|retroarch|ppsspp|provenance|melon ?ds|citra|lime3ds|azahar|dolphin(ios)?|flycast|mame|dosbox|gba4ios|nds4ios|gbc4ios|pcsx\w*|aethersx2|nethersx2|play!|folium|manic ?emu|sudachi|yuzu|ryujinx|mupen\w*|snes\w*|nes ?emu|ps1|psx|n64|nds|gba|gbc|3ds|psp)\b/i],
  ['Music & Video', /\b(iptv|ott|movies?|films?|cinema|anime|cartoons?|netflix|youtube|yt ?music|spotify|soundcloud|deezer|tidal|music|radio|podcasts?|hbo|hulu|disney\+?|crunchyroll|twitch|plex|jellyfin|kodi|vlc|infuse|stremio|streaming|live ?tv|tv ?shows?|sports? ?tv|video ?player|media ?player)\b/i],
  ['Social', /\b(instagram|insta|whatsapp|telegram|facebook|messenger|snapchat|tiktok|twitter|threads|reddit|discord|bereal|pinterest|tumblr|signal|wechat|viber|kik|tinder|bumble|hinge|grindr)\b/i],
  ['Games', /\b(games?|minecraft|roblox|pubg|fortnite|brawl ?stars|clash|subway ?surfers|geometry ?dash|gta|grand theft|call of duty|among us|free ?fire|pokemon|pok[eé]mon|genshin|candy ?crush|8 ?ball|chess|solitaire|sudoku|racing|shooter|rpg)\b/i],
  ['Utilities', /\b(vpn|proxy|adblock\w*|ad ?blocker|dns|ssh|terminal|torrent|downloader|file ?manager|filza|browser|keyboard|scanner|calculator|clipboard|shortcuts?|stikdebug|stik|jit|sidestore|altstore|esign|feather|ksign|gbox|scarlet|trollstore|appdb|livecontainer)\b/i],
];
// Reading what an app is about (its name, subtitle and description, in English when translated) when nothing
// else knows. Each word found scores points for a kind of app; the best kind you have a category for wins.
const CONTENT_KINDS = [
  { names: ['Emulators', 'Emulator', 'Retro'], words: /\b(emulat\w*|rom|roms|retro ?games?|console|bios|nintendo|playstation|sega|arcade|game ?boy|ds|psp|n64)\b/gi, w: 3 },
  { names: ['Games', 'Game', 'Gaming'], words: /\b(games?|gameplay|play(ers?|ing)?|levels?|puzzles?|racing|shooter|multiplayer|battle|quests?|rpg|mmo|arcade|casual|strategy|adventure|zombies?|coins|gems|unlimited (money|coins|gems)|mod menu|god mode|aimbot|esp)\b/gi, w: 1 },
  { names: ['Music & Video', 'Music', 'Video', 'Streaming', 'Entertainment', 'Movies & TV', 'TV'], words: /\b(music|songs?|playlists?|albums?|artists?|audio|radio|podcasts?|videos?|movies?|films?|series|episodes?|tv|stream(ing|s)?|watch|anime|player|lyrics|karaoke|offline playback|background play)\b/gi, w: 1 },
  { names: ['Social', 'Social Networking', 'Chat', 'Messaging'], words: /\b(social|chat(s|ting)?|messag(e|es|ing)|friends?|followers?|posts?|stories|reels|feed|profile|dating|match(es)?|community|comments?|likes?|share photos)\b/gi, w: 1 },
  { names: ['Photo & Video', 'Photography', 'Photos', 'Camera', 'Editing'], words: /\b(photos?|pictures?|camera|selfies?|filters?|edit(or|ing)?|collage|retouch|beauty|stickers?|wallpapers?|video editor|presets?|ai art|face ?swap)\b/gi, w: 1 },
  { names: ['Utilities', 'Tools', 'Utility'], words: /\b(utility|utilities|tools?|vpn|proxy|cleaner|battery|scanner|qr|files?|file manager|downloader|clipboard|widgets?|keyboard|browser|ad ?block\w*|backup|transfer|speed test|tweak(s|ed)?|jailbreak|sideload\w*|sign(ing|er)|certificate)\b/gi, w: 1 },
  { names: ['Productivity', 'Business', 'Work'], words: /\b(productivity|notes?|tasks?|to-?do|calendar|reminders?|documents?|pdf|office|spreadsheet|email|mail|scan documents|business|meetings?|focus|planner)\b/gi, w: 1 },
  { names: ['Education', 'Learning', 'Reference'], words: /\b(learn(ing)?|education|study|students?|courses?|lessons?|language|translate|dictionary|math|quiz|school|exam|flashcards?)\b/gi, w: 1 },
  { names: ['Health & Fitness', 'Health', 'Fitness', 'Sports'], words: /\b(workouts?|fitness|gym|exercise|health|steps?|calories|diet|meditation|sleep|yoga|running|training|sports?|football|soccer|nba|nfl|scores)\b/gi, w: 1 },
  { names: ['Shopping', 'Food & Drink', 'Lifestyle'], words: /\b(shop(ping)?|store|deals?|coupons?|orders?|delivery|food|restaurants?|recipes?|fashion|home|lifestyle)\b/gi, w: 1 },
  { names: ['Finance', 'Crypto'], words: /\b(finance|bank(ing)?|money|budget|crypto|bitcoin|wallet|stocks?|trading|invest\w*|payments?)\b/gi, w: 1 },
  { names: ['Books', 'Reading', 'News', 'Comics'], words: /\b(books?|read(er|ing)?|novels?|manga|comics?|webtoons?|ebooks?|news|articles?|magazines?)\b/gi, w: 1 },
  { names: ['Navigation', 'Travel', 'Maps'], words: /\b(maps?|navigation|gps|directions|travel|trips?|flights?|hotels?|location)\b/gi, w: 1 },
];
function contentCategory(app) {
  const desc = trShown(app.description) || '';
  const text = `${app.name} ${app.name} ${app.name} ${app.subtitle || ''} ${app.subtitle || ''} ${desc.slice(0, 1500)} ${(trShown(app.notes) || '').slice(0, 300)}`;
  const scored = CONTENT_KINDS.map((k) => {
    const hits = text.match(k.words) || [];
    return { k, score: hits.length * k.w, hit: hits[0] };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  // Only categories you have (no new ones from this): the best-scoring kind with a matching category.
  for (const x of scored) {
    for (const n of x.k.names) {
      const mine = existingCategoryNamed(n);
      if (mine) return { categoryId: mine.id, hit: String(x.hit).toLowerCase(), kind: n };
    }
  }
  return null;
}
// The last resort, so nothing stays uncategorized: your "Other" category (made if you don't have one).
function otherCategory(localOnly) {
  const mine = ['Other', 'Others', 'Misc', 'Miscellaneous', 'More'].map(existingCategoryNamed).find(Boolean);
  if (mine) return mine.id;
  return localOnly ? 'new:Other' : categoryIdFor('Other');
}

// Your category for one of the names above: one you already have with that name, or a new one.
function existingCategoryNamed(name) {
  const want = name.toLowerCase();
  return store.categories.find((c) => c.name.toLowerCase() === want)
    || store.categories.find((c) => { const m = sources.categoryFor(c.name); return m && m.name.toLowerCase() === want; });
}
function categoryNamed(name) { const mine = existingCategoryNamed(name); return mine ? mine.id : categoryIdFor(name); }
function categoryGuessNamed(name) { const mine = existingCategoryNamed(name); return mine ? mine.id : `new:${name}`; }

// Lookalikes: built from apps that already have a category, rebuilt at most every few seconds.
const SIMILAR_STOP = new Set(['the', 'app', 'apps', 'pro', 'free', 'lite', 'plus', 'super', 'mango', 'ios', 'iphone', 'ipad', 'mobile', 'my', 'new', 'best', 'mod', 'hack', 'tweaked', 'beta', 'premium', 'official']);
function nameKey(n) {
  return String(n || '').toLowerCase()
    .replace(/[\[(].*?[\])]/g, ' ')
    .replace(/\+\+|\+/g, ' ')
    .replace(/\b(v?\d+(\.\d+)*|plus|pro|premium|lite|beta|tweaked|hack(ed|s)?|mod(ded)?|ipa|cracked|unlocked|no ads|ad ?free|by \w+)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
let similarIndex = null;
function similarIdx() {
  if (similarIndex && Date.now() - similarIndex.at < 5000) return similarIndex;
  const byBundle = new Map(), byName = new Map(), byWord = new Map(), bySource = new Map();
  const add = (m, k, app) => { if (!k) return; const e = m.get(k) || []; e.push(app); m.set(k, e); };
  for (const a of store.apps) {
    if (!a.categoryId || !catExists(a.categoryId)) continue;
    add(byBundle, normBid(a.bundleId), a);
    for (const n of new Set([nameKey(a.name), nameKey(a.originalName)])) {
      add(byName, n, a);
      const w = n.split(' ')[0];
      if (w && w.length >= 4 && !SIMILAR_STOP.has(w)) add(byWord, w, a);
    }
    if (a.remote && a.remote.sourceId) add(bySource, a.remote.sourceId, a);
  }
  similarIndex = { at: Date.now(), byBundle, byName, byWord, bySource };
  return similarIndex;
}
// One category every match agrees on (or none if they disagree).
function agreed(list, self) {
  const others = (list || []).filter((a) => a.id !== self.id);
  if (!others.length) return null;
  const cats = new Set(others.map((a) => a.categoryId));
  return cats.size === 1 ? { categoryId: others[0].categoryId, like: others[0].name } : null;
}
function similarCategory(app) {
  const idx = similarIdx();
  const bid = normBid(app.bundleId);
  const hit = (bid && agreed(idx.byBundle.get(bid), app));
  if (hit) return hit;
  for (const n of new Set([nameKey(app.name), nameKey(app.originalName)])) {
    const h = n && agreed(idx.byName.get(n), app);
    if (h) return h;
  }
  for (const n of new Set([nameKey(app.name), nameKey(app.originalName)])) {
    const w = n.split(' ')[0];
    const h = w && w.length >= 4 && !SIMILAR_STOP.has(w) && agreed(idx.byWord.get(w), app);
    if (h) return h;
  }
  return null;
}
// Most apps from the same source or channel are in one category: probably this one too.
function sourceCategory(app) {
  const sid = app.remote && app.remote.sourceId;
  const list = sid ? (similarIdx().bySource.get(sid) || []).filter((a) => a.id !== app.id) : [];
  if (list.length < 3) return null;
  const counts = new Map();
  for (const a of list) counts.set(a.categoryId, (counts.get(a.categoryId) || 0) + 1);
  const [cid, n] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
  return n / list.length >= 0.7 ? { categoryId: cid, share: Math.round((100 * n) / list.length) } : null;
}
// Like categoryIdFor, but never makes a category: a missing one comes back as "new:Name" (for guesses).
function categoryGuessFor(genre) {
  const c = sources.categoryFor(genre);
  if (!c) return null;
  const mine = store.categories.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
  return mine ? mine.id : `new:${c.name}`;
}
const catName = (cid) => (store.categories.find((c) => c.id === cid) || {}).name || '?';
const HOW_LABEL = { rule: 'your rule', appstore: 'App Store', similar: 'like', keyword: 'name', content: 'description', source: 'same source', other: 'Other' };

// opts.localOnly: no App Store lookups (instant guesses). opts.fresh: ask Apple again about "not found" apps.
// opts.throwBusy: let "Apple says slow down" through so a batch can wait and retry.
async function autoCategory(app, extraText = '', opts = {}) {
  const text = `${app.name} ${app.originalName || ''} ${app.fileName || ''} ${extraText}`;
  const byRule = ruleCategory(text);
  let info = await appStoreInfo(app, { cachedOnly: true });
  if (byRule) return { categoryId: byRule, info, how: 'rule', why: HOW_LABEL.rule };
  const fromGenre = (g) => (opts.localOnly ? categoryGuessFor(g) : categoryIdFor(g));
  if (info && info.genre && info.matchedBy === 'bundleId') return { categoryId: fromGenre(info.genre), info, how: 'appstore', why: `App Store: ${info.genre}` };
  const sim = similarCategory(app);
  if (sim) return { categoryId: sim.categoryId, info, how: 'similar', why: `like ${sim.like}` };
  const name = `${app.name} ${app.originalName || ''} ${app.fileName || ''} ${app.bundleId || ''}`;
  const word = CATEGORY_WORDS.find(([, re]) => re.test(name)) || CATEGORY_WORDS.find(([, re]) => re.test(String(extraText).slice(0, 400)));
  if (word) return { categoryId: opts.localOnly ? categoryGuessNamed(word[0]) : categoryNamed(word[0]), info, how: 'keyword', why: `name says ${word[0]}` };
  if (info === undefined && !opts.localOnly) {
    try { info = await appStoreInfo(app, { fresh: opts.fresh }); } catch (e) { if (opts.throwBusy) throw e; info = null; }
  }
  if (info && info.genre) return { categoryId: fromGenre(info.genre), info, how: 'appstore', why: `App Store: ${info.genre}` };
  const byText = contentCategory(app);
  if (byText) return { categoryId: byText.categoryId, info, how: 'content', why: `description mentions "${byText.hit}"` };
  const src = sourceCategory(app);
  if (src) return { categoryId: src.categoryId, info, how: 'source', why: `${src.share}% of its source` };
  if (opts.mustPlace) return { categoryId: otherCategory(opts.localOnly), info, how: 'other', why: 'nothing else matched' };
  return { categoryId: null, info, how: null };
}

const AUTO_SORT_V = 2; // bump when auto-sort gets smarter, so it looks at everything it placed before again
route('POST', /^\/api\/apps\/auto-categorize$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  // "all": re-sort every app (except ones you put in a category yourself).
  // Otherwise: every app without a category, plus every app an older version of auto-sort placed (or skipped).
  // Apps this version places are marked, so later runs leave them alone.
  const mine = (a) => (a.locked || []).includes('categoryId');
  const list = store.apps.filter((a) => (Array.isArray(b.ids) ? b.ids.includes(a.id) : true)
    && (b.all ? !mine(a) : (!a.categoryId || !catExists(a.categoryId) || (!mine(a) && a.autoSortV !== AUTO_SORT_V))));
  const job = newJob(acc);
  job.title = `Sorting ${list.length} app${list.length === 1 ? '' : 's'}`;
  job.cancellable = true;
  json(res, { jobId: job.id, count: list.length });
  (async () => {
    const result = { sorted: 0, byRule: 0, byAppStore: 0, bySimilar: 0, byKeyword: 0, byContent: 0, bySource: 0, toOther: 0, unknown: 0, filled: 0 };
    const started = Date.now();
    for (const [i, app] of list.entries()) {
      if (job.cancelled) break;
      job.progress = list.length ? i / list.length : 1;
      let r;
      for (let tries = 0; ; tries++) {
        // Every app ends up somewhere: "Other" when nothing fits (unless you turned that off).
        try { r = await autoCategory(app, app.notes || '', { fresh: b.fresh !== false, throwBusy: tries < 4, mustPlace: b.leaveUnsure !== true }); break; } catch (e) {
          if (!e.busy) throw e;
          job.log.push(`⏳ The App Store asked Mango to slow down. Waiting a minute, then carrying on… (${i} of ${list.length} done)`);
          await new Promise((x) => setTimeout(x, Number(process.env.ITUNES_BUSY_WAIT_MS || 60000)));
          if (job.cancelled) break;
        }
      }
      if (!r) break;
      if (r.categoryId) app.autoSortV = AUTO_SORT_V;
      if (r.categoryId && r.categoryId !== app.categoryId) {
        app.categoryId = r.categoryId;
        result.sorted++;
        result[{ rule: 'byRule', appstore: 'byAppStore', similar: 'bySimilar', keyword: 'byKeyword', content: 'byContent', source: 'bySource', other: 'toOther' }[r.how]]++;
        job.log.push(`${app.name} → ${catName(r.categoryId)} (${r.why})`);
      } else if (!r.categoryId) { result.unknown++; job.log.push(`${app.name}: no idea`); }
      // Fill in blanks from the App Store while we're at it.
      if (r.info && b.fill !== false) {
        let filled = false;
        if (!app.developer && r.info.developer && !(app.locked || []).includes('developer')) { app.developer = r.info.developer.slice(0, 80); filled = true; }
        if (!app.description && r.info.description && !(app.locked || []).includes('description')) { app.description = r.info.description.slice(0, 1500); filled = true; }
        if (app.remote && !(app.remote.screenshots || []).length && r.info.screenshots.length && !(app.screenshots || []).length) { app.remote.screenshots = r.info.screenshots; filled = true; }
        if (filled) result.filled++;
      }
      if (i % 10 === 9) {
        store.save();
        const left = Math.round(((Date.now() - started) / (i + 1)) * (list.length - i - 1) / 60000);
        if (left >= 2) job.log.push(`About ${left} minutes left. You can close this, it keeps going.`);
      }
    }
    store.save();
    job.progress = 1;
    job.result = result;
    job.status = 'done';
  })().catch((e) => { job.error = e.message; job.status = 'error'; });
}, 'staff');

// Instant best guesses for apps (no App Store waiting), for sorting by hand.
route('POST', /^\/api\/apps\/category-guesses$/, async (req, res) => {
  const b = await readJson(req);
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 3000) : store.apps.filter((a) => !a.categoryId || !catExists(a.categoryId)).map((a) => a.id);
  const guesses = {};
  for (const aid of ids) {
    const app = store.apps.find((a) => a.id === aid);
    if (!app) continue;
    const r = await autoCategory(app, app.notes || '', { localOnly: true });
    let cid = r.categoryId, suggest = null;
    if (cid && cid.startsWith('new:')) { suggest = cid.slice(4); cid = null; }
    if (cid || suggest) guesses[aid] = { categoryId: cid || null, newCategory: suggest, why: r.why || '' };
  }
  json(res, { guesses });
}, 'staff');

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
  // Newest first. When every version is a number, sort by it; otherwise sort by date (a GitHub repo's older
  // releases go by their tag, like "build-6", while the newest goes by the app's real version, like "0.1.8",
  // and those can't be compared). Your own uploads go in front of the first one they're newer than.
  const numeric = src.every((v) => /^\s*v?\d/i.test(String(v.version || '')));
  const byDate = (x, y) => String(y.date || '').localeCompare(String(x.date || ''));
  const out = src.slice().sort(numeric ? (x, y) => versionCmp(y.version, x.version) || byDate(x, y) : byDate);
  for (const m of man.sort((x, y) => versionCmp(y.version, x.version))) {
    const at = out.findIndex((v) => versionCmp(m.version, v.version) > 0);
    if (at < 0) out.push(m); else out.splice(at, 0, m);
  }
  return out;
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
}, 'staff');

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
}, 'staff');

// ----- Telegram channels -----
// Mango signs in to Telegram as you (through lib/telegram_helper.py) and watches channels for new .ipa posts.
// Files stay on Telegram (or get copied to your GitHub storage) — nothing is kept on this server.
const tg = telegram.createHelper();

// Checks which of a channel's apps still have their post, 200 at a time (Telegram's limit per call).
// Apps whose post is gone get marked removed; apps whose post is back get unmarked.
// A batch that fails to check is left alone, so a hiccup never marks apps as removed.
// limit = only the newest that many posts (regular checks); no limit = every app (a weekly sweep, and before "Delete removed apps").
async function tgMarkRemoved(src, job = null, limit = 0) {
  let linked = store.apps.filter((a) => a.remote && a.remote.kind === 'telegram' && a.remote.sourceId === src.id && !a.remote.ghAssetId);
  if (limit) linked = linked.sort((a, b) => b.remote.msgId - a.remote.msgId).slice(0, limit);
  let newlyGone = 0;
  for (let i = 0; i < linked.length; i += 200) {
    const batch = linked.slice(i, i + 200);
    let exists;
    try { ({ exists } = await tgTry(job, () => tg.exists(tgRef(src), batch.map((a) => a.remote.msgId)), src)); } catch { continue; }
    if (job) job.counter = { label: 'apps checked', done: Math.min(linked.length, i + 200), total: linked.length };
    if (i + 200 < linked.length) await new Promise((r) => setTimeout(r, 1500)); // go easy on Telegram's limits
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
// How to point the helper at a channel. After the first lookup Mango keeps the channel's id + key, so it
// never has to look the @username up again (Telegram only allows a few of those lookups a day, and
// running out made every check sit and wait).
// (The key is a 64-bit number: it's sent as text, because JSON numbers would round it and break it.)
const tgRef = (src) => (src && src.peerKey ? `peer:${src.peerKey}` : src && src.ref);
// 1.9.0 saved rounded keys (field "peer"), which Telegram rejects as "private". Drop them; they're looked up again.
{ let fixed = 0; for (const src of store.sources) if (src.peer !== undefined) { delete src.peer; fixed++; } if (fixed) store.save(); }
// 1.14.1: the full "still posted?" check went weekly. Count the last one as a full one, so it doesn't all run right after updating.
for (const src of store.sources) if (src.kind === 'telegram' && !src.removedFullAt && src.removedCheckAt) src.removedFullAt = src.removedCheckAt;
const tgRefFor = (remote) => { const src = store.sources.find((x) => x.id === remote.sourceId); return src ? tgRef(src) : remote.ref; };
async function ensurePeer(src, job) {
  if (src.peerKey) return;
  const ch = await tgTry(job, () => tg.channel(src.ref));
  if (ch && ch.id && typeof ch.access_hash === 'string' && /^-?\d+$/.test(ch.access_hash)) { src.peerKey = `${ch.id}:${ch.access_hash}`; store.save(); }
}
// Runs a Telegram request, and if Telegram says "slow down, wait N seconds", says so in the log, waits,
// and tries again (up to 3 times, and only for waits up to 10 minutes). Stop still works while waiting.
async function tgTry(job, fn, src = null) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      // The saved channel key stopped working: forget it and go back to the @username once.
      if (src && src.peerKey && (e.status === 403 || e.status === 404) && attempt === 0) {
        delete src.peerKey;
        store.save();
        if (job) job.log.push('Looking the channel up again…');
        continue;
      }
      if (!e.wait || e.wait > 600 || attempt >= 3 || (job && job.cancelled)) {
        if (e.wait) throw new Error(`Telegram asked Mango to wait ${fmtWait(e.wait)} before asking again. It'll try again on the next check.`);
        throw e;
      }
      if (job) job.log.push(`⏸ Telegram asked to slow down, so waiting ${fmtWait(e.wait)} (it limits how fast an account can ask)…`);
      const until = Date.now() + (e.wait + 1) * 1000;
      while (Date.now() < until && !(job && job.cancelled)) {
        await new Promise((r) => setTimeout(r, 1000));
        if (job) job.counter = { label: 'seconds left to wait', done: Math.ceil((until - Date.now()) / 1000), total: null };
      }
      if (job) job.counter = null;
    }
  }
}
const fmtWait = (sec) => (sec >= 120 ? `${Math.round(sec / 60)} minutes` : `${sec} seconds`);
function tgCreds(extra = {}) {
  const t = tgSettings();
  return { apiId: decrypt(t.apiIdEnc), apiHash: decrypt(t.apiHashEnc), session: t.sessionEnc ? decrypt(t.sessionEnc) : '', ...extra };
}
// A saved login that can't be unlocked (the server's secret key changed) must never stop the server from starting.
if (tgReady()) {
  try { tg.start(tgCreds()).catch((e) => console.error('Telegram:', e.message)); } catch {
    console.error("Telegram: the saved sign-in can't be read anymore (the server's secret key changed?). Connect Telegram again in Settings.");
  }
}

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
  const f = await tg.file(tgRef(src), post.id);
  return ipa.inspect({ url: f.url, headers: f.headers });
}
// "Mortal Kombat - KamoHacks [7.4.1].ipa" and "...[7.4.0].ipa" are the same app: used to skip older reposts without reading them.
const fileKey = (name) => String(name || '').toLowerCase().replace(/\.ipa$/, '').replace(/[\[(].*?[\])]/g, ' ').replace(/v?\d+(\.\d+)+/g, ' ').replace(/[^a-z0-9]+/g, '');

async function tgImportPost(src, post, job, preMeta) {
  const opts = src.options;
  const f = await tg.file(tgRef(src), post.id);
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
    if (!app.customIcon) await saveAppIcon(app.id, meta);
    if (old && old.screenshots) remote.screenshots = old.screenshots;
    if ((!app.categoryId || !catExists(app.categoryId)) && !locked.has('categoryId') && (!src.categoryId || src.categoryId === '__auto')) {
      const r = await autoCategory(app, post.text, { mustPlace: true });
      if (r.categoryId) { app.categoryId = r.categoryId; app.autoSortV = AUTO_SORT_V; }
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
    const r = await autoCategory(rec, post.text, { mustPlace: true });
    rec.categoryId = r.categoryId;
    if (r.categoryId) rec.autoSortV = AUTO_SORT_V;
    if (r.info) {
      rec.developer = r.info.developer.slice(0, 80);
      if (r.info.description) { rec.description = r.info.description; rec.descFromCaption = false; }
      remote.screenshots = r.info.screenshots;
    }
    if (r.categoryId) job.log.push(`  → ${catName(r.categoryId)} (${r.why})`);
  }
  await saveAppIcon(rec.id, meta);
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
// Where a waiting check is in line and what it's waiting for, worked out fresh each time it's asked
// (so it never says it's waiting for something that already finished).
function queueInfo(job) {
  const i = checkQueue.findIndex((c) => c.job === job);
  if (i < 0) return null;
  const wrapping = windingDown.has(job.srcId) ? 'the stopped check of it to wrap up' : null;
  return { position: i + 1, waitingFor: (checkRunning && checkRunning.title) || wrapping || (i > 0 ? checkQueue[i - 1].job.title : null) };
}
function runCheck(job, work) {
  job.isCheck = true;
  // Telegram has strict rate limits and its channels are the slow ones, so they always go last:
  // a repo or source check that joins the line goes ahead of any Telegram channel still waiting.
  const tgFirst = job.isTelegram ? -1 : checkQueue.findIndex((c) => c.job.isTelegram);
  if (tgFirst >= 0) checkQueue.splice(tgFirst, 0, { job, work }); else checkQueue.push({ job, work });
  if (checkRunning || checkQueue.length > 1 || checkQueue[0].job !== job) {
    job.status = 'queued';
    job.waitingFor = [queueInfo(job).waitingFor].filter(Boolean); // for the reply that started it
  }
  pumpChecks();
  return job;
}
// Sources whose check was stopped but is still finishing its current step (a Telegram request, say).
// A new check of the same source waits for that, so the two never import the same posts at once.
const windingDown = new Set();
async function pumpChecks() {
  if (checkRunning) return;
  const i = checkQueue.findIndex((c) => c.job.cancelled || !windingDown.has(c.job.srcId));
  if (i < 0) return;
  const [next] = checkQueue.splice(i, 1);
  const { job, work } = next;
  if (job.cancelled) { job.status = 'cancelled'; job.endedAt = Date.now(); return pumpChecks(); }
  checkRunning = job;
  job.status = 'running';
  job.waitingFor = null;
  job.started = Date.now();
  job.activityAt = Date.now();
  try { await work(); } catch (e) {
    if (job.status === 'running') { job.status = 'error'; job.error = e.message; }
  } finally {
    if (job.status === 'running') job.status = job.cancelled ? 'cancelled' : 'done';
    job.endedAt = job.endedAt || Date.now();
    if (job.srcId) windingDown.delete(job.srcId);
    // Free the line if this is still the check holding it (Stop or the watchdog may have already).
    if (checkRunning === job) checkRunning = null;
    setImmediate(pumpChecks);
  }
}
// Stopping the running check frees the line right away: the next one starts now instead of waiting
// for the stopped one to finish whatever request it was in the middle of.
function releaseCheck(job) {
  if (checkRunning !== job) return;
  if (job.srcId) windingDown.add(job.srcId);
  job.status = 'cancelled';
  job.endedAt = Date.now();
  checkRunning = null;
  setImmediate(pumpChecks);
}
const checkBusy = () => !!checkRunning || checkQueue.length > 0;
// Is this source already being checked (or waiting)? Then reuse that instead of starting another.
function checkFor(srcId) {
  return [checkRunning, ...checkQueue.map((c) => c.job)].find((j) => j && j.srcId === srcId && !j.cancelled && ['running', 'queued'].includes(j.status)) || null;
}
// Watchdog: a check that has shown no sign of life for 15 minutes is stopped, so it can never hold up
// the line forever. "Sign of life" = a new log line, counter or progress change.
setInterval(() => {
  const j = checkRunning;
  if (!j) return;
  const sig = `${j.log.length}|${j.counter ? j.counter.done : ''}|${j.progress ?? ''}`;
  if (sig !== j.activitySig) { j.activitySig = sig; j.activityAt = Date.now(); return; }
  if (Date.now() - (j.activityAt || j.started) < 15 * 60_000) return;
  j.log.push('✕ Stopped: nothing happened for 15 minutes, so it was stopped to let the next check run. Try it again.');
  j.cancelled = true;
  try { j.abort.abort(new Error('Stopped: no progress for 15 minutes')); } catch { /* */ }
  releaseCheck(j);
  j.status = 'error';
  j.error = 'Stopped after 15 minutes with no progress. Try it again.';
}, 30_000).unref();

// Every hour, everything gets checked (see scheduleChecks). Remember when, to show "next check in…".
let nextAutoCheck = Date.now() + 5 * 60_000;

const tgSyncing = new Map();
function tgSync(src, acc) {
  const already = checkFor(src.id);
  if (already) return already;
  const job = newJob(acc || OWNER());
  job.cancellable = true;
  job.title = `Checking ${src.name}`;
  job.srcId = src.id;
  job.isTelegram = true;
  tgSyncing.set(src.id, job.id);
  return runCheck(job, async () => {
    const result = { added: 0, updated: 0, same: 0, older: 0, skipped: 0, failed: 0, removed: 0 };
    try {
      if (!tgReady()) throw new Error('Telegram is not connected');
      const opts = src.options;
      const first = !src.lastMsgId;
      job.log.push(first ? `Looking through ${src.name}'s recent posts…` : `Checking ${src.name} for new posts…`);
      await ensurePeer(src, job);
      const { posts } = await tgTry(job, () => tg.posts(tgRef(src), src.lastMsgId || 0, first ? 400 : 200), src);
      const words = opts.keywords.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
      let ipas = posts.filter((p) => p.file && /\.ipa$/i.test(p.file.name));
      if (words.length) ipas = ipas.filter((p) => words.some((w) => `${p.file.name}\n${p.text}`.toLowerCase().includes(w)));
      result.skipped = posts.length - ipas.length;
      if (first) ipas = ipas.slice(0, opts.backfill);
      job.log.push(ipas.length ? `${ipas.length} new post${ipas.length === 1 ? '' : 's'} with an app` : 'No new apps posted ✓');
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
      // Posts deleted from the channel: hide those apps (unless they were copied to GitHub). Channels mostly
      // delete recent posts, so each check only looks at the newest 100 apps. Every app is checked once a week
      // (and again right before "Delete removed apps"), since that takes a while on channels with thousands.
      const linkedCount = store.apps.filter((a) => a.remote && a.remote.kind === 'telegram' && a.remote.sourceId === src.id && !a.remote.ghAssetId).length;
      if (!job.cancelled && linkedCount) {
        const full = !src.removedFullAt || Date.now() - new Date(src.removedFullAt) > 7 * 864e5;
        const n = full ? linkedCount : Math.min(linkedCount, 100);
        job.log.push(full && linkedCount > 100 ? `Weekly check: making sure all ${linkedCount.toLocaleString()} apps from ${src.name} are still posted…` : `Checking the newest ${n} apps from ${src.name} are still posted…`);
        result.removed += await tgMarkRemoved(src, job, full ? 0 : 100);
        if (full) src.removedFullAt = new Date().toISOString();
        src.removedCheckAt = new Date().toISOString();
        job.counter = null;
      }
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
  job.isTelegram = true;
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
      await ensurePeer(src, job);
      job.counter = { label: 'posts looked at', done: 0, total: null };
      while (found.length < want && !job.cancelled) {
        const page = await tgTry(job, () => tg.posts(tgRef(src), 0, 200, offset), src);
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
}, 'staff');

route('POST', /^\/api\/telegram\/channels$/, async (req, res, m, acc) => {
  if (!tgReady()) return fail(res, 400, 'Connect Telegram first');
  const b = await readJson(req);
  let ch;
  try { ch = await tg.channel(b.ref); } catch (e) { return fail(res, e.status || 400, e.message); }
  const ref = ch.username || String(ch.id);
  // Same channel, whether it was added by @username, link or number.
  const sameCh = store.sources.find((x) => x.kind === 'telegram' && (String(x.ref).toLowerCase() === ref.toLowerCase()
    || (ch.username && String(x.username || '').toLowerCase() === String(ch.username).toLowerCase())
    || String(x.ref) === String(ch.id) || (x.peerKey && x.peerKey.split(':')[0] === String(ch.id))));
  if (sameCh) return fail(res, 409, `That channel is already added (${sameCh.name})`);
  const src = {
    id: id(), kind: 'telegram', ref, url: ch.username ? `https://t.me/${ch.username}` : '', name: ch.title, username: ch.username,
    showInLibrary: b.showInLibrary !== false, categoryId: ['__auto', '__none'].includes(b.categoryId) ? b.categoryId : b.categoryId && catExists(b.categoryId) ? b.categoryId : '__auto',
    options: cleanTgOptions(b.options), addedAt: new Date().toISOString(), lastMsgId: 0,
    peerKey: typeof ch.access_hash === 'string' && /^-?\d+$/.test(ch.access_hash) ? `${ch.id}:${ch.access_hash}` : undefined,
  };
  store.sources.push(src);
  store.save();
  const job = tgSync(src, acc);
  json(res, { source: sourceView(src), jobId: job.id, waitingFor: job.status === 'queued' ? job.waitingFor : null });
}, 'staff');

// Every hour, line up a check of every channel, GitHub repo and source (one at a time, see runCheck).
function scheduleChecks(acc, { manual = false } = {}) {
  let n = 0;
  // Repos and sources first, Telegram channels last (smallest channels first).
  const tgApps = (src) => store.apps.filter((a) => a.remote && a.remote.sourceId === src.id).length;
  const order = [...store.sources.filter((x) => x.kind !== 'telegram'), ...store.sources.filter((x) => x.kind === 'telegram').sort((a, b) => tgApps(a) - tgApps(b))];
  for (const src of order) {
    if (checkFor(src.id)) continue;
    if (src.kind === 'telegram') {
      if (tgReady() && (manual || (src.options && src.options.autoSync !== false))) { tgSync(src, acc); n++; }
    } else { sourceCheck(src, acc); n++; }
  }
  if (!manual) nextAutoCheck = Date.now() + 60 * 60_000;
  return n;
}
setTimeout(() => scheduleChecks(), 5 * 60_000).unref();
setInterval(() => scheduleChecks(), 60 * 60_000).unref();



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
}, 'staff');

route('DELETE', /^\/api\/apps\/([a-f0-9]{16})\/screenshots\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  const shot = app && (app.screenshots || []).find((x) => x.id === m[2]);
  if (!shot) return fail(res, 404, 'Screenshot not found');
  app.screenshots = app.screenshots.filter((x) => x.id !== m[2]);
  await rmQuiet(path.join(dirs.apps, app.id + '-shots', `${shot.id}.${shot.ext}`));
  store.save();
  json(res, { app: appView(app, acc) });
}, 'staff');

route('POST', /^\/api\/apps\/([a-f0-9]{16})\/screenshots\/order$/, async (req, res, m, acc) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const { ids = [] } = await readJson(req);
  app.screenshots = [...(app.screenshots || [])].sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
  store.save();
  json(res, { app: appView(app, acc) });
}, 'staff');

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
}, 'staff');
route('PATCH', /^\/api\/collections\/([a-f0-9]{16})$/, async (req, res, m) => {
  const c = store.collections.find((x) => x.id === m[1]);
  if (!c) return fail(res, 404, 'Collection not found');
  cleanCollection(await readJson(req), c);
  if (!c.name) c.name = 'Collection';
  store.save();
  json(res, { collection: c });
}, 'staff');
route('DELETE', /^\/api\/collections\/([a-f0-9]{16})$/, (req, res, m) => {
  const i = store.collections.findIndex((x) => x.id === m[1]);
  if (i < 0) return fail(res, 404, 'Collection not found');
  store.collections.splice(i, 1);
  sortedCollections().forEach((c, n) => { c.order = n; });
  store.save();
  json(res, { ok: true });
}, 'staff');

// ----- app requests -----
route('POST', /^\/api\/requests$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return fail(res, 400, 'Which app do you want?');
  const open = store.requests.filter((r) => r.ownerId === acc.id && r.status === 'pending');
  if (!isStaff(acc) && open.length >= 10) return fail(res, 400, 'You have 10 open requests — wait for some to be answered');
  const r = {
    id: id(), ownerId: acc.id, username: acc.username, name,
    link: String(b.link || '').trim().slice(0, 500), note: String(b.note || '').trim().slice(0, 500),
    status: 'pending', reply: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  store.requests.push(r);
  if (store.requests.length > 1000) store.requests.splice(0, store.requests.length - 1000);
  alertStaff('request', `🙋 ${acc.username} wants ${name}`, r.note || r.link || '', { requestId: r.id }, acc.id);
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
}, 'staff');
route('DELETE', /^\/api\/requests\/([a-f0-9]{16})$/, (req, res, m, acc) => {
  const i = store.requests.findIndex((x) => x.id === m[1] && (isStaff(acc) || (x.ownerId === acc.id && x.status === 'pending')));
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
}, 'staff');

route('PATCH', /^\/api\/categories\/([a-f0-9]{16})$/, async (req, res, m) => {
  const cat = store.categories.find((c) => c.id === m[1]);
  if (!cat) return fail(res, 404, 'Category not found');
  const { name, emoji } = await readJson(req);
  if (typeof name === 'string' && name.trim()) cat.name = name.trim().slice(0, 30);
  if (typeof emoji === 'string' && emoji.trim()) cat.emoji = emoji.trim().slice(0, 8);
  store.save();
  json(res, { category: cat });
}, 'staff');

route('DELETE', /^\/api\/categories\/([a-f0-9]{16})$/, (req, res, m) => {
  const i = store.categories.findIndex((c) => c.id === m[1]);
  if (i < 0) return fail(res, 404, 'Category not found');
  store.categories.splice(i, 1);
  for (const a of store.apps) if (a.categoryId === m[1]) a.categoryId = null;
  sortedCategories().forEach((c, n) => { c.order = n; });
  store.save();
  json(res, { ok: true });
}, 'staff');

route('POST', /^\/api\/categories\/order$/, async (req, res) => {
  const { ids = [] } = await readJson(req);
  ids.forEach((cid, n) => { const c = store.categories.find((x) => x.id === cid); if (c) c.order = n; });
  store.save();
  json(res, { categories: sortedCategories() });
}, 'staff');

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

// Your own certificate's files, so the iPhone app can sign on the phone with the certificates on your account
// (no importing them twice, and they come back after reinstalling the app). Only ever your own.
route('GET', /^\/api\/certs\/([a-f0-9]{16})\/bundle$/, async (req, res, m, acc) => {
  const c = ownCert(acc, m[1]);
  if (!c) return fail(res, 404, 'Certificate not found');
  const dir = path.join(dirs.certs, c.id);
  let p12, profile;
  try {
    [p12, profile] = await Promise.all([fsp.readFile(path.join(dir, 'cert.p12')), fsp.readFile(path.join(dir, 'profile.mobileprovision'))]);
  } catch { return fail(res, 410, "This certificate's files are missing on the server. Add it again."); }
  let password = '';
  try { password = decrypt(c.password); } catch { return fail(res, 500, "Couldn't read this certificate's password. Add it again."); }
  secEvent(req, 'cert-download', acc.username, true, `${c.label} to the iPhone app`);
  res.setHeader('Cache-Control', 'no-store');
  json(res, { id: c.id, label: c.label, p12: p12.toString('base64'), profile: profile.toString('base64'), password });
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

// Gathers the settings files that go with the tweaks: ones uploaded for this sign, plus the library tweaks' own.
async function collectExtras(uploads, libTweaks, toDocs, work, job) {
  const out = [];
  const seen = new Set();
  const add = (name, buf, docs, from) => {
    const k = name.toLowerCase();
    if (seen.has(k)) { job.log.push(`Note: two settings files are called ${name}; using the first one.`); return; }
    seen.add(k);
    out.push({ name, buf, docs, from });
  };
  for (const u of uploads) {
    const st = await fsp.stat(u.file);
    if (st.size > MAX_EXTRA_FILE) throw new Error(`${u.name} is too big (settings files can be up to 5 MB)`);
    add(u.name, await fsp.readFile(u.file), toDocs, 'you');
    await rmQuiet(u.file);
  }
  for (const t of libTweaks) {
    for (const f of t.extras || []) {
      const buf = await fsp.readFile(path.join(dirs.tweaks, t.id, 'extras', f.name)).catch(() => null);
      if (buf) add(f.name, buf, t.toDocuments !== false, t.name); else job.log.push(`Note: ${t.name}'s file ${f.name} is missing on the server.`);
    }
  }
  let helper = null;
  if (out.some((f) => f.docs)) {
    if (helperInstalled()) {
      helper = path.join(work, 'tweaks', 'MangoFiles.dylib');
      await fsp.mkdir(path.dirname(helper), { recursive: true });
      await fsp.copyFile(HELPER_DYLIB, helper);
    } else {
      job.log.push("Note: lib/MangoFiles.dylib isn't on the server, so settings files are only put inside the app, not copied to Documents.");
      for (const f of out) f.docs = false;
    }
  }
  if (out.length) job.log.push(`Adding ${out.length} settings file${out.length === 1 ? '' : 's'}: ${out.map((f) => f.name).join(', ')}`);
  return { files: out, helper };
}

async function prepareModifiedIpa(srcIpa, work, plistEdits, job, frameworks = [], extras = []) {
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
  // Settings files sit next to the tweak inside the app. Ones for Documents also go in MangoFiles/, which the helper copies out on launch.
  for (const f of extras) {
    const beside = path.join(payload, appDir, f.name);
    if (fs.existsSync(beside)) job.log.push(`Note: the app already has its own ${f.name}, so that one was left alone.`);
    else await fsp.writeFile(beside, f.buf);
    if (f.docs) {
      await fsp.mkdir(path.join(payload, appDir, 'MangoFiles'), { recursive: true });
      await fsp.writeFile(path.join(payload, appDir, 'MangoFiles', f.name), f.buf);
    }
  }
  if (extras.some((f) => f.docs)) job.log.push("They're copied into the app's Documents folder the first time it opens.");
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

// The original (unsigned) app file, for signing on the person's own iPhone in the Mango Signer app.
// Same rules as signing on the server: only apps they can see, and it counts toward their daily sign limit.
route('GET', /^\/api\/apps\/([a-f0-9]{16})\/ipa$/, async (req, res, m, acc) => {
  const app = visibleApps(acc).find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const limit = signLimitFor(acc);
  if (limit && signsToday(acc.id) >= limit) return fail(res, 429, `You've used all ${limit} signs for today. It resets at midnight (server time).`);
  const versionIndex = Math.max(0, Math.min(14, Number(req.query.get('v')) || 0));
  checkVersionAllowed(app, acc, versionIndex);
  const count = () => { if (req.method !== 'HEAD') { countSign(acc.id, app.id); store.save(); } };
  const fileName = `${app.name} ${app.version || ''}.ipa`.replace(/[^\w.\- ]/g, '_');
  if (!app.remote) { count(); return serveFile(req, res, path.join(dirs.apps, app.id + '.ipa'), { download: fileName }); }
  const dl = await resolveDownload(remoteDownload(app, versionIndex));
  const idle = idleSignal(null, 90_000);
  let r;
  try { r = await fetchAuthed(dl.url, dl.headers, idle.signal); } catch (e) { idle.done(); return fail(res, 502, `Couldn't get the app (${e.message})`); }
  if (!r.ok || !r.body) { idle.done(); return fail(res, 502, `Couldn't get the app (HTTP ${r.status})`); }
  count(); // only once the app is really on its way
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store',
    ...(r.headers.get('content-length') ? { 'Content-Length': r.headers.get('content-length') } : {}),
  });
  const body = Readable.fromWeb(r.body);
  body.on('data', () => idle.kick());
  return pipeline(body, res).catch(() => {}).finally(() => idle.done());
});

route('POST', /^\/api\/sign$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  const imported = findImport(acc, b.appId);
  if (/^imp_/.test(String(b.appId || '')) && !imported) return fail(res, 404, 'That app was deleted from your Apps tab. Import it again.');
  const app = imported ? importAsApp(imported) : visibleApps(acc).find((a) => a.id === b.appId);
  if (!app) return fail(res, 404, 'App not found');
  if (imported && !app.localFile && !app.remote) return fail(res, 410, 'That file is gone. Import it again.');
  if (imported && app.remote && !ghClient()) return fail(res, 400, 'This app is saved in GitHub storage, which is not connected right now. Ask the owner to reconnect it.');
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
  checkVersionAllowed(app, acc, versionIndex);
  if (app.remote && app.remote.missing) return fail(res, 410, 'This app was removed from its source');

  const iconFile = b.iconUploadId ? tmpPath(b.iconUploadId, acc) : null;
  const dylibFiles = (Array.isArray(b.dylibs) ? b.dylibs : []).slice(0, 20).map((d) => ({
    file: tmpPath(d.uploadId, acc),
    name: String(d.name || 'tweak.dylib').replace(/[^\w.\-+]/g, '_').replace(/^\.+/, '') || 'tweak.dylib',
  }));
  const libTweaks = (Array.isArray(b.tweakIds) ? b.tweakIds : []).slice(0, 20)
    .map((tid) => visibleTweaks(acc).find((t) => t.id === tid)).filter(Boolean);
  let extraFiles;
  try {
    extraFiles = (Array.isArray(b.tweakFiles) ? b.tweakFiles : []).slice(0, MAX_EXTRA_FILES).map((d) => ({ file: tmpPath(d.uploadId, acc), name: safeExtraName(d.name) }));
  } catch (e) { return fail(res, e.status || 400, e.message); }

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
  countSign(acc.id, app.id, app.name);
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
      const extras = await collectExtras(extraFiles, libTweaks, b.filesToDocuments !== false, work, job);
      if (extras.helper) inject.files.unshift(extras.helper); // first, so the files are in place before the tweaks look for them
      for (const p of inject.files) args.push('-l', p);
      if (inject.files.length && b.weakDylibs) args.push('-w');
      if (inject.files.length && b.injectExtensions) args.push('-P');
      if (b.removeExtensions) args.push('-E');
      if (b.removeWatch) args.push('-W');
      if (b.removeUISD) args.push('-U');
      if (b.enableDocs) args.push('-S');

      let input = app.localFile || path.join(dirs.apps, app.id + '.ipa');
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
          const got = await fetchToFile(dl.url, dl.headers, input, job, `Downloading ${app.name}${dl.version ? ' ' + dl.version : ''}${dl.telegram ? ' from Telegram' : ''}…`, { telegram: !!dl.telegram });
          const secs = Math.max(1, (Date.now() - t0) / 1000);
          if (got > 5 * 1048576) job.log.push(`Downloaded ${gb(got)} in ${Math.round(secs)}s (${(got / 1048576 / secs).toFixed(1)} MB/s)`);
          await cachePut(input, key);
        }
        job.progress = null;
      }
      if (plistEdits.length || inject.frameworks.length || extras.files.length) input = await prepareModifiedIpa(input, work, plistEdits, job, inject.frameworks, extras.files);
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
      else if (app.hasIcon) await fsp.copyFile(app.iconFile || path.join(dirs.apps, app.id + '.png'), path.join(dirs.signed, signedId + '.png')).catch(() => {});

      const rec = {
        id: signedId, ownerId: acc.id, token: token(), appId: app.id, certId: cert.id, certLabel: cert.label,
        name: meta.name, bundleId: meta.bundleId, version: meta.version, build: meta.build,
        size: meta.size, hasIcon: !!meta.icon || fs.existsSync(path.join(dirs.signed, signedId + '.png')), signedAt: new Date().toISOString(),
        expires: cert.profile.expires,
        options: {
          ...opts, icon: !!iconFile, dylibs: dylibFiles.map((d) => d.name), tweakFiles: extras.files.map((f) => f.name), tweaks: libTweaks.map((t) => t.name), tweakIds: libTweaks.map((t) => t.id), versionIndex: versionIndex || 0,
          entitlements: entEdits.map((e) => e.key), plist: plistEdits.map((e) => e.key),
        },
      };
      store.signed.unshift(rec);
      if (app.importRec) app.importRec.lastSigned = rec.signedAt;
      // Replace any older signed copy of this app (only one copy per app per person).
      for (const old of previous().filter((x) => x.id !== rec.id)) await removeSigned(old);
      trimSigned(acc);
      store.save();
      job.result = { signed: signedView(rec, req), replaced: true };
      job.status = 'done';
      job.log.push('Done!');
      if (job.notify) { addAlert(acc.id, 'signed', `✅ ${rec.name} is signed and ready`, 'Tap to install it.', { signedId: rec.id, appId: app.id }); store.save(); }
      if (signedToGithubOn()) setTimeout(() => archiveSigned().catch(() => {}), 20_000); // after the first install has a head start
      if (app.importRec && app.importRec.gh) await rmQuiet(importFile(app.importRec)); // already safe on GitHub
    } catch (e) {
      await rmQuiet(out);
      const full = isNoSpace(e) || job.log.some((l) => /no space left|ENOSPC/i.test(l));
      job.error = full ? storageFullMessage() : e.message;
      job.status = 'error';
      if (job.notify && !job.cancelled) { addAlert(acc.id, 'signed', `⚠️ Signing ${app.name} failed`, job.error, { appId: app.id }); store.save(); }
    } finally {
      await rmQuiet(work);
      if (signingNow.get(runKey) === job.id) signingNow.delete(runKey);
    }
  });
});
const signingNow = new Map(); // "owner:app" -> job id

function jobView(j) {
  let status = j.cancelled && j.status !== 'error' ? 'cancelled' : j.status;
  // A check shown as running or waiting must really be: one that isn't running and isn't in line has
  // finished (or was lost), so it never shows as running or waiting forever.
  if (j.isCheck && status === 'queued' && !checkQueue.some((c) => c.job === j)) status = j.result ? 'done' : 'cancelled';
  if (j.isCheck && status === 'running' && checkRunning !== j) status = j.error ? 'error' : 'done';
  const q = status === 'queued' ? queueInfo(j) : null;
  return {
    id: j.id, title: j.title, status, progress: status === 'running' ? j.progress ?? null : null,
    counter: j.counter || null, last: [...j.log].reverse().find((l) => !/^⏳ Waiting/.test(l)) || '', started: j.started, endedAt: j.endedAt || null,
    error: status === 'cancelled' ? 'Cancelled' : j.error, cancellable: !!j.cancellable && !j.cancelled && ['running', 'queued'].includes(status),
    position: q ? q.position : null, waitingFor: q ? q.waitingFor : null, isCheck: !!j.isCheck, srcId: j.srcId || null,
    result: status === 'done' && j.result && typeof j.result === 'object' && !j.result.signed ? j.result : null,
  };
}
// Owner: check every channel, repo and source now / stop everything that's running or waiting.
route('POST', /^\/api\/checks\/run-all$/, (req, res, m, acc) => json(res, { queued: scheduleChecks(acc, { manual: true }) }), 'staff');
route('POST', /^\/api\/jobs\/cancel-all$/, (req, res, m, acc) => {
  let n = 0;
  for (const j of jobs.values()) {
    if (!['running', 'queued'].includes(j.status) || j.cancelled || !j.cancellable || !(j.owner === acc.id || j.isCheck)) continue;
    j.cancelled = true;
    j.log.push('✕ Cancelled');
    const qi = checkQueue.findIndex((c) => c.job === j);
    if (qi >= 0) { checkQueue.splice(qi, 1); j.status = 'cancelled'; j.endedAt = Date.now(); }
    releaseCheck(j);
    try { j.abort.abort(new Error('Cancelled')); } catch { /* */ }
    if (j.child) j.child.kill('SIGKILL');
    n++;
  }
  json(res, { stopped: n });
}, 'staff');

route('GET', /^\/api\/jobs\/([a-f0-9]{16})$/, (req, res, m, acc) => {
  const job = jobs.get(m[1]);
  if (!job || (job.owner !== acc.id && !(job.isCheck && isStaff(acc)))) return fail(res, 404, 'This task stopped because the server restarted (probably an update). Start it again.');
  json(res, { ...jobView(job), log: job.log.slice(-300), result: job.result });
});

// Background tasks you can come back to after leaving the app.
route('GET', /^\/api\/jobs$/, (req, res, m, acc) => {
  // Everything still going, plus what finished in the last half hour.
  const list = [...jobs.values()].filter((j) => (j.owner === acc.id || (isStaff(acc) && j.isCheck)) && j.title && (['running', 'queued'].includes(j.status) || Date.now() - (j.endedAt || Date.now()) < 30 * 60 * 1000));
  const rank = (v) => (v.status === 'running' ? 0 : v.status === 'queued' ? 1 : 2);
  json(res, {
    jobs: list.map(jobView).sort((a, b) => rank(a) - rank(b) || (a.position || 0) - (b.position || 0) || (b.endedAt || b.started) - (a.endedAt || a.started)),
    checks: isStaff(acc) ? { nextAuto: nextAutoCheck, sources: store.sources.length, running: !!checkRunning, waiting: checkQueue.length } : null,
  });
});

// "Keep going in the background": send an alert when this job finishes (or fails).
route('POST', /^\/api\/jobs\/([a-f0-9]{16})\/notify$/, (req, res, m, acc) => {
  const job = jobs.get(m[1]);
  if (!job || job.owner !== acc.id) return fail(res, 404, 'Job not found');
  job.notify = true;
  json(res, { ok: true, status: jobView(job).status });
});

route('POST', /^\/api\/jobs\/([a-f0-9]{16})\/cancel$/, (req, res, m, acc) => {
  const job = jobs.get(m[1]);
  if (!job || (job.owner !== acc.id && !(job.isCheck && isStaff(acc)))) return fail(res, 404, 'Job not found');
  if (job.status === 'done' || job.status === 'error') return json(res, { ok: true, status: job.status });
  job.cancelled = true;
  job.log.push(job.status === 'queued' ? '✕ Cancelled before it started' : '✕ Cancelled — stopping…');
  const qi = checkQueue.findIndex((c) => c.job === job);
  if (qi >= 0) { checkQueue.splice(qi, 1); job.status = 'cancelled'; job.endedAt = Date.now(); }
  releaseCheck(job);
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

// The signed file itself, so the Mango Signer iPhone app can keep its own copy. Unlike the install link,
// downloading it here doesn't count as installing the app.
route('GET', /^\/api\/signed\/([a-f0-9]{16})\/file$/, async (req, res, m, acc) => {
  const s = ownSigned(acc, m[1]);
  if (!s || !signedReady(s)) return fail(res, 404, 'This signed file was cleaned up');
  const local = path.join(dirs.signed, s.id + '.ipa');
  if (s.gh && !fs.existsSync(local)) return serveSignedFromGithub(req, res, s);
  return serveFile(req, res, local, { download: `${s.name}.ipa` });
});

// Puts back a signed file the iPhone app kept, so an app whose file was cleaned up can be installed again.
route('POST', /^\/api\/signed\/([a-f0-9]{16})\/restore$/, async (req, res, m, acc) => {
  const s = ownSigned(acc, m[1]);
  if (!s) return fail(res, 404, 'Not found');
  const { uploadId } = await readJson(req);
  const file = tmpPath(uploadId, acc);
  try {
    const meta = await ipa.inspect(file);
    if (meta.bundleId !== s.bundleId) return fail(res, 400, "That file isn't this signed app");
    await fsp.rename(file, path.join(dirs.signed, s.id + '.ipa'));
  } finally {
    await rmQuiet(file);
  }
  Object.assign(s, { fileDeleted: false, restoredAt: new Date().toISOString(), installedAt: null });
  store.save();
  json(res, { signed: signedView(s, req) });
});

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

// ----- bug reports (testers, admins and you) -----
if (!Array.isArray(store.data.bugs)) store.data.bugs = [];
route('POST', /^\/api\/bugs$/, async (req, res, m, acc) => {
  if (!seesTesterApps(acc) || isOwner(acc)) return fail(res, 403, 'Bug reports are for testers and admins');
  const b = await readJson(req);
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!text) return fail(res, 400, 'Say what went wrong');
  const app = b.appId ? store.apps.find((a) => a.id === b.appId) : null;
  const mine = store.data.bugs.filter((x) => x.ownerId === acc.id && x.status === 'open');
  if (mine.length >= 30) return fail(res, 400, 'You have 30 open reports — wait for some to be looked at');
  const bug = { id: id(), ownerId: acc.id, username: acc.username, text, appId: app ? app.id : null, appName: app ? app.name : null,
    device: shortUa(req.headers['user-agent']), status: 'open', createdAt: new Date().toISOString() };
  store.data.bugs.push(bug);
  if (store.data.bugs.length > 500) store.data.bugs.splice(0, store.data.bugs.length - 500);
  alertStaff('bug', `🐞 ${acc.username} reported a bug${app ? ` in ${app.name}` : ''}`, text.slice(0, 300), { bugId: bug.id, appId: bug.appId }, acc.id);
  store.save();
  json(res, { bug });
});
route('PATCH', /^\/api\/bugs\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const bug = store.data.bugs.find((x) => x.id === m[1]);
  if (!bug) return fail(res, 404, 'Report not found');
  const b = await readJson(req);
  if (['open', 'fixed', 'wontfix'].includes(b.status)) bug.status = b.status;
  if (typeof b.reply === 'string') bug.reply = b.reply.trim().slice(0, 500);
  bug.updatedAt = new Date().toISOString();
  if (bug.ownerId !== acc.id) addAlert(bug.ownerId, 'bug', bug.status === 'fixed' ? '✅ Your bug report was fixed' : '💬 Your bug report got an answer', bug.reply || bug.text.slice(0, 200), { bugId: bug.id });
  store.save();
  json(res, { bug });
}, 'staff');
route('DELETE', /^\/api\/bugs\/([a-f0-9]{16})$/, (req, res, m, acc) => {
  const i = store.data.bugs.findIndex((x) => x.id === m[1] && (isStaff(acc) || x.ownerId === acc.id));
  if (i < 0) return fail(res, 404, 'Report not found');
  store.data.bugs.splice(i, 1);
  store.save();
  json(res, { ok: true });
});

function inviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(8)) s += chars[b % chars.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

route('POST', /^\/api\/invites$/, async (req, res, m, acc) => {
  const b = await readJson(req);
  // An invite can give everyone who uses it a role (tester or admin). Only the owner gives out roles.
  const rank = b.rank ? String(b.rank) : null;
  if (rank && !RANKS.includes(rank)) return fail(res, 400, 'Unknown role');
  if (rank && !isOwner(acc)) return fail(res, 403, 'Only the owner can make invites that give a role');
  const inv = {
    code: inviteCode(), note: String(b.note || '').trim().slice(0, 60),
    maxUses: Math.min(1000, Math.max(1, Number(b.maxUses) || 1)), uses: 0, usedBy: [], createdAt: new Date().toISOString(),
    expiresAt: Number(b.expiresDays) > 0 ? new Date(Date.now() + Math.min(365, Number(b.expiresDays)) * 864e5).toISOString() : null,
  };
  if (rank) inv.rank = rank;
  store.invites.unshift(inv);
  store.save();
  json(res, { invite: inv, signupUrl: `${baseUrl(req)}/?invite=${inv.code}` });
}, 'staff');

route('DELETE', /^\/api\/invites\/([A-Z0-9-]{4,20})$/, (req, res, m, acc) => {
  const i = store.invites.findIndex((x) => x.code === m[1] && (isOwner(acc) || x.rank !== 'admin'));
  if (i < 0) return fail(res, 404, 'Invite not found');
  store.invites.splice(i, 1);
  store.save();
  json(res, { ok: true });
}, 'staff');

route('PATCH', /^\/api\/users\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  const u = findUser(m[1]);
  if (!u) return fail(res, 404, 'User not found');
  const b = await readJson(req);
  // Admins look after everyone else, but only you can change admins or give out roles.
  if (!isOwner(acc) && (u.rank === 'admin' || b.rank !== undefined)) return fail(res, 403, 'Only the owner can change admins and roles');
  if (b.rank !== undefined) {
    const rank = b.rank ? String(b.rank) : null;
    if (rank && !RANKS.includes(rank)) return fail(res, 400, 'Unknown role');
    if ((u.rank || null) !== rank) {
      u.rank = rank;
      addAlert(u.id, 'user', rank === 'admin' ? '⭐ You\'re now an admin' : rank === 'tester' ? '🧪 You\'re now a tester' : 'Your role was removed',
        rank === 'admin' ? 'You can now manage the library and users.' : rank === 'tester' ? 'You can see apps for testers, try beta versions first and send bug reports.' : '');
    }
  }
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
}, 'staff');

route('DELETE', /^\/api\/users\/([a-f0-9]{16})$/, async (req, res, m, acc) => {
  { const t = findUser(m[1]); if (t && t.rank === 'admin' && !isOwner(acc)) return fail(res, 403, 'Only the owner can delete an admin'); }
  const u = findUser(m[1]);
  if (!u) return fail(res, 404, 'User not found');
  for (const c of store.certs.filter((x) => x.ownerId === u.id)) await deleteCertRecord(c);
  for (const s of store.signed.filter((x) => x.ownerId === u.id)) await removeSigned(s);
  for (const imp of store.data.imports.filter((x) => x.ownerId === u.id)) await removeImport(imp);
  store.users.splice(store.users.indexOf(u), 1);
  delete store.data.myApps[u.id];
  for (const a of store.apps) if (a.votes) delete a.votes[u.id];
  store.data.requests = store.requests.filter((r) => r.ownerId !== u.id);
  store.save();
  json(res, { ok: true });
}, 'staff');

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
  if (viaApp && s.appId && !String(s.appId).startsWith('imp_')) {
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
    return send(res, 404, fill({ title: 'Link expired', name: 'This link has expired', meta: 'Ask for a new install link.', icon: '/icon-180.png?v=2', install: '#', hidden: 'hidden' }), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  const v = signedView(s, req);
  send(res, 200, fill({
    title: `Install ${s.name}`, name: s.name,
    meta: `Version ${s.version || '?'} · ${(s.size / 1048576).toFixed(1)} MB`,
    icon: s.hasIcon ? `/i/${s.token}/icon.png` : '/icon-180.png?v=2',
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
  if (!iconCache[size]) {
    // Your logo (public/logo.png, 1024×1024) shrunk to the size asked for. The drawn mango is only a fallback.
    let logo = null;
    try { logo = fs.readFileSync(path.join(PUBLIC_DIR, 'logo.png')); } catch {}
    iconCache[size] = (logo && shrinkPng(logo, size)) || drawAppIcon(size);
  }
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
  // Other sites can't show Mango inside a frame (stops "clickjacking" tricks on your buttons),
  // and browsers always use HTTPS for it once they've seen it on HTTPS.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (String(req.headers['x-forwarded-proto'] || '').startsWith('https')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // With PUBLIC_URL set to your own domain, people opening the old Railway address in a browser are sent there.
  // Only pages: the iPhone app, install links and anything already shared keep working on the old address.
  if (process.env.PUBLIC_URL && (req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/') && /text\/html/.test(req.headers.accept || '')) {
    try {
      const want = new URL(process.env.PUBLIC_URL);
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
      if (host.endsWith('.up.railway.app') && want.host.toLowerCase() !== host) {
        res.writeHead(301, { Location: want.origin + req.url });
        return res.end();
      }
    } catch {}
  }

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
        if (r.access === 'staff' && !isStaff(acc)) return fail(res, 403, 'Only the owner or an admin can do that');
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

// ----- Telegram bot (announcements + chat moderation) -----
// Its settings live outside store.settings so they never go out with the owner's settings; the token is encrypted.
if (!store.data.tgBot || typeof store.data.tgBot !== 'object') store.data.tgBot = {};
const botCfg = () => store.data.tgBot;
const tgbot = tgbotLib.createBot({
  cfg: botCfg,
  save: () => store.save(),
  token: () => { const c = botCfg(); if (!c.tokenEnc) return null; try { return decrypt(c.tokenEnc); } catch { return null; } },
  log: (msg) => console.log(msg),
  appLink: (appId) => `${(botCfg().publicUrl || '').replace(/\/$/, '')}/?app=${appId}`,
  // Only apps everyone can see: never hidden, testers-only or removed ones.
  libraryApps: () => store.apps.filter((a) => a.published !== false && !a.testersOnly && !(a.remote && a.remote.missing)).map(appFeedItem),
  release: async (repo) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return null;
    // GitHub doesn't list releases newest-first reliably, so read plenty and sort them ourselves.
    const list = await githubApi(`/repos/${repo}/releases?per_page=100`);
    // Real versions only (not drafts, or the iPhone app's "failed-N" error reports).
    const r = (Array.isArray(list) ? list : []).filter((x) => !x.draft && /^v?\d/i.test(x.tag_name || ''))
      .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))[0];
    if (!r) return null;
    const ipa = (r.assets || []).find((x) => /\.ipa$/i.test(x.name));
    return { tag: r.tag_name, name: r.name, body: r.body || '', url: r.html_url, ipaUrl: ipa ? ipa.browser_download_url : null };
  },
});
// What a post about one app shows (nothing private: no links to the file, no storage details).
function appFeedItem(a) {
  const custom = a.customIcon ? path.join(dirs.apps, a.id + '-custom.png') : null;
  const own = path.join(dirs.apps, a.id + '.png');
  const hd = path.join(dirs.apps, a.id + '-hd.png');
  const cat = store.categories.find((c) => c.id === a.categoryId);
  return {
    id: a.id, name: a.name, version: a.versionOverride || a.version || '', size: fmtBytes(a.size),
    category: cat ? cat.name : '', developer: a.developer || '',
    notes: String(trShown(a.notes) || '').trim(), description: String(trShown(a.description) || '').trim(),
    // Sharpest first: your custom icon, the big copy from the app, the source's picture, then the small one.
    iconFile: custom && fs.existsSync(custom) ? custom : fs.existsSync(hd) ? hd : !a.iconURL && fs.existsSync(own) ? own : null,
    iconUrl: !a.customIcon && a.iconURL ? a.iconURL : null,
    iconSmall: fs.existsSync(own) ? own : null,
    // No icon at all? An app from a GitHub repo can show the repo owner's GitHub picture instead.
    iconFallbackUrl: (() => {
      const src = a.remote && a.remote.sourceId && store.sources.find((x) => x.id === a.remote.sourceId);
      return src && src.repo && /^[\w.-]+$/.test(src.repo.owner) ? `https://github.com/${src.repo.owner}.png?size=512` : null;
    })(),
  };
}
function fmtBytes(b) {
  if (!b) return '';
  if (b < 1048576) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
function botView() {
  const c = tgbot.cfg();
  return {
    connected: !!c.tokenEnc, running: tgbot.running, username: c.botUsername || null, lastError: tgbot.lastError,
    chats: Object.values(c.chats || {}).sort((a, b) => String(a.title).localeCompare(String(b.title))),
    updatesChat: c.updatesChat || '', appsChat: c.appsChat || '', groupChat: c.groupChat || '',
    announce: c.announce, repos: c.repos, mod: c.mod, welcome: c.welcome, rules: c.rules, brand: c.brand, contact: c.contact || '',
    publicUrl: c.publicUrl || '', queued: (c.appQueue || []).length, locked: Object.keys(c.locked || {}),
  };
}
route('GET', /^\/api\/tgbot$/, (req, res) => json(res, { bot: botView() }), 'owner');
route('POST', /^\/api\/tgbot\/token$/, async (req, res) => {
  const { token } = await readJson(req);
  const t = String(token || '').trim();
  if (!/^\d{5,}:[\w-]{30,}$/.test(t)) return fail(res, 400, "That doesn't look like a bot token. It looks like 1234567890:AAH…, from @BotFather.");
  let me;
  try { me = await tgbot.check(t); } catch (e) { return fail(res, 400, e.code === 401 ? 'Telegram refused that token. Copy it again from @BotFather.' : e.message); }
  const c = botCfg();
  c.tokenEnc = encrypt(t);
  c.botUsername = me.username;
  c.botId = me.id;
  c.publicUrl = c.publicUrl || baseUrl(req);
  c.offset = 0;
  store.save();
  await tgbot.start();
  json(res, { bot: botView() });
}, 'owner');
route('DELETE', /^\/api\/tgbot$/, (req, res) => {
  tgbot.stop();
  const c = botCfg();
  delete c.tokenEnc;
  c.botUsername = null;
  store.save();
  json(res, { bot: botView() });
}, 'owner');
route('PATCH', /^\/api\/tgbot$/, async (req, res) => {
  const b = await readJson(req);
  const c = tgbot.cfg();
  const chatId = (v) => (v === '' || v === null ? '' : /^-?\d{5,}$/.test(String(v)) ? String(v) : /^@\w{4,}$/.test(String(v)) ? String(v) : undefined);
  for (const k of ['updatesChat', 'appsChat', 'groupChat']) {
    if (b[k] === undefined) continue;
    const v = chatId(b[k]);
    if (v === undefined) return fail(res, 400, 'Pick a chat from the list, or type its @username.');
    if (k === 'appsChat' && v !== c.appsChat) c.seenApps = undefined; // start fresh: don't dump the whole library into a new channel
    c[k] = v;
  }
  if (b.announce && typeof b.announce === 'object') for (const k of ['server', 'ios', 'apps']) if (typeof b.announce[k] === 'boolean') {
    if (k === 'apps' && b.announce.apps && !c.announce.apps) c.seenApps = undefined;
    c.announce[k] = b.announce[k];
  }
  if (b.repos && typeof b.repos === 'object') for (const k of ['server', 'ios']) if (typeof b.repos[k] === 'string') {
    const r = b.repos[k].trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    if (r && !/^[\w.-]+\/[\w.-]+$/.test(r)) return fail(res, 400, 'Repos look like owner/repo');
    if (r !== c.repos[k]) delete c.lastTags[k];
    c.repos[k] = r;
  }
  if (b.mod && typeof b.mod === 'object') {
    for (const k of ['antispam', 'captcha', 'cleanJoins', 'flood']) if (typeof b.mod[k] === 'boolean') c.mod[k] = b.mod[k];
    if (b.mod.newHours !== undefined) c.mod.newHours = Math.max(0, Math.min(720, Number(b.mod.newHours) || 0));
    if (Array.isArray(b.mod.bannedWords)) c.mod.bannedWords = [...new Set(b.mod.bannedWords.map((w) => String(w).trim().toLowerCase()).filter(Boolean))].slice(0, 300).map((w) => w.slice(0, 60));
  }
  for (const k of ['welcome', 'rules']) if (typeof b[k] === 'string') c[k] = b[k].trim().slice(0, 1500);
  if (typeof b.brand === 'string') c.brand = b.brand.trim().slice(0, 60) || tgbot.defaults.brand;
  if (typeof b.contact === 'string') {
    const u = b.contact.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
    if (u && !/^\w{4,32}$/.test(u)) return fail(res, 400, 'Your Telegram username is 4–32 letters, numbers or underscores');
    c.contact = u;
  }
  if (typeof b.publicUrl === 'string') {
    try { const u = new URL(b.publicUrl.trim()); if (!/^https?:$/.test(u.protocol)) throw new Error(); c.publicUrl = u.origin; } catch { return fail(res, 400, 'Enter your Mango Signer link, like https://mango.example.com'); }
  }
  store.save();
  json(res, { bot: botView() });
}, 'owner');
// Sends a test post, or the newest release / an app right now.
route('POST', /^\/api\/tgbot\/post$/, async (req, res) => {
  if (!tgbot.running) return fail(res, 400, 'Connect the bot first');
  const { what, to, appId } = await readJson(req);
  const c = tgbot.cfg();
  const chat = { updates: c.updatesChat, apps: c.appsChat, group: c.groupChat }[to];
  if (!chat) return fail(res, 400, 'Pick that chat first');
  try {
    if (what === 'test') await tgbot.api('sendMessage', { chat_id: chat, text: `✅ ${c.brand} bot is connected and can post here.` });
    else if (what === 'server' || what === 'ios') { const r = await tgbot.announceRelease(what, { force: true, to: chat }); if (!r) return fail(res, 404, 'No release found on that repo'); }
    else if (what === 'app') {
      const a = (store.apps.find((x) => x.id === appId) || (() => { throw httpError(404, 'App not found'); })());
      if (a.published === false || a.testersOnly) return fail(res, 400, 'Hidden and testers-only apps are never posted');
      await tgbot.postApp(appFeedItem(a), 'new', chat);
    } else return fail(res, 400, 'Unknown post');
  } catch (e) {
    return fail(res, 400, /not enough rights|chat not found|need administrator|CHAT_WRITE_FORBIDDEN|bot is not a member/i.test(e.message)
      ? 'The bot can\'t post there. Add it to that channel or chat as an admin that can post messages.' : e.message);
  }
  json(res, { ok: true });
}, 'owner');

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
  if (botCfg().tokenEnc) tgbot.start().catch(() => {});
  if (!APP_PASSWORD) console.log('WARNING: APP_PASSWORD is not set — anyone with the link has owner access.');
});
