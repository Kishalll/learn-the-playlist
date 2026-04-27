/**
 * Playlist Routes — Process YouTube playlist URLs
 */

import { Router } from 'express';
import { getPlaylistVideos, getVideoTranscript } from '../services/youtube.js';
import { chunkText } from '../services/chunker.js';
import { generateEmbeddings } from '../services/nvidia.js';
import vectorStore from '../services/vectorStore.js';

const router = Router();

/**
 * POST /api/playlist/load
 * Accepts { url, apiKey } and processes the entire playlist
 * Uses SSE to stream progress updates
 */
router.post('/load', async (req, res) => {
  const { url, apiKey } = req.body;

  if (!url) return res.status(400).json({ error: 'Playlist URL is required' });
  if (!apiKey) return res.status(400).json({ error: 'NVIDIA API key is required' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // 1. Get playlist videos
    send('status', { message: 'Fetching playlist information...' });
    const playlist = await getPlaylistVideos(url);
    send('playlist', {
      title: playlist.title,
      videoCount: playlist.videoCount,
      videos: playlist.videos.map(v => ({ id: v.id, title: v.title, duration: v.duration })),
    });

    let processed = 0;
    let failed = 0;
    let totalChunks = 0;

    // 2. Process each video
    for (const video of playlist.videos) {
      const sourceId = `video_${video.id}`;

      // Skip if already processed
      if (vectorStore.hasSource(sourceId)) {
        processed++;
        send('progress', {
          videoId: video.id,
          title: video.title,
          status: 'skipped',
          message: 'Already processed',
          processed,
          total: playlist.videoCount,
        });
        continue;
      }

      send('progress', {
        videoId: video.id,
        title: video.title,
        status: 'processing',
        message: 'Fetching transcript...',
        processed,
        total: playlist.videoCount,
      });

      try {
        // Fetch transcript
        const transcript = await getVideoTranscript(video.id);

        if (!transcript.success) {
          failed++;
          processed++;
          send('progress', {
            videoId: video.id,
            title: video.title,
            status: 'failed',
            message: transcript.error,
            processed,
            total: playlist.videoCount,
          });
          continue;
        }

        // Chunk the transcript
        const chunks = chunkText(transcript.text, {
          sourceId,
          sourceType: 'video',
          sourceName: video.title,
          videoId: video.id,
          duration: video.duration,
        });

        if (chunks.length === 0) {
          failed++;
          processed++;
          send('progress', {
            videoId: video.id,
            title: video.title,
            status: 'failed',
            message: 'Transcript was empty after processing',
            processed,
            total: playlist.videoCount,
          });
          continue;
        }

        // Generate embeddings
        send('progress', {
          videoId: video.id,
          title: video.title,
          status: 'embedding',
          message: `Embedding ${chunks.length} chunks...`,
          processed,
          total: playlist.videoCount,
        });

        const texts = chunks.map(c => c.text);
        const embeddings = await generateEmbeddings(texts, apiKey);

        // Store in vector store
        vectorStore.addChunks(chunks, embeddings);
        vectorStore.addSource(sourceId, {
          type: 'video',
          name: video.title,
          videoId: video.id,
          duration: video.duration,
          chunkCount: chunks.length,
          charCount: transcript.charCount,
        });

        totalChunks += chunks.length;
        processed++;

        send('progress', {
          videoId: video.id,
          title: video.title,
          status: 'done',
          message: `✅ ${chunks.length} chunks indexed`,
          processed,
          total: playlist.videoCount,
          chunkCount: chunks.length,
        });

        // Small delay between videos to avoid rate limits
        await new Promise(r => setTimeout(r, 300));

      } catch (err) {
        failed++;
        processed++;
        send('progress', {
          videoId: video.id,
          title: video.title,
          status: 'failed',
          message: err.message,
          processed,
          total: playlist.videoCount,
        });
      }
    }

    // 3. Done
    send('complete', {
      playlistTitle: playlist.title,
      totalVideos: playlist.videoCount,
      processedVideos: processed - failed,
      failedVideos: failed,
      totalChunks,
      storeSize: vectorStore.size,
    });

  } catch (err) {
    send('error', { message: err.message });
  }

  res.end();
});

/**
 * GET /api/playlist/sources
 * Returns all loaded sources
 */
router.get('/sources', (req, res) => {
  res.json({
    sources: vectorStore.getSources(),
    totalChunks: vectorStore.size,
  });
});

/**
 * DELETE /api/playlist/clear
 * Clear all data
 */
router.delete('/clear', (req, res) => {
  vectorStore.clear();
  res.json({ message: 'All data cleared' });
});

export default router;
