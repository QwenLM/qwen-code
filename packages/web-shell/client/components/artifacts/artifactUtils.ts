import type {
  DaemonSessionArtifact,
  DaemonWorkspaceFileBytes,
} from '@qwen-code/sdk/daemon';
import type { DaemonWorkspaceActions } from '@qwen-code/webui/daemon-react-sdk';

export function artifactKindLabel(
  kind: string,
  workspacePath?: string,
): string {
  const ext = pathExtension(workspacePath);
  switch (ext) {
    case '.doc':
    case '.docx':
    case '.docm':
    case '.dotx':
    case '.odt':
      return 'Word';
    case '.xls':
    case '.xlsx':
    case '.xlsm':
    case '.xlsb':
    case '.ods':
      return 'Excel';
    case '.ppt':
    case '.pptx':
    case '.pptm':
    case '.odp':
      return 'PowerPoint';
    case '.csv':
      return 'CSV';
    default:
      break;
  }
  switch (kind) {
    case 'html':
      return 'HTML';
    case 'pdf':
      return 'PDF';
    case 'notebook':
      return 'Notebook';
    case 'document':
      return 'Document';
    default:
      return kind || 'artifact';
  }
}

// Keep in sync with OFFICE_DOCUMENT_EXTENSIONS in
// packages/core/src/utils/workspace-artifact-directory.ts
const OFFICE_DOCUMENT_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.docm',
  '.dotx',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.ppt',
  '.pptx',
  '.pptm',
  '.odt',
  '.ods',
  '.odp',
]);

const DOWNLOAD_ONLY_EXTENSIONS = new Set([
  ...OFFICE_DOCUMENT_EXTENSIONS,
  '.pdf',
  '.mp4',
  '.mov',
  '.webm',
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
]);

export function isOfficeDocumentPath(workspacePath?: string): boolean {
  return OFFICE_DOCUMENT_EXTENSIONS.has(pathExtension(workspacePath));
}

export function isDownloadOnlyWorkspaceArtifact(artifact: {
  kind?: string;
  workspacePath?: string;
  mimeType?: string;
}): boolean {
  const extension = pathExtension(artifact.workspacePath);
  const mimeType = normalizeArtifactMimeType(artifact.mimeType);
  if (
    extension === '.svg' ||
    mimeType === 'image/svg+xml' ||
    DOWNLOAD_ONLY_EXTENSIONS.has(extension)
  ) {
    return true;
  }
  if (
    getArtifactImageMimeType(artifact) ||
    extension === '.md' ||
    extension === '.markdown' ||
    extension === '.html' ||
    extension === '.htm' ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/html'
  ) {
    return false;
  }
  if (
    artifact.kind === 'image' ||
    artifact.kind === 'document' ||
    artifact.kind === 'pdf' ||
    artifact.kind === 'video' ||
    artifact.kind === 'audio'
  ) {
    return true;
  }
  return false;
}

function pathExtension(workspacePath?: string): string {
  const name = (workspacePath ?? '').split(/[/\\]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

// Mirrors WORKSPACE_CONTENT_SHA256_METADATA_KEY in the core package, which the
// Web Shell client cannot import.
const WORKSPACE_CONTENT_SHA256_METADATA_KEY = 'qwen.workspace.sha256';

export function getArtifactFreshnessKey(
  artifact: Pick<DaemonSessionArtifact, 'status' | 'updatedAt' | 'metadata'>,
): string {
  const workspaceHash =
    artifact.metadata?.[WORKSPACE_CONTENT_SHA256_METADATA_KEY];
  const hash = typeof workspaceHash === 'string' ? workspaceHash : '';
  return `${artifact.status}:${artifact.updatedAt}:${hash}`;
}

export function getArtifactTypeLabel(artifact: DaemonSessionArtifact): string {
  const artifactType = artifact.metadata?.['artifactType'];
  return typeof artifactType === 'string' && artifactType
    ? artifactType
    : artifactKindLabel(artifact.kind, artifact.workspacePath);
}

export function formatArtifactSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return '';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const MAX_WORKSPACE_FILE_BLOB_BYTES = 100 * 1024 * 1024;
const WORKSPACE_FILE_BLOB_CHUNK_BYTES = 100 * 1024;

export function normalizeArtifactMimeType(mimeType?: string): string {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function getArtifactImageMimeType(
  artifact: Pick<DaemonSessionArtifact, 'mimeType' | 'workspacePath'>,
): string | undefined {
  const mimeType = normalizeArtifactMimeType(artifact.mimeType);
  if (mimeType.startsWith('image/')) {
    if (mimeType === 'image/jpg') return 'image/jpeg';
    return Object.values(IMAGE_MIME_TYPES).includes(mimeType)
      ? mimeType
      : undefined;
  }
  return getImageMimeTypeFromPath(artifact.workspacePath ?? '');
}

export function getImageMimeTypeFromPath(path: string): string | undefined {
  const normalizedPath = path.toLowerCase();
  const extension = normalizedPath.includes('.')
    ? normalizedPath.split('.').pop()
    : undefined;
  return extension ? IMAGE_MIME_TYPES[extension] : undefined;
}

export function getReviewDownloadMimeType(value: string): string {
  return /\.html?$/i.test(value) ? 'text/html' : 'text/markdown';
}

export async function readWorkspaceFileAsBlob(
  readFileBytes: (
    filePath: string,
    opts?: { offset?: number; maxBytes?: number },
  ) => Promise<
    Pick<
      DaemonWorkspaceFileBytes,
      'contentBase64' | 'offset' | 'returnedBytes' | 'sizeBytes'
    >
  >,
  filePath: string,
  mimeType: string,
  options: {
    statFile: (
      filePath: string,
    ) => Promise<{ sizeBytes: number; modifiedMs: number; type?: string }>;
    isCancelled?: () => boolean;
    maxBytes?: number;
  },
): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  const maxBytes = options.maxBytes ?? MAX_WORKSPACE_FILE_BLOB_BYTES;
  const initialStat = await options.statFile(filePath);
  if (options.isCancelled?.()) {
    throw new Error('File loading was cancelled.');
  }
  if (initialStat.type === 'directory') {
    throw new Error('Directories cannot be opened or downloaded as artifacts.');
  }
  if (initialStat.sizeBytes > maxBytes) {
    throw new Error('File is too large to preview or download.');
  }
  let offset = 0;
  while (true) {
    if (options.isCancelled?.()) {
      throw new Error('File loading was cancelled.');
    }
    const file = await readFileBytes(filePath, {
      offset,
      maxBytes: WORKSPACE_FILE_BLOB_CHUNK_BYTES,
    });
    if (options.isCancelled?.()) {
      throw new Error('File loading was cancelled.');
    }
    if (file.sizeBytes !== initialStat.sizeBytes) {
      throw new Error('File changed while loading. Please retry.');
    }
    if (file.returnedBytes <= 0 && offset < initialStat.sizeBytes) {
      throw new Error('File loading made no progress.');
    }
    const binary = atob(file.contentBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    chunks.push(bytes);
    offset = file.offset + file.returnedBytes;
    if (offset >= initialStat.sizeBytes) {
      const finalStat = await options.statFile(filePath);
      if (options.isCancelled?.()) {
        throw new Error('File loading was cancelled.');
      }
      if (
        finalStat.sizeBytes !== initialStat.sizeBytes ||
        finalStat.modifiedMs !== initialStat.modifiedMs
      ) {
        throw new Error('File changed while loading. Please retry.');
      }
      return new Blob(chunks, { type: mimeType });
    }
  }
}

export async function downloadWorkspaceFile(
  workspaceActions: Pick<DaemonWorkspaceActions, 'readFileBytes' | 'stat'>,
  workspacePath: string,
  mimeType = 'application/octet-stream',
  isCancelled?: () => boolean,
): Promise<void> {
  const blob = await readWorkspaceFileAsBlob(
    (filePath, opts) => workspaceActions.readFileBytes(filePath, opts),
    workspacePath,
    mimeType,
    {
      statFile: (filePath) => workspaceActions.stat(filePath),
      isCancelled,
    },
  );
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download =
      normalizePath(workspacePath).split('/').at(-1) ?? workspacePath;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
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
  "default-src 'none'; base-uri 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;";

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

export function isHtmlArtifact(artifact: DaemonSessionArtifact): boolean {
  const path = artifact.workspacePath?.toLowerCase() ?? '';
  const mimeType = normalizeArtifactMimeType(artifact.mimeType);
  return (
    artifact.kind === 'html' ||
    path.endsWith('.html') ||
    path.endsWith('.htm') ||
    mimeType === 'text/html'
  );
}
