#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const ROOT = path.resolve(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'pipeline.config.json'), 'utf8'));

const BLOG_DIR = path.join(ROOT, config.paths.blogDir);

const {
  getQueueTopics,
  getLastResearchDate,
  getCompletedKeywords,
  updateTopicInQueue,
  removeTopicFromQueue,
  appendToCompleted,
  ensureHeaders,
  getPendingReviews,
} = require('./google-sheets');

async function status() {
  const topics = await getQueueTopics();
  const completedEntries = await getCompletedKeywords();
  const lastResearchDate = await getLastResearchDate();

  const pending = topics.filter(t => t.status === 'pending');
  const inProgress = topics.filter(t => t.status === 'in_progress');

  console.log('=== Pipeline Status ===');
  console.log(`Pending topics:     ${pending.length}`);
  console.log(`In progress:        ${inProgress.length}`);
  console.log(`Completed all-time: ${completedEntries.length}`);

  if (lastResearchDate) {
    console.log(`Last research:      ${lastResearchDate}`);
  }

  if (pending.length > 0) {
    console.log('\n--- Pending Topics ---');
    pending.forEach((t, i) => {
      const vol = t.searchVolume ? `vol:${t.searchVolume}` : '';
      const diff = t.keywordDifficulty ? `kd:${t.keywordDifficulty}` : '';
      console.log(`  ${i + 1}. [${t.id}] "${t.keyword}" ${vol} ${diff}`);
    });
  }

  if (inProgress.length > 0) {
    console.log('\n--- In Progress ---');
    inProgress.forEach(t => {
      console.log(`  [${t.id}] "${t.keyword}" → ${t.blogFile || 'no file yet'}`);
    });
  }
}

async function next() {
  const topics = await getQueueTopics();
  const pending = topics.filter(t => t.status === 'pending');

  if (pending.length === 0) {
    console.log('NO_PENDING_TOPICS');
    console.log('Run `npm run pipeline:research` to generate a fresh batch.');
    process.exit(0);
  }

  const topic = pending[0];

  await updateTopicInQueue(topic.id, { status: 'in_progress' });

  console.log('=== Next Topic ===');
  console.log(JSON.stringify(topic, null, 2));
}

async function complete(topicId) {
  if (!topicId) {
    console.error('Usage: queue-manager.js complete <topic-id> [blog-file-path]');
    process.exit(1);
  }

  const blogFile = process.argv[4] || null;
  const topics = await getQueueTopics();

  const topic = topics.find(t => t.id === topicId);
  if (!topic) {
    console.error(`Topic "${topicId}" not found in queue.`);
    process.exit(1);
  }

  await appendToCompleted({
    keyword: topic.keyword,
    blogFile: blogFile || topic.blogFile,
    completedDate: new Date().toISOString(),
    searchVolume: topic.searchVolume || null,
    keywordDifficulty: topic.keywordDifficulty || null,
    source: 'pipeline',
  });

  await removeTopicFromQueue(topicId);

  const remaining = topics.filter(t => t.id !== topicId && t.status === 'pending');
  console.log(`Completed: "${topic.keyword}"`);
  console.log(`Queue remaining: ${remaining.length} pending`);
}

async function update(topicId) {
  if (!topicId) {
    console.error('Usage: queue-manager.js update <topic-id> --title "..." --angle "..." --slug "..."');
    process.exit(1);
  }

  const args = process.argv.slice(4);
  const updates = {};
  const flagMap = {
    '--title': 'suggestedTitle',
    '--angle': 'contentAngle',
    '--slug': 'suggestedSlug',
  };

  for (let i = 0; i < args.length; i++) {
    const field = flagMap[args[i]];
    if (field && i + 1 < args.length) {
      updates[field] = args[i + 1];
      i++;
    }
  }

  if (Object.keys(updates).length === 0) {
    console.error('No updates provided. Use --title, --angle, or --slug flags.');
    process.exit(1);
  }

  await updateTopicInQueue(topicId, updates);

  console.log(`Updated topic "${topicId}":`);
  for (const [key, val] of Object.entries(updates)) {
    console.log(`  ${key}: ${val}`);
  }
}

async function reviews() {
  const pending = await getPendingReviews();

  if (pending.length === 0) {
    console.log('NO_PENDING_REVIEWS');
    return;
  }

  // Project a stable shape — the slash command parses this JSON.
  const out = pending.map(t => ({
    id: t.id,
    keyword: t.keyword,
    suggestedTitle: t.suggestedTitle,
    blogFile: t.blogFile,
    reviewStatus: t.reviewStatus,
    reviewFeedback: t.reviewFeedback || '',
  }));

  console.log(JSON.stringify(out, null, 2));
}

async function init() {
  await ensureHeaders();
  const completedEntries = await getCompletedKeywords();
  const existingKeywords = new Set(completedEntries.map(k => k.keyword.toLowerCase()));

  const blogFiles = fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));
  let added = 0;

  for (const file of blogFiles) {
    const filepath = path.join(BLOG_DIR, file);
    const content = fs.readFileSync(filepath, 'utf8');
    const { data: frontmatter } = matter(content);

    const keyword = (frontmatter.title || file.replace('.md', ''))
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim();

    if (!existingKeywords.has(keyword)) {
      await appendToCompleted({
        keyword: keyword,
        blogFile: path.join(config.paths.blogDir, file),
        completedDate: frontmatter.date ? new Date(frontmatter.date).toISOString() : new Date().toISOString(),
        searchVolume: null,
        keywordDifficulty: null,
        source: 'init',
      });
      existingKeywords.add(keyword);
      added++;
      console.log(`  Added: "${keyword}" (${file})`);
    }
  }

  console.log(`\nInitialized: ${added} new entries added. Total: ${completedEntries.length + added}`);
}

// CLI routing
const command = process.argv[2];
const arg = process.argv[3];

async function main() {
  switch (command) {
    case 'status':
      await status();
      break;
    case 'next':
      await next();
      break;
    case 'complete':
      await complete(arg);
      break;
    case 'update':
      await update(arg);
      break;
    case 'init':
      await init();
      break;
    case 'reviews':
      await reviews();
      break;
    case 'ensure-headers':
      await ensureHeaders();
      break;
    default:
      console.log('Usage: queue-manager.js <status|next|complete|update|init|reviews|ensure-headers> [args]');
      console.log('');
      console.log('Commands:');
      console.log('  status              Show queue status and pending topics');
      console.log('  next                Get next pending topic (marks as in_progress)');
      console.log('  complete <id> [f]   Mark topic as complete, optionally with blog file path');
      console.log('  update <id> [flags] Update topic fields (--title, --angle, --slug)');
      console.log('  init                Seed completed list from existing blog posts');
      console.log('  reviews             Print JSON of rows awaiting publish or revision');
      console.log('  ensure-headers      Initialize Google Sheet header rows');
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
