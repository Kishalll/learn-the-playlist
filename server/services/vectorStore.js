/**
 * In-Memory Vector Store with cosine similarity search
 * Persists to JSON files for session recovery
 */

import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');

class VectorStore {
  constructor() {
    /** @type {Map<string, { text: string, embedding: number[], metadata: object }>} */
    this.store = new Map();
    this.sources = new Map(); // sourceId -> source info
  }

  /**
   * Add chunks with their embeddings to the store
   */
  addChunks(chunks, embeddings) {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      this.store.set(chunk.id, {
        text: chunk.text,
        embedding: embeddings[i],
        metadata: chunk.metadata,
      });
    }
  }

  /**
   * Register a source (video or file)
   */
  addSource(sourceId, sourceInfo) {
    this.sources.set(sourceId, sourceInfo);
  }

  /**
   * Search for the top-K most similar chunks to a query embedding
   */
  search(queryEmbedding, topK = 8) {
    const scores = [];

    for (const [id, entry] of this.store) {
      const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
      scores.push({
        id,
        text: entry.text,
        metadata: entry.metadata,
        similarity,
      });
    }

    scores.sort((a, b) => b.similarity - a.similarity);
    return scores.slice(0, topK);
  }

  /**
   * Get total number of chunks stored
   */
  get size() {
    return this.store.size;
  }

  /**
   * Get all registered sources
   */
  getSources() {
    return Array.from(this.sources.entries()).map(([id, info]) => ({ id, ...info }));
  }

  /**
   * Check if a source already exists
   */
  hasSource(sourceId) {
    return this.sources.has(sourceId);
  }

  /**
   * Remove all chunks for a specific source
   */
  removeSource(sourceId) {
    for (const [id] of this.store) {
      if (id.startsWith(sourceId)) {
        this.store.delete(id);
      }
    }
    this.sources.delete(sourceId);
  }

  /**
   * Clear all data
   */
  clear() {
    this.store.clear();
    this.sources.clear();
  }

  /**
   * Persist store to a JSON file
   */
  save(filename = 'vectorstore.json') {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    const data = {
      chunks: Array.from(this.store.entries()).map(([id, entry]) => ({
        id,
        text: entry.text,
        // Don't persist embeddings to save disk space — they can be regenerated
        metadata: entry.metadata,
      })),
      sources: Array.from(this.sources.entries()),
    };

    fs.writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2));
  }
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// Singleton instance
const vectorStore = new VectorStore();
export default vectorStore;
