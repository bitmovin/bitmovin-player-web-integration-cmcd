/**
 * Returns the path of `targetUrl` relative to `baseUrl` (e.g. `../300kbps/segment35.m4v`),
 * including the query of `targetUrl`.
 * Returns `null` if no relative path is possible, i.e. both URLs have a different origin.
 */
export function toRelativeUrl(baseUrl: string, targetUrl: string): string | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(targetUrl, base);
  } catch {
    return null;
  }

  if (base.origin !== target.origin) {
    return null;
  }

  // Directory segments of the base. The last segment is the file name of the current request.
  const baseDirSegments = base.pathname.split('/').slice(0, -1);
  const targetSegments = target.pathname.split('/');

  // Keep at least the file name of the target.
  let commonLength = 0;
  while (
    commonLength < baseDirSegments.length &&
    commonLength < targetSegments.length - 1 &&
    baseDirSegments[commonLength] === targetSegments[commonLength]
  ) {
    commonLength++;
  }

  const upSegments = new Array(baseDirSegments.length - commonLength).fill('..');
  let relativePath = [...upSegments, ...targetSegments.slice(commonLength)].join('/');

  // A colon in the first segment would make the path look like a URL scheme.
  if (upSegments.length === 0 && relativePath.split('/')[0].includes(':')) {
    relativePath = `./${relativePath}`;
  }

  return `${relativePath}${target.search}`;
}
