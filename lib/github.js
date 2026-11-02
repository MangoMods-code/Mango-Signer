// Tiny GitHub client for keeping library apps in a (private) repo's Release.
const fs = require('fs');
const { Readable, Transform } = require('stream');

const API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const UPLOADS = (process.env.GITHUB_UPLOADS || 'https://uploads.github.com').replace(/\/$/, '');

function client({ owner, repo, token }) {
  const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers = (extra = {}) => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Mango-Signer',
    ...extra,
  });

  async function call(method, url, body) {
    let r;
    try {
      r = await fetch(url.startsWith('http') ? url : base + url, {
        method,
        headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'GitHub took too long to answer. Try again.' : `Couldn't reach GitHub (${e.message})`);
    }
    let data = null;
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) {
      const msg = (data && data.message) || `HTTP ${r.status}`;
      throw Object.assign(new Error(friendly(r.status, msg)), { status: r.status, ghMessage: msg });
    }
    return data;
  }

  function friendly(status, msg) {
    if (status === 401) return 'GitHub rejected the token. Make a new one and paste it again.';
    if (status === 403 && /rate limit/i.test(msg)) return 'GitHub rate limit reached. Try again in a few minutes.';
    if (status === 403) return "The token doesn't have permission for this repo. Give it Contents: Read and write.";
    if (status === 404) return "Couldn't find that repo. Check the name, and make sure the token can access it.";
    if (status === 422 && /empty/i.test(msg)) return 'That repo is empty. Add a README (any file) to it on GitHub first, then try again.';
    return `GitHub: ${msg}`;
  }

  return {
    owner, repo,
    getRepo: () => call('GET', ''),

    async ensureRelease(tag) {
      try {
        return await call('GET', `/releases/tags/${encodeURIComponent(tag)}`);
      } catch (e) {
        if (e.status !== 404) throw e;
        return call('POST', '/releases', {
          tag_name: tag, name: 'Mango Library',
          body: 'App files for Mango Signer. Add .ipa files here and they show up in your library.',
          draft: false, prerelease: false,
        });
      }
    },

    async listAssets(releaseId) {
      const out = [];
      for (let page = 1; page <= 30; page++) {
        const list = await call('GET', `/releases/${releaseId}/assets?per_page=100&page=${page}`);
        out.push(...list);
        if (list.length < 100) break;
      }
      return out;
    },

    deleteAsset: (assetId) => call('DELETE', `/releases/assets/${assetId}`).catch((e) => { if (e.status !== 404) throw e; }),

    // Download link + headers for an asset (works for private repos; GitHub redirects to a short-lived link).
    download(assetId) {
      return { url: `${base}/releases/assets/${assetId}`, headers: headers({ Accept: 'application/octet-stream' }) };
    },

    uploadAsset(releaseId, name, filePath, size, onProgress, signal) {
      return this.uploadStream(releaseId, name, Readable.toWeb(fs.createReadStream(filePath)), size, onProgress, signal);
    },

    // Uploads from any stream (a file, or another download) without saving it to disk first.
    async uploadStream(releaseId, name, webStream, size, onProgress, signal) {
      let sent = 0;
      // Gives up if no data moves for 2 minutes, so a stuck transfer can't hang forever.
      const idle = new AbortController();
      let idleTimer;
      const kick = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new Error('The upload to GitHub stalled (nothing moved for 2 minutes). Try again.')), 120000); };
      kick();
      signal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
      const counter = new Transform({
        transform(chunk, _e, cb) { sent += chunk.length; kick(); if (onProgress) onProgress(sent / size); cb(null, chunk); },
      });
      const src = Readable.fromWeb(webStream);
      src.on('error', (e) => counter.destroy(e));
      const body = Readable.toWeb(src.pipe(counter));
      const url = `${UPLOADS}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }),
          body,
          duplex: 'half',
          signal,
        });
      } catch (e) {
        if (idle.signal.aborted) throw idle.signal.reason;
        throw e;
      } finally {
        clearTimeout(idleTimer);
      }
      let data = null;
      try { data = await r.json(); } catch { /* */ }
      if (!r.ok) {
        const msg = (data && data.message) || `HTTP ${r.status}`;
        const extra = data && Array.isArray(data.errors) && data.errors.some((x) => x.code === 'already_exists') ? ' (a file with that name already exists)' : '';
        throw Object.assign(new Error(friendly(r.status, msg) + extra), { status: r.status });
      }
      return data;
    },
  };
}

module.exports = { client };
