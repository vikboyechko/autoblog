#!/usr/bin/env node

/**
 * Review Watcher — IMAP → Google Sheets bridge.
 *
 * Long-running daemon that polls IMAP every 2 minutes for review reply emails
 * and writes the result (approve / changes_requested + feedback body) to the
 * Queue tab of the project's Google Sheet. Nothing else.
 *
 * The actual revision + publish work happens in an interactive Claude Code
 * session via the `/autoblog-reviews` slash command, which reads the Sheet.
 * That keeps headless Claude invocations and unattended git pushes out of
 * automation entirely.
 *
 * Uses recursive setTimeout (not setInterval) so a slow poll never overlaps.
 *
 * See README.md for setup instructions.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const path = require('path');
const fs = require('fs');

const { setReviewStatus, getTopicByBlogFile } = require('./google-sheets');

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const PROCESSED_UIDS_FILE = path.resolve(__dirname, '.processed-uids.json');
const REVIEW_MAP_FILE = path.resolve(__dirname, '.review-map.json');

// IMAP config from .env (same credentials as SMTP)
const IMAP_CONFIG = {
  host: process.env.SMTP_HOST,
  port: 993,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  logger: false,
};

/**
 * Track processed UIDs on disk so we don't re-process emails,
 * even if another IMAP client (e.g. Mail.app) marks them as read first.
 */
function loadProcessedUids() {
  try {
    const data = fs.readFileSync(PROCESSED_UIDS_FILE, 'utf8');
    return new Set(JSON.parse(data));
  } catch (_) {
    return new Set();
  }
}

function saveProcessedUids(uidSet) {
  // Keep only the last 200 UIDs to prevent unbounded growth
  const arr = [...uidSet].slice(-200);
  fs.writeFileSync(PROCESSED_UIDS_FILE, JSON.stringify(arr));
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function logError(msg, err) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${msg}`, err?.message || err || '');
}

/**
 * Parse a review reply email to extract approval status, file path, topic id, feedback.
 */
function parseReviewReply(subject, textBody, htmlBody) {
  const allText = (textBody || '') + '\n' + (htmlBody || '');

  // Strip email quote markers ("> ") that leak in from Gmail text quoting
  const cleanMarker = (s) => s.trim().replace(/^[>\s]+/, '').replace(/\s+/g, ' ');

  // Extract file path from [PIPELINE-FILE: path] marker in email body
  const fileMatch = allText.match(/\[PIPELINE-FILE:\s*(.+?)\]/);
  let filePath = fileMatch ? cleanMarker(fileMatch[1]) : '';

  // Extract topic id from [PIPELINE-TOPIC: id] marker (added by send-for-review)
  const topicMatch = allText.match(/\[PIPELINE-TOPIC:\s*([^\]]+?)\]/);
  let topicId = topicMatch ? cleanMarker(topicMatch[1]) : '';

  // Fallback: look up file path from title in the review map
  // (Gmail can truncate quoted content, losing the marker)
  if (!filePath) {
    const titleMatch2 = subject.match(/\[Blog Review\]\s*(.+)/);
    const lookupTitle = titleMatch2 ? titleMatch2[1].trim() : '';
    if (lookupTitle) {
      try {
        const map = JSON.parse(fs.readFileSync(REVIEW_MAP_FILE, 'utf8'));
        if (map[lookupTitle]) {
          filePath = map[lookupTitle];
          log(`IMAP: filePath recovered from review map: ${filePath}`);
        }
      } catch (_) {}
    }
  }

  // Extract title from subject: "Re: [Blog Review] Title"
  const titleMatch = subject.match(/\[Blog Review\]\s*(.+)/);
  const title = titleMatch ? titleMatch[1].trim() : 'blog post';

  // Get reply body (text before quoted content)
  let replyBody = textBody || '';
  const quotePatterns = [
    /\nOn .+wrote:\s*\n/s,
    /\n>\s/,
    /\n-{3,}Original Message-{3,}/i,
    /\nFrom:\s.+\nSent:\s/i,
  ];
  for (const pattern of quotePatterns) {
    const idx = replyBody.search(pattern);
    if (idx > 0) {
      replyBody = replyBody.substring(0, idx);
      break;
    }
  }
  replyBody = replyBody.trim();

  // Check if approved (must be alone on a line, case-insensitive)
  const isApproved = /^\s*APPROVE\s*$/i.test(replyBody);

  return { filePath, topicId, title, replyBody, isApproved };
}

/**
 * Resolve a topicId. Prefer the [PIPELINE-TOPIC:] marker; fall back to a
 * Sheet lookup by blogFile so legacy emails (sent before this marker existed)
 * still route correctly.
 */
async function resolveTopicId(parsedTopicId, filePath, title) {
  if (parsedTopicId) return parsedTopicId;
  if (!filePath) {
    log(`IMAP: no topic marker and no file path for "${title}", giving up`);
    return null;
  }
  try {
    const topic = await getTopicByBlogFile(filePath);
    if (topic) {
      log(`IMAP: topicId recovered via Sheet lookup: ${topic.id} (${filePath})`);
      return topic.id;
    }
  } catch (err) {
    logError(`IMAP: Sheet lookup failed for ${filePath}`, err);
  }
  log(`IMAP: no topic row matches ${filePath}; cannot record reply`);
  return null;
}

/**
 * Connect to IMAP, fetch recent emails, write any reply outcomes to the Sheet.
 */
async function pollForReplies() {
  let client;
  try {
    client = new ImapFlow(IMAP_CONFIG);
    await client.connect();
    log('IMAP: connected');

    const processedUids = loadProcessedUids();

    const lock = await client.getMailboxLock('INBOX');
    try {
      // Look at messages from the last 24 hours (not just unseen) so other
      // IMAP clients marking emails read won't hide them from us.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const uids = await client.search({ since });

      const newUids = uids.filter(uid => !processedUids.has(uid));
      if (!newUids.length) {
        log('IMAP: no new messages');
        return;
      }

      log(`IMAP: ${newUids.length} new message(s) to check`);

      for (const uid of newUids) {
        let parsed;
        try {
          const msg = await client.fetchOne(uid, { source: true });
          parsed = await simpleParser(msg.source);
        } catch (fetchErr) {
          logError(`IMAP: failed to fetch/parse message ${uid}`, fetchErr);
          processedUids.add(uid);
          continue;
        }

        const subject = parsed.subject || '';
        const textBody = parsed.text || '';
        const htmlBody = parsed.html || '';

        // Filter: must be a reply to a [Blog Review] email
        if (!subject.startsWith('Re:') || !subject.includes('[Blog Review]')) {
          log(`IMAP: skipping non-review email: "${subject}"`);
          processedUids.add(uid);
          continue;
        }

        log(`IMAP: processing review reply: "${subject}"`);
        const { filePath, topicId: parsedTopicId, title, replyBody, isApproved } =
          parseReviewReply(subject, textBody, htmlBody);

        const topicId = await resolveTopicId(parsedTopicId, filePath, title);
        if (!topicId) {
          // Mark processed so we don't loop on an unresolvable email forever.
          processedUids.add(uid);
          continue;
        }

        // Mark UID processed first so a transient Sheet failure can be retried
        // by the operator (re-send the topic for review) without re-firing
        // on the same email.
        processedUids.add(uid);
        saveProcessedUids(processedUids);

        const newStatus = isApproved ? 'approved' : 'changes_requested';
        // Always store the reply body; for APPROVE it's just the literal word.
        try {
          await setReviewStatus(topicId, newStatus, replyBody);
          log(`SHEET: ${topicId} (${title}) → ${newStatus}`);
        } catch (sheetErr) {
          logError(`SHEET: failed to update ${topicId} (${title})`, sheetErr);
        }
      }

      // Final save in case the last message bumped the cache.
      saveProcessedUids(processedUids);
    } finally {
      lock.release();
    }
  } catch (err) {
    logError('IMAP: poll error', err);
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch (_) {}
    }
  }
}

/**
 * Main loop using recursive setTimeout to prevent overlap.
 */
async function scheduleNext() {
  try {
    await pollForReplies();
  } catch (err) {
    logError('Poll cycle error', err);
  }
  log(`Next poll in ${POLL_INTERVAL_MS / 1000}s`);
  setTimeout(scheduleNext, POLL_INTERVAL_MS);
}

// Startup
function main() {
  if (!IMAP_CONFIG.host || !IMAP_CONFIG.auth.user || !IMAP_CONFIG.auth.pass) {
    console.error('Missing IMAP config. Set SMTP_HOST, SMTP_USER, SMTP_PASS in autoblog/.env');
    process.exit(1);
  }

  log('Review watcher starting (Sheet-writer mode)');
  log(`IMAP: ${IMAP_CONFIG.auth.user}@${IMAP_CONFIG.host}:${IMAP_CONFIG.port}`);
  log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  process.on('SIGTERM', () => { log('Received SIGTERM, shutting down'); process.exit(0); });
  process.on('SIGINT', () => { log('Received SIGINT, shutting down'); process.exit(0); });

  scheduleNext();
}

main();
