const LOCALE_SEGMENTS = new Set(['en', 'zh', 'de', 'fr', 'ja', 'ru', 'pt-BR']);

// Keep this in sync with the public top-level entries in docs/_meta.ts.
const PUBLIC_DOC_ROOTS = new Set(['users', 'developers']);

function publicRootFromSegments(segments = []) {
  if (segments.length === 0) {
    return undefined;
  }

  const rootIndex = LOCALE_SEGMENTS.has(segments[0]) ? 1 : 0;
  return segments[rootIndex];
}

function pathSegmentsFromRoute(route = '') {
  return route.split('/').filter(Boolean);
}

export function isPublicDocsPath(mdxPath = []) {
  const root = publicRootFromSegments(mdxPath);
  return root === undefined || PUBLIC_DOC_ROOTS.has(root);
}

export function isPublicDocsRoute(route = '') {
  const root = publicRootFromSegments(pathSegmentsFromRoute(route));
  return root === undefined || PUBLIC_DOC_ROOTS.has(root);
}
