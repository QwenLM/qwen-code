import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';

export function artifactKindLabel(kind: string): string {
  switch (kind) {
    case 'html':
      return 'HTML';
    case 'pdf':
      return 'PDF';
    case 'notebook':
      return 'Notebook';
    default:
      return kind || 'artifact';
  }
}

export function formatArtifactSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return '';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

export function getArtifactLocation(artifact: DaemonSessionArtifact): string {
  return artifact.workspacePath ?? artifact.url ?? artifact.managedId ?? '';
}

export function normalizePath(value: string | undefined): string {
  const normalized = (value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  const isAbsolute = normalized.startsWith('/');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const path = parts.join('/');
  return isAbsolute ? `/${path}` : path;
}

export function stripWorkspacePath(
  path: string,
  workspaceCwd?: string,
): string {
  const normalizedPath = normalizePath(path);
  const normalizedCwd = normalizePath(workspaceCwd);
  if (!normalizedCwd) return normalizedPath;
  if (normalizedPath === normalizedCwd) {
    return normalizedPath.split('/').pop() ?? normalizedPath;
  }
  const prefix = `${normalizedCwd}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : normalizedPath;
}

export function isSamePath(
  left: string | undefined,
  right: string | undefined,
  workspaceCwd?: string,
): boolean {
  const normalizedLeft = stripWorkspacePath(left ?? '', workspaceCwd);
  const normalizedRight = stripWorkspacePath(right ?? '', workspaceCwd);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

const ARTIFACT_PREVIEW_CSP =
  "default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src data: blob:;";

export function withArtifactPreviewCsp(html: string) {
  if (typeof DOMParser === 'undefined') {
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PREVIEW_CSP}"></head><body>${stripUnsafePreviewMarkup(html)}</body></html>`;
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc
    .querySelectorAll(
      'noscript, meta[http-equiv="refresh" i], meta[http-equiv="Content-Security-Policy" i]',
    )
    .forEach((element) => element.remove());
  const meta = doc.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = ARTIFACT_PREVIEW_CSP;
  doc.head.prepend(meta);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function stripUnsafePreviewMarkup(html: string) {
  return html
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?refresh["']?)[^>]*>/gi, '')
    .replace(
      /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?Content-Security-Policy["']?)[^>]*>/gi,
      '',
    );
}
