/**
 * NVIDIA NIM API Client
 * OpenAI-compatible REST API for LLM chat + embeddings
 */

const BASE_URL = 'https://integrate.api.nvidia.com/v1';
const EMBEDDING_MODEL = 'nvidia/nv-embedqa-e5-v5';
const CHAT_MODEL = 'meta/llama-3.3-70b-instruct';

/**
 * Generate embeddings for an array of texts
 * Batches in groups of 50 to stay within limits
 */
export async function generateEmbeddings(texts, apiKey, inputType = 'passage') {
  const allEmbeddings = [];
  const batchSize = 50;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const response = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
        input_type: inputType,
        encoding_format: 'float',
        truncate: 'END',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`NVIDIA Embedding API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const embeddings = data.data.map(d => d.embedding);
    allEmbeddings.push(...embeddings);

    // Small delay between batches to respect rate limits
    if (i + batchSize < texts.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return allEmbeddings;
}

/**
 * Generate embedding for a single query text
 */
export async function embedQuery(text, apiKey) {
  const results = await generateEmbeddings([text], apiKey, 'query');
  return results[0];
}

/**
 * Chat completion with streaming via SSE
 * Returns a ReadableStream of tokens
 */
export async function chatStream(messages, apiKey) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      stream: true,
      max_tokens: 4096,
      temperature: 0.3,
      top_p: 0.9,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`NVIDIA Chat API error (${response.status}): ${err}`);
  }

  return response.body;
}

/**
 * Non-streaming chat completion (for summaries, etc.)
 */
export async function chatComplete(messages, apiKey) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      stream: false,
      max_tokens: 2048,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`NVIDIA Chat API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}
