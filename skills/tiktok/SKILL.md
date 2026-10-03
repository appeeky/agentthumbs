---
name: tiktok
description: Post a video or photos to TikTok on the user's phone, or save them as a draft, and switch between the TikTok accounts signed in there. Use when a task says to post, publish, upload or draft something on TikTok.
---

# TikTok

TikTok changes its UI often and runs A/B tests, so two phones can differ. Labels below are the usual ones; when one is missing, find the control by its icon in the screenshot and tell the user what changed.

## Getting to a known place

Open the app with `open_app com.zhiliaoapp.musically` (iOS and Android). It starts in the For You feed with sound on; the video playing there is not yours to like or comment on. If a sheet, a live stream or a DM is open, close it or go to the **Profile** tab (bottom right).

## Use the right account

1. Go to the **Profile** tab. The account name is at the top center, with a down arrow.
2. To switch, tap the name. A sheet lists the signed-in accounts; tap the one the user named.
3. Confirm the top of the Profile tab now shows that name before you go on.

Never add an account or sign in unless the user asked; see the sign-in skill.

## Get the media onto the phone

- **Android:** `push_media` the file; it is the newest item in the gallery.
- **iOS:** the file has to be in Photos already. Ask the user which one, and how to recognize it.

## Post

1. Tap **+** in the middle of the tab bar. The camera opens.
2. Tap **Upload** (the gallery thumbnail at the bottom right of the camera). If TikTok asks for photo access, allow access to the item or to all photos as the user prefers; see the permissions skill.
3. Pick the file. Check the duration or thumbnail matches what the user described; the newest item is first. For several photos, pick each in order. Tap **Next**.
4. The editor offers sounds, text, effects and filters. Change nothing the user did not ask for. TikTok sometimes adds a suggested sound: remove it unless the user wanted music. Tap **Next**.
5. The post screen:
   - Tap the description field ("Add description…" or similar) and `type` the caption the user approved, word for word. Hashtags and mentions open suggestion lists; finish typing, then dismiss the keyboard and read the field back: it must match exactly.
   - **AI-generated content:** if the video or photos were generated or substantially edited with AI, turn on the AI-generated content label (under **More options** or a similar section). TikTok requires it for realistic AI media. If unsure, ask.
   - Leave privacy ("Everyone can view this post"), comments, Duet and Stitch as they are unless the user said otherwise.
6. Check the account, the media and the caption, then tap **Post**. agentthumbs pauses for the user's approval. If they decline, stop and ask what to change.
7. TikTok uploads in the background and shows progress on the feed. Wait for it to finish, then confirm the video is first on the Profile grid.

## Save as a draft

When the user wants to review on their own phone first, tap **Drafts** instead of **Post** on the post screen. The draft shows on the Profile tab under Drafts. Saving a draft publishes nothing.

## Stopping without posting

Go back with the back arrow (top left). If TikTok asks whether to discard the edits or save them as a draft, choose what the user said; if they said nothing, save a draft rather than lose their work, and tell them.

## Rules

- One post per request. Never repost the same video to fill a schedule unless the user asked for each one.
- Do not like, follow, comment, duet, stitch or message while you are in the app for a post.
- Do not scroll the For You feed beyond what the task needs.
