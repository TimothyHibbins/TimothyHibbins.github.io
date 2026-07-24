const INVIDIOUS_INSTANCES = [
  "https://invidious.nerdvpn.de",
  "https://invidious.fdn.fr",
  "https://invidious.projectsegfau.lt"
];

function youtubeSearchUrlFor(title, artist) {
  const query = `${artist} ${title}`.trim();
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function timeoutSignal(milliseconds) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, clear: () => clearTimeout(timeoutId) };
}

function sanitizeDuration(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    const mins = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return `${mins}:${String(rem).padStart(2, "0")}`;
  }
  return "--:--";
}

function mapVideoToResult(video) {
  const id = video.videoId || video.video_id || "";
  const title = video.title || "Untitled";
  const artist = video.author || "Unknown";
  return {
    id,
    title,
    artist,
    url: id ? `https://www.youtube.com/watch?v=${id}` : (video.url || ""),
    durationLabel: sanitizeDuration(video.lengthSeconds),
    source: "youtube",
    youtubeSearchUrl: youtubeSearchUrlFor(title, artist)
  };
}

function mapItunesToResult(track) {
  const title = track.trackName || "Untitled";
  const artist = track.artistName || "Unknown";
  return {
    id: String(track.trackId || ""),
    title,
    artist,
    url: "",
    durationLabel: sanitizeDuration(Math.floor((track.trackTimeMillis || 0) / 1000)),
    source: "itunes",
    youtubeSearchUrl: youtubeSearchUrlFor(title, artist)
  };
}

async function searchItunes(query, maxResults) {
  const timeout = timeoutSignal(6500);
  const endpoint = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=${maxResults}`;

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: timeout.signal,
      headers: {
        Accept: "application/json"
      }
    });

    timeout.clear();

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    if (!payload || !Array.isArray(payload.results)) {
      return [];
    }

    return payload.results.slice(0, maxResults).map(mapItunesToResult);
  } catch (error) {
    timeout.clear();
    return [];
  }
}

async function searchInvidious(query, maxResults) {
  for (const baseUrl of INVIDIOUS_INSTANCES) {
    const endpoint = `${baseUrl}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
    const timeout = timeoutSignal(6500);

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        signal: timeout.signal,
        headers: {
          Accept: "application/json"
        }
      });

      timeout.clear();

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        continue;
      }

      const mapped = payload.slice(0, maxResults).map(mapVideoToResult).filter((item) => item.url);
      if (mapped.length) {
        return mapped;
      }
    } catch (error) {
      timeout.clear();
    }
  }

  return [];
}

export async function searchSongs(query, maxResults = 12) {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const youtubeResults = await searchInvidious(trimmed, maxResults);
  if (youtubeResults.length) {
    return youtubeResults;
  }

  const itunesResults = await searchItunes(trimmed, maxResults);
  if (itunesResults.length) {
    return itunesResults;
  }

  throw new Error("Search providers unavailable. Use manual title/artist + URL entry.");
}
