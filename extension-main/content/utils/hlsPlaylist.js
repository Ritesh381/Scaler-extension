// ============================================
// utils/hlsPlaylist.js
// Pure HLS (.m3u8) helpers: tell a master playlist from a media playlist,
// dedupe signed playlist URLs, and pick the one URL that stands for a whole
// stream out of everything a player requested for it (master + renditions).
// ============================================

/**
 * Is this playlist text a master playlist (lists renditions, not segments)?
 */
function hlsIsMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/i.test(text || "");
}

/**
 * Identity of a playlist URL without its query: signed CDN URLs change their
 * query on every request while naming the same playlist.
 */
function hlsStreamKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (_) {
    return String(url || "");
  }
}

/**
 * Given every playlist a player fetched for ONE stream ({url, text} — text may
 * be null when it couldn't be fetched), return the URL that stands for the
 * whole stream: the master playlist if one was fetched (the downloaders pick
 * the rendition they need from it), otherwise the first playlist requested.
 * @param {{url: string, text: (string|null)}[]} entries in request order
 * @returns {string|null}
 */
function hlsChooseTopLevelStream(entries) {
  const master = entries.find((e) => hlsIsMasterPlaylist(e.text));
  if (master) return master.url;
  return entries.length ? entries[0].url : null;
}
