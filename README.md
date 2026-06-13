# Autoblog: AI Content Pipeline for Claude Code

An automated SEO blog content pipeline that runs inside [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Claude follows a step-by-step playbook (`PIPELINE.md`) to research keywords, write articles, generate images, and send them for human review.

Built for static sites (Eleventy, Hugo, Astro, etc.) with blog posts as markdown files.

## What It Does

1. **Keyword Research** - Queries the DataForSEO API for keyword suggestions based on your seed keywords, scores them by volume/difficulty/relevance, clusters similar topics, and picks the best batch
2. **Topic Queue** - Manages a Google Sheets queue of pending, in-progress, and completed topics
3. **Article Writing** - Claude writes the full article following your writing style guide
4. **Content Humanization** (optional) - Runs the article through the WalterWrites MCP server (`walter_humanize` tool) to make it read more naturally
5. **Quality Check** - Validates word count, SEO structure, frontmatter, heading count, link count, style compliance, and Eleventy build
6. **Image Generation** - Uses Google's Gemini API to generate New Yorker-style illustrations, alternating light/dark palettes
7. **Email Review** - Sends the finished article as a rendered HTML email for human approval
8. **Review Watcher** (optional) - A PM2 daemon that monitors IMAP for review replies and writes the outcome (`approved` / `changes_requested` + the reply body) to the Queue tab. Revisions and publishing happen in a separate interactive Claude session via the `/autoblog-reviews` slash command — the watcher itself never invokes Claude or runs git

## How to Use It

**First time wiring this template into a new project?** Open Claude Code in your project root and tell it to follow `autoblog/SETUP-NEW-SITE.md` — a procedural walkthrough that covers everything in the "Setup" section below plus the Google Sheet initialization, MCP connection, slash command install, and PM2 watcher setup. It's the fastest way to go from `git clone` to a working pipeline.

Once you're set up, day-to-day usage:

Open Claude Code in your project directory and tell it:

```
Follow the content pipeline in autoblog/PIPELINE.md
```

Claude reads the playbook and runs each step. You can also run individual steps:

```
Run step 1 from autoblog/PIPELINE.md (check queue and research)
```

Or run the scripts directly:

```bash
npm run pipeline:status          # Check queue status
npm run pipeline:research        # Run keyword research
npm run pipeline:research -- --dry-run  # Preview research without writing to Sheets
npm run pipeline:next            # Get next pending topic
npm run pipeline:create          # Create markdown file for in-progress topic
npm run pipeline:quality-check -- src/content/blog/your-post.md
npm run pipeline:images -- src/content/blog/your-post.md
npm run pipeline:send-review -- src/content/blog/your-post.md
npm run pipeline:complete -- topic-20250201-01 src/content/blog/your-post.md
```

## Prerequisites

- **Node.js** v18+
- **Claude Code** CLI installed ([docs](https://docs.anthropic.com/en/docs/claude-code))
- A static site repo with markdown blog posts (the pipeline expects `src/content/blog/`)

### External Services

| Service         | Purpose               | Required                       | Sign Up                     |
| --------------- | --------------------- | ------------------------------ | --------------------------- |
| DataForSEO      | Keyword research API  | Yes                            | https://dataforseo.com      |
| Google Sheets   | Topic queue tracking  | Yes                            | Google Cloud Console        |
| Gemini API      | Blog image generation | No (posts work without images) | https://aistudio.google.com |
| WalterWrites    | Content humanization  | No (can skip this step)        | https://walterwrites.ai     |
| SMTP/IMAP email | Review emails         | No (can review locally)        | Any email provider          |

## Setup

### 1. Copy the autoblog folder into your project

```
your-site/
  src/content/blog/          # Blog post markdown files
  src/assets/images/blog/    # Generated blog images
  autoblog/                  # This pipeline (copy it here)
  .env                       # Environment variables
  package.json
```

### 2. Install dependencies

```bash
npm install dotenv gray-matter marked googleapis @google/generative-ai nodemailer sharp
```

If using the review watcher (optional):

```bash
npm install imapflow mailparser
```

### 3. Add pipeline scripts to package.json

```json
{
  "scripts": {
    "pipeline:status": "node autoblog/scripts/queue-manager.js status",
    "pipeline:research": "node autoblog/scripts/research.js",
    "pipeline:next": "node autoblog/scripts/queue-manager.js next",
    "pipeline:create": "node autoblog/scripts/create-post.js",
    "pipeline:quality-check": "node autoblog/scripts/quality-check.js",
    "pipeline:images": "node autoblog/scripts/generate-blog-images.js",
    "pipeline:send-review": "node autoblog/scripts/send-for-review.js",
    "pipeline:update": "node autoblog/scripts/queue-manager.js update",
    "pipeline:complete": "node autoblog/scripts/queue-manager.js complete",
    "pipeline:reviews": "node autoblog/scripts/queue-manager.js reviews",
    "pipeline:init": "node autoblog/scripts/queue-manager.js init",
    "pipeline:build": "npx @11ty/eleventy"
  }
}
```

Adjust `pipeline:build` for your static site generator (e.g., `npx astro build`, `hugo`, etc.).

### 4. Create .env

Copy `.env.example` to `.env` in your project root and fill in your credentials:

```bash
cp autoblog/.env.example .env
```

At minimum you need DataForSEO and Google Sheets credentials to use the research and queue features. The other services are optional.

### 5. Set up Google Sheets

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable the **Google Sheets API**
4. Go to **IAM & Admin > Service Accounts**, create a service account
5. Create a JSON key for the service account and save it as `service-account-key.json` at your **project root** (next to `package.json`), and update `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` in `.env` to match. Don't place it inside `autoblog/` — that folder is the template and should not carry per-project secrets.
6. Create a new Google Sheet
7. Rename the default tab to **Queue** and create a second tab named **Completed** (these exact names are required)
8. Share the sheet with the service account email (the email ending in `@*.iam.gserviceaccount.com`)
9. Copy the sheet ID from the URL (`https://docs.google.com/spreadsheets/d/THIS_PART/edit`) into your `.env`
10. Initialize the sheet:

```bash
npm run pipeline:init
```

This populates the header rows in both tabs and seeds the Completed list from your existing blog posts (so research doesn't suggest topics you've already covered).

### 6. Configure pipeline.config.json

Edit `autoblog/config/pipeline.config.json` with your product details:

- **`site.domain`** - Your website domain
- **`site.name`** - Product/site name
- **`site.niche`** - What your product/site is about
- **`site.productDescription`** - One-sentence description
- **`site.seedPillars`** - Seed keywords organized by topic category. These drive keyword research. Each pillar should have 2-4 seeds.
- **`site.productFeatures`** - List of features (used for relevance scoring)
- **`paths`** - Adjust if your blog directory structure differs

The `research` and `seo` sections have sensible defaults. See PIPELINE.md "How Research Works" for details on what each setting does.

### 7. Customize writing-style.md

Edit `autoblog/config/writing-style.md` to match your brand voice. Claude reads this file when writing articles.

### 8. Replace example images

Replace the images in `autoblog/config/example-images/` with illustrations that represent the visual style you want for your blog. The Gemini image generator uses these as style references.

### 9. Set up Claude Code permissions (optional)

To let Claude run pipeline commands without prompting for permission each time, create `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run pipeline:*)",
      "Bash(npm run build:*)",
      "Bash(node:*)",
      "Bash(npx:*)",
      "Edit",
      "Write",
      "WebSearch"
    ]
  }
}
```

## Configuration Reference

### Research Settings

| Setting                | Default | Description                            |
| ---------------------- | ------- | -------------------------------------- |
| `batchSize`            | 10      | Number of topics per research run      |
| `maxKeywordDifficulty` | 40      | Hard ceiling on keyword difficulty     |
| `minSearchVolume`      | 50      | Minimum monthly search volume          |
| `minProductRelevance`  | 0.2     | Minimum relevance score (0 = disabled) |
| `suggestionsPerSeed`   | 50      | API results per seed keyword           |
| `locationCode`         | 2840    | DataForSEO geo target (2840 = US)      |

### Scoring Weights

| Signal                  | Weight | Description                                |
| ----------------------- | ------ | ------------------------------------------ |
| Volume/difficulty ratio | 0.35   | High volume + low difficulty               |
| CPC                     | 0.15   | Commercial value signal                    |
| Trend momentum          | 0.15   | Rising search trends score higher          |
| Product relevance       | 0.20   | Word overlap with your product description |

Intent bonuses: commercial 1.5x, transactional 1.3x, informational 1.0x, navigational 0.5x

Competition penalties: HIGH 0.6x, MEDIUM 0.85x, LOW 1.0x

### Clustering

Keywords are clustered by word similarity (Jaccard coefficient). Two keywords sharing 40%+ of their content words land in the same cluster. The final batch is selected round-robin across clusters (max 2 per cluster) to prevent the batch from being dominated by variations of the same topic.

## Optional: Review Watcher + `/autoblog-reviews`

The review flow is split deliberately so that **no Claude is invoked headlessly and no git push runs unattended**:

1. **Watcher daemon** (`autoblog/scripts/review-watcher.js`) — polls IMAP every 2 minutes. When it sees a `Re: [Blog Review] ...` email, it parses the reply and writes the outcome to the Queue tab of your Google Sheet:
   - Reply of just `APPROVE` (case-insensitive, on its own line) → `reviewStatus = approved`
   - Anything else → `reviewStatus = changes_requested`, with the reply body stored in `reviewFeedback`
   - The watcher does **not** commit, push, or invoke Claude. That's all it does.

2. **`/autoblog-reviews` slash command** (`autoblog/.claude/commands/autoblog-reviews.md`) — run interactively in Claude Code. It reads pending rows from the Sheet and, for each one:
   - `changes_requested` → reads the post, applies the reply as feedback, re-runs `pipeline:quality-check`, re-runs `pipeline:send-review` (which automatically flips the row back to `in_review`).
   - `approved` → shows you the diff and proposed commit message, asks for confirmation, and only then runs `git add / commit / push` and calls `pipeline:complete` to move the row out of the queue.

Step 0 of `PIPELINE.md` runs `/autoblog-reviews` before any new work, so the queue is always drained at the start of a session.

### Setup

1. Install PM2: `npm install -g pm2`
2. Install the watcher's runtime deps in your project: `npm install imapflow mailparser`
3. Copy `autoblog/ecosystem.config.example.js` → `ecosystem.config.js` in your project root, edit the script path if your layout differs, then:
   ```bash
   pm2 start ecosystem.config.js && pm2 save
   ```
4. Install the slash command into your project's `.claude/commands/`:
   ```bash
   mkdir -p .claude/commands
   cp autoblog/slash-commands/autoblog-reviews.md .claude/commands/
   ```
   Claude Code only discovers slash commands at `<project-root>/.claude/commands/`, so this copy step is required — leaving the file inside `autoblog/` won't work. (The template ships it at `autoblog/slash-commands/` so it's visible as a regular file rather than buried in a dotfile folder that's typically gitignored.)

The watcher reuses your SMTP credentials from `.env` for IMAP access (port 993). It tracks processed emails by UID on disk (`autoblog/scripts/.processed-uids.json`), so other mail clients reading the same inbox won't interfere.

### Sheet columns

The Queue tab uses 19 columns. Running `npm run pipeline:init` on a fresh sheet writes the right headers automatically:

| Cols | Purpose |
|---|---|
| A–O | Topic data (`id`, `keyword`, `searchVolume`, …, `blogFile`) |
| P | `reviewStatus` (`in_review` \| `approved` \| `changes_requested` \| `published`) |
| Q | `reviewFeedback` (the reply body for `changes_requested`) |
| R | (blank separator) |
| S | `lastResearchDate` metadata (label in S1, value in S2) |

**Upgrading an existing sheet?** Run `node autoblog/scripts/queue-manager.js ensure-headers` once. It now compares the live header row against the canonical layout (A–O topic data, P=`reviewStatus`, Q=`reviewFeedback`, R=blank, S=`lastResearchDate`) and rewrites it in place if any cell is drifted. The old `lastResearchDate` value at Q2 will be cleared during the rewrite; the next `npm run pipeline:research` will repopulate it at S2.

Without this step, sheets that pre-date the review columns will still read review replies under the wrong column keys and `/autoblog-reviews` will silently see "no pending reviews" even when the watcher has logged them.

## Optional: WalterWrites Humanization

Step 5 in PIPELINE.md runs the article body through the [WalterWrites](https://walterwrites.ai) MCP server (`walter_humanize`) to convert AI-pattern prose into natural human writing. The tool preserves headings, lists, URLs, numbers, and configured SEO keywords/entities natively, so there is no manual re-formatting work after.

### Setup

Connect the WalterWrites MCP server to your Claude Code project. Two ways:

- **Claude.ai workspace integration** — if WalterWrites is enabled in your Claude.ai workspace, the `mcp__claude_ai_Walter_Writes_AI__*` tools appear in your Claude Code session automatically. Nothing to configure in the repo.
- **Direct MCP config** — if you're running the server some other way, add it to your project's `.mcp.json`.

To verify the connection, ask Claude to call `walter_account_info` — you should see your account email, plan, and remaining humanizer credits. If those tools aren't available, the pipeline will detect that and skip Step 5.

There are **no credentials in `.env`** for this — the previous version of this template logged into WalterWrites' web UI via Chrome browser automation. That approach is obsolete; the MCP server handles auth itself.

If you skip this step (no MCP, no credits, or you just don't want it), Claude's original article text is used as-is. Posts still publish — they just read more obviously AI-written.

## How the Pipeline Works

See `PIPELINE.md` for the full step-by-step playbook. Here's the flow:

```
Research (DataForSEO) → Queue (Google Sheets) → Write → Humanize → Quality Check → Images → Review → Publish
```

Each step is a standalone Node.js script. Claude orchestrates them by following PIPELINE.md, but you can run any step manually from the command line.

## Tips

- **Narrow niches**: If your niche is small, keyword research may return few results. Lower `minSearchVolume` to 20 or `minProductRelevance` to 0.1, or add more seed pillars.
- **Dry runs**: Always test research with `--dry-run` first to see what topics it would generate without writing to Google Sheets.
- **Image costs**: The default Gemini model (`gemini-3.1-flash-image-preview`) costs ~$0.067/image. For highest quality, switch to `gemini-3-pro-image-preview` (~$0.134/image), or use `gemini-2.0-flash-exp-image-generation` for free (lower quality). Change `MODEL_NAME` in `generate-blog-images.js`. Images are auto-compressed to 1000px wide JPEG (quality 85) via sharp.
- **Quality check**: The quality checker runs an Eleventy dry-run build. If you use a different static site generator, update the build command in `quality-check.js`.

## License

MIT
