// Mango Signer — a self-hosted iOS app signer and installer.
// Zero npm dependencies: Node built-ins + the zsign and openssl command-line tools.
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const Store = require('./lib/store');
const ipa = require('./lib/ipa');
const plist = require('./lib/plist');
const { parseProvision, parseP12, run } = require('./lib/certs');
const { drawAppIcon } = require('./lib/png');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : './data'));
const ZSIGN = process.env.ZSIGN_PATH || 'zsign';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024;

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

// ---------- sessions ----------
const SESSION_DAYS = 90;
function makeSession() {
  const issued = Date.now().toString(36);
  const sig = crypto.createHmac('sha256', SECRET).update('session:' + issued).digest('base64url');
  return `${issued}.${sig}`;
}
function validSession(value) {
  if (!value) return false;
  const [issued, sig] = value.split('.');
  if (!issued || !sig) return false;
  const expect = crypto.createHmac('sha256', SECRET).update('session:' + issued).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  return Date.now() - parseInt(issued, 36) < SESSION_DAYS * 864e5;
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  return !APP_PASSWORD || validSession(cookies(req).mango_session);
}
const loginFails = new Map();

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

async function readJson(req, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
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

function tmpPath(uploadId) {
  if (!/^[a-f0-9]{16}$/.test(uploadId || '')) throw Object.assign(new Error('Missing or invalid upload'), { status: 400 });
  const p = path.join(dirs.tmp, uploadId);
  if (!fs.existsSync(p)) throw Object.assign(new Error('Upload expired — please pick the file again'), { status: 400 });
  return p;
}

async function rmQuiet(p) { await fsp.rm(p, { recursive: true, force: true }).catch(() => {}); }

// ---------- zsign ----------
let zsignVersion = null;
(async () => {
  const r = await run(ZSIGN, ['-v'], { timeout: 10000 });
  const out = (r.stdout.toString() + r.stderr).trim();
  zsignVersion = r.code === -1 ? null : (out.match(/\d+\.\d+(\.\d+)?[\w.-]*/) || [out || 'installed'])[0];
  console.log(zsignVersion ? `zsign ready (${zsignVersion})` : 'WARNING: zsign not found — signing will not work');
})();

function runLogged(cmd, args, job, timeout = 20 * 60 * 1000) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(cmd, args, { cwd: dirs.work });
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

// ---------- jobs ----------
const jobs = new Map();
function newJob() {
  const job = { id: id(), status: 'running', log: [], result: null, error: null, started: Date.now() };
  jobs.set(job.id, job);
  setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref();
  return job;
}

// ---------- public views ----------
function certView(c) {
  return {
    id: c.id, label: c.label, createdAt: c.createdAt, isDefault: store.settings.defaultCertId === c.id,
    p12: c.p12, profile: { ...c.profile, devices: undefined }, check: c.check || null, matches: c.matches,
  };
}
function appView(a) { return { ...a, hasIcon: !!a.hasIcon }; }
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

// ---------- route handlers ----------
const routes = [];
const route = (method, pattern, handler, { open = false } = {}) => routes.push({ method, pattern, handler, open });

route('GET', /^\/api\/session$/, (req, res) => json(res, {
  authed: isAuthed(req), passwordSet: !!APP_PASSWORD,
}), { open: true });

route('POST', /^\/api\/login$/, async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const f = loginFails.get(ip) || { n: 0, t: 0 };
  if (f.n >= 5 && Date.now() - f.t < 60_000) return fail(res, 429, 'Too many tries — wait a minute');
  const { password } = await readJson(req);
  const a = Buffer.from(String(password || '')), b = Buffer.from(APP_PASSWORD);
  if (!APP_PASSWORD || (a.length === b.length && crypto.timingSafeEqual(a, b))) {
    loginFails.delete(ip);
    const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `mango_session=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
    });
  }
  loginFails.set(ip, { n: f.n + 1, t: Date.now() });
  return fail(res, 401, 'Wrong password');
}, { open: true });

route('POST', /^\/api\/logout$/, (req, res) => send(res, 200, { ok: true }, {
  'Set-Cookie': 'mango_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
}));

route('GET', /^\/api\/state$/, async (req, res) => {
  const base = baseUrl(req);
  json(res, {
    apps: store.apps.map(appView),
    certs: store.certs.map(certView),
    signed: store.signed.map((s) => signedView(s, req)),
    settings: store.settings,
    server: {
      baseUrl: base, https: base.startsWith('https://'), zsign: zsignVersion,
      passwordSet: !!APP_PASSWORD, storage: await storageUsed(),
    },
  });
});

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

// Raw file upload: the body is the file. Returns an upload id used by other endpoints.
route('POST', /^\/api\/upload$/, async (req, res) => {
  const uid = id();
  const dest = path.join(dirs.tmp, uid);
  let size = 0;
  const limiter = new (require('stream').Transform)({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD) return cb(Object.assign(new Error('File is too large'), { status: 413 }));
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
  json(res, { uploadId: uid, size });
});

async function addAppFromFile(file, fileName, source) {
  let meta;
  try {
    meta = await ipa.inspect(file);
  } catch (e) {
    await rmQuiet(file);
    throw Object.assign(new Error(e.message || 'Not a valid .ipa'), { status: 400 });
  }
  const appId = id();
  await fsp.rename(file, path.join(dirs.apps, appId + '.ipa'));
  if (meta.icon) await fsp.writeFile(path.join(dirs.apps, appId + '.png'), meta.icon);
  const rec = {
    id: appId, fileName: fileName || `${meta.name}.ipa`, source: source || 'upload', addedAt: new Date().toISOString(),
    name: meta.name, bundleId: meta.bundleId, version: meta.version, build: meta.build, minOS: meta.minOS,
    extensions: meta.extensions, hasWatch: meta.hasWatch, size: meta.size, hasIcon: !!meta.icon,
  };
  store.apps.unshift(rec);
  store.save();
  return rec;
}

route('POST', /^\/api\/apps$/, async (req, res) => {
  const { uploadId, fileName } = await readJson(req);
  const rec = await addAppFromFile(tmpPath(uploadId), String(fileName || '').slice(0, 200), 'upload');
  json(res, { app: appView(rec) });
});

route('POST', /^\/api\/apps\/import$/, async (req, res) => {
  const { url } = await readJson(req);
  let u;
  try { u = new URL(String(url)); } catch { return fail(res, 400, 'Enter a valid link'); }
  if (!/^https?:$/.test(u.protocol)) return fail(res, 400, 'Link must start with http or https');
  const job = newJob();
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
      job.result = { app: appView(rec) };
      job.status = 'done';
    } catch (e) {
      await rmQuiet(dest);
      job.error = e.message;
      job.status = 'error';
    }
  })();
});

route('PATCH', /^\/api\/apps\/([a-f0-9]{16})$/, async (req, res, m) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  const { name } = await readJson(req);
  if (typeof name === 'string' && name.trim()) app.name = name.trim().slice(0, 80);
  store.save();
  json(res, { app: appView(app) });
});

route('DELETE', /^\/api\/apps\/([a-f0-9]{16})$/, async (req, res, m) => {
  const i = store.apps.findIndex((a) => a.id === m[1]);
  if (i < 0) return fail(res, 404, 'App not found');
  store.apps.splice(i, 1);
  store.save();
  await rmQuiet(path.join(dirs.apps, m[1] + '.ipa'));
  await rmQuiet(path.join(dirs.apps, m[1] + '.png'));
  json(res, { ok: true });
});

route('GET', /^\/api\/apps\/([a-f0-9]{16})\/icon$/, (req, res, m) =>
  serveFile(req, res, path.join(dirs.apps, m[1] + '.png'), { cache: 'private, max-age=86400' }));

route('GET', /^\/api\/apps\/([a-f0-9]{16})\/download$/, (req, res, m) => {
  const app = store.apps.find((a) => a.id === m[1]);
  if (!app) return fail(res, 404, 'App not found');
  return serveFile(req, res, path.join(dirs.apps, m[1] + '.ipa'), { download: `${app.name} ${app.version}.ipa` });
});

// ----- certificates -----
async function checkCert(c) {
  const dir = path.join(dirs.certs, c.id);
  const r = await run(ZSIGN, ['-C', path.join(dir, 'cert.p12'), '-p', decrypt(c.password)], { timeout: 30000 });
  if (r.code === -1) return { status: 'unavailable', ocsp: 'zsign not installed', fields: {}, checkedAt: new Date().toISOString() };
  const parsed = parseCheckOutput(r.stdout.toString() + '\n' + r.stderr);
  return { ...parsed, checkedAt: new Date().toISOString() };
}

route('POST', /^\/api\/certs$/, async (req, res) => {
  const { p12UploadId, provUploadId, password = '', label } = await readJson(req);
  const p12File = tmpPath(p12UploadId);
  const provFile = tmpPath(provUploadId);

  let profile;
  try { profile = parseProvision(await fsp.readFile(provFile)); } catch (e) { return fail(res, 400, e.message); }
  let p12;
  try { p12 = await parseP12(p12File, String(password)); } catch (e) { return fail(res, 400, e.message); }

  const matches = profile.certs.length ? profile.certs.some((c) => c.sha1 === p12.sha1) : null;
  const certId = id();
  const dir = path.join(dirs.certs, certId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.rename(p12File, path.join(dir, 'cert.p12'));
  await fsp.rename(provFile, path.join(dir, 'profile.mobileprovision'));

  const rec = {
    id: certId,
    label: String(label || '').trim().slice(0, 60) || profile.teamName || p12.commonName,
    createdAt: new Date().toISOString(),
    password: encrypt(String(password)),
    p12, profile, matches,
  };
  store.certs.push(rec);
  if (!store.settings.defaultCertId) store.settings.defaultCertId = certId;
  store.save();

  rec.check = await checkCert(rec).catch(() => null);
  store.save();
  json(res, { cert: certView(rec) });
});

route('POST', /^\/api\/certs\/([a-f0-9]{16})\/check$/, async (req, res, m) => {
  const c = store.certs.find((x) => x.id === m[1]);
  if (!c) return fail(res, 404, 'Certificate not found');
  c.check = await checkCert(c);
  store.save();
  json(res, { cert: certView(c) });
});

route('PATCH', /^\/api\/certs\/([a-f0-9]{16})$/, async (req, res, m) => {
  const c = store.certs.find((x) => x.id === m[1]);
  if (!c) return fail(res, 404, 'Certificate not found');
  const body = await readJson(req);
  if (typeof body.label === 'string' && body.label.trim()) c.label = body.label.trim().slice(0, 60);
  if (body.makeDefault) store.settings.defaultCertId = c.id;
  store.save();
  json(res, { cert: certView(c) });
});

route('DELETE', /^\/api\/certs\/([a-f0-9]{16})$/, async (req, res, m) => {
  const i = store.certs.findIndex((x) => x.id === m[1]);
  if (i < 0) return fail(res, 404, 'Certificate not found');
  store.certs.splice(i, 1);
  if (store.settings.defaultCertId === m[1]) store.settings.defaultCertId = store.certs[0] ? store.certs[0].id : null;
  store.save();
  await rmQuiet(path.join(dirs.certs, m[1]));
  json(res, { ok: true });
});

// ----- signing -----
route('POST', /^\/api\/sign$/, async (req, res) => {
  const b = await readJson(req);
  const app = store.apps.find((a) => a.id === b.appId);
  if (!app) return fail(res, 404, 'App not found');
  const cert = store.certs.find((c) => c.id === (b.certId || store.settings.defaultCertId));
  if (!cert) return fail(res, 400, 'Add a certificate first');
  if (!zsignVersion) return fail(res, 500, 'zsign is not installed on the server');

  const iconFile = b.iconUploadId ? tmpPath(b.iconUploadId) : null;
  const dylibFiles = (Array.isArray(b.dylibs) ? b.dylibs : []).slice(0, 20).map((d) => ({
    file: tmpPath(d.uploadId),
    name: String(d.name || 'tweak.dylib').replace(/[^\w.\-+]/g, '_').replace(/^\.+/, '') || 'tweak.dylib',
  }));

  const opts = {
    name: String(b.name || '').trim().slice(0, 80),
    bundleId: String(b.bundleId || '').trim(),
    version: String(b.version || '').trim(),
    minOS: String(b.minOS || '').trim(),
  };
  if (opts.bundleId && !/^[A-Za-z0-9.\-]+$/.test(opts.bundleId)) return fail(res, 400, 'Bundle ID can only use letters, numbers, dots and dashes');
  if (opts.version && !/^[0-9A-Za-z.\-]+$/.test(opts.version)) return fail(res, 400, 'Version looks invalid');
  if (opts.minOS && !/^\d+(\.\d+){0,2}$/.test(opts.minOS)) return fail(res, 400, 'Minimum iOS should look like 14.0');

  const job = newJob();
  json(res, { jobId: job.id });

  (async () => {
    const work = path.join(dirs.work, job.id);
    const signedId = id();
    const out = path.join(dirs.signed, signedId + '.ipa');
    try {
      await fsp.mkdir(work, { recursive: true });
      const certDir = path.join(dirs.certs, cert.id);
      const args = [
        '-f',
        '-k', path.join(certDir, 'cert.p12'),
        '-p', decrypt(cert.password),
        '-m', path.join(certDir, 'profile.mobileprovision'),
        '-o', out,
        '-t', work,
        '-z', String(Math.min(9, Math.max(0, Number(store.settings.zipLevel ?? 6)))),
      ];
      if (opts.bundleId) args.push('-b', opts.bundleId);
      if (opts.name) args.push('-n', opts.name);
      if (opts.version) args.push('-r', opts.version);
      if (opts.minOS) args.push('-M', opts.minOS);
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
      args.push(path.join(dirs.apps, app.id + '.ipa'));

      job.log.push(`Signing ${app.name} with ${cert.label}…`);
      const code = await runLogged(ZSIGN, args, job);
      if (code !== 0 || !fs.existsSync(out)) {
        const last = job.log.filter((l) => /error|fail|invalid|can't|cannot|unable/i.test(l)).pop();
        throw new Error(last || `zsign exited with code ${code}`);
      }

      job.log.push('Reading signed app…');
      const meta = await ipa.inspect(out);
      if (meta.icon) await fsp.writeFile(path.join(dirs.signed, signedId + '.png'), meta.icon);
      else if (app.hasIcon) await fsp.copyFile(path.join(dirs.apps, app.id + '.png'), path.join(dirs.signed, signedId + '.png'));

      const rec = {
        id: signedId, token: token(), appId: app.id, certId: cert.id, certLabel: cert.label,
        name: meta.name, bundleId: meta.bundleId, version: meta.version, build: meta.build,
        size: meta.size, hasIcon: !!meta.icon || !!app.hasIcon, signedAt: new Date().toISOString(),
        expires: cert.profile.expires, options: { ...opts, icon: !!iconFile, dylibs: dylibFiles.map((d) => d.name) },
      };
      store.signed.unshift(rec);
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
  })();
});

route('GET', /^\/api\/jobs\/([a-f0-9]{16})$/, (req, res, m) => {
  const job = jobs.get(m[1]);
  if (!job) return fail(res, 404, 'Job not found');
  json(res, { status: job.status, log: job.log.slice(-30), error: job.error, result: job.result, progress: job.progress ?? null });
});

route('DELETE', /^\/api\/signed\/([a-f0-9]{16})$/, async (req, res, m) => {
  const i = store.signed.findIndex((s) => s.id === m[1]);
  if (i < 0) return fail(res, 404, 'Not found');
  store.signed.splice(i, 1);
  store.save();
  await rmQuiet(path.join(dirs.signed, m[1] + '.ipa'));
  await rmQuiet(path.join(dirs.signed, m[1] + '.png'));
  json(res, { ok: true });
});

route('POST', /^\/api\/signed\/([a-f0-9]{16})\/relink$/, async (req, res, m) => {
  const s = store.signed.find((x) => x.id === m[1]);
  if (!s) return fail(res, 404, 'Not found');
  s.token = token();
  store.save();
  json(res, { signed: signedView(s, req) });
});

route('PATCH', /^\/api\/settings$/, async (req, res) => {
  const b = await readJson(req);
  if (b.zipLevel !== undefined) store.settings.zipLevel = Math.min(9, Math.max(0, Number(b.zipLevel) || 0));
  if (b.autoInstall !== undefined) store.settings.autoInstall = !!b.autoInstall;
  store.save();
  json(res, { settings: store.settings });
});

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
}, { open: true });

route('GET', /^\/i\/([\w-]{20,40})\/app\.ipa$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s) return fail(res, 404, 'Link expired');
  return serveFile(req, res, path.join(dirs.signed, s.id + '.ipa'), { download: `${s.name}.ipa` });
}, { open: true });

route('GET', /^\/i\/([\w-]{20,40})\/icon\.png$/, (req, res, m) => {
  const s = findByToken(m[1]);
  if (!s) return fail(res, 404, 'Not found');
  return serveFile(req, res, path.join(dirs.signed, s.id + '.png'), { cache: 'public, max-age=86400' });
}, { open: true });

route('GET', /^\/i\/([\w-]{20,40})\/?$/, async (req, res, m) => {
  const s = findByToken(m[1]);
  const tpl = await fsp.readFile(path.join(PUBLIC_DIR, 'install.html'), 'utf8');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  if (!s) return send(res, 404, tpl.replace(/{{(\w+)}}/g, (_, k) => esc({ title: 'Link expired', name: 'This link has expired', meta: 'Ask for a new install link.', icon: '/icon-180.png', install: '#', hidden: 'hidden' }[k] || '')), { 'Content-Type': 'text/html; charset=utf-8' });
  const v = signedView(s, req);
  const html = tpl.replace(/{{(\w+)}}/g, (_, k) => esc({
    title: `Install ${s.name}`, name: s.name,
    meta: `Version ${s.version || '?'} · ${(s.size / 1048576).toFixed(1)} MB`,
    icon: s.hasIcon ? `/i/${s.token}/icon.png` : '/icon-180.png',
    install: v.installUrl, hidden: '',
  }[k] ?? ''));
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}, { open: true });

// ----- icons -----
const iconCache = {};
route('GET', /^\/(?:apple-touch-icon(?:-precomposed)?|icon-(\d+))\.png$/, (req, res, m) => {
  const size = Math.min(1024, Math.max(32, Number(m[1]) || 180));
  iconCache[size] = iconCache[size] || drawAppIcon(size);
  send(res, 200, iconCache[size], { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
}, { open: true });

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  req.query = url.searchParams;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  try {
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = pathname.match(r.pattern);
      if (!m) continue;
      if (!r.open && !isAuthed(req)) return fail(res, 401, 'Please log in');
      return await r.handler(req, res, m);
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
    if (st && Date.now() - st.mtimeMs > 864e5) await rmQuiet(p);
  }
}, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Mango Signer running on port ${PORT} (data: ${DATA_DIR})`);
  if (!APP_PASSWORD) console.log('WARNING: APP_PASSWORD is not set — anyone with the link can use your certificates.');
});
