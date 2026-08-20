const FILE_HEADER_OLD = /^---[ \t]+\S/
const FILE_HEADER_NEW = /^\+\+\+[ \t]+\S/
const GIT_DIFF_HEADER = /^diff --git[ \t]/
const FILE_HEADER_CAPTURE = /^(---|\+\+\+)[ \t]+([^\t\r\n]+)/
const VALID_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/
const HUNK_LIKE = /^@@(?:[ \t]|$)/

function isFileHeaderPair(lines: string[], index: number): boolean {
  return FILE_HEADER_OLD.test(lines[index] ?? '') && FILE_HEADER_NEW.test(lines[index + 1] ?? '')
}

function findFirstHunkIndex(lines: string[]): number {
  return lines.findIndex(line => HUNK_LIKE.test(line))
}

function findFileHeaderPairBefore(lines: string[], endIndex: number): number {
  for (let i = 0; i < endIndex - 1; i++) {
    if (isFileHeaderPair(lines, i)) return i
  }
  return -1
}

function hasGitHeaderBefore(lines: string[], endIndex: number): boolean {
  return lines.slice(0, endIndex).some(line => GIT_DIFF_HEADER.test(line))
}

function countGitHeaders(lines: string[]): number {
  return lines.filter(line => GIT_DIFF_HEADER.test(line)).length
}

function getHeaderPath(lines: string[], marker: '---' | '+++'): string | undefined {
  const headerLine = lines.find(line => line.startsWith(marker))
  return headerLine?.match(FILE_HEADER_CAPTURE)?.[2]
}

function toGitPath(path: string | undefined, side: 'a' | 'b'): string {
  if (path == null || path === '/dev/null') return `${side}/file`

  const normalized = path.replace(/^[ab]\//, '')
  return `${side}/${normalized}`
}

function withSyntheticGitHeader(prefixLines: string[]): string[] {
  if (prefixLines.some(line => GIT_DIFF_HEADER.test(line))) return prefixLines

  const oldPath = toGitPath(getHeaderPath(prefixLines, '---'), 'a')
  const newPath = toGitPath(getHeaderPath(prefixLines, '+++'), 'b')
  return [`diff --git ${oldPath} ${newPath}`, ...prefixLines]
}

function containsUnifiedFileBreakCandidate(lines: string[]): boolean {
  return lines.some(line => FILE_HEADER_OLD.test(line))
}

/**
 * Normalize a raw diff body (as found in a ```diff markdown code block) into a
 * unified diff shape that @pierre/diffs' PatchDiff can parse.
 *
 * - Already-valid single-file unified/git diffs are returned byte-identically.
 * - Valid numbered hunks without file headers get placeholder headers prepended.
 * - Bare or malformed @@ marker lines are collapsed into a single synthetic hunk.
 */
export function ensureUnifiedDiffFormat(raw: string): string {
  const lines = raw.split('\n')
  const hunkLines = lines.filter(line => HUNK_LIKE.test(line))
  const firstHunkIndex = findFirstHunkIndex(lines)
  const hunkSearchEnd = firstHunkIndex === -1 ? lines.length : firstHunkIndex

  const allHunksValid = hunkLines.length > 0 && hunkLines.every(line => VALID_HUNK.test(line))
  const hasGitHeader = hasGitHeaderBefore(lines, hunkSearchEnd)
  const fileHeaderPairIndex = findFileHeaderPairBefore(lines, hunkSearchEnd)
  const hasFileIdentity = hasGitHeader || fileHeaderPairIndex !== -1

  // PatchDiff only accepts a single file. Preserve multi-file patches unchanged
  // so the existing error boundary can fall back to CodeBlock rather than
  // pretending several files are one synthetic file.
  const isMultiFile = countGitHeaders(lines) > 1
  if (isMultiFile) return raw

  // Fast path for parse-ready diffs: valid hunks plus file identity are already
  // in the shape @pierre/diffs expects.
  if (allHunksValid && hasFileIdentity) return raw

  // Valid hunk-only diffs only need placeholder file headers. Preserve their
  // original hunk line metadata and multi-hunk structure. If the body contains
  // a deletion line that looks like a unified file header (`--- ...`), add a
  // synthetic git header so @pierre/diffs doesn't split it as a second file.
  if (allHunksValid) {
    const prefixLines = ['--- a/file', '+++ b/file']
    const outputPrefixLines = containsUnifiedFileBreakCandidate(lines)
      ? withSyntheticGitHeader(prefixLines)
      : prefixLines
    return [...outputPrefixLines, raw].join('\n')
  }

  // For malformed/bare markers, preserve the leading file metadata/header prefix
  // if one exists. With hunks present, everything before the first hunk is prefix.
  // Without hunks, preserve a leading unified header pair if present.
  let prefixEnd = 0
  if (hasFileIdentity && firstHunkIndex !== -1) {
    prefixEnd = firstHunkIndex
  } else if (fileHeaderPairIndex !== -1) {
    prefixEnd = fileHeaderPairIndex + 2
  }

  const prefixLines = prefixEnd > 0 ? lines.slice(0, prefixEnd) : ['--- a/file', '+++ b/file']
  const bodyLines = lines.slice(prefixEnd).filter(line => !HUNK_LIKE.test(line))
  const outputPrefixLines = containsUnifiedFileBreakCandidate(bodyLines)
    ? withSyntheticGitHeader(prefixLines)
    : prefixLines

  let origCount = 0
  let modCount = 0
  for (const line of bodyLines) {
    if (line.startsWith('-')) origCount++
    else if (line.startsWith('+')) modCount++
    else {
      origCount++
      modCount++
    }
  }

  return [
    ...outputPrefixLines,
    `@@ -1,${origCount} +1,${modCount} @@`,
    ...bodyLines,
  ].join('\n')
}
