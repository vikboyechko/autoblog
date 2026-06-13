#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'pipeline.config.json'), 'utf8'));

const BLOG_DIR = path.join(ROOT, config.paths.blogDir);

const {
  getQueueTopics,
  updateTopicInQueue,
} = require('./google-sheets');

async function run() {
  const topics = await getQueueTopics();
  const inProgress = topics.filter(t => t.status === 'in_progress');

  if (inProgress.length === 0) {
    console.error('No in-progress topic found. Run `npm run pipeline:next` first.');
    process.exit(1);
  }

  const topic = inProgress[0];
  const slug = topic.suggestedSlug || topic.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const filename = `${slug}.md`;
  const filepath = path.join(BLOG_DIR, filename);

  if (fs.existsSync(filepath)) {
    console.log(`File already exists: ${filepath}`);
    console.log(`Topic ID: ${topic.id}`);
    process.exit(0);
  }

  const now = new Date().toISOString();
  const imageSlug = slug;

  // Build reference URLs comment block
  let refsBlock = '';
  if (topic.referenceUrls && topic.referenceUrls.length > 0) {
    const refs = topic.referenceUrls.map(r => `<!-- - ${r.title || r.url}: ${r.url} -->`).join('\n');
    refsBlock = `\n${refs}`;
  }

  const content = `---
title: "${topic.suggestedTitle.replace(/"/g, '\\"')}"
url: ${slug}
description: >-
  REPLACE_WITH_META_DESCRIPTION
date: ${now}
tags:
  - post
image: /assets/images/blog/${imageSlug}-4.jpg
imageAlt: ${topic.keyword}
---

<!-- PIPELINE BRIEF - Replace this entire comment block with your article -->
<!-- Keyword: ${topic.keyword} -->
<!-- Search Volume: ${topic.searchVolume} | Difficulty: ${topic.keywordDifficulty} -->
<!-- Intent: ${topic.searchIntent} -->
<!-- Content Angle: ${topic.contentAngle} -->${refsBlock}
<!-- END BRIEF -->
`;

  fs.writeFileSync(filepath, content);

  // Update queue with blog file path
  await updateTopicInQueue(topic.id, { blogFile: path.join(config.paths.blogDir, filename) });

  console.log(`Created: ${filepath}`);
  console.log(`Topic ID: ${topic.id}`);
  console.log(`Keyword: ${topic.keyword}`);
  console.log(`Suggested Title: ${topic.suggestedTitle}`);
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
