# Setting Up the Autoblog Pipeline for a New Site

A procedural walkthrough for dropping this template into a new project. Claude
Code can read this file end-to-end and execute every step without further
guidance — that's the design target.

For _what each piece does_ and _why it's split this way_, see `README.md`.
This file is purely procedure.

## What's automated and what isn't

The pipeline is deliberately mostly manual. Two things run on their own:

1. **The review-reply watcher** (PM2 daemon, Step 9). Polls your inbox every 2 minutes for replies to review emails and writes the outcome into the Google Sheet. Never writes git, never invokes Claude.
2. **Topic research**, lazily — only when the queue is empty, the next pipeline run triggers it once. It's not on any schedule.

Everything else is interactive: you open Claude Code in your project, tell it to follow `PIPELINE.md`, and it walks through the queue and writes posts in your session. Publishing approved posts goes through the `/autoblog-reviews` slash command, which shows you the staged changeset and asks for confirmation before pushing.

## Prerequisites

System:

- **Node.js** v18+ and `npm`
- **Claude Code CLI** installed
- **Git** with push access to your blog repo
- **PM2** if you want the review-reply watcher (`npm install -g pm2`)

Accounts you'll need credentials for:

| Service         | Purpose                                  | Required?                               | Sign up                                |
| --------------- | ---------------------------------------- | --------------------------------------- | -------------------------------------- |
| DataForSEO      | Keyword research API                     | yes                                     | https://dataforseo.com                 |
| Google Sheets   | Topic queue tracking                     | yes                                     | Google Cloud Console (service account) |
| Gemini API      | Blog image generation                    | optional (posts publish without images) | https://aistudio.google.com            |
| WalterWrites    | AI-pattern humanization (via MCP server) | optional                                | https://walterwrites.ai                |
| SMTP/IMAP email | Review emails + watcher                  | optional (can review locally)           | any provider supporting SMTP+IMAP      |

---

## Step 1: Copy the template into your project

Your final project layout will look like this:

```
your-site/
├── package.json
├── .env                         ← secrets (gitignore this)
├── ecosystem.config.js          ← PM2 config for the watcher (Step 9)
├── service-account-key.json     ← Google service account key (gitignore)
├── .claude/
│   ├── commands/
│   │   └── autoblog-reviews.md  ← slash command (installed in Step 6)
│   └── settings.local.json      ← permission allowlist (Step 7)
├── src/
│   ├── content/blog/            ← your blog post markdown files
│   └── assets/images/blog/      ← Gemini-generated images
└── autoblog/                    ← contents of this template
    ├── README.md
    ├── PIPELINE.md
    ├── SETUP-NEW-SITE.md
    ├── .env.example
    ├── ecosystem.config.example.js
    ├── config/
    │   ├── pipeline.config.json
    │   ├── writing-style.md
    │   └── example-images/
    ├── scripts/
    │   ├── create-post.js
    │   ├── generate-blog-images.js
    │   ├── google-sheets.js
    │   ├── humanize-mcp.js
    │   ├── quality-check.js
    │   ├── queue-manager.js
    │   ├── research.js
    │   ├── review-watcher.js
    │   └── send-for-review.js
    └── slash-commands/
        └── autoblog-reviews.md
```

Copy the entire autoblog template repo's contents into `your-site/autoblog/`. Don't move files into different subfolders — scripts depend on these relative paths.

## Step 2: Install dependencies and add npm scripts

From your project root:

```bash
npm install dotenv gray-matter marked googleapis @google/generative-ai nodemailer sharp
```

If you want the review-reply watcher (Step 9 below), also install:

```bash
npm install imapflow mailparser
```

Add these scripts to your `package.json`:

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

Adjust `pipeline:build` if your static site generator isn't Eleventy (e.g. `npx astro build`, `hugo`). The quality check also runs an Eleventy `--dryrun` by default; if you use a different SSG, update the build invocation near the bottom of `autoblog/scripts/quality-check.js`.

## Step 3: Configure pipeline.config.json

Edit `autoblog/config/pipeline.config.json` with your product details. The key section is `site`:

```json
{
  "site": {
    "domain": "yoursite.com",
    "name": "Your Product",
    "niche": "your product category",
    "productDescription": "What your product does in one sentence",
    "seedPillars": {
      "core": ["seed keyword 1", "seed keyword 2"],
      "features": ["another seed", "more seeds"],
      "use cases": ["use case seed 1", "use case seed 2"]
    },
    "productFeatures": ["feature 1", "feature 2", "feature 3"]
  }
}
```

Seed pillars drive keyword research — each pillar is a topic category with 2–4 seed keywords, fed to DataForSEO in round-robin order so every pillar gets API calls early. The `research`, `seo`, and `imageStyle` sections have sensible defaults; see `README.md` "Configuration Reference" for what each setting controls.

If your blog directory structure differs from `src/content/blog/` and `src/assets/images/blog/`, update the `paths` section.

## Step 4: Create .env

Copy the example to your project root and fill in credentials:

```bash
cp autoblog/.env.example .env
```

At minimum DataForSEO and Google Sheets credentials are required. Gemini (images), SMTP/IMAP (review emails), and WalterWrites (humanization) are optional.

Note: there are **no WalterWrites credentials in `.env`**. Humanization runs through an MCP server connected to your Claude account — see Step 8.

## Step 5: Set up Google Sheets

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a project (or use an existing one).
2. Enable the **Google Sheets API**.
3. Go to **IAM & Admin > Service Accounts**, create a service account, and download a JSON key file. Save it inside your project (e.g. `your-site/service-account-key.json`) and set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` in `.env` to the path. **Gitignore the key file.**
4. Create a new Google Sheet.
5. Rename the default tab to **Queue** and add a second tab named **Completed**. The tab names are hard-coded — they must match exactly.
6. Share the sheet with the service account's email (ends in `@*.iam.gserviceaccount.com`), Editor access.
7. Copy the sheet's ID from its URL (`https://docs.google.com/spreadsheets/d/THIS_PART/edit`) into `GOOGLE_SHEET_ID` in `.env`.
8. Initialize the header rows:
   ```bash
   npm run pipeline:init
   ```
   This writes the canonical layout (Queue tab: A–O topic columns, P=`reviewStatus`, Q=`reviewFeedback`, R=blank, S=`lastResearchDate`; Completed tab: A–F) and seeds the Completed list from any existing blog posts so research doesn't re-suggest topics you've already covered.

If you're reusing a sheet from an older version of this template, `pipeline:init` will detect drift in the header row and repair it in place. See the "Sheet columns" section of `README.md` for details.

## Step 6: Install the slash command

Claude Code only discovers slash commands at `<project-root>/.claude/commands/*.md`. Copy the autoblog command into your project:

```bash
mkdir -p .claude/commands
cp autoblog/slash-commands/autoblog-reviews.md .claude/commands/
```

After this, `/autoblog-reviews` will be available in your Claude Code sessions when run from this project root.

## Step 7: Configure Claude Code permissions

Create `.claude/settings.local.json` so the pipeline can run without permission prompts on routine commands:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run pipeline:*)",
      "Bash(npm run build:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git push:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(node:*)",
      "Bash(npx:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(grep:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(wc:*)",
      "Bash(find:*)",
      "Bash(curl:*)",
      "Edit",
      "Write",
      "WebSearch"
    ]
  }
}
```

If you add new permissions later, restart the Claude Code session to pick them up.

## Step 8: Connect the WalterWrites MCP server (optional)

Humanization runs through the WalterWrites MCP server. Two ways to connect:

- **Claude.ai workspace integration** — enable WalterWrites in your Claude.ai workspace integrations. The `mcp__claude_ai_Walter_Writes_AI__*` tools then appear in your Claude Code session automatically.
- **Direct MCP config** — if you're running the server some other way, add it to a `.mcp.json` in your project root.

To verify the connection, ask Claude to call `walter_account_info`. You should see your account email, plan, and remaining humanizer credits. Note the `max_words_per_request` value — typically 2000 on the standard plan. `autoblog/scripts/humanize-mcp.js` chunks at that ceiling by default.

If you don't connect WalterWrites, the pipeline will skip Step 5 of `PIPELINE.md` and posts will publish without humanization. They still work; they just read more obviously AI-written.

## Step 9: Set up the review watcher (optional, PM2)

The watcher is a long-running daemon that polls IMAP every 2 minutes for replies to review emails and writes the outcome (`approved` / `changes_requested` + the reply body) into the Sheet. It never invokes Claude and never runs git.

1. Copy the example PM2 config to your project root:
   ```bash
   cp autoblog/ecosystem.config.example.js ecosystem.config.js
   ```
2. Start the watcher and persist it across reboots:
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup    # follow the printed instructions to enable on boot
   ```

Verify it's running: `pm2 logs autoblog-review-watcher`. The first poll runs immediately on startup. The watcher reuses your `.env` SMTP credentials for IMAP access on port 993.

If you skip this step, you can still review posts manually — read the email, edit the file by hand, push when ready — you just don't get the `/autoblog-reviews` loop.

## Step 10: Customize voice, images, and brand fixups

- **`autoblog/config/writing-style.md`** — Claude reads this when writing articles. Edit to match your brand voice (tone, banned phrases, sentence-structure rules, examples).
- **`autoblog/config/example-images/`** — replace the stock images with 4–6 illustrations representing the visual style you want for blog images. The Gemini generator uses these as style references.
- **`autoblog/scripts/humanize-mcp.js`** — if you ship product names, brand names, or competitors that WalterWrites tends to lowercase or mangle, add them to the `SITE_BRAND_FIXES` block near the top. Pattern examples are commented in place.

---

## How to run the pipeline

Open Claude Code in your project root and tell it:

```
Follow the content pipeline in autoblog/PIPELINE.md
```

Claude reads the playbook and executes each step. Step 0 is `/autoblog-reviews`, which drains any pending review replies (publishes approved posts after you confirm; revises changes-requested posts). Then it moves on to writing new articles.

You can also run individual steps:

```
Run step 5 from autoblog/PIPELINE.md (humanize the current draft)
```

There is **no scheduling**. Writing happens when you open a session. Research runs lazily, only when the queue is empty (built into PIPELINE.md Step 1). The watcher is the only thing on a continuous loop, and it only writes to the Sheet — never to git, never to Claude.

---

## Testing

### Verify research works

```bash
npm run pipeline:research -- --dry-run
```

Prints the keyword suggestions it would write to the Queue tab without committing them.

### Verify Sheet connectivity

```bash
npm run pipeline:status
```

Should print "Pending topics: 0" (or whatever's in your Queue) without errors.

### Verify the review-email flow (if SMTP is configured)

1. Create a test post in `src/content/blog/`.
2. Add a row for it to the Queue tab manually (set `status=in_progress` and `blogFile` to the file path).
3. Run `npm run pipeline:send-review -- src/content/blog/test-post.md` — should land in your `REVIEW_EMAIL_TO` inbox.
4. Reply `APPROVE` and wait ~2 minutes. Check the Sheet: the row's `reviewStatus` should be `approved`.
5. In Claude Code, run `/autoblog-reviews` to publish it (or reply with revision feedback to test that path instead).

### Verify the watcher (if PM2 is configured)

```bash
pm2 logs autoblog-review-watcher --lines 50
```

Should show "IMAP: connected" and "no new messages" (or processed messages) on each 2-minute tick.

---

## Multi-site notes

- Each site has its own `.env`, its own Google Sheet, and its own PM2 watcher process. Give the watcher entries distinct `name:` values in `ecosystem.config.js` (e.g. `site1-review-watcher`, `site2-review-watcher`) so PM2 can manage them independently.
- The `autoblog/` template contents are identical across sites — only `config/pipeline.config.json`, `config/writing-style.md`, `config/example-images/`, and `scripts/humanize-mcp.js`'s `SITE_BRAND_FIXES` block differ.
- One Claude.ai WalterWrites integration covers all sites (subject to your plan's word/credit limits across the month).

---

## Troubleshooting

| Problem                                                                           | Fix                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude asks for permission on a routine command                                   | Add it to `.claude/settings.local.json` and restart the session.                                                                                                                                                                                   |
| `/autoblog-reviews` reports "no pending reviews" even though replies have arrived | Sheet headers are drifted. Run `node autoblog/scripts/queue-manager.js ensure-headers` once to repair the header row in place.                                                                                                                     |
| Watcher misses emails                                                             | The watcher tracks UIDs on disk in `autoblog/scripts/.processed-uids.json`, not the IMAP Seen flag, so other mail clients reading the inbox don't interfere. If emails still go missing, delete that file to force a re-scan of the last 24 hours. |
| Gmail truncates quoted email content                                              | The watcher falls back to `autoblog/scripts/.review-map.json` (title → filepath mapping) when the `[PIPELINE-FILE:]` marker is stripped.                                                                                                           |
| `pipeline:init` doesn't write headers                                             | Confirm the Sheet has tabs named exactly `Queue` and `Completed`. The names are case-sensitive.                                                                                                                                                    |
| `pipeline:images` errors with `ReferenceError: config is not defined`             | Your copy of `generate-blog-images.js` predates the config-load fix. Update from the template (see line ~70 of the script — it should `JSON.parse(fs.readFileSync(...))` `pipeline.config.json` right after the `CONFIG` block).                   |
| Walter rejects chunks with "text too long"                                        | Your plan's per-request word limit is below 2000. Edit the threshold in `chunkBody()` in `autoblog/scripts/humanize-mcp.js` to match.                                                                                                              |
| Walter rejects chunks with "text too short"                                       | The post has an H2 section under 50 words. Walter requires ≥50 words/request. Merge the short section into a neighbor or expand it.                                                                                                                |
| `pm2 start ecosystem.config.js` says script not found                             | The example assumes `autoblog/` lives at the project root. If you placed it elsewhere, edit the `script:` path in `ecosystem.config.js`.                                                                                                           |
