#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const ROOT = path.resolve(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'pipeline.config.json'), 'utf8'));

const {
  getQueueTopics,
  getCompletedKeywords,
  setLastResearchDate,
  appendTopicsToQueue,
} = require('./google-sheets');

const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;
const DATAFORSEO_BASE = 'https://api.dataforseo.com/v3';

const DRY_RUN = process.argv.includes('--dry-run');

if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
  console.error('Missing DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD in .env');
  process.exit(1);
}

function getAuthHeader() {
  return 'Basic ' + Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
}

async function apiCall(endpoint, body) {
  const response = await fetch(`${DATAFORSEO_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`DataForSEO API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.status_code !== 20000) {
    throw new Error(`DataForSEO error: ${data.status_message}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Seed gathering
// ---------------------------------------------------------------------------

function getStaticSeeds() {
  // Support both flat seedKeywords and structured seedPillars
  const pillars = config.site.seedPillars;
  if (pillars && typeof pillars === 'object' && !Array.isArray(pillars)) {
    const pillarArrays = Object.values(pillars).filter(arr => Array.isArray(arr) && arr.length > 0);
    if (pillarArrays.length === 0) return config.site.seedKeywords || [];

    // Round-robin across pillars so each pillar gets API calls early
    const result = [];
    const maxLen = Math.max(...pillarArrays.map(a => a.length));
    for (let i = 0; i < maxLen; i++) {
      for (const arr of pillarArrays) {
        if (i < arr.length) result.push(arr[i]);
      }
    }
    return result;
  }

  return config.site.seedKeywords || [];
}

function getSeedsFromCompleted(completedEntries) {
  // Extract short seed phrases from completed keywords
  const stopWords = new Set(['a','an','the','and','or','for','with','in','on','to','of','is','are',
    'was','were','how','what','why','when','where','which','your','our','this','that',
    'you','need','know','can','will','just','get','got','not','about','from','into','does']);
  return completedEntries
    .map(e => e.keyword)
    .filter(Boolean)
    .map(kw => {
      const words = kw.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
      if (words.length <= 4) return kw; // already short enough
      return words.slice(0, 3).join(' ');
    });
}

function getSeedsFromBlogFrontmatter() {
  const blogDir = path.resolve(ROOT, config.paths.blogDir);
  if (!fs.existsSync(blogDir)) return [];

  const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.md'));
  const stopWords = new Set(['a','an','the','and','or','for','with','in','on','to','of','is','are',
    'was','were','how','what','why','when','where','which','your','our','this','that',
    'you','need','know','can','will','just','get','got','more','most','best','not',
    'dont','wont','about','also','than','from','into','does','every','want','tell']);
  const keywords = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(blogDir, file), 'utf8');
      const { data } = matter(content);
      if (data.title) {
        // Extract the first 3 content words as a shorter seed phrase
        const words = data.title
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 2 && !stopWords.has(w));
        if (words.length >= 2) {
          keywords.push(words.slice(0, 3).join(' '));
        }
      }
    } catch {
      // skip files that fail to parse
    }
  }

  return keywords;
}

function gatherAllSeeds(completedEntries) {
  const dynamicConfig = config.research.dynamicSeeds || {};
  const staticSeeds = getStaticSeeds();

  let dynamicSeeds = [];

  if (dynamicConfig.enabled !== false) {
    if (dynamicConfig.fromCompleted !== false) {
      dynamicSeeds = dynamicSeeds.concat(getSeedsFromCompleted(completedEntries));
    }
    if (dynamicConfig.fromBlogFrontmatter !== false) {
      dynamicSeeds = dynamicSeeds.concat(getSeedsFromBlogFrontmatter());
    }
  }

  // Deduplicate all seeds (case-insensitive)
  const seen = new Set();
  const allSeeds = [];

  for (const seed of staticSeeds) {
    const key = seed.toLowerCase().trim();
    if (!seen.has(key) && key.length > 0) {
      seen.add(key);
      allSeeds.push(seed);
    }
  }

  const maxDynamic = dynamicConfig.maxDynamicSeeds || 15;
  let dynamicCount = 0;

  for (const seed of dynamicSeeds) {
    if (dynamicCount >= maxDynamic) break;
    const key = seed.toLowerCase().trim();
    if (!seen.has(key) && key.length > 0) {
      seen.add(key);
      allSeeds.push(seed);
      dynamicCount++;
    }
  }

  return allSeeds;
}

// ---------------------------------------------------------------------------
// Keyword fetching
// ---------------------------------------------------------------------------

async function getKeywordSuggestions(seedKeyword) {
  console.log(`  Fetching suggestions for: "${seedKeyword}"`);

  const data = await apiCall('/dataforseo_labs/google/keyword_suggestions/live', [{
    keyword: seedKeyword,
    location_code: config.research.locationCode,
    language_code: config.research.languageCode,
    include_seed_keyword: false,
    limit: config.research.suggestionsPerSeed
  }]);

  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000 || !task.result?.[0]?.items) {
    console.log(`    No results for "${seedKeyword}"`);
    return [];
  }

  const cost = task.cost || 0;
  console.log(`    Got ${task.result[0].items.length} suggestions (cost: $${cost.toFixed(4)})`);

  return task.result[0].items.map(item => ({
    keyword: item.keyword,
    searchVolume: item.keyword_info?.search_volume || 0,
    keywordDifficulty: item.keyword_properties?.keyword_difficulty || 0,
    cpc: item.keyword_info?.cpc || 0,
    competitionLevel: item.keyword_info?.competition_level || 'UNKNOWN',
    searchIntent: item.search_intent_info?.main_intent || 'informational',
    monthlySearches: item.keyword_info?.monthly_searches || []
  })).filter(k => k.keyword);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeTrendMomentum(monthlySearches) {
  if (!monthlySearches || monthlySearches.length < 4) return 1.0;

  // Compare average of last 3 months vs the overall average
  const sorted = [...monthlySearches].sort((a, b) => {
    const da = new Date(a.year, a.month - 1);
    const db = new Date(b.year, b.month - 1);
    return db - da;
  });

  const recent = sorted.slice(0, 3);
  const recentAvg = recent.reduce((sum, m) => sum + (m.search_volume || 0), 0) / recent.length;
  const overallAvg = sorted.reduce((sum, m) => sum + (m.search_volume || 0), 0) / sorted.length;

  if (overallAvg === 0) return 1.0;
  return recentAvg / overallAvg;
}

function roughStem(word) {
  // Minimal suffix stripping for relevance matching
  return word
    .replace(/(tion|sion|ment|ness|ence|ance|ings|able|ible|ful|less|ous|ive|ing|ers|ies|ion|ed|er|ly|es|s)$/, '')
    .replace(/(.)\1$/, '$1'); // collapse double letters left by stripping
}

function computeProductRelevance(keyword) {
  const kw = keyword.toLowerCase();
  const description = (config.site.productDescription || '').toLowerCase();
  const niche = (config.site.niche || '').toLowerCase();
  const features = (config.site.productFeatures || []).map(f => f.toLowerCase());

  // Extract meaningful words from product context (both raw and stemmed)
  const contextWords = new Set();
  const contextStems = new Set();
  const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'with', 'in', 'on', 'to', 'of', 'is', 'are', 'that', 'this', 'it', 'by', 'from', 'as', 'at', 'be', 'has', 'have', 'was', 'were', 'do', 'does', 'any', 'all', 'no', 'not', 'but', 'so', 'if', 'its', 'can', 'will', 'just', 'about', 'also', '100']);

  for (const text of [description, niche, ...features]) {
    for (const word of text.split(/\s+/)) {
      const clean = word.replace(/[^a-z]/g, '');
      if (clean.length > 2 && !stopWords.has(clean)) {
        contextWords.add(clean);
        const stem = roughStem(clean);
        if (stem.length > 2) contextStems.add(stem);
      }
    }
  }

  // Score: what fraction of keyword words match product context
  const kwWords = kw.split(/\s+/).map(w => w.replace(/[^a-z]/g, '')).filter(w => w.length > 2);
  if (kwWords.length === 0) return 0;

  let matches = 0;
  for (const word of kwWords) {
    if (contextWords.has(word)) {
      matches++;
    } else {
      const stem = roughStem(word);
      if (stem.length > 2 && contextStems.has(stem)) matches++;
    }
  }

  // Also check if any product feature phrase appears as a substring
  let phraseBonus = 0;
  for (const feature of features) {
    if (kw.includes(feature) || feature.includes(kw)) {
      phraseBonus = 0.3;
      break;
    }
  }

  return Math.min((matches / kwWords.length) + phraseBonus, 1.0);
}

function scoreKeyword(kw) {
  const scoring = config.research.scoring || {};
  const weights = {
    volumeDifficulty: scoring.volumeDifficultyWeight ?? 0.35,
    cpc: scoring.cpcWeight ?? 0.15,
    trend: scoring.trendMomentumWeight ?? 0.15,
    productRelevance: scoring.productRelevanceWeight ?? 0.20,
  };

  const intentBonuses = scoring.intentBonus || {
    commercial: 1.5,
    transactional: 1.3,
    informational: 1.0,
    navigational: 0.5
  };

  const competitionPenalties = scoring.competitionPenalty || {
    HIGH: 0.6,
    MEDIUM: 0.85,
    LOW: 1.0,
    UNKNOWN: 0.9
  };

  // Volume/difficulty ratio (log-scaled to avoid huge outliers)
  const volDiffRatio = Math.log1p(kw.searchVolume) / Math.max(Math.log1p(kw.keywordDifficulty), 0.1);

  // CPC as commercial value signal (log-scaled)
  const cpcSignal = Math.log1p(kw.cpc * 100);

  // Trend momentum
  const trend = computeTrendMomentum(kw.monthlySearches);

  // Product relevance
  const relevance = computeProductRelevance(kw.keyword);

  // Intent multiplier
  const intent = kw.searchIntent?.toLowerCase() || 'informational';
  const intentMultiplier = intentBonuses[intent] ?? 1.0;

  // Competition penalty
  const compPenalty = competitionPenalties[kw.competitionLevel] ?? 0.9;

  // Composite score
  const rawScore = (
    volDiffRatio * weights.volumeDifficulty +
    cpcSignal * weights.cpc +
    trend * weights.trend +
    relevance * weights.productRelevance
  );

  return rawScore * intentMultiplier * compPenalty;
}

// ---------------------------------------------------------------------------
// Keyword clustering
// ---------------------------------------------------------------------------

function getContentWords(keyword) {
  const stops = new Set(['a','an','the','and','or','for','with','in','on','to','of','is','are',
    'how','what','why','when','where','which','can','do','does','my','your','its',
    'this','that','be','have','has','was','were','will','would','should','could']);
  return new Set(
    keyword.toLowerCase().replace(/-/g, ' ').split(/\s+/)
      .map(w => w.replace(/[^a-z]/g, ''))
      .filter(w => w.length > 2 && !stops.has(w))
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const unionSize = new Set([...setA, ...setB]).size;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

function clusterKeywords(scoredKeywords, similarityThreshold) {
  const clusters = [];

  // Keywords arrive sorted by score descending, so the first keyword
  // in each cluster is always the highest-scoring (the representative).
  for (const kw of scoredKeywords) {
    const words = getContentWords(kw.keyword);
    let bestCluster = null;
    let bestSim = 0;

    for (const cluster of clusters) {
      const sim = jaccardSimilarity(words, cluster.words);
      if (sim > bestSim) {
        bestSim = sim;
        bestCluster = cluster;
      }
    }

    if (bestCluster && bestSim >= similarityThreshold) {
      bestCluster.keywords.push(kw);
    } else {
      clusters.push({
        representative: kw.keyword,
        words,
        keywords: [kw]
      });
    }
  }

  return clusters;
}

function selectDiverse(clusters, batchSize, maxPerCluster) {
  // Round-robin across clusters: take 1 from each cluster per round,
  // up to maxPerCluster per cluster, until batchSize is reached.
  const selected = [];
  let round = 0;

  while (selected.length < batchSize) {
    let addedThisRound = false;

    for (const cluster of clusters) {
      if (selected.length >= batchSize) break;
      if (round < cluster.keywords.length && round < maxPerCluster) {
        selected.push(cluster.keywords[round]);
        addedThisRound = true;
      }
    }

    if (!addedThisRound) break;
    round++;
  }

  return selected;
}

// ---------------------------------------------------------------------------
// SERP and topic generation
// ---------------------------------------------------------------------------

async function getSerpResults(keyword) {
  const data = await apiCall('/serp/google/organic/live/regular', [{
    keyword: keyword,
    location_code: config.research.locationCode,
    language_code: config.research.languageCode,
    depth: 5
  }]);

  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000 || !task.result?.[0]?.items) {
    return [];
  }

  return task.result[0].items
    .filter(item => item.type === 'organic')
    .slice(0, 5)
    .map(item => ({
      url: item.url,
      title: item.title,
      description: item.description
    }));
}

function generateTopicId(index) {
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  return `topic-${date}-${String(index + 1).padStart(2, '0')}`;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function generatePlaceholderTitle(keyword) {
  // Placeholder only — Claude Code generates the real title in Step 1.5
  return keyword.charAt(0).toUpperCase() + keyword.slice(1);
}

function inferSearchIntent(keyword) {
  const kw = keyword.toLowerCase();

  if (/\b(buy|price|cost|cheap|deal|discount|coupon|purchase|order)\b/.test(kw)) {
    return 'transactional';
  }
  if (/\b(best|top|review|compare|vs|alternative|recommend)\b/.test(kw)) {
    return 'commercial';
  }
  if (/\b(how|what|why|when|where|guide|tutorial|tips|learn|example)\b/.test(kw)) {
    return 'informational';
  }
  return 'informational';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log('=== SEO Keyword Research ===');
  console.log(`Site: ${config.site.domain}`);
  console.log(`Niche: ${config.site.niche}`);
  if (DRY_RUN) console.log('*** DRY RUN - will not write to Google Sheets ***');
  console.log('');

  // Load existing keywords to avoid duplicates
  const completedEntries = await getCompletedKeywords();
  const queueTopics = await getQueueTopics();

  const existingKeywords = new Set([
    ...completedEntries.map(k => k.keyword.toLowerCase()),
    ...queueTopics.map(t => t.keyword.toLowerCase())
  ]);

  console.log(`Existing keywords to exclude: ${existingKeywords.size}`);

  // Gather seeds (static + dynamic)
  const seeds = gatherAllSeeds(completedEntries);
  const staticCount = getStaticSeeds().length;
  const dynamicCount = seeds.length - staticCount;

  if (config.site.seedPillars) {
    console.log('\nSeed pillars:');
    for (const [name, pillarSeeds] of Object.entries(config.site.seedPillars)) {
      console.log(`  ${name}: ${pillarSeeds.join(', ')}`);
    }
  }

  console.log(`\nSeeds: ${seeds.length} total (${staticCount} static + ${dynamicCount} dynamic)`);
  seeds.forEach((s, i) => {
    const label = i < staticCount ? 'static' : 'dynamic';
    console.log(`  ${i + 1}. "${s}" [${label}]`);
  });
  console.log('');

  // Fetch suggestions for each seed
  let allSuggestions = [];
  let totalApiCost = 0;

  for (const seed of seeds) {
    try {
      const suggestions = await getKeywordSuggestions(seed);
      allSuggestions = allSuggestions.concat(suggestions);
    } catch (err) {
      console.error(`  Error fetching "${seed}": ${err.message}`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nTotal raw suggestions: ${allSuggestions.length}`);

  // Deduplicate
  const seen = new Set();
  const unique = allSuggestions.filter(s => {
    const key = s.keyword.toLowerCase();
    if (seen.has(key) || existingKeywords.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`After deduplication: ${unique.length}`);

  // Filter by thresholds
  const minRelevance = config.research.minProductRelevance ?? 0;
  const filtered = unique.filter(s => {
    if (s.searchVolume < config.research.minSearchVolume) return false;
    if (s.keywordDifficulty > config.research.maxKeywordDifficulty) return false;
    if (minRelevance > 0 && computeProductRelevance(s.keyword) < minRelevance) return false;
    return true;
  });

  console.log(`After filtering (vol >= ${config.research.minSearchVolume}, kd <= ${config.research.maxKeywordDifficulty}, rel >= ${minRelevance}): ${filtered.length}`);

  if (filtered.length === 0) {
    console.log('\nNo keywords passed filters. Try adjusting thresholds in pipeline.config.json.');
    process.exit(0);
  }

  // Score and rank
  const scored = filtered.map(kw => ({
    ...kw,
    score: scoreKeyword(kw),
    trendMomentum: computeTrendMomentum(kw.monthlySearches),
    productRelevance: computeProductRelevance(kw.keyword)
  }));

  scored.sort((a, b) => b.score - a.score);

  // Cluster similar keywords and select diversely
  const clusterConfig = config.research.clustering || {};
  const clusteringEnabled = clusterConfig.enabled !== false;
  let topKeywords;

  if (clusteringEnabled && scored.length > 0) {
    const threshold = clusterConfig.similarityThreshold ?? 0.4;
    const maxPerCluster = clusterConfig.maxPerCluster ?? 2;

    const clusters = clusterKeywords(scored, threshold);

    console.log(`\nClustered ${scored.length} keywords into ${clusters.length} topic groups (similarity >= ${threshold}):`);
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      console.log(`  [${i + 1}] "${c.representative}" (${c.keywords.length} keywords)`);
      c.keywords.slice(0, 5).forEach(k => console.log(`      - "${k.keyword}" (score: ${k.score.toFixed(2)})`));
      if (c.keywords.length > 5) console.log(`      ... and ${c.keywords.length - 5} more`);
    }

    topKeywords = selectDiverse(clusters, config.research.batchSize, maxPerCluster);
    console.log(`\nSelected ${topKeywords.length} diverse keywords (max ${maxPerCluster} per cluster):`);
  } else {
    topKeywords = scored.slice(0, config.research.batchSize);
    console.log(`\nTop ${topKeywords.length} keywords by composite score:`);
  }

  console.log('  #  Keyword                                 Vol   KD   CPC    Intent        Trend  Rel   Score');
  console.log('  ' + '-'.repeat(100));

  topKeywords.forEach((k, i) => {
    const num = String(i + 1).padStart(2);
    const kw = k.keyword.padEnd(40).slice(0, 40);
    const vol = String(k.searchVolume).padStart(5);
    const kd = String(k.keywordDifficulty).padStart(4);
    const cpc = ('$' + k.cpc.toFixed(2)).padStart(6);
    const intent = (k.searchIntent || 'info').padEnd(13);
    const trend = k.trendMomentum.toFixed(2).padStart(5);
    const rel = k.productRelevance.toFixed(2).padStart(5);
    const score = k.score.toFixed(2).padStart(7);
    console.log(`  ${num} ${kw} ${vol} ${kd} ${cpc} ${intent} ${trend} ${rel} ${score}`);
  });

  // Fetch SERP results
  console.log('\nFetching SERP data for competition analysis...');
  const topics = [];

  for (let i = 0; i < topKeywords.length; i++) {
    const kw = topKeywords[i];
    let referenceUrls = [];

    try {
      referenceUrls = await getSerpResults(kw.keyword);
      console.log(`  [${i + 1}/${topKeywords.length}] "${kw.keyword}" - ${referenceUrls.length} SERP results`);
    } catch (err) {
      console.error(`  [${i + 1}/${topKeywords.length}] SERP error for "${kw.keyword}": ${err.message}`);
    }

    topics.push({
      id: generateTopicId(i),
      keyword: kw.keyword,
      searchVolume: kw.searchVolume,
      keywordDifficulty: kw.keywordDifficulty,
      cpc: kw.cpc,
      competitionLevel: kw.competitionLevel,
      searchIntent: kw.searchIntent || inferSearchIntent(kw.keyword),
      suggestedTitle: generatePlaceholderTitle(kw.keyword),
      suggestedSlug: slugify(kw.keyword),
      contentAngle: `Target keyword: "${kw.keyword}" | Intent: ${kw.searchIntent || inferSearchIntent(kw.keyword)} | Trend: ${kw.trendMomentum.toFixed(2)}x | Product relevance: ${kw.productRelevance.toFixed(2)}`,
      referenceUrls: referenceUrls,
      status: 'pending',
      createdDate: new Date().toISOString(),
      completedDate: null,
      blogFile: null
    });

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  if (DRY_RUN) {
    console.log('\n=== DRY RUN RESULTS ===');
    for (const t of topics) {
      console.log(`\n  ${t.id}: "${t.keyword}"`);
      console.log(`    Title:  ${t.suggestedTitle}`);
      console.log(`    Slug:   ${t.suggestedSlug}`);
      console.log(`    Angle:  ${t.contentAngle}`);
      console.log(`    SERPs:  ${t.referenceUrls.length} competitors`);
      t.referenceUrls.forEach(r => console.log(`      - ${r.title}`));
    }
    console.log(`\n${topics.length} topics generated (not saved - dry run).`);
  } else {
    await setLastResearchDate(new Date().toISOString());
    await appendTopicsToQueue(topics);
    console.log(`\nResearch complete. ${topics.length} topics added to queue.`);
    console.log('Run `npm run pipeline:status` to see the full list.');
  }
}

run().catch(err => {
  console.error('Research failed:', err.message);
  process.exit(1);
});
