---
name: ios-basics
description: Get around iOS through agentthumbs — Home, app switcher, search, keyboards, scrolling, and back. Use for any task on an iPhone.
---

# Getting around iOS

iOS has no on-screen Back button. To leave a screen, use the app's own back arrow (usually top-left), or swipe from the very left edge inward: `swipe` from x near 0 to x near mid-screen at the same y.

- **Home:** `key home`. From Home you can open apps by their icon, or search.
- **Spotlight search:** swipe down on the middle of the Home Screen, then `type` an app or contact name to jump to it. Faster than hunting for an icon.
- **App switcher:** on agentthumbs's iOS driver this may be unavailable; prefer `open_app` or Home + icon instead of switching.
- **Scroll:** `scroll down` reveals content further down. Scroll in small steps and observe again — lists often load as you go.
- **Keyboard:** tap a field first, then `type`. The text appears in the field, not as key presses you can see. Press Enter with `key enter`. To clear a field, tap it, select all if the app supports it, or use `key delete` repeatedly.
- **Pull to refresh:** `swipe` from the top of a list downward.

After each action, observe and check the screen changed the way you expected before the next step. If the same screen persists after three tries, describe what you see and ask the user.
