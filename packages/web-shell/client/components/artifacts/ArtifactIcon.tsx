import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  FileAudioIcon,
  FileTextIcon,
  NotebookTabsIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useWebShellCustomization } from '../../customization';
import csvIcon from '../../assets/artifacts/csv.svg';
import fileIcon from '../../assets/artifacts/file.svg';
import htmlIcon from '../../assets/artifacts/html.svg';
import imageIcon from '../../assets/artifacts/image.svg';
import linkIcon from '../../assets/artifacts/link.svg';
import mdIcon from '../../assets/artifacts/md.svg';
import pdfIcon from '../../assets/artifacts/pdf.svg';
import spreadsheetIcon from '../../assets/artifacts/spreadsheet.svg';
import videoIcon from '../../assets/artifacts/video.svg';
import wordIcon from '../../assets/artifacts/word.svg';
import {
  isAudioArtifact,
  normalizeArtifactMimeType,
  pathExtension,
} from './artifactUtils';

export type ArtifactIconKind =
  | 'csv'
  | 'file'
  | 'html'
  | 'image'
  | 'link'
  | 'md'
  | 'pdf'
  | 'spreadsheet'
  | 'video'
  | 'word';

export const ARTIFACT_ICON_URLS: Readonly<Record<ArtifactIconKind, string>> = {
  csv: csvIcon,
  file: fileIcon,
  html: htmlIcon,
  image: imageIcon,
  link: linkIcon,
  md: mdIcon,
  pdf: pdfIcon,
  spreadsheet: spreadsheetIcon,
  video: videoIcon,
  word: wordIcon,
};

const KIND_ICONS: Readonly<Record<string, ArtifactIconKind>> = {
  csv: 'csv',
  html: 'html',
  image: 'image',
  link: 'link',
  markdown: 'md',
  md: 'md',
  pdf: 'pdf',
  spreadsheet: 'spreadsheet',
  video: 'video',
  word: 'word',
};

const LEGACY_KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  audio: FileAudioIcon,
  document: FileTextIcon,
  notebook: NotebookTabsIcon,
};

const EXTENSION_ICONS: Readonly<Record<string, ArtifactIconKind>> = {
  avif: 'image',
  bmp: 'image',
  csv: 'csv',
  doc: 'word',
  docm: 'word',
  docx: 'word',
  dotx: 'word',
  gif: 'image',
  htm: 'html',
  html: 'html',
  ico: 'image',
  jpeg: 'image',
  jpg: 'image',
  md: 'md',
  markdown: 'md',
  mdx: 'md',
  mov: 'video',
  mp4: 'video',
  ods: 'spreadsheet',
  odt: 'word',
  pdf: 'pdf',
  png: 'image',
  svg: 'image',
  webm: 'video',
  webp: 'image',
  xls: 'spreadsheet',
  xlsb: 'spreadsheet',
  xlsm: 'spreadsheet',
  xlsx: 'spreadsheet',
};

export function getArtifactIconKind(
  artifact?: Pick<
    DaemonSessionArtifact,
    'kind' | 'title' | 'workspacePath' | 'url' | 'mimeType'
  >,
): ArtifactIconKind {
  if (!artifact) return 'file';

  const name = artifact.workspacePath ?? artifact.url ?? artifact.title;
  const extension = pathExtension(name).slice(1);
  if (extension && EXTENSION_ICONS[extension]) {
    return EXTENSION_ICONS[extension];
  }

  const mimeType = normalizeArtifactMimeType(artifact.mimeType);
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'text/csv') return 'csv';
  if (mimeType.includes('spreadsheet') || mimeType.includes('ms-excel')) {
    return 'spreadsheet';
  }
  if (
    mimeType.includes('wordprocessingml') ||
    mimeType === 'application/msword'
  ) {
    return 'word';
  }
  if (mimeType === 'text/html') return 'html';
  if (mimeType === 'text/markdown') return 'md';
  return KIND_ICONS[artifact.kind] ?? 'file';
}

export function ArtifactIcon({
  artifact,
  className,
}: {
  artifact?: DaemonSessionArtifact;
  className?: string;
}): ReactNode {
  const { artifact: customization } = useWebShellCustomization();
  const customIcon = artifact
    ? customization?.renderImage?.(artifact)
    : undefined;
  if (customIcon !== null && customIcon !== undefined && customIcon !== false) {
    return customIcon;
  }

  const kind = getArtifactIconKind(artifact);
  const name = artifact
    ? (artifact.workspacePath ?? artifact.url ?? artifact.title)
    : undefined;
  const legacyKind =
    kind === 'file' && artifact
      ? isAudioArtifact(name, artifact.mimeType)
        ? 'audio'
        : artifact.kind
      : undefined;
  const LegacyIcon = legacyKind ? LEGACY_KIND_ICONS[legacyKind] : undefined;
  if (LegacyIcon) {
    return (
      <LegacyIcon
        className={className}
        data-artifact-icon={legacyKind}
        aria-hidden="true"
      />
    );
  }
  return (
    <img
      className={className}
      src={ARTIFACT_ICON_URLS[kind]}
      data-artifact-icon={kind}
      alt=""
    />
  );
}
