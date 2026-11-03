# 🥭 Mango Signer

A self-hosted iOS app signer, installer and App Library you use from Safari on your iPhone.
Upload an `.ipa`, add a `.p12` + `.mobileprovision`, tap **Sign**, then **Install**.

**[⬇️ Download the latest release](https://github.com/MangoMods-code/Mango-Signer/releases)** · each release lists everything that changed.

## Features
- **App Library** – the owner uploads apps (or imports from a link); invited users browse, search, sign and install them
- **Organization** – categories with emoji, featured apps, search, sorting, bulk select, full app editing, Update IPA, and default sign settings per app
- **Sorting apps into categories** – ✨ Auto-sort uses your keyword rules, the App Store, apps you already sorted that look the same (YouTube++ goes where YouTube is), giveaway words in the name (emulator, IPTV, VPN…) and the category most apps from the same source are in. It paces App Store lookups so Apple doesn't refuse them, and keeps going on the server after you close it. Whatever's left, **Sort by hand** shows one app at a time with Mango's best guess on top
- **Cloud Library** – app files don't have to sit on your Railway volume. Add apps from:
  - **AltStore / SideStore / ESign sources** (JSON source links)
  - **GitHub repos** – paste `github.com/owner/repo`; every release with an `.ipa` becomes a version and new releases show up as updates
  - **Website downloads pages** – paste a page like `example.com/downloads/`; every `.ipa` link on it is picked up, new links become updates, and old ones are kept as older versions
  - **Any direct `.ipa` link** (link-only apps), or your own IPAs kept in a (private) GitHub repo's release
  - Files are downloaded only while signing; recent downloads are kept briefly (up to 1 GB, 2 days) so signing the same app again skips the download. Older versions can be picked when signing
- **Telegram channels** – sign in once and Mango watches channels you pick: new `.ipa` posts are added to the library (or update the existing app), kept as links on Telegram or copied to your GitHub storage. Downloads fetch 8 pieces at once, and Telegram's rate limits are shown with a countdown instead of hanging
- **Update checks & Activity** – every channel, repo, page and source is checked every hour, one at a time (repos and sources first, Telegram channels last, smallest first). The ⏳ Activity screen shows what's running, waiting in line and finished, with live logs, Check all now / Stop all, and a watchdog that stops anything stuck
- **No duplicates** – "Skip apps I already have" per channel/source, a Duplicates screen to pick which copy of each app to keep (or clean them all up in one tap), and apps you delete from a source are remembered so refreshes don't bring them back (restore them from the source's page)
- **Signed apps that stay** – with GitHub storage on a private repo, signed apps are saved to a separate "Mango Signed" release and stay in the Signed tab, ready to reinstall, until they're deleted (or their certificate expires)
- **Installed apps** – Mango tracks what each person installed through it, only nags about real updates (by version number), marks apps whose certificate expired as "won't open", and lets people fix the list ("I already updated it", "Not on my phone anymore")
- **Owner tools** – stats & activity, message everyone, one-tap backup & restore
- **Tweaks** – a tweaks library (jailbreak `.deb` or `.dylib`), per-app default tweaks, automatic CydiaSubstrate/ElleKit bundling for tweaks that need it
- **Presets & batch signing** – save sign settings as presets, select several apps and Get them all at once, import certificates from a `.zip`
- **Alerts & security** – 🔔 alerts inbox (updates, requests, certificate expiry and revokes, new users, lockouts, low storage), ♥ favorites, security log, account lockout, sign out everywhere, expiring invites, daily sign limits
- **Big files** – resumable uploads that survive dropped connections; stalled downloads/uploads are stopped with a message instead of hanging; old signed files are cleaned up automatically; app icons are stored small (180px) to save space
- **Accounts** – invite codes, username + password login, or sign in with your iPhone (UDID)
- **Certificates** – each account adds its own `.p12` + `.mobileprovision`; shows type, expiry, revoke status, cert/profile mismatch, and whether your iPhone is in the profile
- **Entitlements** – one-tap JIT support (`get-task-allow`), increased memory limit, extended virtual addressing, plus custom entitlements; warns when your profile doesn't allow one
- **Info.plist editing** – 120Hz ProMotion, Game Mode, full screen, plus any custom key (add, change or remove)
- **Signing options** – change name, bundle ID, version, minimum iOS, icon; inject `.dylib` tweaks; remove extensions, Watch app or device limits; Files app sharing
- **Install** – one-tap over-the-air install, shareable install pages, download signed `.ipa`
- **Mango Signer iPhone app** – the native app ([Mango-Signer-iOS](https://github.com/MangoMods-code/Mango-Signer-iOS)) signs in to your server and shows the same library, certificates and signed apps. Owners and admins can edit library apps and sort apps without a category from the iPhone too. It can sign on the server, or download the original app (counts toward the daily sign limit, same as signing) and sign it right on the iPhone. Like ESign, it keeps a copy of every signed app on the iPhone and puts it back on the server when the server has cleaned it up, and it checks what's really installed to keep your installed apps list right
- **Admins & testers** – the owner can make people admins (manage the library, users, invites, requests, stats; no sign limit, but never the server settings, GitHub, Telegram sign-in or backups) or testers (see apps marked "Testers only" in their own list, get beta versions first, no sign limit, send bug reports)
- **User management** – reset passwords, turn accounts off, unlink iPhones, delete users, invite codes, hide apps from the library, signing queue

## Deploy on Railway
1. Download the latest zip from [Releases](https://github.com/MangoMods-code/Mango-Signer/releases), put it in a GitHub repo and create a Railway service from it (it builds from the `Dockerfile`).
2. Add a **volume** mounted at `/data`.
3. Set `APP_PASSWORD` (the owner password). Optional: `SESSION_SECRET` (any long random string).
4. Generate a public domain (installs need HTTPS) and open it in Safari.

The owner signs in with the password only (leave username blank). Everyone else needs an invite code from **Users › +**.

## Environment variables
| Name | Default | Purpose |
|---|---|---|
| `APP_PASSWORD` | – | Owner password (required) |
| `DATA_DIR` | `/data` | Storage folder |
| `PUBLIC_URL` | auto | Override the address used in install links |
| `MAX_UPLOAD_MB` | `4096` | Owner upload size limit |
| `MAX_CONCURRENT_SIGNS` | `2` | How many apps sign at once (others wait in line) |
| `ZSIGN_PATH` | `zsign` | Path to the zsign binary |

## GitHub storage (optional)
1. Make a repo on GitHub (private is fine) and tick **Add a README** so it isn't empty.
2. Create a **fine-grained personal access token** limited to that repo with **Contents: Read and write**.
3. In Mango go to **Settings › Cloud Library › GitHub storage**, enter `owner/repo` and the token.

Mango creates a release tagged `mango-library` and keeps each app as a release asset (up to 2 GB each). You can also drop `.ipa` files onto that release on github.com and tap **Sync**. The token is stored encrypted and never sent to the browser.

With **Keep signed apps on GitHub** on (private repos only), signed apps go into a separate release tagged `mango-signed` (then `mango-signed-2`, `-3`… before GitHub's 1,000-file limit). Mango manages it: deleting a signed app in the Signed tab deletes it there too.

## Telegram channels (optional)
Uses [Telethon](https://github.com/LonamiWebs/Telethon) (MIT), installed in the Docker build.
1. On my.telegram.org › **API development tools**, create an app and copy its **api_id** and **api_hash**.
2. In Mango go to **Settings › Cloud Library › ✈️ Telegram channels**, enter them with your phone number, then the code Telegram sends you (and your two-step password if you use one).
3. Tap **Add a channel** and paste its @username or t.me link (a link to one post works too). Each channel has its own settings: where files live (Telegram or GitHub), skipping apps you already have, whether it may update apps you uploaded yourself, matching by name, keyword filter, and automatic hourly checks. Use **🔍 Scan older posts** to go further back in a channel's history.

Only posts with an `.ipa` file attached are picked up (not links to file hosts). Telegram limits how fast an account can make requests; Mango saves each channel's id after the first lookup and checks Telegram channels after everything else to stay under those limits.

## Notes
- JIT can't be switched on from a website; signing with **JIT support** lets tools like StikDebug attach to the app.
- Memory entitlements only work if the capability is enabled for your App ID in your Apple Developer account.
- Sign in with iPhone uses an iOS profile service to read the device UDID. The iPhone signs its answer with the certificate Apple gave it, and Mango checks that signature against Apple's root certificate (downloaded from apple.com once and kept on the volume), so knowing someone's UDID isn't enough to sign in as them. If the check can't be done, people are asked for their password instead. The **owner account always signs in with the password**, and the owner can turn iPhone sign-in off for everyone in Settings.
- **Security:** sessions are signed, HttpOnly, SameSite cookies; passwords use scrypt; certificate passwords, the GitHub token and the Telegram login are encrypted (AES-256-GCM) and never sent to the browser; logins are rate-limited per network and locked after repeated wrong passwords (per account and network, so nobody can lock you out on purpose); the Telegram helper only listens on 127.0.0.1 with a random token; pages can't be framed by other sites. Keep backup zips private: they contain the key that decrypts your saved secrets.

## How it works
- `server.js` – web server and API (no npm dependencies)
- `whats-new.js` – the in-app What's New notes; its first entry is the app's version
- `lib/` – zip (local and HTTP range), plist, PNG (Apple CgBI icons, resizing), Mach-O, .deb, certificate, source, GitHub, App Store lookup and Telegram helpers (`telegram_helper.py` runs Telethon)
- `public/` – the iPhone web app
- Signing is done by [zsign](https://github.com/zhlynn/zsign) (MIT License, by zhlynn), compiled in the Docker build.

Only sign and share apps you have the right to use.

## License
© 2026 MangoMods. **All rights reserved.** The code is public so you can see how it works and run it on your own server for personal use. You may not copy, reupload, rebrand, sell, or present it as your own. See [LICENSE](LICENSE) for the full terms.
