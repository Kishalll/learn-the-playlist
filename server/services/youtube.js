/**
 * YouTube Service — No-API-Key approach
 * Scrapes playlist page for video IDs
 * Scrapes video pages for transcript data (same approach as yt-dlp)
 */

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

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

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

  // Extract the ytInitialData JSON from the page
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
 * Fetch transcript for a single video by scraping its page
 * Extracts the captions track URL from ytInitialPlayerResponse, then fetches the XML
 */
export async function getVideoTranscript(videoId) {
  try {
    // Step 1: Fetch the video page to get captions track URL
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageRes = await fetch(pageUrl, { headers: HEADERS });
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);

    const html = await pageRes.text();

    // Extract captions data from the player response
    const playerMatch = html.match(/"captions":\s*(\{.*?"captionTracks":\s*\[.*?\].*?\})/s);
    if (!playerMatch) {
      return { success: false, text: '', error: 'No captions/subtitles available for this video.' };
    }

    // Parse out the captionTracks array
    const tracksMatch = playerMatch[1].match(/"captionTracks":\s*(\[.*?\])/s);
    if (!tracksMatch) {
      return { success: false, text: '', error: 'Could not parse caption tracks.' };
    }

    let tracks;
    try {
      tracks = JSON.parse(tracksMatch[1]);
    } catch (e) {
      return { success: false, text: '', error: 'Failed to parse caption tracks JSON.' };
    }

    if (!tracks || tracks.length === 0) {
      return { success: false, text: '', error: 'No caption tracks found.' };
    }

    // Pick the best track: prefer manual captions, then auto-generated
    let selectedTrack = tracks.find(t => t.kind !== 'asr') || tracks[0];
    let captionUrl = selectedTrack.baseUrl;

    if (!captionUrl) {
      return { success: false, text: '', error: 'No caption URL found.' };
    }

    // Step 2: Fetch the captions XML
    // Add fmt=json3 for JSON format (easier to parse than XML)
    const captionRes = await fetch(captionUrl + '&fmt=json3', { headers: HEADERS });
    if (!captionRes.ok) throw new Error(`Caption fetch failed: HTTP ${captionRes.status}`);

    const captionData = await captionRes.json();

    // Step 3: Extract text from the JSON3 format
    const events = captionData.events || [];
    let fullText = '';
    const segments = [];

    for (const event of events) {
      if (!event.segs) continue;

      const offsetMs = event.tStartMs || 0;
      const offsetSec = Math.floor(offsetMs / 1000);
      const hours = Math.floor(offsetSec / 3600);
      const mins = Math.floor((offsetSec % 3600) / 60);
      const secs = offsetSec % 60;
      const timestamp = hours > 0
        ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${mins}:${String(secs).padStart(2, '0')}`;

      const text = event.segs.map(s => s.utf8 || '').join('').trim();
      if (text && text !== '\n') {
        segments.push({ timestamp, text });
        fullText += text + ' ';
      }
    }

    if (fullText.trim().length === 0) {
      return { success: false, text: '', error: 'Transcript was empty.' };
    }

    return {
      success: true,
      text: fullText.trim(),
      segments,
      charCount: fullText.length,
      language: selectedTrack.languageCode || 'unknown',
    };

  } catch (err) {
    return {
      success: false,
      text: '',
      error: `Transcript extraction failed: ${err.message}`,
    };
  }
}
