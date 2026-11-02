// Looks apps up on the App Store (Apple's free public lookup) to find their category, developer,
// description and screenshots. Used to sort apps into categories automatically.
const API = (process.env.ITUNES_API || 'https://itunes.apple.com').replace(/\/$/, '');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function view(r) {
  return {
    name: r.trackName || '', genre: r.primaryGenreName || '', genres: r.genres || [],
    developer: r.artistName || r.sellerName || '', description: String(r.description || '').slice(0, 1500),
    screenshots: (r.screenshotUrls || []).slice(0, 8), icon: r.artworkUrl512 || r.artworkUrl100 || '',
    url: r.trackViewUrl || '', bundleId: r.bundleId || '',
  };
}

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mango-Signer' }, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// By bundle ID first (exact), then by name (only if the name really matches, so a mod doesn't get a random app).
async function lookup({ bundleId, name }, country = 'us') {
  if (bundleId) {
    const d = await get(`${API}/lookup?bundleId=${encodeURIComponent(bundleId)}&country=${country}&entity=software`);
    const r = d && Array.isArray(d.results) && d.results.find((x) => x.kind === 'software' || x.wrapperType === 'software');
    if (r) return { ...view(r), matchedBy: 'bundleId' };
  }
  const clean = String(name || '').replace(/\s*[\[(].*?[\])]\s*/g, ' ').replace(/\b(\+\+|hack(s|ed)?|mod(ded)?|tweaked|ipa|v?\d+(\.\d+)+)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length >= 3) {
    const d = await get(`${API}/search?term=${encodeURIComponent(clean)}&country=${country}&entity=software&limit=5`);
    const want = norm(clean);
    const r = d && Array.isArray(d.results) && d.results.find((x) => {
      const n = norm(x.trackName);
      return n === want || (want.length >= 5 && (n.startsWith(want) || want.startsWith(n)));
    });
    if (r) return { ...view(r), matchedBy: 'name' };
  }
  return null;
}

module.exports = { lookup };
