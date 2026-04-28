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

/**
 * POST /api/upload/files
 * Upload and process multiple files
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

  const results = [];

  for (const file of req.files) {
    const sourceId = `file_${file.filename}`;

    try {
      try {
        // Parse the file
        const parsed = await parseFile(file.path, file.originalname);

        // Chunk the content
        const chunks = chunkText(parsed.content, {
          sourceId,
          sourceType: 'file',
          sourceName: parsed.filename,
          fileType: parsed.type,
        });

        if (chunks.length === 0) {
          results.push({
            filename: file.originalname,
            status: 'failed',
            message: 'File content was empty after parsing',
          });
          continue; // Finally block will still run
        }

        // Generate embeddings
        const texts = chunks.map(c => c.text);
        const embeddings = await generateEmbeddings(texts, apiKey);

        // Store in vector store
        vectorStore.addChunks(chunks, embeddings);
        vectorStore.addSource(sourceId, {
          type: 'file',
          name: parsed.filename,
          fileType: parsed.type,
          chunkCount: chunks.length,
          charCount: parsed.charCount,
        });

        results.push({
          filename: file.originalname,
          status: 'success',
          chunkCount: chunks.length,
          charCount: parsed.charCount,
          type: parsed.type,
        });

      } catch (err) {
        let errorMsg = err.message || (typeof err === 'string' ? err : JSON.stringify(err));
        results.push({
          filename: file.originalname,
          status: 'failed',
          message: errorMsg,
        });
      }
    } finally {
      // Clean up uploaded file after processing
      try {
        fs.unlinkSync(file.path);
      } catch (e) { /* ignore cleanup errors */ }

      // Small delay between files to avoid NVIDIA API rate limits
      await new Promise(r => setTimeout(r, 300));
    }
  }

  res.json({
    results,
    totalChunks: vectorStore.size,
    totalSources: vectorStore.getSources().length,
  });
});

export default router;
