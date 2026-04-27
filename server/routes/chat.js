/**
 * Chat Routes — Streaming AI chat with RAG
 */

import { Router } from 'express';
import { processMessage, addAssistantMessage, clearConversation, getConversationStats } from '../services/ragEngine.js';

const router = Router();

/**
 * POST /api/chat/message
 * Send a message and receive a streaming response
 * Body: { message, sessionId, apiKey }
 */
router.post('/message', async (req, res) => {
  const { message, sessionId, apiKey } = req.body;

  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });
  if (!apiKey) return res.status(400).json({ error: 'NVIDIA API key is required' });

  // Set up SSE for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { stream, sources } = await processMessage(sessionId, message, apiKey);

    // Send retrieved sources first
    res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);

    // Stream the LLM response
    let fullResponse = '';
    const decoder = new TextDecoder();

    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n').filter(line => line.trim());

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) {
              fullResponse += token;
              res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
            }
          } catch (e) {
            // Skip unparseable chunks
          }
        }
      }
    }

    // Save the full response to conversation history
    addAssistantMessage(sessionId, fullResponse);

    // Send completion event
    res.write(`event: done\ndata: ${JSON.stringify({ fullLength: fullResponse.length })}\n\n`);

  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
  }

  res.end();
});

/**
 * POST /api/chat/clear
 * Clear conversation history
 */
router.post('/clear', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) clearConversation(sessionId);
  res.json({ message: 'Conversation cleared' });
});

/**
 * POST /api/chat/stats
 * Get conversation statistics
 */
router.post('/stats', (req, res) => {
  const { sessionId } = req.body;
  res.json(getConversationStats(sessionId));
});

export default router;
