/**
 * YouTube Service — Uses yt-dlp for reliable transcript extraction
 * Scrapes playlist page for video IDs (no API key needed)
 * Uses yt-dlp (via youtube-dl-exec) for caption/subtitle extraction
 */

import youtubedl from 'youtube-dl-exec';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMP_DIR = join(__dirname, '..', 'data', 'temp');

// Ensure temp dir exists
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Extract playlist ID from various YouTube URL formats
 */
export function extractPlaylistId(url) {
  const patterns = [
    /[?&]list=([a-zA-Z0-9_-]+)/,
    /playlist\?list=([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch all video IDs and metadata from a playlist by scraping the page
 */
export async function getPlaylistVideos(playlistUrl) {
  const playlistId = extractPlaylistId(playlistUrl);
  if (!playlistId) throw new Error('Invalid playlist URL. Could not extract playlist ID.');

  const url = `https://www.youtube.com/playlist?list=${playlistId}`;
  const response = await fetch(url, { headers: HEADERS });

  if (!response.ok) {
    throw new Error(`Failed to fetch playlist page (HTTP ${response.status})`);
  }

  const html = await response.text();

  const dataMatch = html.match(/var\s+ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!dataMatch) {
    throw new Error('Could not parse playlist data from YouTube page.');
  }

  let ytData;
  try {
    ytData = JSON.parse(dataMatch[1]);
  } catch (e) {
    throw new Error('Failed to parse YouTube playlist JSON data.');
  }

  const videos = [];
  let playlistTitle = 'Unknown Playlist';

  try {
    const contents = ytData?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents?.[0]
      ?.playlistVideoListRenderer?.contents;

    const headerRenderer = ytData?.header?.playlistHeaderRenderer;
    playlistTitle = headerRenderer?.title?.simpleText || headerRenderer?.title?.runs?.[0]?.text || 'Unknown Playlist';

    if (contents) {
      for (const item of contents) {
        const renderer = item?.playlistVideoRenderer;
        if (!renderer) continue;
        const videoId = renderer.videoId;
        if (!videoId) continue;
        const title = renderer.title?.runs?.[0]?.text || `Video ${videos.length + 1}`;
        const duration = renderer.lengthText?.simpleText || 'Unknown';
        videos.push({ id: videoId, title, duration });
      }
    }
  } catch (e) {
    // Fallback: regex extraction
    const regex = /\"videoId\":\"([a-zA-Z0-9_-]{11})\"/g;
    const seen = new Set();
    let match;
    while ((match = regex.exec(html)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        videos.push({ id: match[1], title: `Video ${videos.length + 1}`, duration: 'Unknown' });
      }
    }
  }

  if (videos.length === 0) {
    throw new Error('No videos found in this playlist. It may be private or empty.');
  }

  return { title: playlistTitle, videoCount: videos.length, videos };
}

/**
 * Fetch transcript for a single video using yt-dlp
 * Downloads subtitles only (no video), parses the VTT/SRT output
 */
export async function getVideoTranscript(videoId) {
  const outputBase = join(TEMP_DIR, `sub_${videoId}`);

  // Helper: find and parse any subtitle files that were downloaded
  function tryReadSubFiles() {
    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(`sub_${videoId}`) && (f.endsWith('.vtt') || f.endsWith('.srt')));
    if (files.length === 0) return null;

    const subFile = join(TEMP_DIR, files[0]);
    const content = fs.readFileSync(subFile, 'utf-8');
    const result = parseSubtitleFile(content);

    // Clean up all temp files
    for (const f of files) {
      try { fs.unlinkSync(join(TEMP_DIR, f)); } catch (e) { /* ignore */ }
    }

    if (result.text.length === 0) return null;

    const langMatch = files[0].match(/\.([a-z]{2}(?:-[a-zA-Z]+)?)\.(vtt|srt)$/);
    const language = langMatch ? langMatch[1] : 'unknown';

    console.log(`  📝 Transcript extracted for ${videoId} (lang: ${language}, ${result.segments.length} segments)`);

    return {
      success: true,
      text: result.text,
      segments: result.segments,
      charCount: result.text.length,
      language,
    };
  }

  try {
    // Use yt-dlp to download subtitles only (English first to avoid rate limits)
    await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
      writeAutoSub: true,
      writeSub: true,
      subLang: 'en',
      subFormat: 'vtt',
      skipDownload: true,
      output: outputBase + '.%(ext)s',
      noWarnings: true,
      noCallHome: true,
      noCheckCertificates: true,
    });
  } catch (err) {
    // yt-dlp may throw even on partial success (e.g., got English, failed on Tamil)
    // Check if subtitle files were created anyway
  }

  // Check for subtitle files (works whether yt-dlp succeeded or partially failed)
  const result = tryReadSubFiles();
  if (result) return result;

  return {
    success: false,
    text: '',
    error: 'yt-dlp could not extract subtitles for this video.',
  };
}

/**
 * Parse VTT or SRT subtitle content into text segments
 */
function parseSubtitleFile(content) {
  const segments = [];
  let fullText = '';
  const seen = new Set(); // deduplicate repeated lines

  // Split into blocks
  const blocks = content.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');

    // Find timestamp line (00:00:01.234 --> 00:00:03.456)
    let timestampLine = null;
    let textLines = [];

    for (const line of lines) {
      if (line.includes('-->')) {
        timestampLine = line;
      } else if (timestampLine && line.trim() && !line.match(/^\d+$/) && !line.startsWith('WEBVTT') && !line.startsWith('Kind:') && !line.startsWith('Language:')) {
        textLines.push(line.trim());
      }
    }

    if (timestampLine && textLines.length > 0) {
      // Parse timestamp
      const timeMatch = timestampLine.match(/(\d{2}):(\d{2}):(\d{2})/);
      let timestamp = '0:00';
      if (timeMatch) {
        const h = parseInt(timeMatch[1]);
        const m = parseInt(timeMatch[2]);
        const s = parseInt(timeMatch[3]);
        timestamp = h > 0
          ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${m}:${String(s).padStart(2, '0')}`;
      }

      // Clean text: remove VTT tags and formatting
      const text = textLines
        .join(' ')
        .replace(/<[^>]+>/g, '')       // strip HTML/VTT tags
        .replace(/\{[^}]+\}/g, '')     // strip SRT formatting
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .trim();

      // Deduplicate (auto-captions often repeat lines)
      if (text && !seen.has(text)) {
        seen.add(text);
        segments.push({ timestamp, text });
        fullText += text + ' ';
      }
    }
  }

  return { text: fullText.trim(), segments };
}
