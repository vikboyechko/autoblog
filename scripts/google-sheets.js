#!/usr/bin/env node

const { google } = require('googleapis');
const path = require('path');

const QUEUE_HEADERS = [
  'id', 'keyword', 'searchVolume', 'keywordDifficulty', 'cpc',
  'competitionLevel', 'searchIntent', 'suggestedTitle', 'suggestedSlug',
  'contentAngle', 'referenceUrls', 'status', 'createdDate', 'completedDate', 'blogFile',
  'reviewStatus', 'reviewFeedback'
];

// reviewStatus values: '' | 'in_review' | 'approved' | 'changes_requested' | 'published'
const REVIEW_STATUSES = ['in_review', 'approved', 'changes_requested', 'published'];

const COMPLETED_HEADERS = [
  'keyword', 'blogFile', 'completedDate', 'searchVolume', 'keywordDifficulty', 'source'
];

const NUMBER_FIELDS = new Set(['searchVolume', 'keywordDifficulty', 'cpc']);
const JSON_FIELDS = new Set(['referenceUrls']);

let sheetsClient = null;

function getSheetId() {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID not set in .env');
  return id;
}

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFilePath) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE not set in .env');
  }

  const resolvedKeyPath = path.isAbsolute(keyFilePath)
    ? keyFilePath
    : path.resolve(__dirname, '..', '..', keyFilePath);

  const auth = new google.auth.GoogleAuth({
    keyFile: resolvedKeyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function parseRow(headers, row) {
  const obj = {};
  headers.forEach((h, i) => {
    let val = row[i] !== undefined ? row[i] : null;
    if (val === '') val = null;
    if (NUMBER_FIELDS.has(h) && val !== null) {
      val = Number(val);
    }
    if (JSON_FIELDS.has(h) && val) {
      try { val = JSON.parse(val); } catch { val = []; }
    }
    obj[h] = val;
  });
  return obj;
}

function topicToRow(topic) {
  return QUEUE_HEADERS.map(h => {
    const val = topic[h];
    if (JSON_FIELDS.has(h)) return JSON.stringify(val || []);
    return val !== undefined && val !== null ? String(val) : '';
  });
}

function completedToRow(entry) {
  return COMPLETED_HEADERS.map(h => {
    const val = entry[h];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

// Column index to letter (0 = A, 25 = Z)
function colLetter(index) {
  return String.fromCharCode(65 + index);
}

// --- Queue Operations ---

async function getQueueTopics() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: 'Queue!A1:Q',
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];

  // Key columns off the canonical QUEUE_HEADERS, not the sheet's live header
  // row. Writes already address columns by QUEUE_HEADERS position
  // (updateTopicInQueue), so reads must use the same mapping. Trusting rows[0]
  // means a stale/drifted header row — e.g. a sheet created before the
  // reviewStatus/reviewFeedback columns existed — silently misreads those
  // columns and review replies never surface in /autoblog-reviews. The read
  // range above (A1:Q = 17 cols) maps 1:1 onto the 17 entries of
  // QUEUE_HEADERS. Run `queue-manager.js ensure-headers` to repair the
  // visible header labels in the sheet itself.
  return rows.slice(1).map(row => parseRow(QUEUE_HEADERS, row));
}

async function getLastResearchDate() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: 'Queue!S2',
  });
  return res.data.values?.[0]?.[0] || null;
}

async function setLastResearchDate(dateStr) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSheetId(),
    range: 'Queue!S2',
    valueInputOption: 'RAW',
    requestBody: { values: [[dateStr]] },
  });
}

async function appendTopicsToQueue(topics) {
  const sheets = await getSheetsClient();
  const rows = topics.map(t => topicToRow(t));

  await sheets.spreadsheets.values.append({
    spreadsheetId: getSheetId(),
    range: 'Queue!A1',
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

async function updateTopicInQueue(topicId, updates) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: 'Queue!A:A',
  });
  const ids = (res.data.values || []).map(r => r[0]);
  const rowIndex = ids.indexOf(topicId);
  if (rowIndex === -1) throw new Error(`Topic "${topicId}" not found in Queue sheet`);

  const rowNum = rowIndex + 1; // 1-based

  for (const [key, value] of Object.entries(updates)) {
    const colIndex = QUEUE_HEADERS.indexOf(key);
    if (colIndex === -1) continue;
    const letter = colLetter(colIndex);
    const cellVal = JSON_FIELDS.has(key) ? JSON.stringify(value) : String(value ?? '');

    await sheets.spreadsheets.values.update({
      spreadsheetId: getSheetId(),
      range: `Queue!${letter}${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[cellVal]] },
    });
  }
}

// --- Review Operations ---

async function setReviewStatus(topicId, status, feedback = null) {
  if (!REVIEW_STATUSES.includes(status)) {
    throw new Error(`Invalid review status "${status}". Expected one of: ${REVIEW_STATUSES.join(', ')}`);
  }
  const updates = { reviewStatus: status };
  // Only overwrite feedback when explicitly provided; pass '' to clear.
  if (feedback !== null) updates.reviewFeedback = feedback;
  await updateTopicInQueue(topicId, updates);
}

async function getPendingReviews() {
  const topics = await getQueueTopics();
  return topics.filter(t => t.reviewStatus === 'approved' || t.reviewStatus === 'changes_requested');
}

async function getTopicByBlogFile(blogFile) {
  if (!blogFile) return null;
  const topics = await getQueueTopics();
  // Match by exact blogFile, or by basename as a fallback (handles path-format drift)
  const exact = topics.find(t => t.blogFile === blogFile);
  if (exact) return exact;
  const base = blogFile.split('/').pop();
  return topics.find(t => t.blogFile && t.blogFile.split('/').pop() === base) || null;
}

async function removeTopicFromQueue(topicId) {
  const sheets = await getSheetsClient();

  // Find the row
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: 'Queue!A:A',
  });
  const ids = (res.data.values || []).map(r => r[0]);
  const rowIndex = ids.indexOf(topicId);
  if (rowIndex === -1) throw new Error(`Topic "${topicId}" not found in Queue sheet`);

  // Get the Queue tab's sheetId
  const sheetMeta = await sheets.spreadsheets.get({
    spreadsheetId: getSheetId(),
    fields: 'sheets.properties',
  });
  const queueSheet = sheetMeta.data.sheets.find(s => s.properties.title === 'Queue');
  if (!queueSheet) throw new Error('Queue sheet tab not found');

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: queueSheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          }
        }
      }]
    }
  });
}

// --- Completed Operations ---

async function getCompletedKeywords() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: 'Completed!A1:F',
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];

  const headers = rows[0];
  return rows.slice(1).map(row => parseRow(headers, row));
}

async function appendToCompleted(entry) {
  const sheets = await getSheetsClient();
  const row = completedToRow(entry);

  await sheets.spreadsheets.values.append({
    spreadsheetId: getSheetId(),
    range: 'Completed!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

// --- Initialization ---

async function ensureHeaders() {
  const sheets = await getSheetsClient();
  const sheetId = getSheetId();

  // Queue headers: 17 topic columns (A-Q) + blank (R) + lastResearchDate label (S).
  // Compare cell-by-cell against the canonical layout and rewrite the row if
  // any position is drifted. Necessary for sheets created before review
  // columns existed — the old no-op-on-non-empty behavior could never repair
  // a stale header row, so column labels would silently mismatch the code's
  // canonical layout forever.
  const expectedQueueHeader = [...QUEUE_HEADERS, '', 'lastResearchDate'];
  const qRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Queue!A1:S1',
  });
  const currentQueueHeader = qRes.data.values?.[0] || [];
  const queueMatches = expectedQueueHeader.every((h, i) => (currentQueueHeader[i] || '') === h);
  if (!queueMatches) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Queue!A1:S1',
      valueInputOption: 'RAW',
      requestBody: { values: [expectedQueueHeader] },
    });
    console.log(currentQueueHeader.length
      ? 'Queue header row repaired (drifted from canonical layout).'
      : 'Queue header row written.');
  }

  // Completed headers: same comparison-and-rewrite logic.
  const cRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Completed!A1:F1',
  });
  const currentCompletedHeader = cRes.data.values?.[0] || [];
  const completedMatches = COMPLETED_HEADERS.every((h, i) => (currentCompletedHeader[i] || '') === h);
  if (!completedMatches) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Completed!A1:F1',
      valueInputOption: 'RAW',
      requestBody: { values: [COMPLETED_HEADERS] },
    });
    console.log(currentCompletedHeader.length
      ? 'Completed header row repaired (drifted from canonical layout).'
      : 'Completed header row written.');
  }

  console.log('Sheet headers ensured.');
}

module.exports = {
  getQueueTopics,
  getLastResearchDate,
  setLastResearchDate,
  appendTopicsToQueue,
  updateTopicInQueue,
  removeTopicFromQueue,
  setReviewStatus,
  getPendingReviews,
  getTopicByBlogFile,
  getCompletedKeywords,
  appendToCompleted,
  ensureHeaders,
  QUEUE_HEADERS,
  COMPLETED_HEADERS,
  REVIEW_STATUSES,
};
