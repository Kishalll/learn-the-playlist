/**
 * Playlist Routes — Process YouTube playlist URLs
 */

import { Router } from 'express';
import { getPlaylistVideos, getVideoTranscript } from '../services/youtube.js';
import { chunkText } from '../services/chunker.js';
import { generateEmbeddings } from '../services/nvidia.js';
import vectorStore from '../services/vectorStore.js';
import { syncUploadItemOnSourceRemoval, clearUploadState } from './upload.js';
import { clearAllConversations } from '../services/ragEngine.js';

const router = Router();

const playlistState = {
  running: false,
  cancelRequested: false,
  url: null,
  title: null,
  items: [],
  updatedAt: null,
};

function nowIso() {
  return new Date().toISOString();
}

function setPlaylistMeta(url, title) {
  playlistState.url = url;
  playlistState.title = title;
  playlistState.updatedAt = nowIso();
}

function resetPlaylistState() {
  playlistState.running = false;
  playlistState.cancelRequested = false;
  playlistState.url = null;
  playlistState.title = null;
  playlistState.items = [];
  playlistState.updatedAt = nowIso();
}

function getSourceId(videoId) {
  return `video_${videoId}`;
}

function getStoredSourceInfo(sourceId) {
  const sources = vectorStore.getSources();
  return sources.find(s => s.id === sourceId) || null;
}

function makeItem(video) {
  const sourceId = getSourceId(video.id);
  const alreadyDone = vectorStore.hasSource(sourceId);
  const existing = alreadyDone ? getStoredSourceInfo(sourceId) : null;
  return {
    videoId: video.id,
    sourceId,
    title: video.title,
    duration: video.duration,
    status: alreadyDone ? 'done' : 'pending',
    message: alreadyDone ? 'Already indexed' : 'Pending',
    chunkCount: existing?.chunkCount || 0,
    updatedAt: nowIso(),
  };
}

function markInterruptedAsHeld() {
  for (const item of playlistState.items) {
    if (item.status === 'pending' || item.status === 'processing' || item.status === 'embedding') {
      item.status = 'held';
      item.message = 'Paused. Click Retry to continue.';
      item.updatedAt = nowIso();
    }
  }
  playlistState.updatedAt = nowIso();
}

function shouldPause(disconnected) {
  return disconnected || playlistState.cancelRequested;
}

async function waitForProcessingToStop(timeoutMs = 8000) {
  const start = Date.now();
  while (playlistState.running && (Date.now() - start) < timeoutMs) {
    await new Promise(r => setTimeout(r, 200));
  }
  return !playlistState.running;
}

function setItemStatus(videoId, status, message, extra = {}) {
  const item = playlistState.items.find(v => v.videoId === videoId);
  if (!item) return null;
  item.status = status;
  item.message = message || item.message;
  item.updatedAt = nowIso();
  if (extra.chunkCount !== undefined) item.chunkCount = extra.chunkCount;
  return item;
}

function stateCounts() {
  const counts = {
    total: playlistState.items.length,
    done: 0,
    failed: 0,
    held: 0,
    pending: 0,
  };

  for (const item of playlistState.items) {
    if (item.status === 'done' || item.status === 'skipped') counts.done++;
    else if (item.status === 'failed') counts.failed++;
    else if (item.status === 'held') counts.held++;
    else if (item.status === 'pending' || item.status === 'processing' || item.status === 'embedding') counts.pending++;
  }

  return counts;
}

function totalIndexedChunks() {
  return vectorStore.getSources().reduce((sum, source) => sum + (source.chunkCount || 0), 0);
}

function getPendingSnapshot() {
  const counts = stateCounts();
  const canResume = counts.held > 0 || counts.pending > 0;
  return {
    canResume,
    running: playlistState.running,
    pending: playlistState.url ? {
      url: playlistState.url,
      title: playlistState.title,
      videoCount: counts.total,
      processedVideos: counts.done,
      failedVideos: counts.failed,
      heldVideos: counts.held,
      pendingVideos: counts.pending,
      totalChunks: totalIndexedChunks(),
      updatedAt: playlistState.updatedAt,
      items: playlistState.items,
    } : null,
  };
}

async function processVideoItem(item, apiKey) {
  const sourceId = getSourceId(item.videoId);

  if (vectorStore.hasSource(sourceId)) {
    setItemStatus(item.videoId, 'done', 'Already indexed');
    return { status: 'done', message: 'Already indexed', chunkCount: item.chunkCount || 0 };
  }

  setItemStatus(item.videoId, 'processing', 'Fetching transcript...');
  const transcript = await getVideoTranscript(item.videoId);

  if (!transcript.success) {
    setItemStatus(item.videoId, 'failed', transcript.error || 'Transcript extraction failed');
    return { status: 'failed', message: transcript.error || 'Transcript extraction failed', chunkCount: 0 };
  }

  const chunks = chunkText(transcript.text, {
    sourceId,
    sourceType: 'video',
    sourceName: item.title,
    videoId: item.videoId,
    duration: item.duration,
  });

  if (chunks.length === 0) {
    setItemStatus(item.videoId, 'failed', 'Transcript was empty after processing');
    return { status: 'failed', message: 'Transcript was empty after processing', chunkCount: 0 };
  }

  setItemStatus(item.videoId, 'embedding', `Embedding ${chunks.length} chunks...`);
  const texts = chunks.map(c => c.text);
  const embeddings = await generateEmbeddings(texts, apiKey);

  vectorStore.addChunks(chunks, embeddings);
  vectorStore.addSource(sourceId, {
    type: 'video',
    name: item.title,
    videoId: item.videoId,
    duration: item.duration,
    chunkCount: chunks.length,
    charCount: transcript.charCount,
  });

  setItemStatus(item.videoId, 'done', `✅ ${chunks.length} chunks indexed`, { chunkCount: chunks.length });
  return { status: 'done', message: `✅ ${chunks.length} chunks indexed`, chunkCount: chunks.length };
}

async function streamPlaylistItems({ req, res, apiKey, itemStatusesToProcess }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let disconnected = false;
  res.on('close', () => {
    disconnected = true;
  });
  req.on('aborted', () => {
    disconnected = true;
  });

  const send = (event, data) => {
    if (disconnected || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const counts = stateCounts();
  send('playlist', {
    title: playlistState.title,
    videoCount: counts.total,
    videos: playlistState.items.map(v => ({
      id: v.videoId,
      title: v.title,
      duration: v.duration,
      status: v.status,
      message: v.message,
    })),
  });

  try {
    playlistState.running = true;
    playlistState.cancelRequested = false;
    playlistState.updatedAt = nowIso();
    let runTotalChunks = 0;

    for (const item of playlistState.items) {
      if (!itemStatusesToProcess.includes(item.status)) continue;

      if (shouldPause(disconnected)) {
        markInterruptedAsHeld();
        return;
      }

      const result = await processVideoItem(item, apiKey);
      if (result.status === 'done') {
        runTotalChunks += result.chunkCount || 0;
      }

      if (shouldPause(disconnected)) {
        markInterruptedAsHeld();
        return;
      }

      const progressCounts = stateCounts();
      send('progress', {
        videoId: item.videoId,
        title: item.title,
        status: result.status,
        message: result.message,
        processed: progressCounts.done + progressCounts.failed,
        total: progressCounts.total,
        chunkCount: result.chunkCount,
        runTotalChunks,
        totalSourcesInStore: vectorStore.getSources().length,
        totalChunksInStore: vectorStore.size,
      });

      await new Promise(r => setTimeout(r, 300));
    }

    playlistState.running = false;
    playlistState.updatedAt = nowIso();

    const endCounts = stateCounts();
    send('complete', {
      playlistTitle: playlistState.title,
      totalVideos: endCounts.total,
      processedVideos: endCounts.done,
      failedVideos: endCounts.failed,
      heldVideos: endCounts.held,
      pendingVideos: endCounts.pending,
      runTotalChunks,
      totalChunks: totalIndexedChunks(),
      totalSourcesInStore: vectorStore.getSources().length,
      totalChunksInStore: vectorStore.size,
      storeSize: vectorStore.size,
    });
  } catch (err) {
    send('error', { message: err.message || 'Playlist processing failed' });
  } finally {
    playlistState.running = false;
    playlistState.cancelRequested = false;
    playlistState.updatedAt = nowIso();
  }

  if (!res.writableEnded) res.end();
}

/**
 * POST /api/playlist/load
 */
router.post('/load', async (req, res) => {
  const { url, apiKey } = req.body;

  if (!url) return res.status(400).json({ error: 'Playlist URL is required' });
  if (!apiKey) return res.status(400).json({ error: 'NVIDIA API key is required' });
  if (playlistState.running) return res.status(409).json({ error: 'Another playlist is currently being processed' });

  try {
    const playlist = await getPlaylistVideos(url);
    setPlaylistMeta(url, playlist.title || 'Unknown Playlist');
    playlistState.items = playlist.videos.map(makeItem);
  } catch (err) {
    return res.status(400).json({ error: `Failed to fetch playlist data: ${err.message}` });
  }

  await streamPlaylistItems({ req, res, apiKey, itemStatusesToProcess: ['pending'] });
});

/**
 * POST /api/playlist/resume
 */
router.post('/resume', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'NVIDIA API key is required' });

  if (playlistState.running) {
    playlistState.cancelRequested = true;
    markInterruptedAsHeld();
    const stopped = await waitForProcessingToStop(10000);
    if (!stopped) {
      return res.status(409).json({ error: 'Playlist is already processing. Try again in a few seconds.' });
    }
  }

  const hasPending = playlistState.items.some(item => item.status === 'held' || item.status === 'pending');
  if (!playlistState.url || !hasPending) {
    return res.status(404).json({ error: 'No interrupted playlist found to resume' });
  }

  await streamPlaylistItems({ req, res, apiKey, itemStatusesToProcess: ['held', 'pending'] });
});

/**
 * POST /api/playlist/defer
 * Move interrupted pending items to held state
 */
router.post('/defer', (req, res) => {
  playlistState.cancelRequested = true;
  markInterruptedAsHeld();
  res.json(getPendingSnapshot());
});

/**
 * POST /api/playlist/retry/:videoId
 */
router.post('/retry/:videoId', async (req, res) => {
  const { apiKey } = req.body;
  const videoId = req.params.videoId;

  if (!apiKey) return res.status(400).json({ error: 'NVIDIA API key is required' });
  if (playlistState.running) return res.status(409).json({ error: 'Playlist is currently processing' });

  const item = playlistState.items.find(v => v.videoId === videoId);
  if (!item) return res.status(404).json({ error: 'Video not found in playlist state' });
  if (item.status === 'done' || item.status === 'skipped') {
    return res.status(400).json({ error: 'This video is already indexed' });
  }

  try {
    const result = await processVideoItem(item, apiKey);
    playlistState.updatedAt = nowIso();
    return res.json({
      item,
      result,
      pending: getPendingSnapshot().pending,
      totalChunks: vectorStore.size,
      totalSources: vectorStore.getSources().length,
    });
  } catch (err) {
    setItemStatus(videoId, 'failed', err.message || 'Retry failed');
    playlistState.updatedAt = nowIso();
    return res.status(500).json({ error: err.message || 'Retry failed', item });
  }
});

/**
 * GET /api/playlist/pending
 */
router.get('/pending', (req, res) => {
  res.json(getPendingSnapshot());
});

/**
 * GET /api/playlist/debug-sources
 * Debug endpoint for source/chunk consistency checks
 */
router.get('/debug-sources', (req, res) => {
  const sources = vectorStore.getSources();
  const chunkCountsBySource = {};

  for (const [, entry] of vectorStore.store) {
    const sourceId = entry?.metadata?.sourceId;
    if (!sourceId) continue;
    chunkCountsBySource[sourceId] = (chunkCountsBySource[sourceId] || 0) + 1;
  }

  res.json({
    totalSources: sources.length,
    totalChunks: vectorStore.size,
    sources,
    chunkCountsBySource,
  });
});

/**
 * GET /api/playlist/sources
 */
router.get('/sources', (req, res) => {
  res.json({
    sources: vectorStore.getSources(),
    totalChunks: vectorStore.size,
  });
});

/**
 * DELETE /api/playlist/source/:sourceId
 */
router.delete('/source/:sourceId', (req, res) => {
  const sourceId = req.params.sourceId;
  if (!sourceId) return res.status(400).json({ error: 'Source ID is required' });

  if (!vectorStore.hasSource(sourceId)) {
    return res.status(404).json({ error: 'Source not found' });
  }

  vectorStore.removeSource(sourceId);

  if (sourceId.startsWith('video_')) {
    const videoId = sourceId.slice(6);
    const item = playlistState.items.find(v => v.videoId === videoId);
    if (item) {
      item.status = 'pending';
      item.chunkCount = 0;
      item.message = 'Removed from knowledge base';
      item.updatedAt = nowIso();
    }
  } else if (sourceId.startsWith('file_')) {
    syncUploadItemOnSourceRemoval(sourceId);
  }

  res.json({
    message: 'Source removed from knowledge base',
    removedSourceId: sourceId,
    sources: vectorStore.getSources(),
    totalChunks: vectorStore.size,
  });
});

/**
 * DELETE /api/playlist/clear
 */
router.delete('/clear', (req, res) => {
  vectorStore.clear();
  resetPlaylistState();
  clearUploadState();
  clearAllConversations();
  res.json({ message: 'All data cleared' });
});

export default router;
