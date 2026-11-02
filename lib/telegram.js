// Runs and talks to the Telegram helper (lib/telegram_helper.py, which uses Telethon).
// The helper only listens on 127.0.0.1 and needs a random token, so nothing outside the server can use it.
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PYTHON = process.env.TG_PYTHON || 'python3';
const SCRIPT = process.env.TG_HELPER || path.join(__dirname, 'telegram_helper.py');

function createHelper() {
  let proc = null;
  let port = 0;
  let token = '';
  let starting = null;
  let creds = null; // { apiId, apiHash, session }
  let lastError = null;
  let restarts = 0;

  function stop() {
    if (proc) { proc.removeAllListeners('exit'); proc.kill('SIGTERM'); }
    proc = null; port = 0; starting = null;
  }

  function start(next) {
    if (next) creds = next;
    if (!creds) return Promise.reject(new Error('Telegram is not connected'));
    if (proc && port) return Promise.resolve();
    if (starting) return starting;
    token = crypto.randomBytes(24).toString('hex');
    starting = new Promise((resolve, reject) => {
      let out = '';
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) { lastError = err.message; starting = null; reject(err); } else { lastError = null; restarts = 0; resolve(); }
      };
      try {
        proc = spawn(PYTHON, ['-u', SCRIPT], {
          env: {
            PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', PYTHONUNBUFFERED: '1',
            TG_PORT: '0', TG_TOKEN: token, TG_API_ID: String(creds.apiId), TG_API_HASH: creds.apiHash, TG_SESSION: creds.session || '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        return finish(new Error(`Couldn't start the Telegram helper (${e.message})`));
      }
      const timer = setTimeout(() => finish(new Error('The Telegram helper took too long to start')), 30000);
      proc.on('error', (e) => finish(new Error(e.code === 'ENOENT' ? 'Python isn\'t installed on the server, so Telegram can\'t run. Redeploy with the new Dockerfile.' : e.message)));
      proc.stdout.on('data', (d) => {
        out += d;
        const m = out.match(/READY (\d+)/);
        if (m && !port) { port = Number(m[1]); starting = null; finish(); }
        const er = out.match(/ERROR ([^\n]+)/);
        if (er) finish(new Error(/telethon/i.test(er[1]) ? 'The Telegram library (Telethon) isn\'t installed on the server. Redeploy with the new Dockerfile.' : er[1]));
        if (out.length > 4000) out = out.slice(-2000);
      });
      proc.stderr.on('data', (d) => {
        const t = String(d);
        if (/Traceback|Error/.test(t)) lastError = t.trim().split('\n').pop().slice(0, 300);
      });
      proc.on('exit', (code) => {
        const wasReady = !!port;
        proc = null; port = 0; starting = null;
        if (!done) finish(new Error(lastError || `The Telegram helper stopped (code ${code})`));
        // Came up fine before and then crashed: bring it back, slowing down if it keeps crashing.
        if (wasReady && creds && restarts < 20) {
          restarts++;
          setTimeout(() => start().catch(() => {}), Math.min(60000, 2000 * restarts));
        }
      });
    });
    return starting;
  }

  async function call(method, route, body) {
    await start();
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { 'X-Mango-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(route.startsWith('/posts') ? 180000 : 90000),
      });
    } catch (e) {
      throw Object.assign(new Error(e.name === 'TimeoutError' ? 'Telegram took too long to answer. Try again in a minute.' : `Couldn't reach the Telegram helper (${e.message})`), { status: 502 });
    }
    let data = null;
    try { data = await r.json(); } catch { /* */ }
    if (!r.ok) throw Object.assign(new Error((data && data.error) || `Telegram helper error (HTTP ${r.status})`), { status: r.status === 401 ? 401 : r.status >= 500 ? 502 : r.status });
    return data;
  }

  const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  return {
    start, stop, call,
    get running() { return !!(proc && port); },
    get lastError() { return lastError; },
    get hasCreds() { return !!creds; },
    setSession(session) { if (creds) creds.session = session; },
    status: () => call('GET', '/status'),
    channel: (ref) => call('GET', `/channel?${q({ ref })}`),
    posts: (ref, minId = 0, limit = 50, offsetId = 0) => call('GET', `/posts?${q({ ref, min_id: minId, limit, offset_id: offsetId })}`),
    exists: (ref, ids) => call('GET', `/messages?${q({ ref, ids: ids.join(',') })}`),
    // A URL + header for one post's file. Supports Range requests, so app info can be read without downloading it all.
    async file(ref, msgId) {
      await start();
      return { url: `http://127.0.0.1:${port}/file?${q({ ref, msg: msgId })}`, headers: { 'X-Mango-Token': token } };
    },
  };
}

module.exports = { createHelper };
