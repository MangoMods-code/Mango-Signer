# 🥭 Mango Signer

A self-hosted iOS app signer and installer you use from Safari on your iPhone.
Upload an `.ipa`, add your `.p12` + `.mobileprovision`, tap **Sign**, then **Install**.

## Features
- **Library** – upload `.ipa` files or import them from a link; reads name, version, bundle ID and icon
- **Certificates** – add `.p12` + `.mobileprovision`, see team, type (Development / Ad Hoc / Enterprise), expiry, device count, revocation status (OCSP), and a warning if the cert and profile don't match
- **Signing** – change name, bundle ID, version, minimum iOS, icon; inject `.dylib` tweaks (normal or weak, optionally into extensions); remove extensions, Watch app or device limits; enable Files app sharing
- **Install** – one-tap over-the-air install plus a shareable install page; download signed `.ipa`; reset links
- Password login, `.p12` passwords encrypted at rest, Add to Home Screen support

## Deploy on Railway
1. Push this folder to a GitHub repo and create a Railway service from it (it builds from the `Dockerfile`).
2. Add a **volume** mounted at `/data` (apps, certs and signed files live there).
3. Set variables:
   - `APP_PASSWORD` – your login password (required)
   - `SESSION_SECRET` – optional, any long random string
4. Generate a public domain (installs need HTTPS) and open it in Safari.

## Environment variables
| Name | Default | Purpose |
|---|---|---|
| `APP_PASSWORD` | – | Login password |
| `DATA_DIR` | `/data` | Storage folder |
| `PUBLIC_URL` | auto | Override the address used in install links |
| `MAX_UPLOAD_MB` | `4096` | Upload size limit |
| `ZSIGN_PATH` | `zsign` | Path to the zsign binary |

## How it works
- `server.js` – web server and API (no npm dependencies)
- `lib/` – zip, plist, PNG (Apple CgBI icon) and certificate readers
- `public/` – the iPhone web app
- Signing is done by [zsign](https://github.com/zhlynn/zsign), compiled in the Docker build.

Only sign apps you have the right to use, with your own certificate.
