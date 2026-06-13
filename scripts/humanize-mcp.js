#!/usr/bin/env node

/**
 * humanize-mcp.js — split/restore helper for Walter humanization.
 *
 * Walter's per-call word limits (typically 50-2000 words per request) and
 * its tendency to strip markdown structure make chunking and post-cleanup
 * non-trivial. This script handles both deterministic halves of the work so
 * Claude only orchestrates the MCP calls themselves. Used in PIPELINE.md
 * Step 5.
 *
 * Two commands:
 *
 *   humanize-mcp.js prep <in.md> <prep.json>
 *     - Reads the markdown file, splits the body into 1-2 chunks (single
 *       chunk if ≤2000 words, else split at the H2 nearest the midpoint).
 *     - Extracts inline links, headings, and image lines so they can be
 *       restored verbatim after humanization (Walter rewrites or strips
 *       these).
 *     - Writes the side state (frontmatter + per-chunk extractions) to
 *       <prep.json>.
 *     - Prints `{ items: [{ id, text, entities }] }` to stdout for piping
 *       into the walter_humanize / walter_batch_humanize MCP tool.
 *
 *   humanize-mcp.js finalize <prep.json> <humanized.json> <out.md>
 *     - Reads humanized text per chunk id from <humanized.json>
 *       (shape: `{ items: [{ id, text }] }`).
 *     - Applies post-cleanup (preamble strip, VOICE_TWEAKS, BRAND_FIXES).
 *     - Restores headings, image lines, and inline links from the prep state.
 *     - Writes the rebuilt markdown to <out.md> with `humanized: true`
 *       added to the frontmatter.
 *
 * CUSTOMIZE for your site:
 *   - VOICE_TWEAKS: opinionated phrase rewrites — edit or remove based on
 *     your brand voice.
 *   - SITE_BRAND_FIXES: empty by default — add your product names, brand,
 *     and any competitors you reference so Walter doesn't lowercase them.
 *
 * The structural functions below (chunking, link/heading restore) are
 * generic and should not need editing.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// VOICE TWEAKS
// ---------------------------------------------------------------------------
// Opinionated rewrites of common AI-hedge phrases plus a few writing-style.md
// rules (no dashes, no semicolons). Order matters: phrase substitutions
// happen before the semicolon-to-period replacement, and the period-fix in
// applyCleanups re-capitalizes after either of those.
// ---------------------------------------------------------------------------
const VOICE_TWEAKS = [
  [/\s*[—–]\s*/g, ', '],          // writing-style.md: no em/en dashes
  [/\band\/or\b/gi, 'or'],
  [/\bwe have found\b/gi, 'reviewers report'],
  [/\bwe believe\b/gi, 'in practice'],
  [/\bwe feel\b/gi, 'in practice'],
  [/\bbased on our testing\b/gi, 'in practice'],
  [/;\s*/g, '. '],                 // writing-style.md: no semicolons
];

// ---------------------------------------------------------------------------
// BRAND FIXES
// ---------------------------------------------------------------------------
// Re-capitalize terms Walter tends to flatten to lowercase. GENERIC covers
// broadly useful tech terms; SITE is where you add your own brand, products,
// and competitors. The two are concatenated into BRAND_FIXES below.
// ---------------------------------------------------------------------------
const GENERIC_BRAND_FIXES = [
  // Operating systems
  [/\bmacos\b/gi, 'macOS'],
  [/\bwindows\b/g, 'Windows'],
  [/\blinux\b/g, 'Linux'],
  [/\bios\b(?!\w)/g, 'iOS'],
  // Compliance / standards
  [/\bgdpr\b/gi, 'GDPR'],
  [/\bhipaa\b/gi, 'HIPAA'],
  [/\bsoc\s*2\b/gi, 'SOC 2'],
  [/\bccpa\b/gi, 'CCPA'],
  // General tech acronyms
  [/\bapi(s)?\b/g, (_, s) => 'API' + (s || '')],
  [/\bai\b/g, 'AI'],
  [/\bcpu\b/gi, 'CPU'],
  [/\bgpu\b/gi, 'GPU'],
  [/\bram\b/g, 'RAM'],
  [/\busb-c\b/gi, 'USB-C'],
  [/\busb\b/gi, 'USB'],
  [/\bwifi\b/gi, 'WiFi'],
  [/\bbluetooth\b/gi, 'Bluetooth'],
  [/\burl(s)?\b/gi, (_, s) => 'URL' + (s || '')],
  // File formats
  [/\bmp4\b/gi, 'MP4'],
  [/\bmp3\b/gi, 'MP3'],
  [/\bm4a\b/gi, 'M4A'],
  [/\bwav\b/gi, 'WAV'],
  [/\bvtt\b/gi, 'VTT'],
  [/\bmov\b(?=\s+file|,|\.|$)/gi, 'MOV'],
  [/\bpdf\b/gi, 'PDF'],
  [/\bsrt\b/gi, 'SRT'],
  // Units
  [/(\d+)\s*gb\b/gi, '$1GB'],
  [/(\d+)\s*tb\b/gi, '$1TB'],
  [/(\d+)\s*mb\b/gi, '$1MB'],
];

// SITE-SPECIFIC — replace these examples with your own brand names, product
// names, and any competitors you reference. Each entry is
// `[/pattern/flags, 'Replacement']`. Use `\b` word boundaries to avoid
// partial-word matches (e.g. `\bzoom\b` won't match "zooming").
const SITE_BRAND_FIXES = [
  // [/\byourbrand\b/gi, 'YourBrand'],
  // [/\byourproduct\b/gi, 'YourProduct'],
  // [/\bcompetitorname\b/gi, 'CompetitorName'],
];

const BRAND_FIXES = [...GENERIC_BRAND_FIXES, ...SITE_BRAND_FIXES];

function applyCleanups(text) {
  let t = text;
  // Strip common LLM preambles that leak into Walter output
  t = t.replace(/^(?:I (?:am|will) (?:going to |)(?:make|apply|rewrite|humaniz)[^\n]*\n+)/i, '');
  t = t.replace(/^\d+(?:st|nd|rd|th) paragraph:\s*/gim, '');
  t = t.replace(/(^|\n)\s*(?:START_TEXT|END_TEXT|BEGIN_TEXT|FINAL_TEXT)\s+/gi, '$1');
  // Voice rewrites + dash/semicolon normalization
  for (const [re, repl] of VOICE_TWEAKS) t = t.replace(re, repl);
  // Strip leading punctuation/quote marks from lines (Walter chunking artifact)
  t = t.replace(/(^|\n+)\s*[–—:."”'’,]+\s*/g, '$1');
  // Re-capitalize after our semicolon→period replacement
  t = t.replace(/(\. )([a-z])/g, (_, p, c) => p + c.toUpperCase());
  // Brand/acronym restoration
  for (const [re, repl] of BRAND_FIXES) t = t.replace(re, repl);
  // Collapse runs of spaces
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t;
}

function wordCount(s) { return (s.match(/\S+/g) || []).length; }

function extractInlineLinks(text) {
  const links = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#{1,6}\s/.test(line)) continue;
    if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) continue;
    if (/^\s*\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)\s*$/.test(line)) continue;
    lines[i] = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, anchor, url) => {
      if (/^!\[/.test(anchor)) return m;
      links.push({ anchor, url });
      return anchor;
    });
  }
  return { text: lines.join('\n'), links };
}

function splitByH2(body) {
  const lines = body.split('\n');
  const sections = [];
  let current = [];
  for (const line of lines) {
    if (/^##\s/.test(line) && current.length) {
      sections.push(current.join('\n'));
      current = [line];
    } else current.push(line);
  }
  if (current.length) sections.push(current.join('\n'));
  return sections.filter((s) => s.trim().length > 0);
}

// 1 chunk if ≤2000 words, else split at H2 nearest midpoint.
// Do NOT chunk per-H2: triggers Walter's 50-word minimum + rate limits.
function chunkBody(body) {
  const total = wordCount(body);
  if (total <= 2000) return [body];
  const sections = splitByH2(body);
  if (sections.length < 2) return [body];
  const target = total / 2;
  let bestIdx = 1, bestDelta = Infinity, running = 0;
  for (let i = 0; i < sections.length - 1; i++) {
    running += wordCount(sections[i]);
    const delta = Math.abs(running - target);
    if (delta < bestDelta) { bestDelta = delta; bestIdx = i + 1; }
  }
  return [sections.slice(0, bestIdx).join('\n\n'), sections.slice(bestIdx).join('\n\n')];
}

function extractHeadings(text) {
  const headings = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\s*)(#{1,6})\s+(.+?)\s*$/);
    if (m) headings.push({ indent: m[1], level: m[2], text: m[3] });
  }
  return headings;
}

function extractImageLines(text) {
  const images = [];
  for (const line of text.split('\n')) {
    if (/^\s*\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)\s*$/.test(line) ||
        /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) images.push(line);
  }
  return images;
}

function restoreImageLines(humanized, originals) {
  if (originals.length === 0) return humanized;
  const lines = humanized.split('\n');
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (idx >= originals.length) break;
    const isImg = /^\s*\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)\s*$/.test(lines[i]) ||
                  /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(lines[i]);
    if (isImg) lines[i] = originals[idx++];
  }
  return lines.join('\n');
}

// If Walter stripped `#` markers entirely, reattach `##` to ALL-CAPS bare lines.
function reattachHeadingMarkers(humanized, originalCount) {
  if (originalCount === 0) return humanized;
  const lines = humanized.split('\n');
  let found = lines.filter((l) => /^\s*#{1,6}\s+\S/.test(l)).length;
  if (found >= originalCount) return humanized;
  for (let i = 0; i < lines.length && found < originalCount; i++) {
    const line = lines[i].trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;
    if (line.split(/\s+/).length > 12 || /[.!?,]$/.test(line)) continue;
    const letters = line.replace(/[^A-Za-z]/g, '');
    if (letters.length < 3) continue;
    const upper = letters.replace(/[^A-Z]/g, '').length;
    if (upper / letters.length < 0.7) continue;
    lines[i] = `## ${line}`;
    found++;
  }
  return lines.join('\n');
}

function restoreHeadings(humanized, originals) {
  const pre = reattachHeadingMarkers(humanized, originals.length);
  let lines = pre.split('\n');
  let surviving = lines.filter((l) => /^\s*#{1,6}\s/.test(l)).length;
  if (surviving < originals.length) {
    const missingCount = originals.length - surviving;
    const prepend = originals.slice(0, missingCount).map((o) => `${o.indent}${o.level} ${o.text}`);
    lines = [...prepend, '', ...lines];
  }
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    if (idx >= originals.length) break;
    const orig = originals[idx++];
    lines[i] = `${orig.indent}${orig.level} ${orig.text}`;
  }
  return { text: lines.join('\n'), restored: idx, expected: originals.length };
}

// Mask links / image lines / heading lines with NUL bytes (not spaces) so the
// `\s*` patterns in fuzzyAnchorRe can't match across a masked region. NUL is
// chosen because it's not whitespace and not a valid markdown character, so
// anchor-finding regexes are guaranteed to fail to match inside masked spans.
function withoutMdLinks(t) {
  let s = t.replace(/!\[[^\]]*\]\([^)]+\)/g, (m) => ' '.repeat(m.length));
  s = s.replace(/\[[^\]]+\]\([^)]+\)/g, (m) => ' '.repeat(m.length));
  s = s.replace(/^.*#{1,6}\s.*$/gm, (m) => ' '.repeat(m.length));
  return s;
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fuzzyAnchorRe(anchor) {
  const parts = anchor.split(/(\s+)/).map((p) => /\s+/.test(p) ? '\\s*' : escRe(p));
  return new RegExp(parts.join(''), 'gi');
}

function restoreLinks(humanized, links) {
  let t = humanized;
  const unresolved = [];
  const consumed = new Map();
  function findMatch(re, skip) {
    const safe = withoutMdLinks(t);
    let m, i = 0;
    while ((m = re.exec(safe)) !== null) {
      if (i === skip) return { index: m.index, length: m[0].length };
      i++;
    }
    return null;
  }
  for (const { anchor, url } of links) {
    const key = anchor.toLowerCase();
    const skip = consumed.get(key) || 0;
    let hit = findMatch(new RegExp(escRe(anchor), 'gi'), skip);
    if (!hit) hit = findMatch(fuzzyAnchorRe(anchor), skip);
    if (hit) {
      t = t.slice(0, hit.index) + `[${anchor}](${url})` + t.slice(hit.index + hit.length);
      consumed.set(key, skip + 1);
    } else unresolved.push({ anchor, url });
  }
  return { text: t, unresolved };
}

function prep(inPath, outPath) {
  const raw = fs.readFileSync(path.resolve(inPath), 'utf8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) { process.stderr.write('no frontmatter\n'); process.exit(2); }
  const frontmatter = fmMatch[0];
  const body = raw.slice(frontmatter.length);
  const pieces = chunkBody(body);
  const chunks = pieces.map((sec, i) => {
    const { text: cleaned, links } = extractInlineLinks(sec);
    const headings = extractHeadings(cleaned);
    const images = extractImageLines(cleaned);
    const entities = Array.from(new Set(links.map((l) => l.anchor))).slice(0, 100);
    return { id: `c${i}`, text: cleaned, links, headings, images, entities };
  });
  fs.writeFileSync(path.resolve(outPath), JSON.stringify({ frontmatter, chunks }, null, 2));
  process.stderr.write(`[prep] ${chunks.length} chunk(s) -> ${outPath}\n`);
  for (const c of chunks) {
    const w = wordCount(c.text);
    const flag = w < 50 ? ' [FAIL 50-word min]' : w > 2000 ? ' [FAIL 2000-word max]' : '';
    process.stderr.write(`  ${c.id}: ${w} words, ${c.links.length} links, ${c.headings.length} headings${flag}\n`);
  }
  const items = chunks.map((c) => ({ id: c.id, text: c.text, entities: c.entities }));
  process.stdout.write(JSON.stringify({ items }, null, 2) + '\n');
}

function finalize(prepPath, humanPath, outPath) {
  const prepped = JSON.parse(fs.readFileSync(path.resolve(prepPath), 'utf8'));
  const human = JSON.parse(fs.readFileSync(path.resolve(humanPath), 'utf8'));
  if (!Array.isArray(human.items)) { process.stderr.write('humanized.json needs { items: [{ id, text }] }\n'); process.exit(2); }
  const byId = Object.fromEntries(human.items.map((it) => [it.id, it.text]));
  const allUnresolved = [];
  const outChunks = prepped.chunks.map((c) => {
    const humanText = byId[c.id];
    if (typeof humanText !== 'string') {
      const { text } = restoreLinks(c.text, c.links || []);
      return text;
    }
    const cleaned = applyCleanups(humanText);
    const withImages = restoreImageLines(cleaned, c.images || []);
    const { text: withHeadings } = restoreHeadings(withImages, c.headings || []);
    const { text, unresolved } = restoreLinks(withHeadings, c.links || []);
    if (unresolved.length) allUnresolved.push({ id: c.id, links: unresolved });
    return text;
  });
  let newBody = outChunks.join('\n\n').replace(/\n{3,}/g, '\n\n');
  if (!newBody.endsWith('\n')) newBody += '\n';
  let newFm = prepped.frontmatter;
  newFm = /^humanized:\s*.*$/m.test(newFm)
    ? newFm.replace(/^humanized:\s*.*$/m, 'humanized: true')
    : newFm.replace(/\n---\n$/, '\nhumanized: true\n---\n');
  fs.writeFileSync(path.resolve(outPath), newFm + newBody);
  process.stderr.write(`[finalize] wrote ${outPath} — unresolved_links=${allUnresolved.reduce((a, u) => a + u.links.length, 0)}\n`);
  for (const u of allUnresolved) for (const l of u.links) process.stderr.write(`  [${u.id}] [${l.anchor}](${l.url})\n`);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'prep' && rest.length === 2) prep(rest[0], rest[1]);
else if (cmd === 'finalize' && rest.length === 3) finalize(rest[0], rest[1], rest[2]);
else {
  process.stderr.write('usage:\n  humanize-mcp.js prep <in.md> <prep.json>\n  humanize-mcp.js finalize <prep.json> <humanized.json> <out.md>\n');
  process.exit(2);
}
