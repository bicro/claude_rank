const AVATAR_CACHE_KEY = 'clauderank_avatar';
const AVATAR_TTL = 1000 * 60 * 60 * 24; // 24 hours

/**
 * Get a locally-cached avatar data URL. Fetches from the external URL once,
 * stores as base64 in localStorage, and returns cached version on subsequent calls.
 * Returns null if the URL is falsy or the fetch fails.
 */
export async function getCachedAvatar(url) {
  if (!url) return null;

  try {
    const cached = localStorage.getItem(AVATAR_CACHE_KEY);
    if (cached) {
      const { dataUrl, srcUrl, ts } = JSON.parse(cached);
      if (srcUrl === url && Date.now() - ts < AVATAR_TTL) {
        return dataUrl;
      }
    }
  } catch { /* corrupt cache, refetch */ }

  try {
    const res = await fetch(url);
    if (!res.ok) return url; // fallback to direct URL
    const blob = await res.blob();
    const dataUrl = await blobToDataUrl(blob);
    localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify({
      dataUrl,
      srcUrl: url,
      ts: Date.now(),
    }));
    return dataUrl;
  } catch {
    return url; // fallback to direct URL
  }
}

/** Clear the cached avatar (call on logout or provider change). */
export function clearCachedAvatar() {
  localStorage.removeItem(AVATAR_CACHE_KEY);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
