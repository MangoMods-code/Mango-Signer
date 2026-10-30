# 🥭 Mango Signer

A self-hosted iOS app signer, installer and App Library you use from Safari on your iPhone.
Upload an `.ipa`, add a `.p12` + `.mobileprovision`, tap **Sign**, then **Install**.

## Features
- **App Library** – the owner uploads apps (or imports from a link); invited users browse, search, sign and install them
- **Organization** – categories with emoji, featured apps, search, sorting, bulk select, full app editing, Update IPA, and default sign settings per app
- **Big files** – resumable uploads that survive dropped connections; old signed files are cleaned up automatically
- **Accounts** – invite codes, username + password login, or sign in with your iPhone (UDID)
- **Certificates** – each account adds its own `.p12` + `.mobileprovision`; shows type, expiry, revoke status, cert/profile mismatch, and whether your iPhone is in the profile
- **Entitlements** – one-tap JIT support (`get-task-allow`), increased memory limit, extended virtual addressing, plus custom entitlements; warns when your profile doesn't allow one
- **Info.plist editing** – 120Hz ProMotion, Game Mode, full screen, plus any custom key (add, change or remove)
- **Signing options** – change name, bundle ID, version, minimum iOS, icon; inject `.dylib` tweaks; remove extensions, Watch app or device limits; Files app sharing
- **Install** – one-tap over-the-air install, shareable install pages, download signed `.ipa`
- **Owner tools** – manage users (reset password, turn off, unlink iPhone, delete), invite codes, hide apps from the library, signing queue

## Deploy on Railway
1. Put this project in a GitHub repo and create a Railway service from it (it builds from the `Dockerfile`).
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

## Notes
- JIT can't be switched on from a website; signing with **JIT support** lets tools like StikDebug attach to the app.
- Memory entitlements only work if the capability is enabled for your App ID in your Apple Developer account.
- Sign in with iPhone uses an iOS profile service to read the device UDID. It's a convenience login — anyone who could fake your UDID could use it, so the owner can turn it off in Settings.

## How it works
- `server.js` – web server and API (no npm dependencies)
- `lib/` – zip, plist, PNG (Apple CgBI icon) and certificate readers
- `public/` – the iPhone web app
- Signing is done by [zsign](https://github.com/zhlynn/zsign), compiled in the Docker build.

Only sign and share apps you have the right to use.
