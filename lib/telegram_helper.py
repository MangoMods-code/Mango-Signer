"""Mango Signer's Telegram helper.

A tiny local HTTP server (127.0.0.1 only) that Mango's Node server talks to. It signs in to Telegram
as the owner (with Telethon) and lets Mango list a channel's posts and read .ipa files from them.
Files are streamed in pieces, so a 2 GB game never has to be saved on the server.

Environment (set by server.js):
  TG_PORT, TG_TOKEN    where to listen and the secret Mango sends with every request
  TG_API_ID, TG_API_HASH, TG_SESSION (optional, a Telethon StringSession)
"""
import asyncio
import json
import os
import re
import sys
import time
from urllib.parse import urlparse, parse_qs

try:
    from telethon import TelegramClient, errors, utils
    from telethon.sessions import StringSession
    from telethon.tl.types import DocumentAttributeFilename
except Exception as e:  # pragma: no cover
    print(f"ERROR telethon is not installed ({e})", flush=True)
    sys.exit(3)

PORT = int(os.environ.get("TG_PORT", "0"))
TOKEN = os.environ.get("TG_TOKEN", "")
API_ID = int(os.environ.get("TG_API_ID", "0") or 0)
API_HASH = os.environ.get("TG_API_HASH", "")
SESSION = os.environ.get("TG_SESSION", "")

PART = 512 * 1024  # Telegram serves files in 512 KB pieces (must not cross a 1 MB boundary)
# How many pieces to ask Telegram for at the same time. One at a time waits a full round trip per
# 512 KB; asking for several at once keeps the connection busy and downloads several times faster.
PARALLEL = max(1, min(16, int(os.environ.get("TG_PARALLEL", "8") or 8)))

client = TelegramClient(StringSession(SESSION or None), API_ID, API_HASH,
                        device_model="Mango Signer", app_version="1.7", system_version="Server",
                        flood_sleep_threshold=60, connection_retries=5, retry_delay=2)
login = {"phone": None}
entities = {}


def clean_ref(ref):
    """'@name', 'name', 't.me/name', 'https://t.me/name/123', 't.me/s/name' -> 'name' (or a numeric id)."""
    ref = (ref or "").strip()
    m = re.match(r"^(?:https?://)?(?:www\.)?(?:t|telegram)\.me/(?:s/)?([A-Za-z0-9_+]+)", ref)
    if m:
        ref = m.group(1)
    ref = ref.lstrip("@")
    if re.fullmatch(r"-?\d+", ref):
        return int(ref)
    if ref.startswith("+") or ref.lower() == "joinchat":
        raise ValueError("Private invite links aren't supported. Join the channel in Telegram first, then use its @username.")
    if not re.fullmatch(r"[A-Za-z0-9_]{4,64}", ref):
        raise ValueError("Enter the channel's @username or t.me link")
    return ref


async def entity(ref):
    key = clean_ref(ref)
    if key not in entities:
        entities[key] = await client.get_entity(key)
    return entities[key]


def file_info(msg):
    f = msg.file
    if not f or not msg.document:
        return None
    name = f.name or ""
    if not name:
        for a in msg.document.attributes:
            if isinstance(a, DocumentAttributeFilename):
                name = a.file_name
    return {"name": name or f"file-{msg.id}", "size": f.size or 0, "mime": f.mime_type or ""}


def post_view(msg):
    return {
        "id": msg.id,
        "date": msg.date.isoformat() if msg.date else None,
        "text": (msg.message or "")[:4000],
        "file": file_info(msg),
        "grouped": msg.grouped_id,
    }


async def me_view():
    if not await client.is_user_authorized():
        return None
    me = await client.get_me()
    phone = me.phone or ""
    return {
        "name": " ".join(x for x in [me.first_name, me.last_name] if x) or me.username or "Telegram",
        "username": me.username,
        "phone": ("+" + phone[:2] + "•" * max(0, len(phone) - 4) + phone[-2:]) if phone else None,
    }


# ---------- routes ----------
async def r_status(q, body):
    return {"connected": client.is_connected(), "me": await me_view()}


async def r_login_start(q, body):
    phone = re.sub(r"[^\d+]", "", body.get("phone", ""))
    if not phone:
        raise ValueError("Enter your phone number with the country code, like +1 555 123 4567")
    login["phone"] = phone
    sent = await client.send_code_request(phone)
    kind = type(sent.type).__name__.replace("SentCodeType", "").lower() if sent and sent.type else ""
    return {"ok": True, "via": "app" if kind == "app" else "sms" if kind == "sms" else kind or "telegram"}


async def r_login_code(q, body):
    code = re.sub(r"\D", "", str(body.get("code", "")))
    if not login["phone"]:
        raise ValueError("Start again: enter your phone number first")
    try:
        await client.sign_in(phone=login["phone"], code=code)
    except errors.SessionPasswordNeededError:
        return {"needPassword": True}
    return {"ok": True, "session": client.session.save(), "me": await me_view()}


async def r_login_password(q, body):
    await client.sign_in(password=str(body.get("password", "")))
    return {"ok": True, "session": client.session.save(), "me": await me_view()}


async def r_logout(q, body):
    try:
        await client.log_out()
    except Exception:
        pass
    return {"ok": True}


async def r_channel(q, body):
    e = await entity(q.get("ref", [""])[0])
    title = getattr(e, "title", None) or " ".join(x for x in [getattr(e, "first_name", None), getattr(e, "last_name", None)] if x)
    return {"id": e.id, "title": title or str(e.id), "username": getattr(e, "username", None),
            "members": getattr(e, "participants_count", None)}


async def r_posts(q, body):
    """Newest-first list of posts that have a file.
    min_id = only posts after that id; offset_id = only posts before that id (for paging back through history)."""
    e = await entity(q.get("ref", [""])[0])
    limit = max(1, min(400, int(q.get("limit", ["50"])[0])))
    min_id = int(q.get("min_id", ["0"])[0])
    offset_id = int(q.get("offset_id", ["0"])[0])
    out = []
    oldest = None
    scanned = 0
    async for msg in client.iter_messages(e, limit=limit, min_id=min_id, offset_id=offset_id):
        scanned += 1
        oldest = msg.id if oldest is None else min(oldest, msg.id)
        if msg.document:
            out.append(post_view(msg))
    return {"posts": out, "oldest": oldest, "scanned": scanned}


async def r_messages(q, body):
    """Which of these post ids still exist (used to notice deleted posts)."""
    e = await entity(q.get("ref", [""])[0])
    ids = [int(x) for x in q.get("ids", [""])[0].split(",") if x.strip().isdigit()][:200]
    found = await client.get_messages(e, ids=ids) if ids else []
    return {"exists": [m.id for m in found if m and m.document]}


ROUTES = {
    ("GET", "/status"): r_status,
    ("POST", "/login/start"): r_login_start,
    ("POST", "/login/code"): r_login_code,
    ("POST", "/login/password"): r_login_password,
    ("POST", "/logout"): r_logout,
    ("GET", "/channel"): r_channel,
    ("GET", "/posts"): r_posts,
    ("GET", "/messages"): r_messages,
}


def E(*names):
    """Error classes by name (skips any this Telethon version doesn't have)."""
    return tuple(getattr(errors, n) for n in names if hasattr(errors, n))


def friendly(e):
    name = type(e).__name__
    if isinstance(e, E("FloodWaitError")):
        return 429, f"Telegram asked to slow down. Try again in {getattr(e, 'seconds', 60)} seconds."
    if isinstance(e, E("PhoneNumberInvalidError", "PhoneNumberBannedError")):
        return 400, "That phone number isn't valid (or is banned). Include the country code, like +1."
    if isinstance(e, E("PhoneCodeInvalidError", "PhoneCodeEmptyError")):
        return 400, "That code isn't right. Check the code Telegram sent and try again."
    if isinstance(e, E("PhoneCodeExpiredError")):
        return 400, "That code expired. Start again to get a new one."
    if isinstance(e, E("PasswordHashInvalidError")):
        return 400, "Wrong two-step verification password."
    if isinstance(e, E("ApiIdInvalidError", "ApiIdPublishedFloodError")):
        return 400, "Telegram rejected the API ID / API hash. Copy them again from my.telegram.org."
    if isinstance(e, E("UsernameNotOccupiedError", "UsernameInvalidError")):
        return 404, "No channel with that username."
    if isinstance(e, E("ChannelPrivateError", "ChannelInvalidError")):
        return 403, "That channel is private. Join it in Telegram first."
    if isinstance(e, E("AuthKeyUnregisteredError", "SessionRevokedError", "AuthKeyDuplicatedError", "UserDeactivatedError")):
        return 401, "Telegram signed Mango out. Connect Telegram again."
    if isinstance(e, ValueError):
        msg = str(e)
        if "Cannot find any entity" in msg or "No user has" in msg:
            return 404, "Couldn't find that channel. Check the @username."
        return 400, msg
    return 500, f"Telegram error: {name}: {e}"[:300]


# ---------- file streaming ----------
# Messages are cached for a few minutes: reading one app's info takes several small reads of the same file,
# and fetching the post again for each one was slow. A stale file reference is refreshed automatically.
msg_cache = {}


async def get_post(ref, msg_id, fresh=False):
    key = (str(ref).lower(), msg_id)
    hit = msg_cache.get(key)
    if hit and not fresh and time.time() - hit[1] < 600:
        return hit[0]
    msg = await client.get_messages(await entity(ref), ids=msg_id)
    msg_cache[key] = (msg, time.time())
    if len(msg_cache) > 2000:
        for k in sorted(msg_cache, key=lambda k: msg_cache[k][1])[:500]:
            msg_cache.pop(k, None)
    return msg


def piece_size(length):
    """Small reads (reading app info) ask Telegram for small pieces instead of 512 KB each."""
    size = 65536
    while size < length and size < PART:
        size *= 2
    return size


async def stream_file(writer, q, headers):
    ref = q.get("ref", [""])[0]
    msg_id = int(q.get("msg", ["0"])[0])
    msg = await get_post(ref, msg_id)
    if not msg or not msg.document:
        return await send_json(writer, 404, {"error": "That post or file is gone from the channel"})
    size = msg.file.size or 0
    start, end = 0, size - 1
    rng = headers.get("range", "")
    m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
    partial = False
    if m and size:
        a, b = m.group(1), m.group(2)
        if a == "" and b:
            start, end = max(0, size - int(b)), size - 1
        else:
            start = int(a or 0)
            end = min(size - 1, int(b)) if b else size - 1
        if start >= size or start > end:
            writer.write(f"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
            await writer.drain()
            return
        partial = True
    length = end - start + 1 if size else 0
    name = (file_info(msg) or {}).get("name", "app.ipa").replace('"', "")
    head = [
        f"HTTP/1.1 {'206 Partial Content' if partial else '200 OK'}",
        "Content-Type: application/octet-stream",
        f"Content-Length: {length}",
        "Accept-Ranges: bytes",
        f'Content-Disposition: attachment; filename="{name}"',
        "Connection: close",
    ]
    if partial:
        head.append(f"Content-Range: bytes {start}-{end}/{size}")
    writer.write(("\r\n".join(head) + "\r\n\r\n").encode())
    await writer.drain()
    if not length:
        return
    piece = piece_size(length)
    aligned = start - (start % piece)
    skip = start - aligned
    offsets = list(range(aligned, end + 1, piece))
    sent_any = False

    async def fetch(doc, offset):
        """One piece of the file. Retries a couple of times on hiccups; waits out flood limits."""
        for attempt in range(4):
            try:
                async for chunk in client.iter_download(doc, offset=offset, request_size=piece, chunk_size=piece, limit=1, file_size=size):
                    return chunk
                return b""
            except errors.FloodWaitError as e:
                await asyncio.sleep(min(60, e.seconds + 1))
            except Exception as e:
                if "FileReference" in type(e).__name__ or attempt == 3:
                    raise
                await asyncio.sleep(0.5 * (attempt + 1))
        raise RuntimeError("Telegram kept failing to send part of the file")

    for attempt in range(2):
        tasks = {}
        try:
            left = length
            skip_now = skip
            nxt = 0
            for i in range(len(offsets)):
                # Keep up to PARALLEL pieces on the way while we send the earlier ones in order.
                while nxt < len(offsets) and nxt < i + PARALLEL:
                    tasks[nxt] = asyncio.ensure_future(fetch(msg.document, offsets[nxt]))
                    nxt += 1
                chunk = await tasks.pop(i)
                if i < len(offsets) - 1 and len(chunk) < piece:
                    raise RuntimeError("Telegram sent a short piece")
                if skip_now:
                    chunk = chunk[skip_now:]
                    skip_now = 0
                if len(chunk) > left:
                    chunk = chunk[:left]
                writer.write(chunk)
                sent_any = True
                await writer.drain()
                left -= len(chunk)
                if left <= 0:
                    break
            break
        except Exception as e:
            # Old file reference: get the post again and retry, as long as nothing was sent yet.
            if attempt == 0 and not sent_any and "FileReference" in type(e).__name__:
                msg = await get_post(ref, msg_id, fresh=True)
                continue
            raise
        finally:
            for t in tasks.values():
                t.cancel()


# ---------- tiny HTTP server ----------
async def send_json(writer, status, data):
    body = json.dumps(data).encode()
    writer.write(f"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    await writer.drain()


async def handle(reader, writer):
    try:
        line = (await reader.readline()).decode("latin-1").strip()
        if not line:
            return
        method, target, _ = (line.split(" ") + ["", ""])[:3]
        headers = {}
        while True:
            h = (await reader.readline()).decode("latin-1")
            if h in ("\r\n", "\n", ""):
                break
            k, _, v = h.partition(":")
            headers[k.strip().lower()] = v.strip()
        body = {}
        n = int(headers.get("content-length", "0") or 0)
        if n:
            raw = await reader.readexactly(min(n, 1 << 20))
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                body = {}
        if headers.get("x-mango-token") != TOKEN:
            return await send_json(writer, 403, {"error": "forbidden"})
        u = urlparse(target)
        q = parse_qs(u.query)
        try:
            if method == "GET" and u.path == "/file":
                return await stream_file(writer, q, headers)
            fn = ROUTES.get((method, u.path))
            if not fn:
                return await send_json(writer, 404, {"error": "not found"})
            await send_json(writer, 200, await fn(q, body))
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as e:  # turn Telegram errors into short messages
            status, msg = friendly(e)
            try:
                await send_json(writer, status, {"error": msg})
            except Exception:
                pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def main():
    if not API_ID or not API_HASH:
        print("ERROR missing API ID / hash", flush=True)
        sys.exit(2)
    await client.connect()
    server = await asyncio.start_server(handle, "127.0.0.1", PORT)
    port = server.sockets[0].getsockname()[1]
    print(f"READY {port}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
