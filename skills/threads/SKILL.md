---
name: threads
description: Post text, photos or a video to Threads on the user's phone, and switch between the Threads profiles signed in there. Use when a task says to post or publish something on Threads.
---

# Threads

Threads profiles belong to Instagram accounts, and the app is often reached from Instagram (the Threads button on an Instagram profile). Labels below are the usual ones; when one is missing, find the control by its icon and tell the user what changed.

## Getting to a known place

Open the app with `open_app com.burbn.barcelona` (iOS) or `com.instagram.barcelona` (Android). It opens on the Home feed. If a thread, a reply composer or a profile is open, go back until you see the tab bar.

## Use the right profile

1. Go to the **Profile** tab (the person icon, bottom right). The profile name and handle are at the top.
2. To switch, long-press the **Profile** tab or open the account menu from the profile. A sheet lists the profiles signed in on this phone; tap the one the user named.
3. Confirm the Profile tab shows that handle before you go on.

Never add an account or sign in unless the user asked; see the sign-in skill.

## Get the media onto the phone

- **Android:** `push_media` the file; it is the newest item in the gallery.
- **iOS:** the file has to be in Photos already. Ask the user which one, and how to recognize it.

## Post

1. Tap the compose button in the tab bar (a pencil or **+** in the middle). The **New thread** composer opens with the cursor in the text field.
2. `type` the text the user approved, word for word. Threads has a 500 character limit per post; if the text is longer, ask the user how to split it rather than cutting it yourself. Read the field back: it must match exactly.
3. For media, tap the gallery icon under the text, pick the photos or the video, and confirm. Check the preview shows what the user described.
4. **AI label:** if the media was generated or substantially edited with AI, add the AI label when Threads offers one (it follows Instagram's rules). If unsure, ask.
5. Leave "Anyone can reply" and topics as they are unless the user asked.
6. Check the profile, the text and the media, then tap **Post**. agentthumbs pauses for the user's approval. If they decline, stop and ask what to change.
7. Threads posts in the background. Confirm the new thread is first on the Profile tab.

## Threads of several posts

When the user gave several posts as one thread, write the first, then tap **Add to thread** under it for each next one, in order. Check every part before **Post**; it publishes them all at once.

## Stopping without posting

Close the composer with **Cancel** (top left). If Threads asks whether to discard or save a draft, choose what the user said; if they said nothing, save a draft and tell them.

## Rules

- One post or one thread per request.
- Do not like, follow, repost, quote or reply while you are in the app for a post.
