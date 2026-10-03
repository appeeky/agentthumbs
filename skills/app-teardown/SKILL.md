---
name: app-teardown
description: Walk through an app's store page, onboarding and paywall on a real phone and report what a new user sees, screen by screen. Use to study a competitor's app, or to compare an app against an earlier teardown.
---

# App teardown

You are a new user opening this app for the first time. Record what they see; change nothing about the user's accounts.

## Before you start

- Get the app's exact name and developer from the user, or its bundle id / package name. Many apps share a name.
- Ask what to focus on if they did not say: onboarding, paywall, pricing, permissions, or all of it.
- If the user has an earlier teardown of the same app, keep it at hand to compare.

## Saving screens

Every action returns a screenshot. When you can run shell commands, also save the screens that matter: `agentthumbs observe --out teardown/<app>/<nn>-<screen>.jpg`. Number them in the order you saw them.

## The walk

1. **Store page.** Open the app's page in the App Store or Play Store. Note the subtitle, rating and rating count, price and in-app purchases line, the first three screenshots' headlines, and "What's New".
2. **Install.** Get the app (see the app-store skill). If it is already installed, ask the user before deleting it to start fresh; never delete it on your own.
3. **First launch to first value.** Go through onboarding the way a person would, choosing the most typical answer when it asks questions. For every screen note: the headline, what it asks of the user, and the button that moves on. Count the screens.
4. **Permissions.** Note each prompt (notifications, tracking, location, contacts) and the screen it appeared on. Choose "Don't Allow" / "Ask App Not to Track" unless the app cannot continue without it.
5. **Paywall.** When one appears, note where in the flow it showed, whether it can be closed and how, every plan with its price and period, the trial length, which plan is preselected, and the copy on the main button. Then close it or go back.
6. **Account wall.** If the app demands an account before showing anything, stop and ask the user. Do not create an account with their email or phone number unless they say so.

## Never

- Start a trial, subscribe or buy. Those taps pause for approval anyway; do not request it.
- Accept terms on the user's behalf beyond what any first-time user must tap to continue.
- Rate, review, share or invite from inside the app.

## Report

Write it so someone who never opened the app understands the funnel:

```text
<App> by <developer>, <platform>, <date>
Store: <subtitle> · <rating> (<count>) · <price / IAP>
Onboarding: <n> screens until <first value>
  1. <headline> — asks <what> — button "<label>"
  …
Permissions: <prompt> on screen <n>, …
Paywall: after screen <n>, closable <yes/no/after delay>
  <plan> <price>/<period>, trial <length> (preselected)
  Main button: "<copy>"
Notable: <anything unusual: dark patterns, A/B looking variants, localization>
```

When you have an earlier teardown, end with **Changes since <date>**: only what differs, most important first (pricing and paywall placement before copy).
