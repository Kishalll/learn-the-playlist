/**
 * Upload Routes — Handle file uploads (PDF, DOCX, TXT, MD)
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseFile, getSupportedExtensions } from '../services/fileParser.js';
import { chunkText } from '../services/chunker.js';
import { generateEmbeddings } from '../services/nvidia.js';
import vectorStore from '../services/vectorStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configure multer for file uploads
const uploadDir = join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const supported = getSupportedExtensions();
    if (supported.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Supported: ${supported.join(', ')}`));
    }
  },
});

const router = Router();

const uploadState = {
  running: false,
  items: [],
  updatedAt: null,
};

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toPublicItem(item) {
  return {
    id: item.id,
    filename: item.filename,
    sourceId: item.sourceId,
    status: item.status,
    message: item.message,
    chunkCount: item.chunkCount,
    charCount: item.charCount,
    type: item.type,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function cleanupStoredFile(item) {
  if (!item.storedPath) return;
  try {
    if (fs.existsSync(item.storedPath)) fs.unlinkSync(item.storedPath);
  } catch {
    // ignore cleanup errors
  }
  item.storedPath = null;
}

export function syncUploadItemOnSourceRemoval(sourceId) {
  const item = uploadState.items.find(f => f.sourceId === sourceId);
  if (!item) return;

  setItemStatus(item, 'failed', 'Removed from knowledge base. Re-upload this file to index again.', {
    chunkCount: 0,
  });
}

export function clearUploadState() {
  for (const item of uploadState.items) {
    cleanupStoredFile(item);
  }
  uploadState.running = false;
  uploadState.items = [];
  uploadState.updatedAt = nowIso();
}

function setItemStatus(item, status, message, extra = {}) {
  item.status = status;
  if (message) item.message = message;
  item.updatedAt = nowIso();
  if (extra.chunkCount !== undefined) item.chunkCount = extra.chunkCount;
  if (extra.charCount !== undefined) item.charCount = extra.charCount;
  if (extra.type !== undefined) item.type = extra.type;
}

function markPendingAsHeld(items) {
  for (const item of items) {
    if (item.status === 'pending' || item.status === 'processing' || item.status === 'embedding') {
      setItemStatus(item, 'held', 'Paused. Click Retry to continue.');
    }
  }
}

function stateCounts() {
  const counts = {
    total: uploadState.items.length,
    done: 0,
    failed: 0,
    held: 0,
    pending: 0,
  };

  for (const item of uploadState.items) {
    if (item.status === 'done') counts.done++;
    else if (item.status === 'failed') counts.failed++;
    else if (item.status === 'held') counts.held++;
    else if (item.status === 'pending' || item.status === 'processing' || item.status === 'embedding') counts.pending++;
  }

  return counts;
}

function getPendingSnapshot() {
  const counts = stateCounts();
  return {
    canResume: counts.held > 0 || counts.pending > 0,
    running: uploadState.running,
    pending: {
      totalFiles: counts.total,
      doneFiles: counts.done,
      failedFiles: counts.failed,
      heldFiles: counts.held,
      pendingFiles: counts.pending,
      updatedAt: uploadState.updatedAt,
      items: uploadState.items.map(toPublicItem),
    },
  };
}

async function processFileItem(item, apiKey) {
  if (!item.storedPath || !fs.existsSync(item.storedPath)) {
    setItemStatus(item, 'failed', 'Original uploaded file is missing. Re-upload this file to continue.');
    return { status: 'failed', message: item.message };
  }

  const sourceId = item.sourceId;

  setItemStatus(item, 'processing', 'Parsing file...');
  const parsed = await parseFile(item.storedPath, item.filename);

  const chunks = chunkText(parsed.content, {
    sourceId,
    sourceType: 'file',
    sourceName: parsed.filename,
    fileType: parsed.type,
  });

  if (chunks.length === 0) {
    setItemStatus(item, 'failed', 'File content was empty after parsing');
    return { status: 'failed', message: item.message };
  }

  setItemStatus(item, 'embedding', `Embedding ${chunks.length} chunks...`);
  const texts = chunks.map(c => c.text);
  const embeddings = await generateEmbeddings(texts, apiKey);

  vectorStore.addChunks(chunks, embeddings);
  vectorStore.addSource(sourceId, {
    type: 'file',
    name: parsed.filename,
    fileType: parsed.type,
    chunkCount: chunks.length,
    charCount: parsed.charCount,
  });

  setItemStatus(item, 'done', `✅ ${chunks.length} chunks indexed`, {
    chunkCount: chunks.length,
    charCount: parsed.charCount,
    type: parsed.type,
  });
  cleanupStoredFile(item);
  return { status: 'done', message: item.message };
}

async function processSpecificItems(items, apiKey, disconnectedRef = { value: false }) {
  uploadState.running = true;
  uploadState.updatedAt = nowIso();

  const results = [];

  for (const item of items) {
    if (disconnectedRef.value) {
      markPendingAsHeld([item]);
      continue;
    }

    try {
      const outcome = await processFileItem(item, apiKey);
      results.push({ ...toPublicItem(item), outcome: outcome.status });
    } catch (err) {
      setItemStatus(item, 'failed', err.message || 'File processing failed');
      results.push({ ...toPublicItem(item), outcome: 'failed' });
    }

    if (disconnectedRef.value) {
      markPendingAsHeld(items);
      break;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  uploadState.running = false;
  uploadState.updatedAt = nowIso();

  return results;
}

/**
 * POST /api/upload/files
 * Upload and process only newly uploaded files
 */
router.post('/files', (req, res, next) => {
  upload.array('files', 30)(req, res, function (err) {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  let { apiKey } = req.body;

  // Since multer parses the body AFTER the global middleware, we need to handle the placeholder here
  if ((!apiKey || apiKey === '__env__') && process.env.NVIDIA_API_KEY) {
    apiKey = process.env.NVIDIA_API_KEY;
  }

  if (!apiKey) return res.status(400).json({ error: 'NVIDIA API key is required' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
  if (uploadState.running) return res.status(409).json({ error: 'File processing is already running' });

  const created = req.files.map(file => ({
    id: makeId(),
    filename: file.originalname,
    storedPath: file.path,
    sourceId: `file_${file.filename}`,
    status: 'pending',
    message: 'Pending',
    chunkCount: 0,
    charCount: 0,
    type: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }));

  // Recent uploads first; unfinished old files stay below
  uploadState.items = [...created, ...uploadState.items];
  uploadState.updatedAt = nowIso();

  const disconnected = { value: false };
  res.on('close', () => {
    disconnected.value = true;
  });
  req.on('aborted', () => {
    disconnected.value = true;
  });

  await processSpecificItems(created, apiKey, disconnected);

  if (disconnected.value || res.writableEnded) return;

  const counts = stateCounts();
  res.json({
    results: created.map(toPublicItem),
    totalChunks: vectorStore.size,
    totalSources: vectorStore.getSources().length,
    counts,
  });
});

/**
 * POST /api/upload/resume
 * Resume held/pending files only
 */
router.post('/resume', async (req, res) => {
  let { apiKey } = req.body;
  if ((!apiKey || apiKey === '__env__') && process.env.NVIDIA_API_KEY) {
    apiKey = process.env.NVIDIA_API_KEY;
  }

  if (!apiKey) return res.status(400).json({ error: 'NVIDIA API key is required' });
  if (uploadState.running) return res.status(409).json({ error: 'File processing is already running' });

  const targets = uploadState.items.filter(item => item.status === 'held' || item.status === 'pending');
  if (targets.length === 0) return res.status(404).json({ error: 'No interrupted files to resume' });

  await processSpecificItems(targets, apiKey, { value: false });

  res.json({
    resumed: targets.length,
    items: targets.map(toPublicItem),
    totalChunks: vectorStore.size,
    totalSources: vectorStore.getSources().length,
    counts: stateCounts(),
  });
});

/**
 * POST /api/upload/retry/:itemId
 * Retry one failed/held file
 */
router.post('/retry/:itemId', async (req, res) => {
  let { apiKey } = req.body;
  const itemId = req.params.itemId;

  if ((!apiKey || apiKey === '__env__') && process.env.NVIDIA_API_KEY) {
    apiKey = process.env.NVIDIA_API_KEY;
  }

  if (!apiKey) return res.status(400).json({ error: 'NVIDIA API key is required' });
  if (uploadState.running) return res.status(409).json({ error: 'File processing is already running' });

  const item = uploadState.items.find(f => f.id === itemId);
  if (!item) return res.status(404).json({ error: 'File item not found' });

  if (!['failed', 'held', 'pending'].includes(item.status)) {
    return res.status(400).json({ error: 'Only failed or held files can be retried' });
  }

  uploadState.running = true;
  try {
    await processFileItem(item, apiKey);
  } catch (err) {
    setItemStatus(item, 'failed', err.message || 'Retry failed');
  } finally {
    uploadState.running = false;
    uploadState.updatedAt = nowIso();
  }

  res.json({
    item: toPublicItem(item),
    totalChunks: vectorStore.size,
    totalSources: vectorStore.getSources().length,
    counts: stateCounts(),
  });
});

/**
 * POST /api/upload/defer
 * Move interrupted pending items to held state
 */
router.post('/defer', (req, res) => {
  markPendingAsHeld(uploadState.items);
  uploadState.running = false;
  uploadState.updatedAt = nowIso();
  res.json(getPendingSnapshot());
});

/**
 * GET /api/upload/pending
 */
router.get('/pending', (req, res) => {
  res.json(getPendingSnapshot());
});

export default router;
