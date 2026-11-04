// Mango Signer's Telegram bot (the Bot API, with a token from @BotFather — not your own Telegram account).
// It announces new Mango Signer versions, iPhone app builds and library apps in your channels, and keeps
// your chat clean: anti-spam, a "tap to prove you're human" check for newcomers, banned words, flood
// control, and admin commands (/warn, /mute, /ban, /lock…).
//
// It asks Telegram for new messages itself (long polling), so nothing needs to be set up on Railway.

const API = (process.env.TELEGRAM_BOT_API || 'https://api.telegram.org').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nameOf = (u) => esc([u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'someone');
const mention = (u) => `<a href="tg://user?id=${u.id}">${nameOf(u)}</a>`;

const DEFAULTS = {
  announce: { server: true, ios: true, apps: true },
  repos: { server: 'MangoMods-code/Mango-Signer', ios: 'MangoMods-code/Mango-Signer-iOS' },
  mod: { antispam: true, captcha: true, cleanJoins: true, flood: true, newHours: 24, bannedWords: [] },
  welcome: 'Welcome to the Mango Signer chat, {name}! 🥭 Read the /rules and have fun.',
  rules: '1. Be nice.\n2. No spam, ads or links to other groups.\n3. Keep it about Mango Signer and sideloading.\n4. Admins have the final say.',
  brand: '🥭 Mango Signer',
  // Telegram username people can message to buy a certificate (shown at the bottom of build posts).
  contact: 'MangoOwnah',
};

// Telegram turns these off for everyone when the chat is locked, and for newcomers until they tap the button.
const NO_PERMS = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false,
  can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false,
  can_send_other_messages: false, can_add_web_page_previews: false,
};
const OPEN_PERMS = Object.fromEntries(Object.keys(NO_PERMS).map((k) => [k, true]));

function createBot(ctx) {
  // ctx: cfg() → the saved settings object (changed in place), save(), token() → bot token or null,
  // libraryApps() → public library apps, release(repo) → newest release, appLink(id), log(msg)
  let running = false;
  let gen = 0;
  let me = null;
  let lastError = null;
  let ticker = null;
  let ticks = 0;
  const adminCache = new Map(); // `${chat}:${user}` -> { is, at }
  const chatPerms = new Map(); // chat -> its normal permissions (to give back after the human check)
  const flood = new Map(); // `${chat}:${user}` -> [times]
  const pending = new Map(); // `${chat}:${user}` -> { msgId, until }

  const cfg = () => {
    const c = ctx.cfg();
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (c[k] === undefined) c[k] = JSON.parse(JSON.stringify(v));
      else if (v && typeof v === 'object' && !Array.isArray(v)) c[k] = { ...v, ...c[k] };
    }
    c.chats = c.chats || {};
    c.warns = c.warns || {};
    c.joined = c.joined || {};
    c.locked = c.locked || {};
    c.lastTags = c.lastTags || {};
    return c;
  };

  async function api(method, params = {}, { timeout = 20000, token } = {}) {
    const t = token || ctx.token();
    if (!t) throw new Error('No bot token');
    const form = typeof FormData !== 'undefined' && params instanceof FormData;
    let r;
    try {
      r = await fetch(`${API}/bot${t}/${method}`, {
        method: 'POST',
        headers: form ? undefined : { 'Content-Type': 'application/json' },
        body: form ? params : JSON.stringify(params),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      // Never pass on fetch's own message: it could include the address, which has the token in it.
      throw Object.assign(new Error(e.name === 'TimeoutError' ? 'Telegram took too long to answer' : "Couldn't reach Telegram"), { network: true });
    }
    const d = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!d.ok) {
      throw Object.assign(new Error(d.description || 'Telegram error'), { code: d.error_code || r.status, retryAfter: d.parameters && d.parameters.retry_after });
    }
    return d.result;
  }
  // Waits out "too many requests" once, so a burst of announcements doesn't get lost.
  async function call(method, params, opts) {
    try { return await api(method, params, opts); } catch (e) {
      if (e.code === 429 && e.retryAfter && e.retryAfter < 120) { await sleep((e.retryAfter + 1) * 1000); return api(method, params, opts); }
      throw e;
    }
  }
  const quiet = (p) => p.catch(() => null);
  const say = (chat, text, extra = {}) => call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  // A short notice that cleans itself up.
  async function notice(chat, text, ms = 20000, extra = {}) {
    const m = await quiet(say(chat, text, extra));
    if (m) setTimeout(() => quiet(api('deleteMessage', { chat_id: chat, message_id: m.message_id })), ms).unref();
  }

  // ---------- running ----------
  async function start() {
    stop();
    if (!ctx.token()) return;
    const mine = ++gen;
    running = true;
    try {
      me = await api('getMe');
      await quiet(api('deleteWebhook', { drop_pending_updates: false }));
      lastError = null;
    } catch (e) {
      lastError = e.message;
      running = false;
      if (e.code === 401) ctx.log('Telegram bot: the token was refused. Paste a new one from @BotFather.');
      return;
    }
    const c = cfg();
    c.botUsername = me.username;
    c.botId = me.id;
    ctx.save();
    ctx.log(`Telegram bot @${me.username} is running`);
    ticker = setInterval(() => tick().catch((e) => { lastError = e.message; }), 30000);
    ticker.unref && ticker.unref();
    setTimeout(() => tick().catch(() => {}), 3000).unref();
    poll(mine);
  }
  function stop() {
    running = false;
    gen++;
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  async function poll(mine) {
    let fails = 0;
    while (running && mine === gen) {
      let ups;
      try {
        ups = await api('getUpdates', {
          offset: cfg().offset || 0, timeout: 50,
          allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
        }, { timeout: 65000 });
        fails = 0;
      } catch (e) {
        if (mine !== gen) return;
        lastError = e.message;
        if (e.code === 401) { ctx.log('Telegram bot: the token stopped working. Paste a new one from @BotFather.'); running = false; return; }
        // 409: another copy of the server is still asking (during a redeploy). It sorts itself out.
        fails++;
        await sleep(Math.min(60000, (e.code === 409 ? 10000 : 3000) * fails));
        continue;
      }
      if (mine !== gen) return;
      const c = cfg();
      for (const u of ups) {
        c.offset = u.update_id + 1;
        try { await handle(u); } catch (e) { lastError = e.message; }
      }
      if (ups.length) ctx.save();
    }
  }

  // Every 30 seconds: the human check's deadline; library apps every minute; GitHub releases every 10 minutes.
  async function tick() {
    if (!running) return;
    ticks++;
    const now = Date.now();
    for (const [k, p] of pending) {
      if (now < p.until) continue;
      pending.delete(k);
      const [chat, user] = k.split(':');
      // Didn't tap the button in time: removed (they can join again and try).
      await quiet(api('banChatMember', { chat_id: chat, user_id: Number(user), until_date: Math.floor(now / 1000) + 60 }));
      await quiet(api('unbanChatMember', { chat_id: chat, user_id: Number(user), only_if_banned: true }));
      await quiet(api('deleteMessage', { chat_id: chat, message_id: p.msgId }));
    }
    const c = cfg();
    for (const [k, t] of Object.entries(c.joined)) if (now - t > 7 * 864e5) delete c.joined[k];
    if (ticks % 2 === 0) await announceApps().catch((e) => { lastError = `Apps channel: ${e.message}`; });
    if (ticks % 20 === 1) {
      await announceRelease('server').catch((e) => { lastError = `Updates (server): ${e.message}`; });
      await announceRelease('ios').catch((e) => { lastError = `Updates (iPhone app): ${e.message}`; });
    }
  }

  // ---------- announcements ----------
  // Release notes (GitHub markdown) → Telegram's HTML: bullets, bold section names, no duplicate title line.
  function notesHtml(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    while (lines.length && (!lines[0].trim() || /^🥭/.test(lines[0].trim()))) lines.shift();
    const out = [];
    for (let raw of lines) {
      const l = raw.trim();
      if (!l) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
      let h = esc(l)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>');
      if (/^#{1,6}\s+/.test(l)) h = `<b>${esc(l.replace(/^#{1,6}\s+/, ''))}</b>`;
      else if (/^[-*•]\s+/.test(l)) h = `• ${h.replace(/^[-*•]\s+/, '')}`;
      else if (l.length <= 40 && !/[.!?:,]$/.test(l)) h = `<b>${h}</b>`; // a short line on its own is a section name
      out.push(h);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    let html = out.join('\n');
    if (html.length > 3000) html = html.slice(0, 3000).replace(/<[^>]*$/, '').replace(/\n[^\n]*$/, '') + '\n…';
    return html;
  }
  const line = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈';
  function contactLine() {
    const u = String(cfg().contact || '').replace(/^@/, '').trim();
    return /^\w{4,32}$/.test(u) ? `💳 Need a certificate? <a href="https://t.me/${u}">DM @${esc(u)}</a>` : '';
  }
  function releasePost(which, r) {
    const c = cfg();
    const notes = notesHtml(r.body);
    const title = String(r.name || '').split(/\s+[—–-]\s+/);
    const head = which === 'ios'
      ? `📱 <b>Mango Signer for iPhone</b>\n<i>New build · ${esc(r.tag)}</i>`
      : `🥭 <b>Mango Signer ${esc(r.tag)}</b>${title[1] ? `\n<i>${esc(title.slice(1).join(' — '))}</i>` : ''}`;
    const parts = [head];
    // The iPhone builds' own notes are just "Unsigned build from commit …", so say something useful instead.
    if (notes && !/^\s*unsigned build/i.test(String(r.body || ''))) parts.push(`<blockquote expandable>${notes}</blockquote>`);
    else if (which === 'ios') parts.push('✨ Fresh build, ready to sign.\nSign it with your certificate in Mango Signer, ESign or any signer, then install.');
    const contact = contactLine();
    parts.push(line + (contact ? `\n${contact}` : ''));
    parts.push(`${esc(c.brand)}  ·  #MangoSigner ${which === 'ios' ? '#iPhoneApp' : '#Update'}`);
    const text = parts.join('\n\n');
    const buttons = [];
    if (r.ipaUrl) buttons.push({ text: '⬇️ Download .ipa', url: r.ipaUrl });
    buttons.push({ text: '📄 Release notes', url: r.url });
    return { text, reply_markup: { inline_keyboard: [buttons] } };
  }
  async function announceRelease(which, { force = false, to } = {}) {
    const c = cfg();
    if (!force && (!c.announce[which] || !c.updatesChat)) return null;
    const r = await ctx.release(c.repos[which]);
    if (!r) return null;
    // First time: remember what's out now instead of posting old news.
    if (!force && c.lastTags[which] === undefined) { c.lastTags[which] = r.tag; ctx.save(); return null; }
    if (!force && c.lastTags[which] === r.tag) return null;
    c.lastTags[which] = r.tag;
    ctx.save();
    const post = releasePost(which, r);
    await call('sendMessage', { chat_id: to || c.updatesChat, text: post.text, reply_markup: post.reply_markup, parse_mode: 'HTML', disable_web_page_preview: true });
    return r;
  }

  // "0e2f01e05cfd…" (a GitHub commit) → "build 0e2f01e"; anything else very long is shortened.
  function shortVersion(v) {
    const s = String(v || '').trim().replace(/^v(?=\d)/i, '');
    if (!s) return '';
    if (/^[0-9a-f]{12,}$/i.test(s)) return `build ${s.slice(0, 7)}`;
    return s.length > 24 ? `${s.slice(0, 22)}…` : `v${s}`;
  }
  function appCaption(a, kind) {
    const c = cfg();
    const facts = [a.version && `<code>${esc(shortVersion(a.version))}</code>`, a.size && esc(a.size), a.category && `🗂 ${esc(a.category)}`].filter(Boolean).join('  ·  ');
    const lines = [`${kind === 'update' ? '⬆️ <b>Updated</b>' : '🆕 <b>New</b>'}  ·  <b>${esc(a.name)}</b>`];
    if (facts) lines.push(facts);
    if (a.developer) lines.push(`<i>by ${esc(a.developer)}</i>`);
    const what = String(a.notes || a.description || '').replace(/\s+/g, ' ').trim();
    if (what) lines.push('', `<blockquote>${esc(what.slice(0, 260))}${what.length > 260 ? '…' : ''}</blockquote>`);
    if (!/^https:\/\//.test(ctx.appLink(a.id))) lines.push('', `👉 <a href="${esc(ctx.appLink(a.id))}">Sign with Mango Signer</a>`);
    const contact = contactLine();
    if (contact) lines.push('', contact);
    const tags = [a.category && `#${a.category.replace(/[^\p{L}\p{N}]+/gu, '')}`, kind === 'update' ? '#Update' : '#New'].filter(Boolean).join(' ');
    lines.push('', `${esc(c.brand)}  ·  ${tags}`);
    return lines.join('\n').slice(0, 1024);
  }
  const appButtons = (a) => ({ inline_keyboard: [[{ text: '✍️ Sign with Mango Signer', url: ctx.appLink(a.id) }]] });
  // Telegram only takes https links on buttons (a local test server is http).
  const markup = (a) => (/^https:\/\//.test(ctx.appLink(a.id)) ? { reply_markup: appButtons(a) } : {});
  async function sendPhotoFile(chat, file, caption, a) {
    const buf = await require('fs').promises.readFile(file);
    const f = new FormData();
    f.append('chat_id', String(chat));
    f.append('caption', caption);
    f.append('parse_mode', 'HTML');
    if (/^https:\/\//.test(ctx.appLink(a.id))) f.append('reply_markup', JSON.stringify(appButtons(a)));
    f.append('photo', new Blob([buf], { type: 'image/png' }), 'icon.png');
    return call('sendPhoto', f, { timeout: 60000 });
  }
  async function postApp(a, kind, to) {
    const caption = appCaption(a, kind);
    const chat = to || cfg().appsChat;
    if (a.iconFile) {
      try { return await sendPhotoFile(chat, a.iconFile, caption, a); } catch (e) { if (e.code === 429) throw e; }
    }
    for (const url of [a.iconUrl, a.iconSmall ? null : a.iconFallbackUrl].filter(Boolean)) {
      try { return await call('sendPhoto', { chat_id: chat, photo: url, caption, parse_mode: 'HTML', ...markup(a) }); } catch (e) { if (e.code === 429) throw e; }
    }
    if (a.iconSmall && a.iconSmall !== a.iconFile) {
      try { return await sendPhotoFile(chat, a.iconSmall, caption, a); } catch (e) { if (e.code === 429) throw e; }
    }
    if (a.iconSmall && a.iconFallbackUrl) {
      try { return await call('sendPhoto', { chat_id: chat, photo: a.iconFallbackUrl, caption, parse_mode: 'HTML', ...markup(a) }); } catch (e) { if (e.code === 429) throw e; }
    }
    return call('sendMessage', { chat_id: chat, text: caption, parse_mode: 'HTML', disable_web_page_preview: true, ...markup(a) });
  }
  async function announceApps() {
    const c = cfg();
    const apps = ctx.libraryApps();
    // First time (or turned back on): remember the library as it is now, so it doesn't post everything at once.
    if (!c.seenApps || !c.announce.apps || !c.appsChat) {
      c.seenApps = Object.fromEntries(apps.map((a) => [a.id, a.version || '']));
      c.appQueue = [];
      ctx.save();
      return;
    }
    c.appQueue = c.appQueue || [];
    for (const a of apps) {
      const was = c.seenApps[a.id];
      if (was === undefined) c.appQueue.push({ id: a.id, kind: 'new' });
      else if (was !== (a.version || '')) c.appQueue.push({ id: a.id, kind: 'update' });
      c.seenApps[a.id] = a.version || '';
    }
    const ids = new Set(apps.map((a) => a.id));
    for (const id of Object.keys(c.seenApps)) if (!ids.has(id)) delete c.seenApps[id];
    // One post per app (the newest news wins), at most 300 waiting, a few per minute so Telegram doesn't slow us down.
    const seen = new Set();
    c.appQueue = c.appQueue.reverse().filter((q) => ids.has(q.id) && !seen.has(q.id) && seen.add(q.id)).reverse().slice(-300);
    ctx.save();
    for (let n = 0; n < 4 && c.appQueue.length; n++) {
      const q = c.appQueue[0];
      const a = apps.find((x) => x.id === q.id);
      if (a) {
        try { await postApp(a, q.kind); } catch (e) {
          if (e.code === 429) break; // try again next minute
          lastError = `Apps channel: ${e.message}`;
          if (e.code === 400 || e.code === 403) { c.appQueue.shift(); break; } // wrong channel or no rights: don't loop on it
        }
      }
      c.appQueue.shift();
      ctx.save();
    }
  }

  // ---------- moderation ----------
  async function isAdmin(chat, user) {
    if (!user) return false;
    const k = `${chat}:${user.id}`;
    const hit = adminCache.get(k);
    if (hit && Date.now() - hit.at < 5 * 60000) return hit.is;
    let is = false;
    try { const m = await api('getChatMember', { chat_id: chat, user_id: user.id }); is = ['creator', 'administrator'].includes(m.status); } catch { /* treat as not admin */ }
    adminCache.set(k, { is, at: Date.now() });
    return is;
  }
  async function normalPerms(chat) {
    if (chatPerms.has(chat)) return chatPerms.get(chat);
    let p = OPEN_PERMS;
    try { const ch = await api('getChat', { chat_id: chat }); if (ch.permissions) p = ch.permissions; } catch { /* */ }
    chatPerms.set(chat, p);
    return p;
  }
  const hasLink = (m) => {
    const text = `${m.text || ''} ${m.caption || ''}`;
    const ents = [...(m.entities || []), ...(m.caption_entities || [])];
    return ents.some((e) => ['url', 'text_link'].includes(e.type)) || /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|\b[\w-]+\.(com|net|org|io|me|gg|xyz|app|link|ly)\b)/i.test(text);
  };
  const hasInvite = (m) => /(t\.me\/(\+|joinchat\/)|telegram\.me\/(\+|joinchat\/)|chat\.whatsapp\.com|discord\.(gg|com\/invite))/i.test(`${m.text || ''} ${m.caption || ''}`)
    || [...(m.entities || []), ...(m.caption_entities || [])].some((e) => e.type === 'text_link' && /t\.me\/(\+|joinchat)|discord\.gg/i.test(e.url || ''));
  const isForward = (m) => !!(m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_date);
  function parseTime(s) {
    const m = String(s || '').match(/^(\d+)\s*([mhdw]?)$/i);
    if (!m) return 3600;
    const n = Number(m[1]);
    return n * ({ m: 60, h: 3600, d: 86400, w: 604800 }[(m[2] || 'm').toLowerCase()]);
  }
  const forHow = (secs) => (secs >= 86400 ? `${Math.round(secs / 86400)} day${secs >= 172800 ? 's' : ''}` : secs >= 3600 ? `${Math.round(secs / 3600)} hour${secs >= 7200 ? 's' : ''}` : `${Math.round(secs / 60)} minutes`);
  const mute = (chat, user, secs) => api('restrictChatMember', { chat_id: chat, user_id: user, permissions: NO_PERMS, until_date: Math.floor(Date.now() / 1000) + secs });
  async function unmute(chat, user) {
    return api('restrictChatMember', { chat_id: chat, user_id: user, permissions: await normalPerms(chat) });
  }

  async function handle(u) {
    const c = cfg();
    if (u.my_chat_member) {
      const ch = u.my_chat_member.chat;
      const st = u.my_chat_member.new_chat_member.status;
      if (['left', 'kicked'].includes(st)) delete c.chats[ch.id];
      else c.chats[ch.id] = { id: ch.id, title: ch.title || ch.username || String(ch.id), type: ch.type, username: ch.username || null, admin: st === 'administrator' };
      return;
    }
    if (u.callback_query) return onButton(u.callback_query);
    const m = u.message || u.edited_message;
    if (!m || !m.chat) return;
    const chat = m.chat.id;
    if (['group', 'supergroup'].includes(m.chat.type) && !c.chats[chat]) c.chats[chat] = { id: chat, title: m.chat.title, type: m.chat.type, username: m.chat.username || null };
    if (String(chat) !== String(c.groupChat)) {
      // Only your chat is moderated. In a private message, the bot just says what it is.
      if (m.chat.type === 'private' && u.message && /^\/start/.test(m.text || '')) await quiet(say(chat, `Hi! I'm the ${esc(c.brand)} bot. I look after the Mango Signer channel and chat.`));
      return;
    }
    if (u.message && m.new_chat_members) return onJoin(m);
    if (u.message && m.left_chat_member) { if (c.mod.cleanJoins) await quiet(api('deleteMessage', { chat_id: chat, message_id: m.message_id })); return; }
    // Your channel's posts show up in its chat as forwards, and anonymous admins post as the chat: never touch those.
    if (m.is_automatic_forward || (m.sender_chat && (m.sender_chat.id === chat || m.sender_chat.type === 'channel' && c.chats[m.sender_chat.id]))) return;
    const from = m.from;
    if (!from || from.is_bot) return;
    const text = (m.text || m.caption || '').trim();
    const admin = await isAdmin(chat, from);
    if (u.message && /^\/\w+/.test(text)) {
      const handled = await command(m, text, admin);
      if (handled) return;
    }
    if (admin) return;

    const del = () => quiet(api('deleteMessage', { chat_id: chat, message_id: m.message_id }));
    const words = (c.mod.bannedWords || []).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
    const low = text.toLowerCase();
    if (words.some((w) => (/^[\p{L}\p{N}]+$/u.test(w) ? new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(low) : low.includes(w)))) {
      await del();
      return notice(chat, `🚫 ${mention(from)}, that message had a word that isn't allowed here.`);
    }
    if (c.mod.antispam) {
      if (hasInvite(m)) { await del(); return notice(chat, `🚫 ${mention(from)}, links to other groups aren't allowed here.`); }
      const joinedAt = c.joined[`${chat}:${from.id}`];
      const isNew = joinedAt && Date.now() - joinedAt < (Number(c.mod.newHours) || 24) * 3600000;
      if (isNew && (hasLink(m) || isForward(m))) {
        await del();
        return notice(chat, `🚫 ${mention(from)}, new members can't send links or forwards yet. Hang around for a bit first!`);
      }
    }
    if (c.mod.flood && u.message) {
      const k = `${chat}:${from.id}`;
      const now = Date.now();
      const times = (flood.get(k) || []).filter((t) => now - t < 8000);
      times.push(now);
      flood.set(k, times);
      if (times.length >= 6) {
        flood.delete(k);
        await del();
        await quiet(mute(chat, from.id, 600));
        return notice(chat, `🔇 ${mention(from)} is muted for 10 minutes for flooding the chat.`, 60000);
      }
    }
  }

  async function onJoin(m) {
    const c = cfg();
    const chat = m.chat.id;
    if (c.mod.cleanJoins) await quiet(api('deleteMessage', { chat_id: chat, message_id: m.message_id }));
    for (const user of m.new_chat_members) {
      if (user.is_bot) continue;
      c.joined[`${chat}:${user.id}`] = Date.now();
      const welcome = esc(c.welcome || DEFAULTS.welcome).replace(/\{name\}/g, mention(user));
      if (c.mod.captcha) {
        await quiet(mute(chat, user.id, 0));
        const msg = await quiet(say(chat, `${welcome}\n\n👇 Tap the button within 5 minutes to start chatting.`, {
          reply_markup: { inline_keyboard: [[{ text: "✅ I'm human", callback_data: `human:${user.id}` }]] },
        }));
        if (msg) pending.set(`${chat}:${user.id}`, { msgId: msg.message_id, until: Date.now() + 5 * 60000 });
      } else if (c.welcome) {
        await notice(chat, welcome, 120000);
      }
    }
    ctx.save();
  }

  async function onButton(q) {
    const m = String(q.data || '').match(/^human:(\d+)$/);
    if (!m || !q.message) return quiet(api('answerCallbackQuery', { callback_query_id: q.id }));
    if (String(q.from.id) !== m[1]) return quiet(api('answerCallbackQuery', { callback_query_id: q.id, text: "That button isn't for you 🙂", show_alert: false }));
    const chat = q.message.chat.id;
    pending.delete(`${chat}:${q.from.id}`);
    await quiet(unmute(chat, q.from.id));
    await quiet(api('answerCallbackQuery', { callback_query_id: q.id, text: 'Welcome! You can chat now 🥭' }));
    const c = cfg();
    await quiet(api('editMessageText', { chat_id: chat, message_id: q.message.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
      text: esc(c.welcome || DEFAULTS.welcome).replace(/\{name\}/g, mention(q.from)) }));
    setTimeout(() => quiet(api('deleteMessage', { chat_id: chat, message_id: q.message.message_id })), 120000).unref();
  }

  const HELP_ALL = '/rules – the chat rules';
  const HELP_ADMIN = [
    'Reply to someone\'s message with:',
    '/warn [reason] – warn them (3 warnings = muted for a day)',
    '/unwarn – take a warning back',
    '/mute [10m, 2h, 1d] – mute (1 hour if no time)',
    '/unmute – let them talk again',
    '/kick – remove them (they can come back)',
    '/ban – remove them for good',
    '/del – delete that message',
    '/pin – pin that message',
    '',
    'Anywhere:',
    '/unban [user id] – let someone back in',
    '/lock – only admins can send messages',
    '/unlock – everyone can talk again',
    '/rules – the chat rules',
  ].join('\n');

  // Returns true when the message was a command the bot dealt with.
  async function command(m, text, admin) {
    const c = cfg();
    const chat = m.chat.id;
    const [raw, ...args] = text.split(/\s+/);
    const [name, at] = raw.slice(1).toLowerCase().split('@');
    if (at && me && at !== me.username.toLowerCase()) return false;
    const delCmd = () => quiet(api('deleteMessage', { chat_id: chat, message_id: m.message_id }));
    if (name === 'rules') { await say(chat, `📜 <b>Rules</b>\n\n${esc(c.rules || DEFAULTS.rules)}`, { reply_to_message_id: m.message_id }); return true; }
    if (name === 'help' || name === 'start') {
      await say(chat, admin ? `🛠 <b>Admin commands</b>\n\n${esc(HELP_ADMIN)}` : esc(HELP_ALL), { reply_to_message_id: m.message_id });
      return true;
    }
    const adminOnly = ['warn', 'unwarn', 'mute', 'unmute', 'kick', 'ban', 'unban', 'del', 'pin', 'lock', 'unlock'];
    if (!adminOnly.includes(name)) return false;
    if (!admin) { await delCmd(); return true; }
    const target = m.reply_to_message && m.reply_to_message.from;
    const needsTarget = ['warn', 'unwarn', 'mute', 'unmute', 'kick', 'ban', 'del', 'pin'];
    if (needsTarget.includes(name) && !target) { await notice(chat, `↩️ Reply to someone's message with /${name}.`); await delCmd(); return true; }
    if (target && ['warn', 'mute', 'kick', 'ban'].includes(name) && (target.is_bot || await isAdmin(chat, target))) {
      await notice(chat, "🙅 That doesn't work on admins or bots."); await delCmd(); return true;
    }
    try {
      switch (name) {
        case 'warn': {
          const k = `${chat}:${target.id}`;
          c.warns[k] = (c.warns[k] || 0) + 1;
          const reason = args.join(' ').slice(0, 200);
          if (c.warns[k] >= 3) {
            c.warns[k] = 0;
            await mute(chat, target.id, 86400);
            await say(chat, `🔇 ${mention(target)} got a 3rd warning and is muted for a day.${reason ? `\nReason: ${esc(reason)}` : ''}`);
          } else {
            await say(chat, `⚠️ ${mention(target)}, warning ${c.warns[k]} of 3.${reason ? `\nReason: ${esc(reason)}` : ''}`);
          }
          ctx.save();
          break;
        }
        case 'unwarn': {
          const k = `${chat}:${target.id}`;
          c.warns[k] = Math.max(0, (c.warns[k] || 0) - 1);
          ctx.save();
          await say(chat, `✅ Took a warning back from ${mention(target)} (${c.warns[k]} of 3 now).`);
          break;
        }
        case 'mute': {
          const secs = parseTime(args[0]);
          await mute(chat, target.id, secs);
          await say(chat, `🔇 ${mention(target)} is muted for ${forHow(secs)}.`);
          break;
        }
        case 'unmute':
          await unmute(chat, target.id);
          await say(chat, `🔊 ${mention(target)} can talk again.`);
          break;
        case 'kick':
          await api('banChatMember', { chat_id: chat, user_id: target.id, until_date: Math.floor(Date.now() / 1000) + 60 });
          await quiet(api('unbanChatMember', { chat_id: chat, user_id: target.id, only_if_banned: true }));
          await say(chat, `👢 ${mention(target)} was removed.`);
          break;
        case 'ban':
          await api('banChatMember', { chat_id: chat, user_id: target.id, revoke_messages: false });
          await quiet(api('deleteMessage', { chat_id: chat, message_id: m.reply_to_message.message_id }));
          await say(chat, `⛔ ${mention(target)} is banned.`);
          break;
        case 'unban': {
          const id = target ? target.id : Number(args[0]);
          if (!id) { await notice(chat, '↩️ Reply to their message, or send /unban followed by their user ID.'); break; }
          await api('unbanChatMember', { chat_id: chat, user_id: id, only_if_banned: true });
          await say(chat, '✅ Unbanned. They can join again.');
          break;
        }
        case 'del':
          await api('deleteMessage', { chat_id: chat, message_id: m.reply_to_message.message_id });
          break;
        case 'pin':
          await api('pinChatMessage', { chat_id: chat, message_id: m.reply_to_message.message_id, disable_notification: true });
          break;
        case 'lock': {
          if (!c.locked[chat]) {
            const ch = await api('getChat', { chat_id: chat });
            c.locked[chat] = ch.permissions || OPEN_PERMS;
          }
          await api('setChatPermissions', { chat_id: chat, permissions: NO_PERMS });
          ctx.save();
          await say(chat, '🔒 The chat is locked. Only admins can send messages for now.');
          break;
        }
        case 'unlock': {
          const back = c.locked[chat] || OPEN_PERMS;
          await api('setChatPermissions', { chat_id: chat, permissions: back });
          delete c.locked[chat];
          chatPerms.delete(chat);
          ctx.save();
          await say(chat, '🔓 The chat is open again. Be nice! 🥭');
          break;
        }
        default:
      }
    } catch (e) {
      await notice(chat, /not enough rights|administrator|CHAT_ADMIN_REQUIRED|rights/i.test(e.message)
        ? "😬 I can't do that. Make me an admin with permission to delete messages, ban users and pin messages."
        : `😬 That didn't work: ${esc(e.message)}`);
    }
    await delCmd();
    return true;
  }

  return {
    start, stop, api,
    get running() { return running; },
    get username() { return me && me.username; },
    get lastError() { return lastError; },
    announceRelease,
    postApp,
    releasePost,
    defaults: DEFAULTS,
    cfg,
    // Checks a token without saving it (for "Connect").
    async check(token) { return api('getMe', {}, { token }); },
  };
}

module.exports = { createBot };
