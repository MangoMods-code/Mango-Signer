// Powers the in-app "What's New" screen. Newest version first.
// The first entry's version is the app's real version.
// Only things people using the app will notice go here — owner-only changes are left out.
module.exports = [
  {
    version: '1.2.4',
    date: '2026-10-30',
    title: 'Live Install Progress & Smoother Everything',
    summary: 'Watch your app install with a live percentage, and enjoy a smoother feel across the whole app.',
    sections: [
      {
        title: '📲 Live install progress',
        items: [
          'Tapping Install (or Get) now opens a progress screen with a ring that fills up as your iPhone downloads the app.',
          'It walks through each step: the install pop-up, downloading, and finishing on your Home Screen.',
          'While downloading you see the percentage, how much has downloaded, the speed and about how long is left.',
          'When the download finishes the ring turns green with a ✓. Your iPhone then finishes installing on the Home Screen.',
          'If nothing pops up, or you tap Cancel by accident, a hint appears with a Try again button to bring the pop-up back.',
          'If your iPhone says "Unable to Install" after downloading, the progress screen explains the usual reasons: a revoked certificate or an iPhone that isn\'t in the profile.',
          'Shared install links show progress too, so friends you send a link to can see their install happening.',
          'You can leave the app while it installs. When you come back, the progress catches up.',
        ],
      },
      {
        title: '✨ Smoother everything',
        items: [
          'Switching tabs slides the new page in from the side you tapped toward, and its rows ripple in one after another.',
          'Buttons, pills, chips and rows shrink slightly and light up while your finger is on them, so every tap feels like it registered.',
          'The tab bar icon gives a little pop when you pick a tab.',
          'Toggles have a springy knob that stretches while you hold it, like iPhone settings.',
          'Pop-ups spring up when they open and glide down when they close instead of disappearing instantly.',
          'Moving from one pop-up to another (like an app\'s page to signing) fades the new content in smoothly.',
          'Messages at the bottom of the screen glide up and fade away.',
          'App icons fade in as they load instead of popping in.',
          'Text boxes and the search bar glow softly when you tap into them.',
          'The Select bar slides up from the bottom, and checkmarks bounce when you tick an app.',
          'Progress bars and the install ring move smoothly instead of jumping.',
          'Opening What\'s New sections now animates in.',
          'If you have Reduce Motion turned on in your iPhone settings, all of this is switched off automatically.',
        ],
      },
    ],
  },
  {
    version: '1.2.3',
    date: '2026-10-30',
    title: 'Faster Uploads',
    summary: 'Big files now upload several pieces at once, and you can pick how hard uploads push your connection.',
    sections: [
      {
        title: '🚀 Parallel uploads',
        items: [
          'Files over 8 MB are split into pieces that upload at the same time instead of one after another, so there\'s no pause between pieces.',
          'On most connections this is noticeably faster, especially on Wi-Fi. If your internet\'s upload speed is the limit, nothing can go past that, but you\'ll get much closer to it.',
          'If a piece fails, only that piece is sent again. Everything else keeps going.',
          'Pieces can arrive in any order and are put back together exactly, byte for byte.',
        ],
      },
      {
        title: '🎚️ Upload speed setting',
        items: [
          'New Upload speed option in Account: Normal (1 piece at a time), Fast (3), Turbo (6) and Max (10).',
          'Turbo is the default. Try Max on strong Wi-Fi, or Normal if uploads keep dropping on a weak signal.',
          'The setting is saved on this device only, so your phone and iPad can use different speeds.',
        ],
      },
    ],
  },
  {
    version: '1.2.2',
    date: '2026-10-30',
    title: 'Smoother Pop-ups',
    summary: 'Pop-up screens now close properly when you swipe them down, and they no longer freeze.',
    sections: [
      {
        title: '👆 Swipe to close',
        items: [
          'Pop-up screens — like an app\'s details, signing, certificates and What\'s New — now follow your finger when you pull them down, just like iPhone apps.',
          'Let go after a long enough pull, or flick down quickly, and the pop-up closes. Let go early and it springs back into place.',
          'You can always pull down from the little handle at the top, even when you\'ve scrolled down inside the pop-up.',
          'When you\'re partway down a long pop-up, scrolling up takes you back to the top first instead of closing it by surprise.',
          'Text boxes, menus and side-scrolling rows inside a pop-up don\'t accidentally trigger a close.',
        ],
      },
      {
        title: '❌ Close button',
        items: [
          'Every pop-up now has a ✕ button in the top-right corner if you\'d rather tap than swipe.',
          'Tapping the dark area behind a pop-up still closes it too.',
          'While something is uploading or signing, the ✕ and swipe are paused so you can\'t close it by accident partway through.',
        ],
      },
      {
        title: '🐞 Fixes',
        items: [
          'Fixed pop-ups freezing when pulled down, which could leave them stuck so they wouldn\'t close afterward.',
          'The page behind a pop-up now stays still while the pop-up is open, so it no longer scrolls or bounces underneath.',
          'Going from one pop-up straight to another (like from an app\'s details to signing) no longer replays the slide-up animation.',
          'Pop-ups size themselves better on iPhones with the Safari toolbar showing.',
        ],
      },
    ],
  },
  {
    version: '1.2.1',
    date: '2026-10-30',
    title: "What's New & Update Alerts",
    summary: 'See everything that changed in each version, and get a heads-up when a newer version is ready.',
    sections: [
      {
        title: "✨ What's New screen",
        items: [
          "This screen! It lists every version of Mango Signer with a detailed breakdown of what changed.",
          'It opens by itself the first time you open the app after an update, and only once per version.',
          "Open it any time from Account › What's New.",
          'The newest version is open at the top. Tap an older version to read it.',
        ],
      },
      {
        title: '🔔 Update alerts',
        items: [
          'When a newer version of Mango Signer is ready, an orange "Version Updated! Tap here to refresh" bar appears at the top.',
          'It shows the version you have and the new one, for example V1.2.0 → V1.2.1.',
          'Tap it to reload on the newest version. Your account, certificates and signed apps stay exactly the same.',
          'The app checks every minute while it\'s open and whenever you come back to it, including on the sign-in screen.',
          "It never refreshes on its own, so it won't interrupt an upload or signing. Tap it whenever you're ready.",
        ],
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-10-30',
    title: 'Organized Library',
    summary: 'The App Library got search, categories and a Featured shelf, apps come set up and ready to sign, and signing got a lot simpler.',
    sections: [
      {
        title: '🔎 Finding apps',
        items: [
          'A search bar at the top of the App Library searches app names, descriptions, developers, notes and categories as you type.',
          'Category chips (like 🎮 Games and 🕹️ Emulators) filter the library. Each one shows how many apps it has.',
          'A sort menu switches between Grouped, A–Z, Newest and Biggest. Your choice is remembered on your device.',
          'The Grouped view shows a ★ Featured shelf at the top, then each category in its own section.',
        ],
      },
      {
        title: '📱 App pages',
        items: [
          'Tapping an app opens its own page with its category, version and size, a description, and notes like what\'s tweaked or setup tips.',
          'An info card shows the version, bundle ID, minimum iOS, size, extensions and when it was last updated.',
          'Apps can have custom icons, which also show on your home screen after you install them.',
        ],
      },
      {
        title: '⚡ Set up for you',
        items: [
          'Apps can come with their signing settings already chosen — things like JIT support, more RAM, 120Hz or Game Mode.',
          'You\'ll see "Comes set up with: …" on the app\'s page and "✨ Set up for you" when you sign, so you can just tap Sign.',
          'Library rows show a quick preview of what an app comes set up with.',
        ],
      },
      {
        title: '✍️ Simpler signing',
        items: [
          'The sign screen now starts simple: pick your certificate and tap one big Sign App button.',
          'Name, bundle ID, version, minimum iOS, icon, entitlements, Info.plist, tweaks and other options are tucked under "More options".',
          'If your certificate can\'t do something an app needs (like More RAM), a clear warning shows up before you sign.',
          'Your screen stays awake while uploading and signing (iOS 16.4 and newer).',
        ],
      },
      {
        title: '🛡️ Certificates',
        items: [
          'Each certificate shows what it allows: JIT, More RAM and Extended VA, each with a ✓ or ✕.',
          'Cards show the profile name and separate expiry dates for the certificate and the profile.',
          'You can rename your certificates.',
          'The Certificates tab shows a red dot when one is revoked or has less than a week left.',
        ],
      },
      {
        title: '📦 Signed apps',
        items: [
          'Each signed app shows how many days are left before its certificate expires, highlighted when it\'s under a week.',
          'Signed files are cleaned up after a while to save space. Apps you already installed keep working, and they move to a "File removed" section with a Re-sign button.',
        ],
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-30',
    title: 'App Library & Accounts',
    summary: 'Mango Signer opened up to friends: an App Library to sign from, your own account and certificates, and JIT, more RAM and Info.plist tweaks.',
    sections: [
      {
        title: '📚 App Library',
        items: [
          'Browse the App Library and sign and install any app in it with your own certificate.',
        ],
      },
      {
        title: '👤 Your account',
        items: [
          'Join with an invite code. Invite links fill in the code for you.',
          'Sign in with your username and password, or with "Sign in with this iPhone" after linking your device.',
          'Change your password and link or unlink your iPhone from the Account tab.',
        ],
      },
      {
        title: '🔐 Private certificates',
        items: [
          'Your certificates and signed apps are private to your account. Nobody else can see or use them.',
          'You can store up to 5 certificates, and your newest signed apps are kept ready to install.',
          'Certificate cards show whether your linked iPhone is in the profile, so you know before signing if an app will install.',
        ],
      },
      {
        title: '🧬 Entitlements & Info.plist',
        items: [
          'One-tap toggles for JIT support, increased memory limit and extended virtual addressing.',
          'Add any custom entitlement with a Yes/No or text value.',
          'Warnings appear when your profile doesn\'t allow an entitlement you turned on.',
          'Info.plist presets for 120Hz ProMotion, Game Mode and Require full screen, plus any custom key you want to add, change or remove.',
          'After signing an app with JIT support, a reminder explains how to turn JIT on with a tool like StikDebug.',
        ],
      },
      {
        title: '⏳ Signing queue',
        items: [
          'If someone else is signing at the same time, you\'ll see "Waiting in line…" and your app starts as soon as it\'s your turn.',
        ],
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-30',
    title: 'First Release',
    summary: 'The very first Mango Signer: sign and install iPhone apps right from Safari.',
    sections: [
      {
        title: '🥭 The basics',
        items: [
          'Add your .p12 certificate and .mobileprovision profile, and see your team, type, expiry and whether the certificate is revoked.',
          'Sign apps with options to change the name, bundle ID, version, minimum iOS and icon, add .dylib tweaks, and remove extensions, the Watch app or device limits.',
          'Install signed apps with one tap, share an install link, or download the signed .ipa.',
          'Add Mango Signer to your home screen to use it like an app.',
        ],
      },
    ],
  },
];
