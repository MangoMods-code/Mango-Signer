// Unpacks jailbreak .deb packages to pull out tweak .dylib files (and a CydiaSubstrate.framework, if it has one).
// Uses dpkg-deb, which comes with the Debian image the server runs on.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let p;
    try { p = spawn(cmd, args, opts); } catch (e) { return resolve({ code: -1, out, err: e.message }); }
    p.stdout.on('data', (d) => { if (out.length < 1e6) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

function parseControl(text) {
  const f = {};
  let last = null;
  for (const line of String(text).split('\n')) {
    if (/^\s/.test(line) && last) { f[last] += '\n' + line.trim(); continue; }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) { last = m[1].toLowerCase(); f[last] = m[2]; }
  }
  return f;
}

async function walk(dir, root = dir, out = []) {
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, root, out);
    else out.push({ full, rel: path.relative(root, full), link: ent.isSymbolicLink() });
  }
  return out;
}

// Follows a symlink inside the unpacked package. Absolute links point inside the package root.
async function realFile(root, file) {
  let p = file;
  for (let i = 0; i < 8; i++) {
    const st = await fsp.lstat(p).catch(() => null);
    if (!st) return null;
    if (!st.isSymbolicLink()) return st.isFile() ? p : null;
    const target = await fsp.readlink(p);
    p = target.startsWith('/') ? path.join(root, target) : path.resolve(path.dirname(p), target);
    if (!p.startsWith(root)) return null;
  }
  return null;
}

const TWEAK_DIR_RE = /(^|\/)(Library\/MobileSubstrate\/DynamicLibraries|usr\/lib\/TweakInject)\/[^/]+\.dylib$/i;

// Unpacks a .deb into `dest` and reports what's inside.
async function unpack(debFile, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const fields = await run('dpkg-deb', ['-f', debFile]);
  if (fields.code === -1) throw new Error("This server can't open .deb files (dpkg-deb is missing)");
  if (fields.code !== 0) throw new Error("That doesn't look like a valid .deb package");
  const x = await run('dpkg-deb', ['-x', debFile, dest]);
  if (x.code !== 0) throw new Error(`Couldn't unpack the .deb (${(x.err || '').trim().split('\n').pop() || 'unknown error'})`);
  const control = parseControl(fields.out);
  const files = await walk(dest);
  const tweaks = [];
  for (const f of files) {
    if (!TWEAK_DIR_RE.test(f.rel)) continue;
    const real = await realFile(dest, f.full);
    if (real) tweaks.push({ name: path.basename(f.rel), file: real });
  }
  // Loose .dylibs anywhere else (some packages put the tweak in an odd folder).
  if (!tweaks.length) {
    for (const f of files.filter((x) => /\.dylib$/i.test(x.rel))) {
      const real = await realFile(dest, f.full);
      if (real) tweaks.push({ name: path.basename(f.rel), file: real });
    }
  }
  const frameworkDir = files.map((f) => f.rel.match(/^(.*?CydiaSubstrate\.framework)\//)).find(Boolean);
  const bundles = [...new Set(files.map((f) => (f.rel.match(/(^|\/)Library\/Application Support\/([^/]+\.bundle)\//) || [])[2]).filter(Boolean))];
  const prefs = files.some((f) => /PreferenceBundles|PreferenceLoader/.test(f.rel));
  return {
    control: {
      package: control.package || '', name: control.name || control.package || '', version: control.version || '',
      author: (control.author || control.maintainer || '').replace(/\s*<[^>]*>/, ''), description: (control.description || '').slice(0, 600),
      depends: control.depends || '', arch: control.architecture || '',
    },
    tweaks,
    substrateFramework: frameworkDir ? path.join(dest, frameworkDir[1]) : null,
    bundles,
    hasPrefs: prefs,
  };
}

// Copies a framework folder, turning symlinks into real files (iOS apps can't ship symlinks that point outside).
async function copyFramework(root, src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    const real = await realFile(root, from);
    if (real) { await fsp.copyFile(real, to); continue; }
    const st = await fsp.stat(from).catch(() => null);
    if (st && st.isDirectory()) await copyFramework(root, from, to);
  }
}

module.exports = { unpack, copyFramework, parseControl, run };
