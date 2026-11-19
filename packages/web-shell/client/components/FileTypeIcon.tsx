import {
  BracesIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCode2Icon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  PresentationIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentProps } from 'react';
import {
  ARTIFACT_ICON_URLS,
  getArtifactIconKind,
} from './artifacts/ArtifactIcon';

const EXTENSION_ICONS: ReadonlyArray<[ReadonlySet<string>, LucideIcon]> = [
  [new Set(['json', 'jsonl', 'geojson']), BracesIcon],
  [
    new Set([
      'js',
      'jsx',
      'ts',
      'tsx',
      'mjs',
      'cjs',
      'css',
      'html',
      'htm',
      'xml',
      'svg',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'c',
      'cc',
      'cpp',
      'h',
      'hpp',
      'sh',
      'sql',
      'yaml',
      'yml',
      'toml',
    ]),
    FileCode2Icon,
  ],
  [
    new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']),
    FileArchiveIcon,
  ],
  [new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods']), FileSpreadsheetIcon],
  [new Set(['ppt', 'pptx', 'odp']), PresentationIcon],
  [
    new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff']),
    FileImageIcon,
  ],
  [new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']), FileAudioIcon],
  [new Set(['mp4', 'mov', 'webm', 'avi', 'mkv']), FileVideoIcon],
  [
    new Set(['txt', 'md', 'mdx', 'log', 'pdf', 'doc', 'docx', 'rtf']),
    FileTextIcon,
  ],
];

function iconForFile(name: string, mimeType?: string): LucideIcon {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  for (const [extensions, Icon] of EXTENSION_ICONS) {
    if (extensions.has(extension)) return Icon;
  }
  if (mimeType?.startsWith('image/')) return FileImageIcon;
  if (mimeType?.startsWith('audio/')) return FileAudioIcon;
  if (mimeType?.startsWith('video/')) return FileVideoIcon;
  if (mimeType?.startsWith('text/')) return FileTextIcon;
  return FileIcon;
}

export function FileTypeIcon({
  name,
  mimeType,
  size = 24,
  absoluteStrokeWidth,
  ...props
}: ComponentProps<LucideIcon> & { name: string; mimeType?: string }) {
  const Icon = iconForFile(name, mimeType);
  const kind = getArtifactIconKind({
    kind: 'file',
    title: name.replace(/[?#]/g, '_'),
    mimeType,
  });
  if (kind !== 'file' || Icon === FileIcon) {
    return (
      <svg width={size} height={size} {...props} data-file-type-icon={kind}>
        <image href={ARTIFACT_ICON_URLS[kind]} width="100%" height="100%" />
      </svg>
    );
  }
  return (
    <Icon size={size} absoluteStrokeWidth={absoluteStrokeWidth} {...props} />
  );
}
