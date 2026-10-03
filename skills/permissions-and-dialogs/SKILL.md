---
name: permissions-and-dialogs
description: Handle the system pop-ups iOS shows — permissions, tracking, notifications, sign-in sheets, rating prompts. Use whenever a dialog interrupts a task.
---

# System dialogs on iOS

Dialogs appear over the app and block it until you deal with them. Read the dialog, then pick the choice that serves the task.

- **Permission prompts** ("Allow access to your Camera / Photos / Microphone / Location"): allow what the task needs. For location, the options are usually **Allow Once**, **Allow While Using App**, **Don't Allow** — pick While Using App unless the user said otherwise.
- **App Tracking Transparency** ("Allow [app] to track…"): choose **Ask App Not to Track** by default unless the user wants tracking on.
- **Notifications** ("…would like to send you Notifications"): **Allow** only if the task is about notifications; otherwise **Don't Allow** to avoid noise.
- **"Sign in with Apple" sheet:** this signs in with the user's Apple Account and may reveal or hide their email. Only proceed if the task is to sign in; the user enters Face ID / the passcode, not you.
- **Rate this app / What's New / cookie banners:** dismiss them (Not Now, Continue, Accept as appropriate) and carry on.
- **Passcode / Face ID / CAPTCHA:** you cannot pass these. Stop and ask the user.

After handling a dialog, observe again — another may follow.
