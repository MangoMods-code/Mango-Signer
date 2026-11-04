// Reads app info (name, bundle id, version, icon) from an .ipa file.
const { fileSource, urlSource, listEntriesFrom, readEntryFrom } = require('./zip');
const plist = require('./plist');
const { normalizePng, shrinkPng } = require('./png');

const APP_DIR_RE = /^Payload\/([^/]+\.app)\/$/;
const INFO_RE = /^Payload\/([^/]+\.app)\/Info\.plist$/;

function iconNames(info) {
  const names = new Set();
  const add = (list) => Array.isArray(list) && list.forEach((n) => typeof n === 'string' && names.add(n));
  for (const key of ['CFBundleIcons', 'CFBundleIcons~ipad']) {
    const primary = info[key] && info[key].CFBundlePrimaryIcon;
    if (primary && typeof primary === 'object') add(primary.CFBundleIconFiles);
    if (typeof primary === 'string') names.add(primary);
  }
  add(info.CFBundleIconFiles);
  if (typeof info.CFBundleIconFile === 'string') names.add(info.CFBundleIconFile);
  return [...names].map((n) => n.replace(/\.png$/i, ''));
}

// Works on a local path, or on { url, headers } to read a web link without downloading all of it.
async function inspect(target) {
  const src = typeof target === 'string' ? await fileSource(target) : await urlSource(target.url, { headers: target.headers });
  try {
    return await inspectFrom(src);
  } finally {
    await src.close();
  }
}

async function inspectFrom(src) {
  const entries = await listEntriesFrom(src);
  const infoEntry = entries.find((e) => INFO_RE.test(e.name));
  if (!infoEntry) throw new Error('This file has no app inside (missing Payload/*.app/Info.plist)');
  const appDir = infoEntry.name.slice(0, -'Info.plist'.length);

  const info = plist.parse(await readEntryFrom(src, infoEntry, 8 * 1024 * 1024));
  const { size } = src;

  // Pick a matching icon PNG at the top level of the .app folder: the smallest one that's still
  // sharp (150px+), going by the size in its name (AppIcon60x60@3x = 180px). Then shrink it to 180px.
  let icon = null;
  const names = iconNames(info);
  const topLevelPngs = entries.filter((e) => {
    if (!e.name.startsWith(appDir) || !/\.png$/i.test(e.name)) return false;
    const rest = e.name.slice(appDir.length);
    return !rest.includes('/');
  });
  let candidates = topLevelPngs.filter((e) => {
    const base = e.name.slice(appDir.length);
    return names.some((n) => base.startsWith(n));
  });
  if (!candidates.length) candidates = topLevelPngs.filter((e) => /icon/i.test(e.name));
  const hint = (e) => {
    const m = e.name.slice(appDir.length).match(/(\d+(?:\.\d+)?)x\d+(?:\.\d+)?(?:@(\d)x)?/i);
    return m ? Number(m[1]) * Number(m[2] || 1) : 0;
  };
  const rank = (e) => { const h = hint(e); return h >= 150 ? h : h ? 10000 - h : 5000; };
  candidates.sort((a, b) => rank(a) - rank(b) || b.size - a.size);
  for (const c of candidates.slice(0, 4)) {
    try {
      const png = normalizePng(await readEntryFrom(src, c, 4 * 1024 * 1024));
      if (png) { icon = shrinkPng(png, 180); break; }
    } catch { /* try next */ }
  }
  // A sharper copy (up to 512px) for big pictures like Telegram posts: the biggest icon file in the app.
  let iconHd = null;
  const big = [...new Set([...candidates, ...topLevelPngs.filter((e) => /icon/i.test(e.name))])].sort((a, b) => b.size - a.size);
  for (const c of big.slice(0, 3)) {
    try {
      const png = normalizePng(await readEntryFrom(src, c, 8 * 1024 * 1024));
      if (png) { iconHd = shrinkPng(png, 512); break; }
    } catch { /* try next */ }
  }

  const appex = new Set();
  for (const e of entries) {
    const m = e.name.match(/^Payload\/[^/]+\.app\/(PlugIns|Extensions)\/([^/]+\.appex)\//);
    if (m) appex.add(m[2]);
  }
  const hasWatch = entries.some((e) => e.name.startsWith(appDir + 'Watch/'));

  return {
    name: info.CFBundleDisplayName || info.CFBundleName || info.CFBundleExecutable || 'Unknown App',
    bundleId: info.CFBundleIdentifier || '',
    version: info.CFBundleShortVersionString || info.CFBundleVersion || '',
    build: info.CFBundleVersion || '',
    minOS: info.MinimumOSVersion || '',
    executable: info.CFBundleExecutable || '',
    extensions: appex.size,
    hasWatch,
    size,
    icon,
    iconHd,
  };
}

module.exports = { inspect };
