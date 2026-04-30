import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { embedQuery } from './services/nvidia.js';

import playlistRoutes from './routes/playlist.js';
import uploadRoutes from './routes/upload.js';
import chatRoutes from './routes/chat.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT || 3001;
const ROOT_ENV_PATH = join(__dirname, '..', '.env');
const KEY_HEALTH_CACHE_MS = 60 * 1000;

let keyHealthCache = {
  key: null,
  checkedAt: 0,
  isValid: false,
  reason: null,
};

// Ensure data directory exists
const dataDir = join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

function upsertEnvKey(filePath, key, value) {
  const line = `${key}=${value}`;
  const hasFile = fs.existsSync(filePath);
  const current = hasFile ? fs.readFileSync(filePath, 'utf-8') : '';
  const lines = current ? current.split(/\r?\n/) : [];

  let replaced = false;
  const updated = lines.map((entry) => {
    if (entry.startsWith(`${key}=`)) {
      replaced = true;
      return line;
    }
    return entry;
  });

  if (!replaced) {
    if (updated.length > 0 && updated[updated.length - 1].trim() !== '') updated.push('');
    updated.push(line);
  }

  const text = updated.join('\n').replace(/\n*$/, '\n');
  fs.writeFileSync(filePath, text, 'utf-8');
}

async function getServerKeyStatus(forceCheck = false) {
  const key = String(process.env.NVIDIA_API_KEY || '').trim();
  if (!key) {
    return { hasKey: false, isValid: false, keyPreview: null, reason: 'No API key configured' };
  }

  const now = Date.now();
  const canUseCache = !forceCheck && keyHealthCache.key === key && (now - keyHealthCache.checkedAt) < KEY_HEALTH_CACHE_MS;

  if (canUseCache) {
    return {
      hasKey: true,
      isValid: keyHealthCache.isValid,
      keyPreview: `nvapi-***${key.slice(-4)}`,
      reason: keyHealthCache.reason,
    };
  }

  try {
    await embedQuery('health check', key);
    keyHealthCache = {
      key,
      checkedAt: now,
      isValid: true,
      reason: null,
    };
  } catch (err) {
    keyHealthCache = {
      key,
      checkedAt: now,
      isValid: false,
      reason: 'Configured API key is invalid or expired',
    };
  }

  return {
    hasKey: true,
    isValid: keyHealthCache.isValid,
    keyPreview: `nvapi-***${key.slice(-4)}`,
    reason: keyHealthCache.reason,
  };
}

// Middleware: inject API key from .env if not provided in request
app.use('/api', (req, res, next) => {
  if (req.body && (!req.body.apiKey || req.body.apiKey === '__env__') && process.env.NVIDIA_API_KEY) {
    req.body.apiKey = process.env.NVIDIA_API_KEY;
  }
  next();
});

// Save API key into root .env after validating it with NVIDIA API
app.post('/api/config/api-key', async (req, res) => {
  const key = String(req.body?.apiKey || '').trim();
  if (!key) return res.status(400).json({ error: 'NVIDIA API key is required' });

  try {
    await embedQuery('connection test', key);
  } catch (err) {
    return res.status(400).json({
      error: 'API key is invalid or expired. Please enter a working key.',
      details: err.message,
    });
  }

  try {
    upsertEnvKey(ROOT_ENV_PATH, 'NVIDIA_API_KEY', key);
    process.env.NVIDIA_API_KEY = key;
    keyHealthCache = {
      key,
      checkedAt: Date.now(),
      isValid: true,
      reason: null,
    };
    return res.json({ success: true, keyPreview: `nvapi-***${key.slice(-4)}` });
  } catch (err) {
    return res.status(500).json({ error: `Failed to save key to .env: ${err.message}` });
  }
});

// Routes
app.use('/api/playlist', playlistRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/chat', chatRoutes);

// Config endpoint — tells frontend if key is configured and valid
app.get('/api/config', async (req, res) => {
  const config = await getServerKeyStatus(false);
  res.json(config);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🚀 FastFrwd server running on http://localhost:${PORT}\n`);
});
