---
name: app-store
description: Install, open, and update apps on iOS from the App Store. Use when a task needs an app that may not be installed.
---

# Apps on iOS

**Open an installed app:** prefer `open_app` with the bundle id (e.g. `com.burbn.instagram`). If you do not know it, `key home` then Spotlight search the app's name and tap it.

**Install a new app:**
1. `open_app com.apple.AppStore` (or find App Store on Home).
2. Tap the Search tab, tap the search field, `type` the app name, `key enter`.
3. Find the right result — check the developer name, not just the title. Tap **Get** (or the cloud/price button).
4. Installing needs the user's Apple Account. Face ID / Touch ID and the account password are the user's to enter — if a prompt asks for them, stop and ask the user to authorize, do not try to bypass it.
5. Wait until the button turns to **Open**, then open the app.

**After installing,** the app usually starts at onboarding or a sign-in screen — see the sign-in and permissions skills.

Never buy a paid app or make an in-app purchase unless the user asked for that specific purchase; those taps pause for approval.
