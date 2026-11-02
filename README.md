# 🥭 Mango Signer

A self-hosted iOS app signer, installer and App Library you use from Safari on your iPhone.
Upload an `.ipa`, add a `.p12` + `.mobileprovision`, tap **Sign**, then **Install**.

**[⬇️ Download the latest release](https://github.com/MangoMods-code/Mango-Signer/releases)** · each release lists everything that changed.

## Features
- **App Library** – the owner uploads apps (or imports from a link); invited users browse, search, sign and install them
- **Organization** – categories with emoji, featured apps, search, sorting, bulk select, full app editing, Update IPA, and default sign settings per app
- **Cloud Library** – add AltStore/SideStore/ESign-style sources, link-only apps, or keep your own IPAs in a (private) GitHub repo's release, so app files don't sit on your Railway volume. Files are downloaded only while signing and deleted right after. Older versions from sources can be picked when signing
- **Big files** – resumable uploads that survive dropped connections; old signed files are cleaned up automatically
- **Accounts** – invite codes, username + password login, or sign in with your iPhone (UDID)
- **Certificates** – each account adds its own `.p12` + `.mobileprovision`; shows type, expiry, revoke status, cert/profile mismatch, and whether your iPhone is in the profile
- **Entitlements** – one-tap JIT support (`get-task-allow`), increased memory limit, extended virtual addressing, plus custom entitlements; warns when your profile doesn't allow one
- **Info.plist editing** – 120Hz ProMotion, Game Mode, full screen, plus any custom key (add, change or remove)
- **Signing options** – change name, bundle ID, version, minimum iOS, icon; inject `.dylib` tweaks; remove extensions, Watch app or device limits; Files app sharing
- **Install** – one-tap over-the-air install, shareable install pages, download signed `.ipa`
- **Owner tools** – manage users (reset password, turn off, unlink iPhone, delete), invite codes, hide apps from the library, signing queue

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

## Notes
- JIT can't be switched on from a website; signing with **JIT support** lets tools like StikDebug attach to the app.
- Memory entitlements only work if the capability is enabled for your App ID in your Apple Developer account.
- Sign in with iPhone uses an iOS profile service to read the device UDID. It's a convenience login — anyone who could fake your UDID could use it, so the owner can turn it off in Settings.

## How it works
- `server.js` – web server and API (no npm dependencies)
- `lib/` – zip (local and HTTP range), plist, PNG (Apple CgBI icon), certificate, source and GitHub helpers
- `public/` – the iPhone web app
- Signing is done by [zsign](https://github.com/zhlynn/zsign) (MIT License, by zhlynn), compiled in the Docker build.

Only sign and share apps you have the right to use.

## License
© 2026 MangoMods. **All rights reserved.** The code is public so you can see how it works and run it on your own server for personal use. You may not copy, reupload, rebrand, sell, or present it as your own. See [LICENSE](LICENSE) for the full terms.
