#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'pipeline.config.json'), 'utf8'));

const filepath = process.argv[2];
if (!filepath) {
  console.error('Usage: quality-check.js <blog-post-file>');
  process.exit(1);
}

const fullPath = path.isAbsolute(filepath) ? filepath : path.join(ROOT, filepath);
if (!fs.existsSync(fullPath)) {
  console.error(`File not found: ${fullPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(fullPath, 'utf8');
const { data: frontmatter, content } = matter(raw);

// Strip HTML comments from content for analysis
const cleanContent = content.replace(/<!--[\s\S]*?-->/g, '').trim();

const results = {
  file: filepath,
  passed: true,
  checks: {}
};

function check(category, name, pass, detail) {
  if (!results.checks[category]) results.checks[category] = [];
  results.checks[category].push({ name, pass, detail });
  if (!pass) results.passed = false;
}

// === SEO Checks ===

// Word count
const words = cleanContent.split(/\s+/).filter(w => w.length > 0);
const wordCount = words.length;
const wcMin = config.seo.targetWordCount.min;
const wcMax = config.seo.targetWordCount.max;
check('seo', 'Word count', wordCount >= wcMin && wordCount <= wcMax,
  `${wordCount} words (target: ${wcMin}-${wcMax})`);

// Frontmatter fields
const requiredFields = ['title', 'url', 'description', 'date', 'tags'];
for (const field of requiredFields) {
  const hasField = frontmatter[field] !== undefined && frontmatter[field] !== null;
  check('seo', `Frontmatter: ${field}`, hasField,
    hasField ? 'present' : 'MISSING');
}

// Meta description length
const desc = frontmatter.description || '';
const descClean = desc.replace(/\s+/g, ' ').trim();
const descLen = descClean.length;
check('seo', 'Meta description length', descLen >= 120 && descLen <= 160,
  `${descLen} chars (target: 120-160)`);

// H2 headings count
const h2Matches = cleanContent.match(/^## .+$/gm) || [];
const h2Count = h2Matches.length;
check('seo', 'H2 headings count', h2Count >= config.seo.minH2Headings && h2Count <= config.seo.maxH2Headings,
  `${h2Count} H2s (target: ${config.seo.minH2Headings}-${config.seo.maxH2Headings})`);

// H3 headings (at least some)
const h3Matches = cleanContent.match(/^### .+$/gm) || [];
check('seo', 'H3 headings present', h3Matches.length >= 2,
  `${h3Matches.length} H3s (minimum: 2)`);

// Internal links
const internalLinks = cleanContent.match(/(?<!!)\[([^\]]+)\]\(\/[^)]+\)/g) || [];
check('seo', 'Internal links', internalLinks.length >= config.seo.minInternalLinks && internalLinks.length <= config.seo.maxInternalLinks,
  `${internalLinks.length} internal links (target: ${config.seo.minInternalLinks}-${config.seo.maxInternalLinks})`);

// External links
const externalLinks = cleanContent.match(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g) || [];
check('seo', 'External links', externalLinks.length >= config.seo.minExternalLinks && externalLinks.length <= config.seo.maxExternalLinks,
  `${externalLinks.length} external links (target: ${config.seo.minExternalLinks}-${config.seo.maxExternalLinks})`);

// FAQ section
const hasFaq = /^##+ .*(FAQ|Frequently Asked|Common Questions)/im.test(cleanContent);
check('seo', 'FAQ section', hasFaq,
  hasFaq ? 'found' : 'MISSING - add FAQ section with 5-6 questions');

// Keyword in title (use filename-derived keyword as fallback)
const slug = path.basename(fullPath, '.md');
const keywordFromSlug = slug.replace(/-/g, ' ');
// Check if title contains any significant words from the slug
const slugWords = keywordFromSlug.split(' ').filter(w => w.length > 3);
const titleLower = (frontmatter.title || '').toLowerCase();
const keywordInTitle = slugWords.some(w => titleLower.includes(w));
check('seo', 'Keyword relevance in title', keywordInTitle,
  keywordInTitle ? 'keyword words found in title' : `title may not target keyword "${keywordFromSlug}"`);

// === Style Checks ===

// No semicolons
const semicolons = (cleanContent.match(/;/g) || []).length;
check('style', 'No semicolons', semicolons === 0,
  semicolons === 0 ? 'none found' : `${semicolons} semicolons found`);

// No emojis
const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
const emojis = cleanContent.match(emojiRegex) || [];
check('style', 'No emojis', emojis.length === 0,
  emojis.length === 0 ? 'none found' : `${emojis.length} emojis found`);

// No hashtags (but allow heading markers)
const hashtags = cleanContent.match(/(?<!\n)#[a-zA-Z]\w+/g) || [];
check('style', 'No hashtags', hashtags.length === 0,
  hashtags.length === 0 ? 'none found' : `found: ${hashtags.join(', ')}`);

// No excessive caps (words > 3 chars that are ALL CAPS, excluding common acronyms)
const commonAcronyms = new Set(['HTML', 'CSS', 'JSON', 'API', 'HTTPS', 'HTTP', 'REST', 'CORS',
  'SQL', 'GDPR', 'HIPAA', 'FERPA', 'CCPA', 'GGUF', 'SERP', 'CAPTCHA', 'SAML', 'SSO', 'OAuth',
  'YAML', 'TOML', 'UUID', 'URL', 'URI', 'DNS', 'FAQ', 'PDF', 'JPEG', 'WEBP', 'HEIC',
  'FLAC', 'ALAC', 'AIFF', 'MIDI', 'MPEG', 'ZOOM', 'VOIP', 'RTMP', 'WEBRTC']);
const capsWords = (cleanContent.match(/\b[A-Z]{4,}\b/g) || [])
  .filter(w => !commonAcronyms.has(w));
check('style', 'No excessive capitalization', capsWords.length === 0,
  capsWords.length === 0 ? 'none found' : `all-caps words: ${capsWords.slice(0, 5).join(', ')}${capsWords.length > 5 ? '...' : ''}`);

// Common filler phrases
const fillerPhrases = [
  "in today's world",
  "it's worth noting",
  "at the end of the day",
  "it goes without saying",
  "needless to say",
  "in this day and age",
  "as we all know",
  "the fact of the matter",
  "when all is said and done",
  "to be perfectly honest",
  "cutting-edge",
  "game-changer",
  "revolutionary",
  "groundbreaking",
  "unparalleled",
  "best-in-class",
  "synergy",
  "leverage",
  "paradigm shift",
  "move the needle",
  "deep dive",
  "circle back",
  "low-hanging fruit"
];
const contentLower = cleanContent.toLowerCase();
const foundFillers = fillerPhrases.filter(p => contentLower.includes(p));
check('style', 'No filler phrases', foundFillers.length === 0,
  foundFillers.length === 0 ? 'none found' : `found: "${foundFillers.join('", "')}"`);

// Placeholder content check
const hasPlaceholder = /REPLACE_WITH|TODO|PLACEHOLDER|Lorem ipsum/i.test(cleanContent) ||
  /REPLACE_WITH|TODO|PLACEHOLDER/i.test(frontmatter.description || '');
check('style', 'No placeholder content', !hasPlaceholder,
  hasPlaceholder ? 'FOUND placeholder text - replace before publishing' : 'none found');

// === Build Check ===
let buildPass = false;
let buildDetail = '';
try {
  execSync('npx @11ty/eleventy --dryrun', {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 30000
  });
  buildPass = true;
  buildDetail = 'Eleventy dry-run succeeded';
} catch (err) {
  buildDetail = `Eleventy dry-run FAILED: ${err.stderr?.toString().slice(0, 200) || err.message}`;
}
check('build', 'Eleventy build', buildPass, buildDetail);

// === Output ===
console.log('=== Quality Check Report ===');
console.log(`File: ${filepath}`);
console.log(`Overall: ${results.passed ? 'PASSED' : 'FAILED'}`);
console.log('');

for (const [category, checks] of Object.entries(results.checks)) {
  console.log(`--- ${category.toUpperCase()} ---`);
  for (const c of checks) {
    const icon = c.pass ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.detail}`);
  }
  console.log('');
}

// Output JSON for programmatic use
console.log('--- JSON ---');
console.log(JSON.stringify(results, null, 2));

process.exit(results.passed ? 0 : 1);
