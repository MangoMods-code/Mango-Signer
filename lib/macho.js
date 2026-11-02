// Reads and edits the libraries a Mach-O binary (a .dylib tweak) links against.
// Used to point jailbreak tweaks at a CydiaSubstrate.framework bundled inside the app.

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

const DYLIB_CMDS = new Set([
  0xc, // LC_LOAD_DYLIB
  0x80000018, // LC_LOAD_WEAK_DYLIB
  0x8000001f, // LC_REEXPORT_DYLIB
  0x20, // LC_LAZY_LOAD_DYLIB
  0x80000023, // LC_LOAD_UPWARD_DYLIB
]);
const LC_ID_DYLIB = 0xd;
const LC_RPATH = 0x8000001c;

// Offsets of each architecture slice in the file.
function slices(buf) {
  if (buf.length < 8) return [];
  const be = buf.readUInt32BE(0);
  if (be === FAT_MAGIC || be === FAT_MAGIC_64) {
    const n = buf.readUInt32BE(4);
    const out = [];
    const step = be === FAT_MAGIC_64 ? 32 : 20;
    for (let i = 0; i < n && i < 16; i++) {
      const at = 8 + i * step;
      if (at + step > buf.length) break;
      const offset = be === FAT_MAGIC_64 ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8);
      if (offset < buf.length) out.push(offset);
    }
    return out;
  }
  const le = buf.readUInt32LE(0);
  return le === MH_MAGIC || le === MH_MAGIC_64 ? [0] : [];
}

const isMachO = (buf) => slices(buf).length > 0;

// Calls fn(cmd, cmdOffset, cmdSize) for every load command in every slice.
function eachCommand(buf, fn) {
  for (const base of slices(buf)) {
    const magic = buf.readUInt32LE(base);
    if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) continue;
    const ncmds = buf.readUInt32LE(base + 16);
    let p = base + (magic === MH_MAGIC_64 ? 32 : 28);
    for (let i = 0; i < ncmds && p + 8 <= buf.length; i++) {
      const cmd = buf.readUInt32LE(p);
      const size = buf.readUInt32LE(p + 4);
      if (size < 8 || p + size > buf.length) break;
      fn(cmd, p, size);
      p += size;
    }
  }
}

function readStr(buf, start, end) {
  let e = start;
  while (e < end && buf[e] !== 0) e++;
  return buf.toString('utf8', start, e);
}

// What this binary links to (unique), its own install name and its rpaths.
function info(buf) {
  const deps = new Set();
  const rpaths = new Set();
  let id = null;
  eachCommand(buf, (cmd, p, size) => {
    if (DYLIB_CMDS.has(cmd)) deps.add(readStr(buf, p + buf.readUInt32LE(p + 8), p + size));
    else if (cmd === LC_ID_DYLIB) id = readStr(buf, p + buf.readUInt32LE(p + 8), p + size);
    else if (cmd === LC_RPATH) rpaths.add(readStr(buf, p + buf.readUInt32LE(p + 8), p + size));
  });
  return { deps: [...deps], id, rpaths: [...rpaths] };
}

// Rewrites linked library paths in place. map(oldPath) returns a new path or null to keep it.
// A new path must fit in the space the old command has, so it's only ever made shorter or equal.
function rewriteDeps(buf, map) {
  let changed = 0;
  const skipped = [];
  eachCommand(buf, (cmd, p, size) => {
    if (!DYLIB_CMDS.has(cmd)) return;
    const strAt = p + buf.readUInt32LE(p + 8);
    const old = readStr(buf, strAt, p + size);
    const next = map(old);
    if (!next || next === old) return;
    const room = p + size - strAt;
    const bytes = Buffer.from(next, 'utf8');
    if (bytes.length + 1 > room) { skipped.push(old); return; }
    buf.fill(0, strAt, p + size);
    bytes.copy(buf, strAt);
    changed++;
  });
  return { changed, skipped };
}

// ----- tweak helpers -----
const SUBSTRATE_RE = /(CydiaSubstrate\.framework\/CydiaSubstrate|libsubstrate\.dylib|libsubstitute(\.0)?\.dylib|libellekit\.dylib|libhooker\.dylib)$/i;
const SUBSTRATE_PATH = '@rpath/CydiaSubstrate.framework/CydiaSubstrate';
// Libraries only found on jailbroken phones (other than Substrate itself).
const JB_ONLY_RE = /^(\/var\/jb\/|\/Library\/(Frameworks|MobileSubstrate)\/|\/usr\/lib\/(lib(colorpicker|cephei|cepheiprefs|rocketbootstrap|activator|applist|sparkapplist|sparkcolourpicker|gcuniversal|alderis|powercuts|mryipc|jbroot|roothide|rootless)[^/]*\.dylib|TweakInject\/))/i;

// Looks at a tweak .dylib: does it need Substrate, and anything else a non-jailbroken phone won't have?
function inspectTweak(buf) {
  if (!isMachO(buf)) return { ok: false, error: "That file isn't an iOS library (.dylib)" };
  const { deps } = info(buf);
  const needsSubstrate = deps.some((d) => SUBSTRATE_RE.test(d));
  const missing = deps.filter((d) => !SUBSTRATE_RE.test(d) && JB_ONLY_RE.test(d)).map((d) => d.split('/').pop());
  return { ok: true, deps, needsSubstrate, missing: [...new Set(missing)] };
}

// Points every Substrate-style link at the framework Mango bundles into the app.
function patchForSubstrate(buf) {
  return rewriteDeps(buf, (d) => (SUBSTRATE_RE.test(d) && d !== SUBSTRATE_PATH ? SUBSTRATE_PATH : null));
}

module.exports = { isMachO, info, rewriteDeps, inspectTweak, patchForSubstrate, SUBSTRATE_PATH };
