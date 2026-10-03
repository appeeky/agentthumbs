---
name: instagram
description: Post a photo or video to Instagram on the user's phone, and switch between the Instagram accounts signed in there. Use when a task says to post, publish or share something on Instagram, or to act as one of the user's Instagram accounts.
---

# Instagram

Walked through on iOS (Instagram app, October 2026). Labels below are the accessibility labels agentthumbs shows; the app is in English on the phone this was written on. Instagram changes its UI often: if a label is missing, find the control by its icon in the screenshot and say what changed.

## Getting to a known place

Open the app with `open_app com.burbn.instagram` (iOS) or `com.instagram.android` (Android). It resumes where it was left, which can be:

- **an in-app browser** showing some website: tap **Dismiss** (the X at the top left);
- **a half-open Create sheet**: tap **Dismiss**;
- someone's story, a DM or a reel: go to the **Profile** tab (bottom right).

## Use the right account

Posting from the wrong account is the worst mistake here; check it before every post.

1. Go to the **Profile** tab. The account name is at the top center.
2. To switch, tap the account name. A sheet lists the signed-in accounts as **"INSTAGRAM profile, <name>"**.
3. Tap the account the user named. A toast says **"Switched to <name>"** and the top center shows it. Confirm both before going on.

Never add or sign in to an account here unless the user asked; see the sign-in skill.

## Get the media onto the phone

- **Android:** `push_media` the file; it is the newest item in the gallery.
- **iOS:** `push_media` is not available over WebDriverAgent. The photo or video has to be in Photos already (the user's iCloud, AirDrop, or an app that saves to Photos). Ask the user which one, and how to recognize it, before you start.

## Post

1. On the Profile tab, tap **"Tap to open creation menu"** (the **+** at the top left). A **Create** sheet lists Reel, Edits, Post, Story, Instants, Highlights, Live, Fundraiser.
2. Tap **Post**. agentthumbs asks for approval here because the label is "Post"; tell the user this tap only opens the composer.
3. **New post** shows the gallery under a large preview. **The newest item is already selected.** If that is not the file, tap the right **"Photo thumbnail, <date>"** or **"Video thumbnail, video duration: <m:ss>, <date>"** cell and check the preview changed. **Select** lets you pick several for a carousel.
4. Tap **Next**. The edit screen offers Audio, Text, Overlay, Filter and Edit. Change nothing unless the user asked. Tap **Next**.
5. The first time an account posts, a **Sharing posts** sheet explains that the account is public and others can reuse the post. Tap **OK**.
6. The final **New post** screen has the caption, Poll, Prompt, Add audio, Tag people, Add location, an **Add AI Label** toggle and **Share**.
   - Tap **"Add a caption..."**. A separate **Caption** editor opens. `type` the caption the user approved, word for word, then read the field back from the next observation: it must match exactly, including emoji and accents. Tap **OK** (top right).
   - **AI label:** turn on **Add AI Label** when the photo or video was generated or substantially edited with AI (for example anything made in a UGC or video generation tool). Instagram requires it for realistic AI media. If you are not sure, ask.
   - Add tags, location or audio only if the user asked for them.
7. Check, from the observation: the account (step "Use the right account"), the media in the preview, the caption, the AI label. Then tap **Share**. agentthumbs pauses for the user's approval; if they decline, stop and ask what to change.
8. After sharing, the post appears at the top of the Profile grid. Report that, with the account name.

## Stopping without posting

When the user only wants a draft, or you have to stop, leave the composer with **Back** / **Cancel** (top left) instead of **Share**. If Instagram asks whether to discard or keep the post, choose what the user said; if they said nothing, discard.

## Rules

- One post per request. Never post the same media twice to fill a schedule unless the user asked for each one.
- Do not like, follow, comment or DM while you are in the app for a post.
- The Create sheet, a profile's **Share profile** button and many web pages in the in-app browser carry labels like "Post" and "Share". Read where you are before you tap; approvals are not a substitute for reading.
