// Powers the in-app "What's New" screen. Newest version first.
// The first entry's version is the app's real version.
// Only things people using the app will notice go here — owner-only changes are left out.
module.exports = [
  {
    version: '1.12.6',
    date: '2026-11-03',
    title: 'Cleaner Lists',
    summary: 'Tags and sizes are easier to see.',
    sections: [
      {
        title: '✨ Look',
        items: [
          'Signed apps show "On your phone", days left and ☁ Saved on their own line, so nothing gets cut off.',
          'App sizes show in grid view too, and come before the developer name in list view.',
        ],
      },
    ],
  },
  {
    version: '1.12.5',
    date: '2026-11-03',
    title: 'No Doubles',
    summary: 'The library no longer gets the same app twice from the same link.',
    sections: [
      {
        title: '📚 Library',
        items: [
          'Fewer duplicate apps: the same source, repo, channel or link can only be added once.',
        ],
      },
    ],
  },
  {
    version: '1.12.4',
    date: '2026-11-03',
    title: 'Your Certificates, Everywhere',
    summary: 'Signing on your iPhone now uses the certificates on your account.',
    sections: [
      {
        title: '📱 iPhone app',
        items: [
          'Sign on this iPhone works with the certificates on your account (marked ☁). No need to add them a second time.',
          'Reinstalled the app? Your account certificates come back by themselves.',
        ],
      },
    ],
  },
  {
    version: '1.12.3',
    date: '2026-11-03',
    title: 'Privacy Tune-up',
    summary: 'You only get the details you need.',
    sections: [
      {
        title: '🔒 Privacy',
        items: [
          'Collections only show apps you can see.',
          'Testers get the 🧪 badge and the apps picked for testers. Daily sign limits are the same for everyone.',
        ],
      },
    ],
  },
  {
    version: '1.12.2',
    date: '2026-11-03',
    title: 'Join as a Tester',
    summary: 'Some invites now make you a tester the moment you sign up.',
    sections: [
      {
        title: '🧪 Testers',
        items: [
          'If you joined with a tester invite, you are a tester right away: you get the 🧪 badge and the apps picked for testers.',
        ],
      },
    ],
  },
  {
    version: '1.12.1',
    date: '2026-11-03',
    title: 'Tune-up',
    summary: 'Small fixes to keep things safe and quick.',
    sections: [
      {
        title: '🔧 Fixes',
        items: [
          'The iPhone app no longer flashes back to older info when you tap things quickly.',
          'Behind-the-scenes safety and speed fixes on the server.',
        ],
      },
    ],
  },
  {
    version: '1.12.0',
    date: '2026-11-03',
    title: 'Better Sorted Library',
    summary: 'More apps now sit in the right category, so they are easier to find.',
    sections: [
      {
        title: '📂 Library',
        items: [
          'Apps are sorted into categories much better now, so browsing Games, Emulators, Music & Video and the rest finds more of what you are after.',
        ],
      },
    ],
  },
  {
    version: '1.11.2',
    date: '2026-11-03',
    title: 'Telegram Apps Sign Again',
    summary: 'Apps from Telegram channels no longer get stuck on "Downloading".',
    sections: [
      {
        title: '✍️ Signing',
        items: [
          'When Telegram makes Mango wait before sending a file, signing shows a countdown and carries on by itself instead of looking stuck.',
          'Cancelling a sign now stops its Telegram download right away, so it doesn\'t slow down the next one.',
          'If a Telegram file can\'t be downloaded, you see the real reason instead of a spinner.',
        ],
      },
    ],
  },
  {
    version: '1.11.1',
    date: '2026-11-03',
    title: 'Sign in the Background',
    summary: 'Big apps can keep signing while you do something else.',
    sections: [
      {
        title: '✍️ Signing',
        items: [
          'While an app is signing, tap "Keep going in the background" to close the screen. Signing keeps going on the server.',
          'You get an alert when it\'s ready (or if it fails). Tap the alert to install it.',
        ],
      },
    ],
  },
  {
    version: '1.11.0',
    date: '2026-11-03',
    title: 'Admins & Testers',
    summary: 'The owner can now make people admins or testers.',
    sections: [
      {
        title: '⭐ Admins',
        items: [
          'Admins can help run Mango: add and edit apps, sources, categories and tweaks, look after users and invites, answer requests, and see stats and activity.',
          'Admins have no daily sign limit.',
        ],
      },
      {
        title: '🧪 Testers',
        items: [
          'Testers see apps marked "Testers only", in a 🧪 For testers list at the top of their library.',
          'Testers can send bug reports straight from an app\'s page or their Account tab, and see the answer.',
        ],
      },
    ],
  },
  {
    version: '1.10.0',
    date: '2026-11-03',
    title: 'Signed Apps Stay on Your iPhone',
    summary: 'The Mango Signer iPhone app can now keep every app you sign and put it back when the server cleans it up.',
    sections: [
      {
        title: '📱 iPhone app',
        items: [
          'Everything you sign is saved inside the Mango Signer iPhone app too, like ESign.',
          'If the server already removed a signed file, the app puts its saved copy back, so you can install it again without signing it again.',
          'The app checks what\'s really installed on your iPhone, so your installed apps list stays right on its own.',
        ],
      },
    ],
  },
  {
    version: '1.9.9',
    date: '2026-11-03',
    title: 'GitHub Updates Fix, Part 2',
    summary: 'Apps from GitHub repos now always pick the release that came out last.',
    sections: [
      {
        title: '🛠 Fixes',
        items: [
          'GitHub doesn\'t always list releases newest first, so some apps from GitHub repos stayed on an older release. Mango now goes by the date each release came out.',
        ],
      },
    ],
  },
  {
    version: '1.9.8',
    date: '2026-11-03',
    title: 'GitHub Updates Fix',
    summary: 'Apps from GitHub repos always show their newest version.',
    sections: [
      {
        title: '🛠 Fixes',
        items: [
          'Apps from GitHub repos whose releases are named things like "build-8" instead of a version number now update to the newest release instead of getting stuck on an older one.',
        ],
      },
    ],
  },
  {
    version: '1.9.7',
    date: '2026-11-03',
    title: 'Ready for the iPhone App',
    summary: 'Mango Signer can now work with the Mango Signer iPhone app.',
    sections: [
      {
        title: '📱 iPhone app',
        items: [
          'The Mango Signer iPhone app can sign in to this server and show your library, certificates and signed apps.',
          'In the app you can sign on the server like always, or have the app signed right on your iPhone. Signing on your iPhone counts toward your daily sign limit, the same as signing here.',
        ],
      },
    ],
  },
  {
    version: '1.9.6',
    date: '2026-11-02',
    title: 'Safer iPhone Sign-In',
    summary: 'Signing in with your iPhone now checks that it\'s really your iPhone.',
    sections: [
      {
        title: '🔒 Sign in with iPhone',
        items: [
          'Signing in with your iPhone now checks Apple\'s signature on your iPhone\'s answer, so it only works from the real iPhone. Someone who knows your device ID can\'t use it to get into your account.',
          'If the check can\'t be done for some reason, you\'re asked to sign in with your username and password instead.',
        ],
      },
    ],
  },
  {
    version: '1.9.5',
    date: '2026-11-02',
    title: 'Security Check-Up',
    summary: 'A security tune-up: safer sign-in and stronger protection for your account.',
    sections: [
      {
        title: '🔒 Security',
        items: [
          'If someone keeps entering wrong passwords for your account, they get locked out, not you. You can still sign in from your own phone.',
          'Login limits can no longer be dodged by faking where a request comes from.',
          'Other websites can\'t show Mango inside their page, which stops tricks that get you to tap buttons you can\'t see.',
          'App and tweak names are always shown as plain text, so a badly named tweak can\'t mess with the app.',
        ],
      },
    ],
  },
  {
    version: '1.9.4',
    date: '2026-11-02',
    title: 'Apps From Websites',
    summary: 'Apps that a developer posts on their own website now update by themselves too.',
    sections: [
      {
        title: '🌐 Apps from websites',
        items: [
          'Apps whose developer posts them on their own website now update by themselves. When the site gets a new version, it shows up as an update.',
          'Older versions stay available to sign, even after the website removes them.',
          'Each app gets its real name, icon and version from the app itself.',
        ],
      },
    ],
  },
  {
    version: '1.9.3',
    date: '2026-11-02',
    title: 'Links From Anywhere',
    summary: 'Paste a direct .ipa link from any website into either box and it just works.',
    sections: [
      {
        title: '🔗 Adding apps by link',
        items: [
          'A direct link to an .ipa file from any website now works in the Add Source box too, not just in Add App. Mango adds that one app.',
          'Links work without the https:// at the start.',
        ],
      },
    ],
  },
  {
    version: '1.9.2',
    date: '2026-11-02',
    title: 'Smarter Check Order',
    summary: 'GitHub and source updates come in first, before the slower Telegram channels.',
    sections: [
      {
        title: '🔄 Update checks',
        items: [
          'GitHub repos and sources are always checked before Telegram channels, so their updates show up first instead of waiting behind a big channel.',
          'Smaller Telegram channels are checked before bigger ones.',
          'Big channels are checked at a gentler pace, so Telegram doesn\'t make Mango wait as often.',
        ],
      },
    ],
  },
  {
    version: '1.9.1',
    date: '2026-11-02',
    title: 'Channel Fix',
    summary: 'Fixed Telegram channels wrongly showing as private.',
    sections: [
      {
        title: '✈️ Telegram channels',
        items: [
          'Fixed channels showing "That channel is private" after the last update, even though they\'re public. New apps from them come in again on the next check.',
        ],
      },
    ],
  },
  {
    version: '1.9.0',
    date: '2026-11-02',
    title: 'Faster Channel Checks',
    summary: 'Checking Telegram channels for new apps takes seconds instead of minutes.',
    sections: [
      {
        title: '✈️ Telegram channels',
        items: [
          'Checking a channel for new apps now takes seconds. Before, it could sit for minutes.',
          'If Telegram asks Mango to slow down, the check says so and counts down the wait instead of looking frozen.',
          'Each check says what it found ("No new apps posted ✓" or "3 new posts with an app").',
          'Apps whose post was deleted from a channel are noticed within a few hours instead of on every check, which keeps checks quick.',
        ],
      },
    ],
  },
  {
    version: '1.8.9',
    date: '2026-11-02',
    title: 'Stop Means Stop',
    summary: 'Stopping a check now lets the next one start right away.',
    sections: [
      {
        title: '⏳ Activity',
        items: [
          'Stopping a check now lets the ones waiting behind it start right away. Before, they kept waiting while the stopped one finished what it was in the middle of.',
          'Checking the same channel again right after stopping it waits a moment for the stopped one to wrap up, so the same app is never added twice.',
        ],
      },
    ],
  },
  {
    version: '1.8.8',
    date: '2026-11-02',
    title: 'Activity',
    summary: 'A new Activity screen shows everything running on the server live, with no more endless loading.',
    sections: [
      {
        title: '⏳ Activity',
        items: [
          'New Activity screen: open it from the ⏳ button or Settings › Activity, any time, even when nothing is running.',
          'It\'s split into Running, Waiting in line and Finished, with progress, how long each has been going, and what each one found ("3 new · 1 updated").',
          'Tap anything to see its full log, updating live.',
          'Waiting items show their place in line and what they\'re waiting for, always up to date, so they never say they\'re waiting for something that already finished.',
          'Check all now and Stop all buttons.',
          'The ⏳ button says ✓ All done for a moment when everything finishes, then the library refreshes.',
          'A channel or source page shows when it\'s being checked, with a link to the Activity screen.',
        ],
      },
      {
        title: '🛡️ Nothing gets stuck',
        items: [
          'If a check stops making progress for 15 minutes, it\'s stopped automatically so the ones waiting behind it can run.',
          'Something that has finished can never show as still running or waiting.',
          'Status updates more often while the Activity screen is open, and picks up right away when you come back to the app.',
        ],
      },
    ],
  },
  {
    version: '1.8.7',
    date: '2026-11-02',
    title: 'Small Fixes',
    summary: 'Behind-the-scenes improvements to keep the library tidy.',
    sections: [
      {
        title: '🧹 Tidier library',
        items: [
          'When the same app is in the library more than once, the right version is kept, so you see the version that\'s meant to be there.',
        ],
      },
    ],
  },
  {
    version: '1.8.6',
    date: '2026-11-02',
    title: 'No More Duplicates',
    summary: 'The library no longer fills up with the same app twice.',
    sections: [
      {
        title: '🔁 One of each app',
        items: [
          'When a channel or source has an app that\'s already in the library, it\'s skipped instead of added again, so you won\'t see the same app twice.',
          'Duplicates that were already there have been tidied up.',
        ],
      },
    ],
  },
  {
    version: '1.8.5',
    date: '2026-11-02',
    title: 'Smoother Updates',
    summary: 'Apps from channels, GitHub and sources are checked for updates every hour, one at a time, so checks no longer slow each other down.',
    sections: [
      {
        title: '🔄 Update checks',
        items: [
          'Every channel, GitHub repo and source is checked for new versions every hour.',
          'Only one check runs at a time. If you start one while another is running, it waits its turn and starts by itself, and the screen tells you what it\'s waiting for.',
          'Waiting checks show as "Waiting" under the ⏳ button, where you can cancel them before they start.',
          'Starting the same check twice just shows the one that\'s already running instead of doubling up.',
        ],
      },
    ],
  },
  {
    version: '1.8.4',
    date: '2026-11-02',
    title: 'Tidy Version Notes',
    summary: 'Version notes are easier to read, and deleted apps stay deleted.',
    sections: [
      {
        title: '📝 Version notes',
        items: [
          'Notes under Other versions no longer pile on top of each other. Each shows 3 lines. Tap it to read the rest.',
          'Notes are shown as clean text, without stray symbols like ## and **.',
        ],
      },
      {
        title: '🧹 Fewer duplicates',
        items: [
          'Apps removed from the library stay removed when their source refreshes, so the same app doesn\'t come back twice from different places.',
        ],
      },
    ],
  },
  {
    version: '1.8.3',
    date: '2026-11-02',
    title: 'Apps from GitHub',
    summary: 'Apps whose developers post them on GitHub now update by themselves.',
    sections: [
      {
        title: '🐙 GitHub apps that keep updating',
        items: [
          'Apps from developers who post their .ipa on GitHub now stay up to date by themselves. When the developer releases a new version, it shows up as an update.',
          'Older versions stay available to sign, each with that release\'s notes.',
          'Each app gets its real name, icon and version from the app itself.',
        ],
      },
    ],
  },
  {
    version: '1.8.2',
    date: '2026-11-02',
    title: 'Signed Apps That Stay',
    summary: 'Your signed apps now stay in the Signed tab, ready to install again, until you delete them.',
    sections: [
      {
        title: '📦 Signed tab',
        items: [
          'Signed apps no longer get cleaned up after a day or after you install them. They stay ready to install again any time, with no re-signing, until you delete them.',
          'Signed apps marked ☁ saved are stored safely off the server, so they never fill it up.',
          'Deleting a signed app removes it everywhere.',
          'When the certificate an app was signed with expires, that copy is removed, since it couldn\'t be installed anyway. Tap Re-sign to make a fresh one.',
        ],
      },
    ],
  },
  {
    version: '1.8.1',
    date: '2026-11-02',
    title: 'Faster Signing',
    summary: 'Apps from Telegram download several times faster, signing the same app again skips the download, and signing itself is quicker.',
    sections: [
      {
        title: '🚀 Speed',
        items: [
          'Apps from Telegram channels now download in 8 pieces at once instead of one at a time, which is several times faster for big games.',
          'Signing an app that was signed in the last couple of days reuses the copy already downloaded, so it skips the download completely.',
          'Signing is quicker: the signed app is packed with faster compression. It can be a few percent bigger but takes much less time.',
          'The signing log shows how fast the download went.',
        ],
      },
    ],
  },
  {
    version: '1.8.0',
    date: '2026-11-02',
    title: 'Smarter Installed Apps',
    summary: 'Update reminders are now accurate, you can fix your installed list yourself, and nothing gets stuck loading forever.',
    sections: [
      {
        title: '📱 Your installed apps, done right',
        items: [
          'Update reminders only show up when there\'s actually a newer version than the one you installed. Mango now compares real version numbers, so a renamed version (like "2.0 MOD") no longer looks like an update.',
          'Updated an app somewhere else? Tap "I already updated it" on the app\'s page and the reminder goes away.',
          'Deleted an app from your phone? Tap "Not on my phone anymore" and Mango stops treating it as installed.',
          'New "Your installed apps" list: tap Fix the list in the Installed or Updates filter (or Review in the Signed tab) to see everything Mango thinks is on your phone, with ✓ and ✕ buttons to fix it in one place.',
          'Apps whose certificate has expired or been revoked show "⚠ Won\'t open" instead of asking you to update, with a Sign Again to Fix button.',
          'Installing an app replaces any other app on your phone with the same bundle ID, and the list now knows that.',
          'Installs from a shared install link no longer count as on your phone, since the link could have been opened on anyone\'s phone.',
          'Old update alerts for apps you already updated or deleted are cleared out.',
          'In the Signed tab, the copy that\'s on your phone is marked "On your phone".',
        ],
      },
      {
        title: '⚡ Nothing hangs anymore',
        items: [
          'Every request now gives up with a clear message if the connection or server goes quiet, instead of spinning forever.',
          'Downloads and uploads that stop moving for a minute and a half are stopped with a message, so you can just try again.',
          'If an install gets stuck partway, the install screen tells you after 30 seconds and how to fix it.',
          'If the server restarts during an update while something is running, you\'re told to start it again instead of it waiting forever.',
          'The library loads faster with thousands of apps.',
        ],
      },
    ],
  },
  {
    version: '1.7.7',
    date: '2026-11-02',
    title: 'Missing Apps Are Back',
    summary: 'Hundreds of apps from Telegram channels were wrongly hidden as removed. They\'re back in the library.',
    sections: [
      {
        title: '🔧 Fixed',
        items: [
          'Apps from big Telegram channels could get marked "Removed from source" and hidden even though their post was still there. Mango now checks every post properly, and apps that were hidden by mistake come back on their own a few seconds after the update.',
          'Apps that really were taken down from their channel or source are still hidden, so you only see apps you can actually get.',
        ],
      },
    ],
  },
  {
    version: '1.7.6',
    date: '2026-11-02',
    title: 'Lighter Icons',
    summary: 'App icons are saved at a normal size, so the library loads faster and takes up much less space.',
    sections: [
      {
        title: '🖼️ Smaller, faster icons',
        items: [
          'App icons used to be saved at full size, sometimes over 1 MB each. Now they\'re saved at the size your phone shows them (180px), so they look the same but are a small fraction of the size.',
          'Icons that were already saved get shrunk on their own a few seconds after the update. Nothing about your apps changes.',
          'The library loads faster, especially with a lot of apps or on mobile data.',
          'Custom icons you set on an app are kept sharp (512px), since they\'re used as the home screen icon when you sign.',
        ],
      },
    ],
  },
  {
    version: '1.7.5',
    date: '2026-11-02',
    title: 'Background Tasks',
    summary: 'Signing and imports keep going when you leave the app, with a ⏳ button to check on them.',
    sections: [
      {
        title: '⏳ Keeps going in the background',
        items: [
          'Signing and other long jobs run on the server, and now the app keeps up with them even if you switch apps or lock your phone. When you come back, it picks up where it was.',
          'While something is running, a ⏳ button floats above the tabs showing what it is and how far along it is. Tap it to see everything that\'s running, with a Stop button for each.',
          'Long jobs no longer stop showing progress after an hour.',
        ],
      },
      {
        title: '✈️ More apps, faster',
        items: [
          'New apps from Telegram channels show up much faster, and the library refreshes on its own while they\'re being added.',
        ],
      },
    ],
  },
  {
    version: '1.7.4',
    date: '2026-11-02',
    title: 'Older Apps from Channels',
    summary: 'Many more apps from Telegram channels, including ones posted years ago.',
    sections: [
      {
        title: '✈️ More apps from channels',
        items: [
          'Apps posted in Telegram channels a long time ago can now be added to the library, not just recent ones, so you may see a lot of new apps show up.',
          'A channel posting an old build again never replaces the newer version you already have.',
          'An app\'s description now updates along with its version, so it doesn\'t keep showing details from an older post.',
        ],
      },
    ],
  },
  {
    version: '1.7.3',
    date: '2026-11-02',
    title: 'Newer Versions Sooner',
    summary: 'Apps from sources can now get new versions before the source posts them, and every older version stays available.',
    sections: [
      {
        title: '⬆ Newer versions',
        items: [
          'When a newer build of an app shows up before its source posts it, it can now be added to the library right away. It shows up as an update just like a normal one: UPDATED in the library, the ⬆ Update badge and a 🔔 alert if you installed it.',
          'Get installs the newest version. The source\'s older versions stay under "Other versions" on the app\'s page, each with its own Get button.',
          'Versions added early are marked "Added by you" in the list. Once the source posts that version itself, the source\'s copy is used instead.',
        ],
      },
    ],
  },
  {
    version: '1.7.2',
    date: '2026-11-02',
    title: 'Cancel & Full Logs',
    summary: 'You can now cancel signing and big transfers, and long messages are shown in full instead of being cut off.',
    sections: [
      {
        title: '✕ Cancel',
        items: [
          'While an app is signing, a "Cancel signing" button shows under the progress. It stops right away, even partway through a big download.',
          'Adding an app from a link and other long transfers have a Cancel button too.',
          'Nothing half-finished is left behind. A cancelled signing doesn\'t count toward a daily signing limit.',
        ],
      },
      {
        title: '📜 Full logs, no more "…"',
        items: [
          'The signing log now shows the whole history (up to 300 lines) instead of just the last few, and long lines wrap instead of being cut off.',
          'The log box is taller, so you can see more at once. Scroll it to see everything.',
          'Long messages in pop-up screens and Settings (errors, file names, alerts) now wrap onto the next line instead of ending in "…".',
        ],
      },
    ],
  },
  {
    version: '1.7.1',
    date: '2026-11-02',
    title: 'Auto Categories',
    summary: 'Apps now sort themselves into the right category, and more apps show their real developer, description and screenshots.',
    sections: [
      {
        title: '✨ Automatic categories',
        items: [
          'New apps from Telegram channels go straight into the right category (🎮 Games, 💬 Social, 🎵 Music & Video and so on) instead of Uncategorized.',
          'The category comes from the app\'s App Store listing, so it matches what you\'d see on the App Store.',
          'Apps the owner places in a category by hand always stay there.',
          'You may see a few new categories, like 📚 Education or ⚽ Sports, when an app belongs in one.',
        ],
      },
      {
        title: '🛍️ Better app pages',
        items: [
          'Apps that came without details now show their real developer, the App Store description and App Store screenshots where available.',
          'The post\'s own notes (like a mod\'s features) stay under "What\'s changed".',
        ],
      },
    ],
  },
  {
    version: '1.7.0',
    date: '2026-11-02',
    title: 'Telegram Channels',
    summary: 'Apps from Telegram channels now land in the library on their own and stay up to date, plus messages from the owner in your alerts.',
    sections: [
      {
        title: '✈️ Apps from Telegram',
        items: [
          'The library can now include apps posted in Telegram channels. They show a ✈️ badge with the channel\'s name.',
          'When the channel posts a new version, the app in the library updates itself. If you installed it, you get the ⬆ Update badge and a 🔔 alert.',
          'The app page shows what the post said about the update under "What\'s changed", with the promo lines taken out.',
          'Each channel has its own filter in ☰ Filters, under Sources.',
          'If a channel deletes a post, that app is taken out of the library so you never hit a dead download.',
          'You don\'t need Telegram or an account for any of this. Get works exactly the same as for every other app.',
        ],
      },
      {
        title: '📣 Messages',
        items: [
          'The owner can now send everyone a message. It shows up in your 🔔 alerts with a 📣 icon.',
        ],
      },
      {
        title: '🔧 Fixes',
        items: [
          'If a download from the cloud stops partway, signing now stops with a clear message instead of trying to sign a broken file.',
          'The phone number box matches the style of the other boxes.',
        ],
      },
    ],
  },
  {
    version: '1.6.0',
    date: '2026-11-02',
    title: 'Alerts & Security',
    summary: 'A 🔔 alerts inbox, certificate warnings before your apps stop opening, ♥ Favorites, and a sign-ins page to keep your account safe.',
    sections: [
      {
        title: '🔔 Alerts',
        items: [
          'A bell now shows at the top of the screen when you have alerts, with a red badge for new ones.',
          'You get an alert when an app you installed gets a new version. Tap it to go straight to the app and update.',
          'You get an alert when your app request is added or declined, with the owner\'s reply.',
          'You get an alert 7, 3 and 1 day(s) before a certificate expires, on the day it expires, and if Apple revokes it.',
          'Opening the bell marks everything as read. "Clear all" empties it.',
          'The app now refreshes itself every few minutes while it\'s open, so new alerts and apps show up without reloading.',
        ],
      },
      {
        title: '🔐 Certificate warnings',
        items: [
          'If your default certificate expires within 7 days, has expired, or was revoked, a banner shows at the top of the library. Tap it to go to Certificates.',
          'Certificates are re-checked with Apple twice a day in the background, so you hear about a revoke without opening the Certificates tab.',
        ],
      },
      {
        title: '♥ Favorites',
        items: [
          'Tap the heart next to 👍/👎 on any app\'s page to add it to your Favorites.',
          'A ♥ chip shows at the top of the library once you have a favorite. Tap it to see only those apps. Favorites is also in ☰ Filters.',
          'Favorites are private to your account.',
        ],
      },
      {
        title: '🛡 Sign-ins & security',
        items: [
          'Account (or Settings) › "Sign-ins & security" lists your recent sign-ins with the device, browser and time, plus any wrong-password attempts.',
          '"Sign out everywhere else" signs out every other phone and browser and keeps you signed in on this one.',
          'After 8 wrong passwords in a row, an account locks for 15 minutes, even if the tries come from different places. If it happens to your account, you get an alert.',
          'Invite codes can now expire, so an old code can\'t be used later.',
          'If there\'s a daily signing limit, Account shows how many signs you have left today. It resets at midnight.',
        ],
      },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-11-02',
    title: 'Tweaks & Presets',
    summary: 'Add tweaks while signing, save your favorite sign settings as presets, get several apps at once, import certificates from a .zip, and a much tidier filter bar.',
    sections: [
      {
        title: '🧩 Tweaks',
        items: [
          'The signing screen (Sign with options… › More options) now lists tweaks from the library. Flip one on and it\'s added to the app when it signs.',
          'Some apps come with tweaks already switched on. Get adds them for you, and the app page shows them under "Comes set up with".',
          'You can still add your own tweak files, and now jailbreak .deb packages work too, not just .dylib files. Mango pulls the tweak out of the package for you.',
          'Tweaks made for jailbroken phones get what they need to run (Substrate) added to the app automatically when it\'s available.',
          'If a tweak needs something only a jailbroken phone has, the signing log tells you it may not work.',
          'Heads up: tweaks that change the whole system (Springboard, Control Center, lock screen) can\'t work on a non-jailbroken iPhone. Tweaks made for one app, like YouTube or Instagram tweaks, usually do.',
        ],
      },
      {
        title: '💾 Presets',
        items: [
          'Set up the signing screen the way you like it (JIT, memory, Info.plist changes, removed extensions, tweaks and so on), then tap "Save these settings as a preset" at the bottom.',
          'Next time, pick it from the new Preset menu at the top of the signing screen and everything switches on at once.',
          'Saving with the same name updates that preset. Presets are private to your account.',
        ],
      },
      {
        title: '📲 Get several apps at once',
        items: [
          'Everyone now has a Select button in the library. Tap it, pick the apps you want, then tap Get.',
          'They sign one after another with your default certificate and each app\'s ready-made settings, and each one gets its own Install button.',
          'Apps you already signed recently skip straight to Install.',
        ],
      },
      {
        title: '🔐 Certificates from a .zip',
        items: [
          'Add Certificate has a new "Got a .zip? Import it in one go" button, for when your certificate comes as a single .zip.',
          'Mango finds the .p12 and .mobileprovision inside, and looks for the password in any text file in the zip (like "Password.txt").',
          'If it can\'t find the password, type it in the Password box and import again.',
        ],
      },
      {
        title: '🧹 Tidier filters',
        items: [
          'The filter bar at the top of the library is now just All, plus ✓ Installed, ⬆ Updates and ★ Featured when you have any, and a ☰ Filters button. No more side-scrolling.',
          'Filters opens a sheet with everything else in a neat grid: categories, sources, tags and collections, each with how many apps it has.',
          'When you pick something from Filters, it shows as a highlighted chip at the top. Tap it to go back to All.',
          'The Request an App button moved into Filters too.',
        ],
      },
    ],
  },
  {
    version: '1.4.2',
    date: '2026-11-02',
    title: 'Cleaner Library',
    summary: 'A tidier library with less scrolling, and a Got it button you can reach right away.',
    sections: [
      {
        title: '🧹 Cleaner library',
        items: [
          'Featured and Updates for you are now a slim row of app icons instead of big cards, so the app list starts much higher on the screen.',
          'The Popular shelf is gone from the top. You can still see the most installed apps any time with Sort: Popular.',
          'Collections moved into the filter chips at the top (for example 💪 JIT Setup). Tap one to open it, same as before.',
          'The 🆕 New chip hides itself when every app is new, since it would show the same thing as All.',
        ],
      },
      {
        title: '📰 What\'s New',
        items: [
          'The Got it button now sits right under the latest version, so you don\'t have to scroll past every old update to close it.',
          'Older versions are listed under "Earlier versions" below the button, closed until you tap one.',
        ],
      },
    ],
  },
  {
    version: '1.4.1',
    date: '2026-11-02',
    title: 'Recently Updated',
    summary: 'With All selected, the library now lists apps from most recently updated to oldest.',
    sections: [
      {
        title: '🕒 Recently updated',
        items: [
          'With All selected, the library now shows one list of every app, sorted from most recently added or updated at the top to the oldest at the bottom.',
          'Each app shows when it was added or last updated (for example "Updated 2h ago"), right under its version.',
          'The list shows 40 apps at a time. Tap "Show more" at the bottom to load the next 40.',
          'The shelves at the top (Updates for you, Featured, Popular and Collections) are still there.',
          'Picking any other filter (a category, a source, Installed and so on) works the same as before.',
          'In the sort menu, the default option is now called "Recently updated" while All is selected, and "Featured first" everywhere else. Any other sort (A–Z, Popular, Biggest…) still gives you a plain list.',
        ],
      },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-11-01',
    title: 'Cloud Library',
    summary: 'Way more apps in the library, older versions you can pick from, screenshots and patch notes from the developers, and a few fixes.',
    sections: [
      {
        title: '☁ More apps',
        items: [
          'The library can now include apps from public app sources (the same kind of repos AltStore, SideStore, ESign and Feather use).',
          'These apps show a blue ☁ badge with the name of the source they come from.',
          'Each source gets its own filter chip at the top of the library, so you can browse just that source.',
          'Search now matches source names too.',
          'Big categories show their first 24 apps with a "See all" button, so the library stays quick even with hundreds of apps.',
          'The library loads much faster on cell data (it\'s now sent compressed).',
          'Source apps stay up to date on their own. When the developer posts a new version, the app shows UPDATED and, if you installed it, ⬆ Update.',
        ],
      },
      {
        title: '🕰️ Older versions',
        items: [
          'Apps that come with more than one version now have an "Other versions" list on their page, with the date, size and patch notes for each.',
          'Tap Get next to any version to sign and install that one. Handy when the newest version has a bug or needs a newer iOS than you have.',
          'The full signing screen ("Sign with options…") has an App version picker too.',
          'One-tap Get always gives you the newest version. A copy you signed from an older version is never reused for it.',
        ],
      },
      {
        title: '🛍️ App pages',
        items: [
          'Screenshots from the developer now show on app pages when there are no uploaded ones. Tap one to view it full screen and swipe between them.',
          'If an app has no notes, its page shows the developer\'s "What\'s new" for the latest version.',
          'App info now shows which source an app comes from.',
          'Apps a source stops offering are taken out of the library automatically, so you won\'t hit a dead download.',
        ],
      },
      {
        title: '🔧 Fixes',
        items: [
          'Signing an app whose icon only exists online no longer fails at the last step. The signed app uses the icon from inside the app instead.',
          'Older-version and newest-version signed copies of the same app are kept apart, so Get never hands you the wrong one.',
        ],
      },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-10-30',
    title: 'Library & Installs',
    summary: 'One-tap Get, Installed and Update badges, ratings, screenshots, collections, requests, themes and a whole lot more.',
    sections: [
      {
        title: '📲 One-tap Get',
        items: [
          'Every app now has a Get button. It signs the app with your default certificate and the app\'s ready-made settings, then shows a big Install button.',
          'If you already signed that app recently and nothing has changed, Get skips signing and goes straight to the install pop-up.',
          'Still want control? "Sign with options…" on the app\'s page opens the full signing screen.',
          'When an install finishes downloading, you get a burst of confetti 🎉',
        ],
      },
      {
        title: '✓ Installed & ⬆ Updates',
        items: [
          'Apps you installed through Mango show a green ✓ Installed badge.',
          'When a newer version is added to the library, they show ⬆ Update and the button changes to Update.',
          'A new "Updates for you" shelf at the top of the library lists everything with an update, showing old → new versions.',
          'The Library tab shows a small dot when you have updates waiting.',
          'New filters: ✓ Installed, ⬆ Updates and 🆕 New.',
          'Mango can\'t see apps you delete from your iPhone, so an app stays marked as installed until you reinstall or update it.',
        ],
      },
      {
        title: '🧾 Install history & QR codes',
        items: [
          'The Signed tab now has an Install history with every app you installed, its version, certificate and time.',
          'Any signed app can show a QR code for its install link. Scan it with another iPhone\'s Camera to install there.',
        ],
      },
      {
        title: '🛍️ App pages',
        items: [
          'Screenshots: swipe through them on the app\'s page, and tap one to view it full screen.',
          '👍 / 👎 ratings: tell everyone if an app is good. Tap again to take your vote back.',
          'A stats row shows how many times an app was installed, how liked it is, and its minimum iOS.',
          'Tags like "Needs JIT" or "Controller support" show on the page. Tap one to see every app with that tag.',
          'Pages show which collections an app is in.',
        ],
      },
      {
        title: '🔥 Discover',
        items: [
          'NEW and UPDATED badges on apps added or updated in the last 3 days.',
          'New shelves in the library: 🔥 Popular (most installed), 📦 Collections and 🆕 New & updated.',
          'New sort options: Popular and Top rated.',
          'Search now finds apps by their tags too.',
        ],
      },
      {
        title: '📦 Collections',
        items: [
          'Collections bundle apps together, like an "Emulator setup" with everything you need.',
          'Open one to see its apps, or tap "Get all" to sign them all in a row. Each one then installs with its own tap, since iOS asks for every app.',
        ],
      },
      {
        title: '🙋 App requests',
        items: [
          'Can\'t find an app? Tap Request in the library (or + Request an App in Account) and say what you want.',
          'Your requests and their answers (Added, Declined, plus any reply) show in Account › My app requests.',
          'When a request is marked added and linked to an app, you can open it straight from the request.',
        ],
      },
      {
        title: '🎨 Themes & grid view',
        items: [
          'New Appearance settings in Account: Mango, Midnight, AMOLED black or Light themes.',
          'Pick an accent color: Mango, Pink, Blue, Green, Purple or Red.',
          'Switch the library between a list and a home-screen-style grid of big icons (the ☰ / ▦ buttons, or Appearance).',
          'These are saved on your device.',
        ],
      },
      {
        title: '🐞 Fixes',
        items: [
          'You now keep just one signed copy of each app. Signing an app again replaces the old copy instead of piling up duplicates.',
          'Tapping Sign or Get twice by accident no longer signs the app twice. The second tap just follows the one already running.',
          'Clearer messages when the server is low on space, saying how much is needed and how much is free.',
          'QR codes now work everywhere, even without an internet connection to outside sites.',
        ],
      },
      {
        title: '📣 Announcements & welcome tour',
        items: [
          'Important news now shows as a banner at the top of the app. Tap ✕ to hide it.',
          'New here? A short welcome tour shows how everything works. Replay it any time from Account › Show the welcome tour.',
        ],
      },
    ],
  },
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
