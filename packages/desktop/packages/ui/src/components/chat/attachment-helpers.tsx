/**
 * Attachment helpers for displaying file type icons and labels
 *
 * Shared utilities for rendering file attachments in user messages.
 * Used by both Electron app and web viewer.
 */

import { File, Image as ImageIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AttachmentType } from '@craft-agent/core'

// Comprehensive MIME type to human-friendly label mapping
const MIME_TYPE_LABELS: Record<string, string> = {
  // Documents
  'application/pdf': 'PDF',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/rtf': 'RTF',

  // Text & Markup
  'text/plain': 'Text',
  'text/markdown': 'Markdown',
  'text/html': 'HTML',
  'text/css': 'CSS',
  'text/csv': 'CSV',
  'text/xml': 'XML',
  'application/xml': 'XML',
  'application/json': 'JSON',
  'application/x-yaml': 'YAML',
  'text/yaml': 'YAML',

  // Code
  'text/javascript': 'JavaScript',
  'application/javascript': 'JavaScript',
  'text/typescript': 'TypeScript',
  'application/typescript': 'TypeScript',
  'text/x-python': 'Python',
  'text/x-java': 'Java',
  'text/x-c': 'C',
  'text/x-c++': 'C++',
  'text/x-csharp': 'C#',
  'text/x-go': 'Go',
  'text/x-rust': 'Rust',
  'text/x-swift': 'Swift',
  'text/x-kotlin': 'Kotlin',
  'text/x-ruby': 'Ruby',
  'text/x-php': 'PHP',
  'application/x-sh': 'Shell',
  'text/x-shellscript': 'Shell',

  // Images
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/svg+xml': 'SVG',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',

  // Archives
  'application/zip': 'ZIP',
  'application/x-rar-compressed': 'RAR',
  'application/x-7z-compressed': '7-Zip',
  'application/gzip': 'GZIP',
  'application/x-tar': 'TAR',

  // Media
  'audio/mpeg': 'MP3',
  'audio/wav': 'WAV',
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
}

// Extension fallback for when MIME type is generic (e.g., application/octet-stream)
const EXTENSION_LABELS: Record<string, string> = {
  // Code
  'js': 'JavaScript',
  'ts': 'TypeScript',
  'tsx': 'React TSX',
  'jsx': 'React JSX',
  'py': 'Python',
  'rb': 'Ruby',
  'go': 'Go',
  'rs': 'Rust',
  'swift': 'Swift',
  'kt': 'Kotlin',
  'java': 'Java',
  'c': 'C',
  'cpp': 'C++',
  'h': 'Header',
  'cs': 'C#',
  'php': 'PHP',
  'sh': 'Shell',
  'bash': 'Bash',
  'zsh': 'Zsh',

  // Config
  'json': 'JSON',
  'yaml': 'YAML',
  'yml': 'YAML',
  'toml': 'TOML',
  'xml': 'XML',
  'ini': 'Config',
  'env': 'Env',

  // Docs
  'md': 'Markdown',
  'txt': 'Text',
  'rtf': 'RTF',
  'pdf': 'PDF',
  'doc': 'Word',
  'docx': 'Word',
  'xls': 'Excel',
  'xlsx': 'Excel',
  'ppt': 'PowerPoint',
  'pptx': 'PowerPoint',
  'csv': 'CSV',
}

/**
 * Get a human-friendly label for a file type
 */
export function getFileTypeLabel(type: AttachmentType, mimeType: string, fileName?: string): string {
  // 1. Check exact MIME type match
  if (MIME_TYPE_LABELS[mimeType]) {
    return MIME_TYPE_LABELS[mimeType]
  }

  // 2. Try to extract from filename extension
  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase()
    if (ext && EXTENSION_LABELS[ext]) {
      return EXTENSION_LABELS[ext]
    }
  }

  // 3. Fallback based on type category
  switch (type) {
    case 'pdf': return 'PDF'
    case 'office': return 'Document'
    case 'text': return 'Text'
    case 'image': return 'Image'
    default: return 'File'
  }
}

export interface FileTypeIconProps {
  type: AttachmentType
  mimeType: string
  className?: string
}

/**
 * File icon - ImageIcon for images, generic File icon with color tint for others
 */
export function FileTypeIcon({ type, mimeType, className }: FileTypeIconProps) {
  const baseClass = cn("h-4 w-4", className)

  // Images get dedicated icon
  if (type === 'image') {
    return <ImageIcon className={cn(baseClass, "text-accent")} />
  }

  // Everything else gets generic file icon with color tint
  const colorClass = getFileColor(type, mimeType)
  return <File className={cn(baseClass, colorClass)} />
}

function getFileColor(type: AttachmentType, mimeType: string): string {
  // Code files get success color
  if (isCodeFile(mimeType)) {
    return "text-success"
  }

  switch (type) {
    case 'pdf':
      return "text-destructive"
    case 'office':
      return "text-accent"
    case 'text':
      return "text-muted-foreground"
    default:
      return "text-muted-foreground"
  }
}

function isCodeFile(mimeType: string): boolean {
  const codeTypes = [
    'application/javascript',
    'application/typescript',
    'application/json',
    'text/javascript',
    'text/typescript',
    'text/x-python',
    'text/x-java',
    'text/css',
    'text/html',
    'text/xml',
    'application/xml',
    'text/yaml',
  ]
  return codeTypes.includes(mimeType) || mimeType.startsWith('text/x-')
}
