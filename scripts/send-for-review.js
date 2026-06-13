#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const matter = require('gray-matter');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'pipeline.config.json'), 'utf8'));

const { getTopicByBlogFile, setReviewStatus } = require('./google-sheets');

function resolveImagePath(src) {
  // Images in markdown use paths like /assets/images/blog/foo.jpg
  // Resolve to actual file in src/ directory
  const stripped = src.replace(/^\//, '');
  const fromSrc = path.join(ROOT, 'src', stripped);
  if (fs.existsSync(fromSrc)) return fromSrc;

  // Try from public/
  const fromPublic = path.join(ROOT, 'public', stripped);
  if (fs.existsSync(fromPublic)) return fromPublic;

  // Try as-is from root
  const fromRoot = path.join(ROOT, stripped);
  if (fs.existsSync(fromRoot)) return fromRoot;

  return null;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  return types[ext] || 'application/octet-stream';
}

function buildHtmlEmail(title, description, slug, wordCount, htmlBody, filePath, topicId) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#f4f4f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5; padding:24px 0;">
    <tr><td align="center">
      <table width="640" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr><td style="background:#8445ec; padding:24px 32px;">
          <h1 style="margin:0; color:#ffffff; font-size:18px; font-weight:600;">Blog Post Review</h1>
        </td></tr>

        <!-- Meta -->
        <tr><td style="padding:24px 32px 0;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb; border-radius:6px; padding:16px;">
            <tr><td>
              <p style="margin:0 0 6px; font-size:13px; color:#6b7280;"><strong style="color:#374151;">Title:</strong> ${escapeHtml(title)}</p>
              <p style="margin:0 0 6px; font-size:13px; color:#6b7280;"><strong style="color:#374151;">Slug:</strong> /${escapeHtml(slug)}/</p>
              <p style="margin:0 0 6px; font-size:13px; color:#6b7280;"><strong style="color:#374151;">Description:</strong> ${escapeHtml(description)}</p>
              <p style="margin:0 0 6px; font-size:13px; color:#6b7280;"><strong style="color:#374151;">Word count:</strong> ~${wordCount}</p>
              <p style="margin:0; font-size:13px; color:#6b7280;"><strong style="color:#374151;">File:</strong> ${escapeHtml(filePath)}</p>
            </td></tr>
          </table>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:20px 32px 0;">
          <hr style="border:none; border-top:1px solid #e5e7eb; margin:0;">
        </td></tr>

        <!-- Article Body -->
        <tr><td style="padding:16px 32px 32px;">
          <div style="font-size:15px; line-height:1.7; color:#1f2937;">
            ${htmlBody}
          </div>
        </td></tr>

        <!-- Approval Instructions -->
        <tr><td style="padding:16px 32px 0;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:14px 16px;">
            <tr><td>
              <p style="margin:0 0 4px; font-size:13px; font-weight:600; color:#166534;">How to respond</p>
              <p style="margin:0; font-size:13px; color:#15803d; line-height:1.5;">
                Reply <strong>APPROVE</strong> to publish this post.<br>
                Reply with specific change requests to revise and receive a new draft.
              </p>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb; padding:16px 32px; border-top:1px solid #e5e7eb;">
          <p style="margin:0; font-size:12px; color:#9ca3af; text-align:center;">
            Sent by ${escapeHtml(config.site.name || 'Content Pipeline')} review system
          </p>
          <p style="margin:4px 0 0; font-size:11px; color:#d1d5db;">[PIPELINE-FILE: ${escapeHtml(filePath)}]${topicId ? ` [PIPELINE-TOPIC: ${escapeHtml(topicId)}]` : ''}</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendForReview(filePath) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REVIEW_EMAIL_TO, REVIEW_EMAIL_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !REVIEW_EMAIL_TO) {
    console.error('Missing SMTP config in .env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REVIEW_EMAIL_TO)');
    process.exit(1);
  }

  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(fullPath, 'utf8');
  const { data: frontmatter, content } = matter(raw);

  const title = frontmatter.title || path.basename(fullPath, '.md');
  const slug = frontmatter.url || '';
  const description = frontmatter.description || '';
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  // Look up the topic row by blogFile so the review watcher can update the right row.
  // Non-fatal if not found — the email still sends; downstream falls back to title/file lookup.
  let topic = null;
  try {
    topic = await getTopicByBlogFile(filePath);
    if (!topic) {
      console.log(`  Note: no Queue row found with blogFile=${filePath}; review status will not auto-update.`);
    }
  } catch (lookupErr) {
    console.log(`  Note: topic lookup failed (${lookupErr.message}); review status will not auto-update.`);
  }
  const topicId = topic?.id || '';

  // Find all images in the markdown and prepare CID attachments
  const attachments = [];
  const cidMap = new Map();
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;

  while ((match = imageRegex.exec(content)) !== null) {
    const imgSrc = match[2];
    const resolved = resolveImagePath(imgSrc);
    if (resolved) {
      const filename = path.basename(resolved);
      const cid = filename.replace(/[^a-z0-9.-]/gi, '_');
      cidMap.set(imgSrc, cid);
      attachments.push({
        filename,
        path: resolved,
        cid,
        contentType: mimeType(resolved),
      });
      console.log(`  Image: ${filename} -> cid:${cid}`);
    } else {
      console.log(`  Image not found: ${imgSrc}`);
    }
  }

  // Render markdown to HTML
  let htmlBody = marked(content);

  // Add inline styles to rendered elements for email compatibility
  htmlBody = htmlBody
    .replace(/<h2>/g, '<h2 style="margin:28px 0 12px; font-size:20px; color:#111827; border-bottom:1px solid #e5e7eb; padding-bottom:8px;">')
    .replace(/<h3>/g, '<h3 style="margin:20px 0 8px; font-size:17px; color:#1f2937;">')
    .replace(/<p>/g, '<p style="margin:0 0 14px; font-size:15px; line-height:1.7; color:#374151;">')
    .replace(/<strong>/g, '<strong style="color:#111827;">')
    .replace(/<a /g, '<a style="color:#8445ec; text-decoration:underline;" ')
    .replace(/<ul>/g, '<ul style="margin:0 0 14px; padding-left:24px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 14px; padding-left:24px;">')
    .replace(/<li>/g, '<li style="margin:0 0 6px; font-size:15px; line-height:1.6; color:#374151;">');

  // Replace image src with cid references
  for (const [src, cid] of cidMap) {
    // marked renders images as <img src="...">
    htmlBody = htmlBody.replace(
      new RegExp(`src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'),
      `src="cid:${cid}"`
    );
  }

  // Style images for email
  htmlBody = htmlBody.replace(/<img /g, '<img style="max-width:100%; height:auto; border-radius:6px; margin:12px 0;" ');

  const fullHtml = buildHtmlEmail(title, description, slug, wordCount, htmlBody, filePath, topicId);

  // Also attach the raw markdown for reference
  attachments.push({
    filename: path.basename(fullPath),
    path: fullPath,
  });

  const port = parseInt(SMTP_PORT || '587', 10);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  const info = await transporter.sendMail({
    from: REVIEW_EMAIL_FROM || SMTP_USER,
    to: REVIEW_EMAIL_TO,
    subject: `[Blog Review] ${title}`,
    text: `Blog post review: ${title}\n\nSlug: /${slug}/\nDescription: ${description}\nWord count: ~${wordCount}\nFile: ${filePath}\n\n[PIPELINE-FILE: ${filePath}]${topicId ? `\n[PIPELINE-TOPIC: ${topicId}]` : ''}\n\nSee the HTML version of this email for the full rendered article with images.\n\nReply APPROVE to publish this post.\nReply with specific change requests to revise and receive a new draft.`,
    html: fullHtml,
    attachments,
  });

  // Save title-to-filepath mapping for the review watcher
  // (Gmail can truncate quoted email content, losing the [PIPELINE-FILE:] marker)
  const mapFile = path.join(__dirname, '.review-map.json');
  let reviewMap = {};
  try { reviewMap = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch (_) {}
  reviewMap[title] = filePath;
  fs.writeFileSync(mapFile, JSON.stringify(reviewMap, null, 2));

  console.log(`\nEmail sent: ${info.messageId}`);
  console.log(`To: ${REVIEW_EMAIL_TO}`);
  console.log(`Subject: [Blog Review] ${title}`);
  console.log(`Attachments: ${attachments.length} (${attachments.length - 1} images + 1 markdown)`);

  // Mark the Sheet row as in_review and clear any prior feedback so /autoblog-reviews
  // doesn't re-process this row on its next pass. Non-fatal if no topic row was found.
  if (topicId) {
    try {
      await setReviewStatus(topicId, 'in_review', '');
      console.log(`Sheet: ${topicId} → reviewStatus=in_review`);
    } catch (statusErr) {
      console.log(`  Note: failed to set reviewStatus on Sheet (${statusErr.message})`);
    }
  }
}

// CLI
const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: send-for-review.js <path-to-blog-post.md>');
  process.exit(1);
}

sendForReview(filePath).catch(err => {
  console.error('Failed to send review email:', err.message);
  process.exit(1);
});
