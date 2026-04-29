/**
 * RAG Engine — Retrieval Augmented Generation orchestrator
 * Handles the full pipeline: embed query → retrieve → augment → stream
 */

import { embedQuery, chatStream } from './nvidia.js';
import vectorStore from './vectorStore.js';

// Store conversation histories per session
const conversations = new Map();

const SYSTEM_PROMPT = `You are an expert teacher and tutor. Your role is to teach concepts from the knowledge base provided below. The student is completely new to this topic.

TEACHING RULES:
1. ALWAYS explain step-by-step, starting from the very basics. Build up gradually.
2. Use simple analogies and real-world examples to make concepts click.
3. After explaining a key concept, ask the student a verification question to check understanding.
4. Include practice problems and worked examples when relevant.
5. Be CONCISE yet THOROUGH — every sentence must add value. No fluff.
6. Reference which video or document your information comes from (use the source tags).
7. If the student asks something NOT covered in the knowledge base, say so honestly and explain what you do know that's related.
8. Respond in the SAME LANGUAGE the student uses. If they ask in Tamil, respond in Tamil. If in Hindi, respond in Hindi. Default to English.
9. Format your responses well — use headings, bullet points, numbered lists, and code blocks where appropriate.
10. When solving problems, show each step clearly and explain WHY each step is taken.
11. If a concept has prerequisites, briefly mention what the student should know first.
12. When listing available sources, list UNIQUE source names only (no duplicates).

Remember: You are a patient, encouraging teacher. The student's understanding is your top priority.`;

/**
 * Get or create a conversation session
 */
export function getConversation(sessionId) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, {
      messages: [],
      createdAt: new Date().toISOString(),
    });
  }
  return conversations.get(sessionId);
}

/**
 * Process a user message through the RAG pipeline
 * Returns a readable stream of the AI response
 */
export async function processMessage(sessionId, userMessage, apiKey) {
  const conversation = getConversation(sessionId);

  // 1. Add user message to history
  conversation.messages.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
  });

  // 2. Retrieve relevant context from vector store
  let contextText = '';
  let retrievedSources = [];

  const asksForSourceList = /\b(source|sources|what can you access|available sources|knowledge base|what do you have)\b/i.test(userMessage);

  if (vectorStore.size > 0) {
    const queryEmbedding = await embedQuery(userMessage, apiKey);
    const results = vectorStore.search(queryEmbedding, 8);

    const uniqueSourceMap = new Map();
    for (const r of results) {
      const sourceId = r.metadata.sourceId || r.metadata.sourceName || 'unknown_source';
      const sourceName = r.metadata.sourceName || r.metadata.sourceId || 'Unknown source';
      const existing = uniqueSourceMap.get(sourceId);

      if (!existing || r.similarity > existing._sim) {
        uniqueSourceMap.set(sourceId, {
          sourceId,
          source: sourceName,
          type: r.metadata.sourceType,
          similarity: Math.round(r.similarity * 100),
          text: r.text.substring(0, 200) + '...',
          _sim: r.similarity,
        });
      }
    }

    retrievedSources = Array.from(uniqueSourceMap.values())
      .sort((a, b) => b._sim - a._sim)
      .map(({ _sim, ...source }) => source);

    contextText = results.map((r) => {
      const source = r.metadata.sourceName || r.metadata.sourceId;
      const type = r.metadata.sourceType === 'video' ? '🎥 Video' : '📄 File';
      return `[Context Chunk — ${type} — "${source}"]\n${r.text}`;
    }).join('\n\n---\n\n');

    const sourceCatalog = retrievedSources.map((s, i) => {
      const type = s.type === 'video' ? 'Video' : 'File';
      return `${i + 1}. ${type} — ${s.source}`;
    }).join('\n');

    contextText += `\n\n---\n\n[UNIQUE SOURCE CATALOG]\n${sourceCatalog}`;

    if (asksForSourceList) {
      const allSources = vectorStore.getSources();
      const globalCatalog = allSources.map((s, i) => {
        const type = s.type === 'video' ? 'Video' : 'File';
        return `${i + 1}. ${type} — ${s.name || s.id}`;
      }).join('\n');

      contextText += `\n\n---\n\n[COMPLETE KNOWLEDGE BASE SOURCES]\n${globalCatalog}`;
    }
  }

  // 3. Build the augmented messages array
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  // Add knowledge base context
  if (contextText) {
    messages.push({
      role: 'system',
      content: `KNOWLEDGE BASE (retrieved relevant sections):\n\n${contextText}\n\nUse this knowledge base to answer the student's question. Always cite which source you're drawing from. If the user asks for available sources, use the UNIQUE SOURCE CATALOG or COMPLETE KNOWLEDGE BASE SOURCES and do not repeat duplicates.`,
    });
  } else {
    messages.push({
      role: 'system',
      content: 'NOTE: No knowledge base has been loaded yet. The student has not uploaded any videos or files. Let them know they should load a playlist or upload files first, but still try to help with general knowledge if possible.',
    });
  }

  // Add conversation history (last 20 messages for context)
  const recentMessages = conversation.messages.slice(-20);
  for (const msg of recentMessages) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  // 4. Stream the response
  const stream = await chatStream(messages, apiKey);

  return {
    stream,
    sources: retrievedSources,
    conversationLength: conversation.messages.length,
  };
}

/**
 * Add assistant response to conversation history
 */
export function addAssistantMessage(sessionId, content) {
  const conversation = getConversation(sessionId);
  conversation.messages.push({
    role: 'assistant',
    content,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Clear conversation history
 */
export function clearConversation(sessionId) {
  conversations.delete(sessionId);
}

/**
 * Clear all conversation sessions
 */
export function clearAllConversations() {
  conversations.clear();
}

/**
 * Get conversation stats
 */
export function getConversationStats(sessionId) {
  const conversation = conversations.get(sessionId);
  if (!conversation) return { messageCount: 0 };
  return {
    messageCount: conversation.messages.length,
    createdAt: conversation.createdAt,
  };
}
