---
description: Drain pending review replies — apply feedback or stage approved posts for publish.
---

You are draining the autoblog review queue. Pending reviews live in the Google
Sheet's Queue tab: every row whose `reviewStatus` is `approved` or
`changes_requested` was written there by the review watcher
(`autoblog/scripts/review-watcher.js`) when the client replied to a
`[Blog Review]` email.

Do **not** invent items, and do **not** publish anything that isn't in the
returned list. The Sheet is the source of truth.

## Step 1 — Fetch the pending list

Run:

```bash
npm run pipeline:reviews
```

The output is either the literal string `NO_PENDING_REVIEWS` (nothing to do —
stop here and report that to the user) or a JSON array of objects with shape:

```
{ id, keyword, suggestedTitle, blogFile, reviewStatus, reviewFeedback }
```

If JSON parsing fails or the script errors, stop and surface the error to the
user — do not guess.

Print a short summary line first ("Found N pending: X approved, Y with
changes."), then process the rows below in this order: **handle revisions
first, then publishes.** Revisions trigger a fresh review email round-trip;
doing them up front keeps that round-trip moving while you handle approvals.

## Step 2 — For each `changes_requested` row

1. Read the file at `blogFile` and the `reviewFeedback` text.
2. Apply the feedback to the post using the Edit tool. Follow the writing
   guidance in `autoblog/config/writing-style.md` and preserve the existing
   structure (do not re-humanize via WalterWrites unless the feedback
   explicitly asks for it).
3. Run the quality check:
   ```bash
   npm run pipeline:quality-check -- <blogFile>
   ```
   If it FAILS, fix the failures (up to 2 attempts) then proceed.
4. Re-send for review:
   ```bash
   npm run pipeline:send-review -- <blogFile>
   ```
   This sets `reviewStatus` back to `in_review` and clears the feedback cell
   automatically — you don't need to update the Sheet yourself.
5. Report: `Revised "<title>" and re-sent for review.`

If a revision throws, **stop processing that row** (leave it as
`changes_requested`) and continue with the next. Report the error in the
summary at the end.

## Step 3 — For each `approved` row

Note: the `git` commands below stage `src/assets/images/blog/` along with the
post. If `autoblog/config/pipeline.config.json` has a custom `paths.imagesDir`
that differs from the default, substitute that value for
`src/assets/images/blog/` in all three commands.

1. Show the user the staged changeset before publishing:
   ```bash
   git status -- <blogFile> src/assets/images/blog/
   git diff --stat -- <blogFile> src/assets/images/blog/
   ```
   And the proposed commit message: `publish: <suggestedTitle>`.

2. **Ask the user to confirm** before pushing. Use AskUserQuestion with two
   options: "Publish now" / "Skip this one". Do not push without a `yes`.

3. On confirm, run (one command at a time, stop on the first failure):
   ```bash
   git add <blogFile> src/assets/images/blog/
   git commit -m "publish: <suggestedTitle>"
   git push
   ```

4. After a successful push, move the row out of the queue and into Completed:
   ```bash
   npm run pipeline:complete -- <id> <blogFile>
   ```

5. Report: `Published "<title>" (<commit-sha-short>).`

If the user picks "Skip this one", leave the row as `approved` so it shows up
again next run. Do not modify the Sheet.

## Step 4 — Summary

End with a one-block summary:

```
Pending reviews drained:
  Revised:    N  (list titles)
  Published:  N  (list titles + commit sha)
  Skipped:    N  (list titles + reason)
  Errors:     N  (list titles + error)
```

If the user invoked you as part of a larger pipeline run (Step 0 of
`PIPELINE.md`), say "Reviews drained. Continue with the next topic when
ready." and stop — do not auto-advance to writing the next article.

## Notes / guard-rails

- Never run `git push` without the user's explicit `yes` in this session.
- Never call `claude -p`, `claude --print`, or spawn any headless Claude.
  All writing/revising happens in this interactive session.
- If `npm run pipeline:reviews` keeps returning items you've already
  processed in this session, the watcher hasn't picked up the re-sent email
  yet — that's normal; tell the user and stop.
