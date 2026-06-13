# Content Pipeline - Autonomous Playbook

Follow these steps exactly. Do not ask questions (except where Step 0 explicitly requires confirmation). Handle errors gracefully and continue.

## Step 0: Drain Pending Reviews

Before starting new work, clear anything the reviewer has already replied to.
The review watcher (`autoblog/scripts/review-watcher.js`) is constantly writing reply
outcomes into the Queue tab; this step acts on them.

Invoke the slash command:

```
/autoblog-reviews
```

This will:
- Apply feedback to any `changes_requested` posts and re-send them for review.
- Show you the diff for each `approved` post and, **after you confirm**, commit & push it, then move the row to Completed.

The slash command stops after draining and waits for you to continue. It does
not automatically advance into Step 1. Move on only when it reports the
queue is empty.

If there are no pending reviews, the command will print
`NO_PENDING_REVIEWS` and exit — proceed to Step 1.

## Step 1: Check Queue Status

```bash
npm run pipeline:status
```

If there are **no pending topics** (output shows `Pending topics: 0`), run research:

```bash
npm run pipeline:research
```

Use `npm run pipeline:research -- --dry-run` to preview results without writing to Google Sheets.

If research fails (API error, no results), stop and report the error in a commit message.

### How Research Works

**Seed Gathering**

Seeds determine what keyword suggestions the DataForSEO API returns. Seeds come from three sources, combined and deduplicated:

1. **Static seeds from `seedPillars`** in `pipeline.config.json`. Pillars are named topic categories (e.g. "core", "productivity", "privacy", "use cases"). Each pillar contains 2-4 seed keywords. Seeds are fed to the API in round-robin order across pillars so every pillar gets API calls early. If the config uses the older flat `seedKeywords` array instead, the code falls back to that.
2. **Dynamic seeds from Completed sheet.** Keywords from previously completed blog posts. Long phrases are truncated to 3 content words so they work as API seeds.
3. **Dynamic seeds from blog frontmatter.** Titles from existing blog posts in `src/content/blog/`. Each title is reduced to its first 3 content words (stop words stripped).

Dynamic seeds are capped by `maxDynamicSeeds` in config (default 15). The seed pool grows each pipeline cycle as more posts are completed.

**Scoring**

Each keyword suggestion from the API is scored using a weighted composite:

| Signal | Weight | Description |
|--------|--------|-------------|
| Volume/difficulty ratio | 0.35 | `log(volume) / log(difficulty)` — high volume, low difficulty |
| CPC | 0.15 | Commercial value signal — higher CPC means advertisers pay for this term |
| Trend momentum | 0.15 | Recent 3-month search avg vs overall avg — rising topics score higher |
| Product relevance | 0.20 | Word overlap between keyword and `productDescription`, `niche`, `productFeatures` in config |

The raw score is then multiplied by an **intent bonus** (commercial 1.5x, transactional 1.3x, informational 1.0x, navigational 0.5x) and a **competition penalty** (HIGH 0.6x, MEDIUM 0.85x, LOW 1.0x).

Keywords below `minProductRelevance` (default 0.2) are filtered out entirely to prevent off-topic results.

**Clustering and Diversity**

After scoring, keywords are clustered by Jaccard similarity on their content words (stop words and hyphens stripped). Two keywords that share 40%+ of their content words land in the same cluster. For example, "zoom meeting transcription", "how to transcribe a zoom meeting", and "can zoom transcribe a meeting" all cluster together.

The final batch is selected via round-robin across clusters, taking at most `maxPerCluster` (default 2) from each cluster. This prevents the batch from being dominated by variations of the same topic.

**Config Reference**

All research behavior is controlled by `pipeline.config.json` under `research`:

```
batchSize              — number of topics per research run (default 10)
maxKeywordDifficulty   — hard ceiling on KD (default 40)
minSearchVolume        — hard floor on monthly volume (default 50)
minProductRelevance    — minimum relevance score to keep (default 0.2, 0 = disabled)
suggestionsPerSeed     — API results per seed (default 50)
locationCode           — DataForSEO geo target (default 2840 = US)
languageCode           — language filter (default "en")
dynamicSeeds.enabled   — pull seeds from completed/blog (default true)
dynamicSeeds.maxDynamicSeeds — cap on dynamic seeds (default 15)
scoring.*              — all weights and multipliers are configurable
clustering.enabled     — topic deduplication (default true)
clustering.similarityThreshold — Jaccard cutoff (default 0.4)
clustering.maxPerCluster       — diversity cap (default 2)
```

## Step 1.5: Generate Titles and Angles

After research adds topics to the queue, generate a unique title and content angle for each pending topic. The research script only sets the keyword as a placeholder title. You must generate the real titles.

1. Run `npm run pipeline:status` to see pending topics
2. For each pending topic with a placeholder title, review the keyword, search intent, SERP reference URLs (competitor titles/descriptions), and search volume
3. Generate a compelling, click-worthy title that:
   - Includes the primary keyword naturally
   - Is different from the competitor titles in the SERP data
   - Matches the writing style in `autoblog/config/writing-style.md` (direct, no hype, no cliches)
   - Fits the search intent (how-to for informational, comparison for commercial, etc.)
   - Is unique across the batch (avoid repeating the same title patterns)
4. Generate a specific content angle that explains what unique perspective this article should take, considering the site's niche and what competitors already cover
5. Update each topic:

```bash
npm run pipeline:update -- <topic-id> --title "Your Generated Title" --angle "Your content angle"
```

Example:
```bash
npm run pipeline:update -- topic-20250201-03 --title "How to Transcribe Interviews Without Uploading Your Audio" --angle "Focus on privacy risks of cloud transcription for journalists and researchers. Compare local vs cloud options with real workflow examples."
```

Do this for every pending topic before moving to Step 2.

## Step 2: Get Next Topic

```bash
npm run pipeline:next
```

This outputs the topic brief as JSON. Read the full brief including keyword, search volume, difficulty, search intent, suggested title, content angle, and reference URLs. Refine the suggested title and content angle before proceeding (see Step 1.5).

The topic is now marked `in_progress`.

## Step 3: Create Post File

```bash
npm run pipeline:create
```

This creates a markdown file in `src/content/blog/` with proper frontmatter. Note the file path and topic ID from the output.

## Step 4: Write the Article

Read `autoblog/config/writing-style.md` for style guidelines.

Write the full article content into the created markdown file. Follow these rules:

### Content Requirements
- **Word count:** 1200-2500 words
- **Structure:** 4-6 H2 headings, 1-2 H3s under each H2
- **FAQ section:** Include a "Frequently Asked Questions" H2 at the end with 5-6 questions
- **Internal links:** 3-8 links to existing site pages (use relative paths like `/blog/`, `/blog/digital-planner-for-remarkable-move/`, `/blog/installation-guide/`, `/blog/how-this-app-was-made/`)
- **External links:** 2-5 links to authoritative external sources
- **Stats/data:** Include relevant statistics or data points for credibility

### Writing Style
- Active voice, direct address ("you")
- Conversational, real tone (no hype, no fluff)
- Short sentences mixed with longer ones
- No semicolons, no hashtags, no emojis, no dashes
- No cliches or jargon ("cutting-edge", "game-changer", "revolutionary")
- Replace uncertainty with clarity ("might" → use definitive statements)
- Simple language, direct and concise

### SEO
- Primary keyword must appear in the title and first paragraph
- Use the keyword naturally throughout (don't force it)
- Write a meta description (120-160 characters) and update the frontmatter `description` field
- Update the `imageAlt` field in frontmatter with descriptive alt text

### After Writing
Remove all HTML comment blocks (the pipeline brief comments) from the file. Only the frontmatter and article content should remain.

## Step 5: Humanize via WalterWrites

Run the article body through Walter's humanizer using the `humanize-mcp.js` helper. The helper does the deterministic work — chunking long posts at H2 boundaries, removing inline link syntax so Walter doesn't rewrite anchor text, then restoring links/headings/images and applying brand and voice fixups after. Claude only orchestrates the MCP call in the middle.

### Steps

1. **Prep.** Split the post into 1–2 chunks (one chunk if ≤2000 words, two if larger) and extract restorable state:
   ```bash
   node autoblog/scripts/humanize-mcp.js prep <blogFile> /tmp/autoblog-prep.json > /tmp/autoblog-items.json
   ```
   - The side state (frontmatter + per-chunk links/headings/images) lands in `/tmp/autoblog-prep.json`.
   - The items payload (shape: `{ items: [{ id, text, entities }] }`) is printed to stdout and captured in `/tmp/autoblog-items.json`.
   - The script logs per-chunk word counts to stderr. If any chunk shows `[FAIL 50-word min]` or `[FAIL 2000-word max]`, stop and fix the post before continuing — Walter will reject those.

2. **Humanize.** Read `/tmp/autoblog-items.json` and call `mcp__claude_ai_Walter_Writes_AI__walter_batch_humanize` **once** with:
   - `defaults`:
     - `mode`: `"safe"` (minimal changes focused on stripping AI patterns. `"balanced"` rewrites more aggressively but tends to drop or hallucinate links and reintroduce dashes/semicolons even with the preserve config below — the helper has to undo those, so it's better to ask Walter for less to begin with.)
     - `output_format`: `"markdown"`
     - `structure.keep_headings`: `true`
     - `structure.keep_lists`: `true`
     - `preserve.urls`: `true`
     - `preserve.numbers`: `true`
     - `preserve.keywords`: `[<primary keyword from the topic brief>]`
   - `items`: one entry per prep item:
     - `id`: the item's `id` (use it verbatim — `c0`, `c1`)
     - `text`: the item's `text`
     - `preserve.entities`: the item's `entities` array (link anchor texts the helper extracted — preserves words that are link targets so restoreLinks can find them)

   Collect the responses into `{ items: [{ id, text: <humanized_text> }] }` keyed by the same ids, and write the JSON to `/tmp/autoblog-humanized.json`.

3. **Finalize.** Apply brand/voice fixups, restore links/headings/images, and write the rebuilt markdown back over the original file:
   ```bash
   node autoblog/scripts/humanize-mcp.js finalize /tmp/autoblog-prep.json /tmp/autoblog-humanized.json <blogFile>
   ```
   This also adds `humanized: true` to the frontmatter and logs any unresolved links to stderr.

### Post-Humanization Rules

**Do NOT manually rewrite, rephrase, or "improve" the finalized text.** Walter's output IS the final voice; the helper has already restored structure (headings, lists, links, images) deterministically and applied the configured brand/voice fixups.

The only acceptable edit after finalize is fixing the rare obvious typo. If you think a sentence "sounds worse" than your original — leave it. Rewriting reintroduces the AI patterns Walter just stripped, defeating the entire step.

If `finalize` logged `unresolved_links=N` with N > 0, those link anchors couldn't be reattached because Walter rewrote them too aggressively. Surface that in your commit message; don't try to reverse-engineer them by hand.

### Customizing brand and voice fixups

The helper applies a list of brand-name and voice cleanups during `finalize`. Generic tech terms (OS names, compliance acronyms, file formats, units) ship as defaults. To add your own brand and product names — anything Walter tends to lowercase or rewrite — edit the `SITE_BRAND_FIXES` block in `autoblog/scripts/humanize-mcp.js`. The opinionated phrase rewrites (`we have found → reviewers report`, etc.) live in `VOICE_TWEAKS` right above it and are equally editable.

### Checking credits before a batch

If you're about to humanize several posts in a session and want to verify credits, call `mcp__claude_ai_Walter_Writes_AI__walter_account_info` first. It returns your remaining humanizer credits and per-request word limit.

### Skipping humanization

If the WalterWrites MCP server isn't connected (the `mcp__claude_ai_Walter_Writes_AI__*` tools aren't available in your session) or you don't want to humanize, skip this step entirely and note it in the commit message. The article still publishes — it just reads more obviously AI-written.

## Step 6: Quality Check

```bash
npm run pipeline:quality-check -- <filepath>
```

Example: `npm run pipeline:quality-check -- src/content/blog/offline-transcription-software.md`

If any checks **FAIL**:
- Fix the issues in the blog post
- Run the quality check again
- Maximum 2 fix attempts. If still failing after 2 attempts, proceed anyway.

## Step 7: Generate Blog Images

```bash
npm run pipeline:images -- <filepath>
```

This uses the Gemini API (`gemini-3.1-flash-image-preview`) to generate New Yorker-style illustrations and inserts them into the markdown file. Images automatically alternate between light and dark color palettes for variety.

**Image generation details:**
- Model: `gemini-3.1-flash-image-preview` (~$0.067/image, requires billing)
- Output format: 1000px wide JPEG, quality 85, auto-compressed via sharp
- Images alternate light/dark backgrounds (image 1 light, image 2 dark, etc.)
- All images in `autoblog/config/example-images/` are used as style references
- Alternative models: `gemini-3-pro-image-preview` (~$0.134/image, highest quality) or `gemini-2.0-flash-exp-image-generation` (free, lower quality) — change `MODEL_NAME` in the script

If image generation fails, proceed without images and note this in the commit message.

## Step 8: Mark Complete

```bash
npm run pipeline:complete -- <topic-id> <filepath>
```

Example: `npm run pipeline:complete -- topic-20250128-01 src/content/blog/offline-transcription-software.md`

## Step 8.5: Send for Review (Optional)

```bash
npm run pipeline:send-review -- <filepath>
```

This sends a rendered HTML email to the reviewer configured as `REVIEW_EMAIL_TO` in `.env`. The email includes the post title, meta info (slug, description, word count), and the full article rendered with inline images (CID-embedded). The raw markdown file is also attached for reference.

`[PIPELINE-FILE: <filepath>]` and `[PIPELINE-TOPIC: <id>]` markers are included in both the plain text and HTML footer so the review watcher can identify which Queue row the reply refers to. Sending also sets that row's `reviewStatus` to `in_review` automatically.

When the reviewer replies, the review watcher (`autoblog/scripts/review-watcher.js`) picks up the reply via IMAP and writes the outcome to the Queue tab — `approved` or `changes_requested`, plus the reply body in `reviewFeedback`. **The watcher does not commit, push, or invoke Claude.** All revision and publish work happens in a separate interactive Claude session via the `/autoblog-reviews` slash command (see Step 0), which is also run as the first step of the next pipeline pass.

## Step 9: Build the Site

```bash
npm run pipeline:build
```

If the build fails, investigate the error and fix it before proceeding.

## Step 10: Done

The pipeline is complete. If you sent the post for review (Step 8.5), do **not** commit it now — wait for the reviewer's reply. The watcher will park the outcome in the Queue tab, and the next pipeline run's Step 0 (`/autoblog-reviews`) will publish or revise it. If you skipped Step 8.5, review the post yourself and commit when ready.

## Error Recovery

| Error | Action |
|-------|--------|
| DataForSEO API fails | Log error, work on existing pending topics if any |
| WalterWrites MCP not connected or out of credits | Skip Step 5, note in commit message |
| Quality check keeps failing | Proceed after 2 fix attempts |
| Image generation fails | Commit without images, note in commit message |
| Eleventy build fails | Fix the error before committing |
| No pending topics and research fails | Stop, commit nothing |
