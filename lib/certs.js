// Reads .mobileprovision profiles and .p12 certificates.
const crypto = require('crypto');
const { spawn } = require('child_process');
const plist = require('./plist');

function run(cmd, args, { input, env, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = Buffer.alloc(0), stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { stdout = Buffer.concat([stdout, d]); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

function certInfo(x509) {
  const cn = (x509.subject.match(/CN=([^\n]+)/) || [])[1] || x509.subject;
  return {
    commonName: cn.trim(),
    validFrom: new Date(x509.validFrom).toISOString(),
    validTo: new Date(x509.validTo).toISOString(),
    serial: x509.serialNumber,
    sha1: crypto.createHash('sha1').update(x509.raw).digest('hex').toUpperCase(),
  };
}

function parseProvision(buf) {
  const start = buf.indexOf('<?xml');
  const end = buf.indexOf('</plist>');
  if (start < 0 || end < 0) throw new Error("That doesn't look like a .mobileprovision file");
  const p = plist.parse(buf.subarray(start, end + '</plist>'.length));
  const ent = p.Entitlements || {};
  const appIdFull = ent['application-identifier'] || '';
  const teamId = (p.TeamIdentifier && p.TeamIdentifier[0]) || appIdFull.split('.')[0] || '';
  const appId = appIdFull.startsWith(teamId + '.') ? appIdFull.slice(teamId.length + 1) : appIdFull;
  const devices = Array.isArray(p.ProvisionedDevices) ? p.ProvisionedDevices : [];

  let type = 'App Store';
  if (p.ProvisionsAllDevices) type = 'Enterprise';
  else if (devices.length && ent['get-task-allow']) type = 'Development';
  else if (devices.length) type = 'Ad Hoc';

  const certs = (p.DeveloperCertificates || []).map((der) => {
    try { return certInfo(new crypto.X509Certificate(der)); } catch { return null; }
  }).filter(Boolean);

  return {
    name: p.Name || 'Profile',
    appIdName: p.AppIDName || '',
    teamName: p.TeamName || '',
    teamId,
    appId, // e.g. "*" or "com.example.app"
    wildcard: appId.endsWith('*'),
    type,
    deviceCount: devices.length,
    devices,
    created: p.CreationDate ? new Date(p.CreationDate).toISOString() : null,
    expires: p.ExpirationDate ? new Date(p.ExpirationDate).toISOString() : null,
    uuid: p.UUID || '',
    certs,
    entitlements: Object.keys(ent),
  };
}

// Reads the signing certificate out of a .p12 using the openssl CLI.
async function parseP12(p12Path, password) {
  const env = { MANGO_P12_PASS: password || '' };
  const base = ['pkcs12', '-in', p12Path, '-clcerts', '-nokeys', '-passin', 'env:MANGO_P12_PASS'];
  let r = await run('openssl', base, { env });
  if (r.code !== 0 || !r.stdout.length) r = await run('openssl', [...base, '-legacy'], { env });
  if (r.code !== 0 || !r.stdout.length) {
    if (/mac verify|invalid password|bad decrypt/i.test(r.stderr)) throw new Error('Wrong password for this .p12');
    throw new Error("Couldn't read the .p12 (wrong password or not a certificate file)");
  }
  const pem = r.stdout.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!pem) throw new Error('No certificate found inside the .p12');
  return certInfo(new crypto.X509Certificate(pem[0]));
}

module.exports = { parseProvision, parseP12, run };
