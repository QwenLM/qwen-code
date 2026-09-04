const LOCALE_SEGMENTS = new Set(['en', 'zh', 'de', 'fr', 'ja', 'ru', 'pt-BR']);

// Keep this in sync with the public top-level page entries in docs/_meta.ts.
// docs-site/scripts/link-public-docs.mjs consumes the same allowlist.
export const PUBLIC_DOC_ROOTS = ['users', 'developers'];

const PUBLIC_DOC_ROOT_SET = new Set(PUBLIC_DOC_ROOTS);

function publicRootFromSegments(segments = []) {
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    return undefined;
  }

  const rootIndex = LOCALE_SEGMENTS.has(segments[0]) ? 1 : 0;
  return segments[rootIndex];
}

export function isPublicDocsPath(mdxPath = []) {
  const root = publicRootFromSegments(mdxPath);
  return root === undefined || PUBLIC_DOC_ROOT_SET.has(root);
}

export function filterPublicStaticParams(staticParams = []) {
  return staticParams.filter((staticParam) => {
    if (!Array.isArray(staticParam?.mdxPath)) {
      throw new TypeError(
        'Expected generateStaticParamsFor("mdxPath") to return objects with an mdxPath array.',
      );
    }

    return isPublicDocsPath(staticParam.mdxPath);
  });
}
