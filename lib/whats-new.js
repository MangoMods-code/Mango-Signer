// Powers the in-app "What's New" screen. Newest version first.
// The first entry's version is the app's version.
module.exports = [
  {
    version: '1.2.1',
    date: '2026-10-30',
    title: "What's New & Update Alerts",
    summary: 'You can now see everything that changed in each version, and the app tells you when a newer version is ready.',
    sections: [
      {
        title: "✨ What's New screen",
        items: [
          "A new What's New screen lists every version of Mango Signer with a full, detailed breakdown of what changed.",
          'It opens by itself the first time you open the app after an update, so you never miss a change. It only shows once per version.',
          "You can open it any time from Settings (owner) or Account (everyone else) by tapping What's New.",
          'The newest version is expanded at the top. Older versions are folded up underneath — tap one to read it.',
          "Each version shows its date, a one-line summary, and the changes grouped into sections like Library, Signing and Fixes.",
        ],
      },
      {
        title: '🔔 Update alerts',
        items: [
          'When the server is updated while you have the app open, an orange "Version Updated! Tap here to refresh" bar appears at the top of the screen.',
          'The bar shows which version you have and which one is ready, for example V1.2.0 → V1.2.1.',
          'Tapping it reloads the app on the newest version. Nothing is lost — your library, certificates and signed apps all stay the same.',
          'The app checks for a new version every minute while it is open, and again whenever you come back to it from another app or the home screen.',
          'The check also runs on the sign-in screen, so people who are logged out see it too.',
          "It never refreshes on its own, so it won't interrupt an upload or signing. Tap it whenever you're ready.",
        ],
      },
      {
        title: '©️ License & credits',
        items: [
          'Mango Signer now has an official license: © 2026 MangoMods, all rights reserved.',
          'The code is public so people can see how it works and run it on their own server for personal use, but it may not be copied, reuploaded, rebranded, sold, or presented as someone else\'s work.',
          'The full terms are in the LICENSE file and in a new License section at the bottom of the README.',
          'A copyright line now shows on the sign-in screen, at the bottom of Settings and Account, and on shared install pages.',
          'zsign, the signing engine, keeps its own MIT license and is credited in the app and README.',
        ],
      },
      {
        title: '🧹 Housekeeping',
        items: [
          'The CHANGELOG file was removed from the project. Release notes now live in each GitHub release, and the full history lives here in the app.',
          'The app page now loads its scripts with the version attached, so iPhones always pick up the newest files after an update instead of an old saved copy.',
        ],
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-10-30',
    title: 'Organized Library',
    summary: 'A big organization update: categories, search, a Featured shelf, full app editing, one-tap signing setups, bulk actions and uploads that survive bad connections.',
    sections: [
      {
        title: '📂 Categories',
        items: [
          'Apps can now be sorted into categories, each with its own emoji.',
          'Six starter categories are included: 🎮 Games, 🕹️ Emulators, 💬 Social, 🎵 Music & Video, 🧰 Utilities and ✨ Tweaked.',
          'The owner can create, rename, change the emoji of, reorder (with up and down arrows) and delete categories from Library › ⚙︎ Edit, or from Settings › Categories.',
          'Deleting a category never deletes apps — they simply move to Uncategorized.',
          'You can also make a brand-new category right from an app\'s edit screen by choosing "+ New category…".',
        ],
      },
      {
        title: '🔎 Finding apps',
        items: [
          'A search bar at the top of the library searches app names, bundle IDs, descriptions, developers, notes and category names as you type.',
          'Category chips under the search bar filter the library. Each chip shows how many apps it has.',
          'The owner also gets Uncategorized and Hidden chips to quickly find apps that need sorting or are hidden from users.',
          'A sort menu lets you switch between Grouped, A–Z, Newest and Biggest. Your chosen filter and sort are remembered on your device.',
          'The default Grouped view shows a ★ Featured shelf at the top, then one section per category in your chosen order, then everything else under Other.',
        ],
      },
      {
        title: '✏️ Editing library apps',
        items: [
          'Right after you upload or import an app, an "Add details" screen opens so you can set everything up straight away (all optional).',
          'You can change the name shown in the library, its category, the developer or source, a description, and a separate "Notes / what\'s tweaked" box.',
          'Apps can be marked Featured (pinned to the top with a ★) and shown or hidden from the App Library.',
          'You can give an app a custom icon (square PNG). By default the custom icon is also used on the installed app when it\'s signed, and you can turn that off.',
          'You can go back to the app\'s original icon at any time.',
          'The app detail screen now shows category, featured and version badges, the description and notes, and a full info card with version, bundle ID, minimum iOS, size, extensions and when it was added or updated.',
        ],
      },
      {
        title: '⬆️ Update IPA',
        items: [
          'Owners can swap in a newer .ipa for an existing library app, from a file or from a link.',
          'Everything you set up is kept: name, category, description, notes, icon, featured, visibility and default sign settings.',
          'The app\'s version, size and info are refreshed from the new file, and the detail screen shows what version it was before.',
        ],
      },
      {
        title: '⚡ Default sign settings',
        items: [
          'Each library app can have its own default sign settings: JIT support, increased memory limit, extended virtual addressing, 120Hz, Game Mode, full screen, custom entitlements and Info.plist keys, minimum iOS, and options like removing extensions or showing the app in the Files app.',
          'These are switched on automatically whenever anyone signs that app, so friends can just tap Sign without knowing what any of it means.',
          'Library rows show a short preview of an app\'s defaults (for example "JIT, More RAM"), and the detail screen says "Comes set up with: …".',
        ],
      },
      {
        title: '✍️ Simpler signing',
        items: [
          'The sign screen now starts simple: pick a certificate and tap one big Sign App button.',
          'If the app has default settings, a "✨ Set up for you" note lists them.',
          'Everything else — name, bundle ID, version, minimum iOS, icon, entitlements, Info.plist, tweaks and options — is tucked under "More options".',
          'If your certificate\'s profile doesn\'t allow something that\'s turned on (like More RAM), you get a clear warning right under the certificate before you sign.',
        ],
      },
      {
        title: '☑️ Bulk select',
        items: [
          'Tap Select in the library to tick several apps at once.',
          'Then move them to a category, show or hide them, feature or unfeature them, or delete them, all in one go.',
        ],
      },
      {
        title: '📶 Big uploads',
        items: [
          'Uploads over 8 MB are now sent in pieces. If your connection drops, the upload waits and continues from where it stopped instead of starting over.',
          'While uploading you see how much has been sent, the current speed and roughly how long is left.',
          'Your screen is kept awake during uploads and signing (iOS 16.4 and newer) so locking doesn\'t cut them off.',
          'Import from link now fixes Dropbox links automatically (dl=0 becomes dl=1) and gives a clear message if a link opens a web page instead of a file.',
        ],
      },
      {
        title: '🛡️ Certificates',
        items: [
          'Each certificate now shows what its profile allows: JIT, More RAM and Extended VA, each with a ✓ or ✕.',
          'Certificate cards show the profile name and separate expiry dates for the certificate and the profile.',
          'Certificates can be renamed.',
          'The Certificates tab shows a red dot when one of your certificates is revoked or has less than a week left.',
        ],
      },
      {
        title: '📦 Signed apps & storage',
        items: [
          'Signed apps now show how many days are left before their certificate expires, highlighted when it\'s under a week.',
          'Signed files are automatically deleted after 7 days by default to keep big games from filling your server. The owner can change this to 1, 3, 7 or 30 days, or never.',
          'Apps you already installed keep working after their signed file is cleaned up. The Signed tab moves them to a "File removed" section with a Re-sign button.',
          'Settings shows a colored storage bar split into Library, Signed, Certificates and Temp, with buttons to clean up old signed files and temporary files.',
        ],
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-30',
    title: 'App Library & Accounts',
    summary: 'Mango Signer became multi-user: invite friends, let them sign apps from your library with their own certificates, and unlock JIT, more RAM and Info.plist tweaks.',
    sections: [
      {
        title: '📚 App Library',
        items: [
          'Apps the owner uploads now appear in an App Library that invited users can browse, sign and install.',
          'The owner can hide any app from the App Library and add a description to it.',
          'Only the owner can upload, edit, download originals or delete library apps.',
        ],
      },
      {
        title: '👥 Accounts & invites',
        items: [
          'People join with an invite code made by the owner in the new Users tab. Each code can be set to work for 1 to 100 people and can have a note like who it\'s for.',
          'Invite links open the sign-up screen with the code already filled in.',
          'Users sign in with a username and password, or with "Sign in with this iPhone", which reads the device\'s UDID through a quick profile.',
          'The owner signs in with their password, leaving the username blank.',
          'Users can change their password and link or unlink their iPhone from the Account tab.',
          'The owner can see every user, their linked iPhone, certificate and signed counts and when they were last seen, and can reset passwords, turn accounts off and on, unlink iPhones or delete accounts.',
          'Login attempts are rate-limited to slow down password guessing.',
        ],
      },
      {
        title: '🔐 Private certificates',
        items: [
          'Every account has its own certificates and signed apps. Nobody can see or use anyone else\'s.',
          'Each user can store up to 5 certificates, and their newest 10 signed apps are kept by default (the owner can change this).',
          'Certificate cards show whether your linked iPhone is included in the profile, so you know before signing if an app will install.',
        ],
      },
      {
        title: '🧬 Entitlements & Info.plist',
        items: [
          'One-tap toggles for JIT support (get-task-allow), increased memory limit and extended virtual addressing.',
          'Add any custom entitlement with a Yes/No or text value.',
          'Warnings appear when your profile doesn\'t allow an entitlement you turned on.',
          'Info.plist presets for 120Hz ProMotion, Game Mode and Require full screen.',
          'Add, change or remove any custom Info.plist key as text, number or Yes/No.',
          'After signing an app with JIT support, a reminder explains how to turn JIT on with a tool like StikDebug.',
        ],
      },
      {
        title: '⚙️ Behind the scenes',
        items: [
          'A signing queue lets several people sign at the same time without overloading the server; others see "Waiting in line…".',
          'The signing engine version in Settings is now shown in a cleaner format.',
        ],
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-30',
    title: 'First Release',
    summary: 'The very first Mango Signer: a self-hosted app signer and installer you use from Safari on your iPhone.',
    sections: [
      {
        title: '🥭 The basics',
        items: [
          'Upload .ipa files from Files or import them from a link. Mango reads the app\'s name, version, bundle ID and real icon.',
          'Add a .p12 certificate and .mobileprovision profile. Mango shows the team, type, expiry, device count and whether the certificate is revoked, and warns if the certificate and profile don\'t match.',
          'Sign apps with options to change the name, bundle ID, version, minimum iOS and icon, inject .dylib tweaks, and remove extensions, the Watch app or device limits.',
          'Install signed apps with one tap, share an install page link, download the signed .ipa, or reset the install link.',
          'Password-protected, with .p12 passwords stored encrypted, and works as a home-screen app.',
        ],
      },
    ],
  },
];
