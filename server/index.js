import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

import playlistRoutes from './routes/playlist.js';
import uploadRoutes from './routes/upload.js';
import chatRoutes from './routes/chat.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT || 3001;

// Ensure data directory exists
const dataDir = join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Middleware: inject API key from .env if not provided in request
app.use('/api', (req, res, next) => {
  if (req.body && (!req.body.apiKey || req.body.apiKey === '__env__') && process.env.NVIDIA_API_KEY) {
    req.body.apiKey = process.env.NVIDIA_API_KEY;
  }
  next();
});

// Routes
app.use('/api/playlist', playlistRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/chat', chatRoutes);

// Config endpoint — tells frontend if key is already configured
app.get('/api/config', (req, res) => {
  const hasKey = !!process.env.NVIDIA_API_KEY;
  res.json({ hasKey, keyPreview: hasKey ? 'nvapi-***' + process.env.NVIDIA_API_KEY.slice(-4) : null });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🚀 PlaylistGPT server running on http://localhost:${PORT}\n`);
});
