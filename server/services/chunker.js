/**
 * Text Chunker — Recursive Character Splitter
 * Optimized for educational content (transcripts + documents)
 */

const DEFAULT_CHUNK_SIZE = 2000;   // ~512 tokens
const DEFAULT_OVERLAP = 400;       // ~100 tokens
const SEPARATORS = ['\n\n', '\n', '. ', ', ', ' ', ''];

/**
 * Split text into overlapping chunks using recursive separator hierarchy
 */
export function chunkText(text, metadata = {}, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap || DEFAULT_OVERLAP;

  if (!text || text.trim().length === 0) return [];

  const rawChunks = recursiveSplit(text, chunkSize, SEPARATORS);
  const overlappingChunks = addOverlap(rawChunks, overlap, text);

  return overlappingChunks.map((chunk, index) => ({
    id: `${metadata.sourceId || 'unknown'}_chunk_${index}`,
    text: chunk.trim(),
    metadata: {
      ...metadata,
      chunkIndex: index,
      totalChunks: overlappingChunks.length,
      charCount: chunk.length,
    },
  }));
}

/**
 * Recursively split text using separator hierarchy
 */
function recursiveSplit(text, chunkSize, separators) {
  if (text.length <= chunkSize) return [text];

  const sep = separators[0];
  const remainingSeps = separators.slice(1);

  if (sep === '') {
    // Last resort: hard split by character count
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  const parts = text.split(sep);
  const chunks = [];
  let currentChunk = '';

  for (const part of parts) {
    const candidate = currentChunk ? currentChunk + sep + part : part;

    if (candidate.length <= chunkSize) {
      currentChunk = candidate;
    } else {
      if (currentChunk) chunks.push(currentChunk);

      if (part.length > chunkSize && remainingSeps.length > 0) {
        // This part is too big — split it with the next separator
        const subChunks = recursiveSplit(part, chunkSize, remainingSeps);
        chunks.push(...subChunks.slice(0, -1));
        currentChunk = subChunks[subChunks.length - 1];
      } else if (part.length > chunkSize) {
        // Hard split
        for (let i = 0; i < part.length; i += chunkSize) {
          chunks.push(part.slice(i, i + chunkSize));
        }
        currentChunk = '';
      } else {
        currentChunk = part;
      }
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

/**
 * Add overlap between consecutive chunks for context continuity
 */
function addOverlap(chunks, overlapSize) {
  if (chunks.length <= 1) return chunks;

  const result = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prevChunk = chunks[i - 1];
    const overlapText = prevChunk.slice(-overlapSize);
    result.push(overlapText + chunks[i]);
  }

  return result;
}
