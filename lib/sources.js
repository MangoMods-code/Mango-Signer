// Reads app sources in the AltStore / SideStore format (and the older flat ESign/Scarlet style).
// Only metadata and download links are kept — no app files.

// Turns GitHub page links into raw file links, so people can paste whatever link they have.
function normalizeSourceUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error('Enter a valid link'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Link must start with http or https');
  if (u.hostname === 'github.com') {
    // github.com/owner/repo/blob/branch/path -> raw.githubusercontent.com/owner/repo/branch/path
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  return u.toString();
}

const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());

function parseVersions(app) {
  let list = [];
  if (Array.isArray(app.versions) && app.versions.length) {
    list = app.versions.map((v) => ({
      version: str(v.version, 60),
      date: str(v.date || v.versionDate, 40),
      url: str(v.downloadURL || v.downloadUrl || v.url, 2000),
      size: num(v.size),
      minOS: str(v.minOSVersion || v.minimumOSVersion, 20),
      notes: str(v.localizedDescription || v.versionDescription, 1500),
      channel: str(v.releaseChannel, 30),
    }));
  } else {
    // Older flat style: the app itself has version/downloadURL.
    list = [{
      version: str(app.version, 60),
      date: str(app.versionDate || app.date, 40),
      url: str(app.downloadURL || app.downloadUrl || app.down, 2000),
      size: num(app.size),
      minOS: str(app.minOSVersion, 20),
      notes: str(app.versionDescription, 1500),
      channel: '',
    }];
  }
  return list.filter((v) => isUrl(v.url)).slice(0, 15);
}

function parseScreens(app) {
  const out = [];
  const add = (u) => { if (isUrl(u)) out.push(u.trim()); else if (u && isUrl(u.imageURL)) out.push(u.imageURL.trim()); };
  if (Array.isArray(app.screenshotURLs)) app.screenshotURLs.forEach(add);
  const s = app.screenshots;
  if (Array.isArray(s)) s.forEach(add);
  else if (s && typeof s === 'object') ['iphone', 'ipad'].forEach((k) => Array.isArray(s[k]) && s[k].forEach(add));
  return [...new Set(out)].slice(0, 8);
}

// Some sources leave out an app's name. Work it out from other fields, then from the download's file name
// ("YouTube_19.2_Injected.ipa" -> "YouTube").
const TAG_WORDS = /^(injected|tweaked|patched|cracked|modded|mod|unlocked|premium|pro|vip|plus|deluxe|ipa|decrypted|dumped|signed|unsigned|latest|new|app|ios|by|with|and|v)$/i;
function guessName(a, versions) {
  for (const k of ['title', 'appName', 'app_name', 'displayName', 'bundleName', 'CFBundleDisplayName', 'CFBundleName']) {
    const v = str(a[k], 80);
    if (v) return v;
  }
  const url = (versions[0] && versions[0].url) || '';
  let file = '';
  try { file = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch {}
  file = file.replace(/\.ipa$/i, '').replace(/[_+]+/g, ' ').replace(/\s*-\s*/g, ' ').replace(/[()[\]{}]/g, ' ');
  const words = [];
  for (const w of file.split(/\s+/).filter(Boolean)) {
    if (/^v?\d+([.,]\d+)+[a-z]?$/i.test(w) || /^v\d+$/i.test(w) || /^\d{3,}$/.test(w)) break; // stop at the version number
    if (TAG_WORDS.test(w) && words.length) break;
    words.push(w);
  }
  let name = words.join(' ').trim();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(name)) name = name.split('.').pop(); // a bundle ID as the file name
  if (name && name === name.toLowerCase()) name = name.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  if (name.length >= 2) return name.slice(0, 80);
  const bid = str(a.bundleIdentifier || a.bundleID || a.bundleId, 200);
  if (bid) { const last = bid.split('.').pop(); if (last) return last.charAt(0).toUpperCase() + last.slice(1); }
  return 'Untitled';
}

function parseSource(data) {
  if (!data || typeof data !== 'object') throw new Error("That link isn't a source (it isn't JSON)");
  const rawApps = Array.isArray(data) ? data : Array.isArray(data.apps) ? data.apps : null;
  if (!rawApps) throw new Error("That file doesn't look like an app source (no apps list found)");
  const seen = new Map();
  const apps = [];
  const byName = new Map(); // apps with no bundle ID, by name: each version listed separately is merged into one app
  for (const a of rawApps.slice(0, 5000)) {
    if (!a || typeof a !== 'object') continue;
    const versions = parseVersions(a);
    if (!versions.length) continue; // nothing to download
    const name = str(a.name, 80) || guessName(a, versions);
    const bundleId = str(a.bundleIdentifier || a.bundleID || a.bundleId, 200);
    if (!bundleId) {
      const prev = byName.get(name.toLowerCase());
      if (prev) {
        for (const v of versions) if (!prev.versions.some((x) => x.url === v.url || (v.version && x.version === v.version))) prev.versions.push(v);
        continue;
      }
    }
    // Apps are matched by bundle ID across syncs, so a rename upstream doesn't create a duplicate.
    let key = (bundleId || `name:${name}`).toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) key += `#${n}`;
    const entry = {
      key, name, bundleId,
      developer: str(a.developerName || a.developer, 80),
      subtitle: str(a.subtitle, 200),
      description: str(a.localizedDescription || a.description || a.subtitle, 1500),
      iconURL: isUrl(a.iconURL) ? a.iconURL.trim() : isUrl(a.icon) ? a.icon.trim() : '',
      tint: str(a.tintColor, 12).replace(/^#?/, '#'),
      category: str(a.category, 40),
      screenshots: parseScreens(a),
      versions,
    };
    apps.push(entry);
    if (!bundleId) byName.set(name.toLowerCase(), entry);
  }
  // Merged apps: newest version first, at most 15 kept.
  const vnum = (v) => String(v.version || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const newer = (x, y) => {
    const a = vnum(x), b = vnum(y);
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (b[i] || 0) - (a[i] || 0);
    return String(y.date || '').localeCompare(String(x.date || ''));
  };
  for (const e of byName.values()) if (e.versions.length > 1) e.versions = e.versions.sort(newer).slice(0, 15);
  return {
    name: str(data.name, 80) || 'Source',
    identifier: str(data.identifier, 200),
    iconURL: isUrl(data.iconURL) ? data.iconURL.trim() : '',
    subtitle: str(data.subtitle || data.description, 300),
    apps,
  };
}

// Matches a source's category to one of yours (or suggests a new one).
const CATEGORY_ALIASES = [
  [/^(games?|gaming)$/i, 'Games'],
  [/^(emu|emus|emulators?|emulation)$/i, 'Emulators'],
  [/^(social|social networking|communication|messaging)$/i, 'Social'],
  [/^(movies?|music|video|photo-video|photo & video|entertainment|streaming|tv)$/i, 'Music & Video'],
  [/^(tools?|utilit(y|ies)|productivity|developer|developer tools)$/i, 'Utilities'],
  [/^(tweaked|tweaks?|modded|mods?)$/i, 'Tweaked'],
];
const CATEGORY_EMOJI = [
  [/lifestyle/i, '🌿'], [/sport/i, '⚽'], [/travel|navigation/i, '🧭'], [/food|drink/i, '🍔'], [/business/i, '💼'], [/book|reference/i, '📖'],
  [/weather/i, '🌤️'], [/medical/i, '🩺'], [/graphics|design/i, '🎨'], [/magazine|newspaper/i, '🗞️'], [/kids/i, '🧸'],
  [/sideload/i, '📲'], [/port/i, '🚢'], [/32 ?bit|legacy|old/i, '🕰️'], [/jailbreak/i, '🔓'],
  [/education|learn/i, '📚'], [/finance|money/i, '💸'], [/health|fitness/i, '💪'], [/news|read/i, '📰'], [/shop/i, '🛍️'],
];
function categoryFor(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  for (const [re, target] of CATEGORY_ALIASES) if (re.test(n)) return { name: target };
  const pretty = n.length <= 4 && n === n.toUpperCase() ? n : n.charAt(0).toUpperCase() + n.slice(1);
  const emoji = (CATEGORY_EMOJI.find(([re]) => re.test(n)) || [null, '📁'])[1];
  return { name: pretty, emoji };
}

module.exports = { normalizeSourceUrl, parseSource, categoryFor };
