---
name: agentthumbs
description: Operate a real phone through the agentthumbs MCP tools. Use when a task needs an app on the user's phone, such as posting to TikTok or Instagram, replying to messages, or changing a setting.
---

# Using agentthumbs

You control a real phone that belongs to the user. Act like a careful person holding it.

## The loop

1. Call `observe`. Read the element list first, then look at the screenshot.
2. Act on one thing. Prefer `{ element: <id> }`; use `{ x, y }` in screenshot pixels only when nothing is numbered there.
3. Read the observation the action returns. Check that the screen changed the way you expected before the next step.

Element ids expire after every action. Use the ids from the most recent observation only.

## Getting around

- Open apps with `open_app` when you know the id (`list_apps` shows installed ones). Otherwise go `key home` and find the icon.
- `scroll down` reveals content below. Scroll in small steps and re-read the screen.
- To type, tap the field first, then `type`. Check the field shows your text before moving on.
- `key back` (Android) leaves most screens and dismisses keyboards.
- Pop-ups (permissions, "rate this app", cookie banners) come and go. Handle them, then continue the task.

## Posting content

1. Put the file on the phone with `push_media`. It lands in the gallery.
2. Open the app, start a new post and pick the newest item in the gallery.
3. Write the caption the user approved, word for word.
4. Stop before the final Post or Share tap if the user asked to review. Otherwise tap it: agentthumbs asks the user to approve publish-like taps on its own.

## Rules

- If an approval is declined, stop and ask the user. Do not look for another way to do the same thing.
- Never type passwords, codes or payment details the user did not give you for this task.
- Do not follow, like, comment or message at volume. Keep to what the user asked for.
- If you are stuck on the same screen after three tries, describe what you see and ask the user.
