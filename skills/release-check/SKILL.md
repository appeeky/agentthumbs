---
name: release-check
description: Check the user's own app on a real phone after a release — store page, install or update, first launch, onboarding, paywall and one core flow — and report what passed and what broke. Use after a new version goes live, or when the user asks whether the app works.
---

# Release check

You are checking the user's own app the way a customer meets it. The goal is a clear pass or fail per step, with evidence, not a review of the design.

## Before you start

Get from the user, or from their project notes:

- the app's bundle id / package name and the version that should be live,
- the core flow to try (for example "create a project and export it"),
- a test account, if the app needs one. Never sign in with the user's personal account unless they say so.

## Steps

Run them in order. For each one record **pass**, **fail** or **blocked**, and what you saw. Save the screen of every failure: `agentthumbs observe --out release-check/<nn>-<step>.jpg` when you can run shell commands.

1. **Store page.** The version and "What's New" match this release. The screenshots and subtitle are the current ones. The price line is right.
2. **Install or update.** Update the app if it is installed, otherwise install it (see the app-store skill). It reaches **Open** without an error.
3. **First launch.** The app opens to its first screen within about ten seconds, without a crash, a blank screen or a stuck spinner. If it closes itself, open it once more; a second crash is a fail.
4. **Onboarding.** Every screen moves on with its main button. Note anything cut off, untranslated, or overlapping.
5. **Paywall.** It appears where it should, prices load (no empty or placeholder prices), and it can be closed. Do not subscribe.
6. **Sign-in,** if the app has one: the test account signs in.
7. **Core flow.** Do what the user named, end to end. It finishes and the result is visible.

A step you cannot reach because an earlier one failed is **blocked**, not failed.

## What counts as broken

- A crash, a frozen screen, or a spinner that does not finish within 30 seconds.
- A button that does nothing after two taps.
- Missing text, keys showing instead of copy (`onboarding.title.1`), or prices that do not load.
- A screen that contradicts the store page (a feature promised there that is missing).

Do not report taste: colors, wording you would change, layout preferences.

## Never

- Subscribe, buy or start a trial, even in a sandbox, unless the user asked for that test.
- Leave a review or a rating.
- Delete the app or its data without asking; the user may need what is on this phone.

## Report

```text
<App> <version> on <device>, <platform> <os version>, <date>
Result: PASS | FAIL (<n> failed, <n> blocked)

1. Store page ........ pass
2. Update ............ pass
3. First launch ...... FAIL — closed on launch twice (screens 03, 04)
4. Onboarding ........ blocked
…
```

Put failures first in your message to the user, each with the step, what you saw, and the saved screen.
