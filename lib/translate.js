'use strict';
// Translates app descriptions that aren't in English, so the library reads the same everywhere.
// Two free services: DeepL (needs a free API key, 500,000 characters a month, best quality, works out the
// language itself) and MyMemory (no key, 5,000 characters a day, or 50,000 with an email address).

const LANG_NAMES = {
  ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ru: 'Russian', uk: 'Ukrainian', es: 'Spanish', pt: 'Portuguese',
  fr: 'French', de: 'German', it: 'Italian', id: 'Indonesian', tr: 'Turkish', vi: 'Vietnamese', th: 'Thai', fa: 'Persian',
  he: 'Hebrew', el: 'Greek', hi: 'Hindi', pl: 'Polish', nl: 'Dutch', ms: 'Malay',
};

const words = (s) => new Set(s.split(' '));
const EN = words('the and to of for with you your is this that it in on are be can from by app all new will not or an as at have more use get now just free no ads unlock premium features version support fixed added');
const LATIN = {
  es: words('de la que el en y los las del para con una por se su es al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también nuevo nueva versión aplicación'),
  pt: words('de que e o da do em para com um uma os no na se por mais não é as dos das como mas ao ele ou ser quando muito nos já está também só pelo pela nova versão aplicativo'),
  fr: words('de la le et les des en un une pour du est que dans avec sur pas plus ce qui ne au se par sont aux cette ou nouvelle version application'),
  de: words('der die und das ist nicht mit für den von zu ein eine auf auch sie es sich dem im des wird werden oder bei neue version'),
  it: words('di il che la per un una del della è con non sono le gli da nel alla anche più come questo nuova versione'),
  id: words('yang dan di untuk dengan ini itu dari ke tidak ada bisa akan dalam juga atau pada sudah baru versi aplikasi'),
  tr: words('ve bir bu için ile da de çok daha gibi olan sonra yeni sürüm uygulama'),
  pl: words('i w na z do nie się jest to że od po dla jak ale nowa wersja aplikacja'),
  nl: words('de het een en van is in op te met voor niet zijn dat die ook nieuwe versie'),
};

// Leaves out links, @names, #tags and emoji, which say nothing about the language.
const clean = (t) => String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/[@#][\w.]+/g, ' ').replace(/[\p{Extended_Pictographic}‍️]/gu, ' ');

/** The language code of `text` if it isn't English (and there's enough to tell), otherwise null. */
function detect(text) {
  const t = clean(text);
  const letters = t.match(/\p{L}/gu) || [];
  if (letters.length < 15) return null;
  const n = (re) => (t.match(re) || []).length;
  const share = (re) => n(re) / letters.length;
  if (share(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) > 0.05) return 'ja';
  if (share(/\p{Script=Han}/gu) > 0.2) return 'zh';
  if (share(/\p{Script=Hangul}/gu) > 0.2) return 'ko';
  if (share(/\p{Script=Cyrillic}/gu) > 0.25) return /[іїєґ]/i.test(t) ? 'uk' : 'ru';
  if (share(/\p{Script=Arabic}/gu) > 0.25) return /[پچژگ]/.test(t) ? 'fa' : 'ar';
  if (share(/\p{Script=Hebrew}/gu) > 0.25) return 'he';
  if (share(/\p{Script=Thai}/gu) > 0.25) return 'th';
  if (share(/\p{Script=Greek}/gu) > 0.25) return 'el';
  if (share(/\p{Script=Devanagari}/gu) > 0.25) return 'hi';
  if (n(/[ạảãắằẳẵặấầẩẫậẹẻẽếềểễệịỉĩọỏõốồổỗộớờởỡợụủũứừửữựỳỵỷỹđơư]/giu) >= 4) return 'vi';
  const ws = t.toLowerCase().match(/\p{L}+/gu) || [];
  let en = 0;
  const score = Object.fromEntries(Object.keys(LATIN).map((k) => [k, 0]));
  for (const w of ws) {
    if (EN.has(w)) en++;
    for (const [k, set] of Object.entries(LATIN)) if (set.has(w)) score[k]++;
  }
  const [best, bs] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return bs >= 3 && bs > en * 1.5 ? best : null;
}

class QuotaError extends Error {}

// Splits text into pieces of at most `max` bytes, at line or sentence ends where it can.
function pieces(text, max) {
  const out = [];
  let cur = '';
  const push = (s) => { if (s.trim()) out.push(s); };
  for (const part of text.split(/(?<=[\n.!?。！？])/u)) {
    if (Buffer.byteLength(cur + part) <= max) { cur += part; continue; }
    push(cur);
    cur = '';
    if (Buffer.byteLength(part) <= max) { cur = part; continue; }
    let chunk = '';
    for (const ch of part) { if (Buffer.byteLength(chunk + ch) > max) { push(chunk); chunk = ''; } chunk += ch; }
    cur = chunk;
  }
  push(cur);
  return out;
}

async function myMemory(text, from, email) {
  const outs = [];
  for (const p of pieces(text, 450)) {
    const u = new URL('https://api.mymemory.translated.net/get');
    u.searchParams.set('q', p);
    u.searchParams.set('langpair', `${from}|en`);
    if (email) u.searchParams.set('de', email);
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (r.status === 429) throw new QuotaError("MyMemory's free daily allowance is used up");
    const j = await r.json().catch(() => ({}));
    const t = j.responseData && j.responseData.translatedText;
    if (/MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS/i.test(t || '') || j.quotaFinished) throw new QuotaError("MyMemory's free daily allowance is used up");
    if (String(j.responseStatus) !== '200' || !t) throw new Error(j.responseDetails || `MyMemory said ${r.status}`);
    // Keep line breaks the way they were.
    outs.push(/\n$/.test(p) && !/\n$/.test(t) ? t + '\n' : t);
  }
  return outs.join(' ').replace(/ \n/g, '\n').trim();
}

async function deepl(texts, key) {
  const host = /:fx$/.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const body = new URLSearchParams();
  for (const t of texts) body.append('text', t);
  body.set('target_lang', 'EN-US');
  const r = await fetch(`${host}/v2/translate`, {
    method: 'POST', body,
    headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 456) throw new QuotaError("DeepL's free monthly allowance is used up");
  if (r.status === 403) throw new Error('DeepL turned down the API key. Check it in DeepL › Account › API Keys.');
  if (r.status === 429) throw new QuotaError('DeepL asked to slow down');
  if (!r.ok) throw new Error(`DeepL said ${r.status}`);
  const j = await r.json();
  return (j.translations || []).map((x) => ({ text: x.text, from: String(x.detected_source_language || '').toLowerCase() }));
}

/** Checks a DeepL key and returns how much of this month's allowance is used. */
async function deeplUsage(key) {
  const host = /:fx$/.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const r = await fetch(`${host}/v2/usage`, { headers: { Authorization: `DeepL-Auth-Key ${key}` }, signal: AbortSignal.timeout(15000) });
  if (r.status === 403) throw new Error("DeepL didn't accept that key. Copy it again from DeepL › Account › API Keys.");
  if (!r.ok) throw new Error(`DeepL said ${r.status}`);
  const j = await r.json();
  return { used: j.character_count || 0, limit: j.character_limit || 0 };
}

module.exports = { detect, myMemory, deepl, deeplUsage, QuotaError, LANG_NAMES, pieces };
