// Reads app info (name, bundle id, version, icon) from an .ipa file.
const { fileSource, urlSource, listEntriesFrom, readEntryFrom } = require('./zip');
const plist = require('./plist');
const { normalizePng } = require('./png');

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

  // Pick the largest matching icon PNG at the top level of the .app folder.
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
  candidates.sort((a, b) => b.size - a.size);
  for (const c of candidates.slice(0, 4)) {
    try {
      const png = normalizePng(await readEntryFrom(src, c, 4 * 1024 * 1024));
      if (png) { icon = png; break; }
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
  };
}

module.exports = { inspect };
