/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { estimateMemoryImport } from '@qwen-code/qwen-code-core/memory/import-budget.js';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

export class MemoryImportRequestError extends Error {}

export const IMPORT_LIMITS = {
  files: 256,
  fileBytes: 512 * 1024,
  totalBytes: 8 * 1024 * 1024,
  sectionBytes: 64 * 1024,
  headings: 4096,
  markdownLines: 16_384,
  inlineMarkers: 4096,
} as const;
export interface ImportSourceFile {
  path: string;
  content: string;
}
export interface ImportSource {
  version: 1;
  source: 'codex';
  files: ImportSourceFile[];
}
export interface ImportSection {
  id: string;
  groupId: string;
  title: string;
  path: string;
  line: number;
  content: string;
  references: string[];
  suggestedScope: 'user' | 'project' | 'unassigned';
  sourceProject?: string;
  reason: string;
  selectable: boolean;
}
export interface ImportPreview {
  version: 1;
  kind: 'preview';
  digest: string;
  groups: Array<{
    id: string;
    scope: ImportSection['suggestedScope'];
    sourceProject?: string;
    sectionIds: string[];
    estimate: ReturnType<typeof estimateMemoryImport>;
  }>;
  sections: ImportSection[];
  warnings: string[];
  estimate: ReturnType<typeof estimateMemoryImport>;
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validSourcePath(value: string): boolean {
  return (
    value.length <= 512 &&
    !/[\\\p{Cc}]/u.test(value) &&
    !value.startsWith('/') &&
    !/^[a-z]:/i.test(value) &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..') &&
    (/^(?:MEMORY|memory_summary)\.md$/.test(value) ||
      // Keep in lockstep with the rollout reference discovery regex below:
      // a name outside this class is admitted but never discovered.
      /^rollout_summaries\/[\w.-]+\.md$/.test(value))
  );
}
export function validateSource(value: unknown): ImportSource {
  if (
    !record(value) ||
    value['version'] !== 1 ||
    value['source'] !== 'codex' ||
    !Array.isArray(value['files']) ||
    value['files'].length === 0 ||
    value['files'].length > IMPORT_LIMITS.files
  )
    throw new MemoryImportRequestError('Invalid version 1 Codex source set.');
  let bytes = 0;
  const seen = new Set<string>();
  const files = value['files'].map((file: unknown): ImportSourceFile => {
    if (
      !record(file) ||
      typeof file['path'] !== 'string' ||
      !validSourcePath(file['path']) ||
      typeof file['content'] !== 'string' ||
      file['content'].includes('\0')
    )
      throw new MemoryImportRequestError(
        'Invalid Codex Markdown resource. Only memory Markdown and rollout_summaries/*.md are accepted.',
      );
    const size = Buffer.byteLength(file['content']);
    bytes += size;
    if (
      size > IMPORT_LIMITS.fileBytes ||
      bytes > IMPORT_LIMITS.totalBytes ||
      seen.has(file['path'].toLowerCase())
    )
      throw new MemoryImportRequestError(
        'Source exceeds limits or contains duplicate paths.',
      );
    seen.add(file['path'].toLowerCase());
    return { path: file['path'], content: file['content'] };
  });
  if (
    !files.some(
      (file) => file.path === 'MEMORY.md' || file.path === 'memory_summary.md',
    )
  )
    throw new MemoryImportRequestError(
      'Select the Codex memories folder containing MEMORY.md or memory_summary.md.',
    );
  return {
    version: 1,
    source: 'codex',
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
const parser = unified().use(remarkParse);
function headingTitle(raw: string): string {
  const atx = raw.match(/^ {0,3}#{1,6}(?:[\t ]+|$)/);
  if (atx)
    return raw
      .slice(atx[0].length)
      .replace(/[\t ]+#+[\t ]*$/, '')
      .trim();
  // A setext heading's slice includes its underline on the next line.
  return raw
    .split(/\r\n|[\r\n]/)
    .slice(0, -1)
    .join(' ')
    .trim();
}
function scopeFor(
  content: string,
  title: string,
  summary: boolean,
): Pick<ImportSection, 'suggestedScope' | 'sourceProject' | 'reason'> {
  const scopes: Array<{ value: string; quoted: boolean; prose: boolean }> = [];
  for (const match of content.matchAll(
    /(?:^|[\s;(])cwd\s*[=:]\s*(?:`([^`\n]+)`|([^\r\n,;()\s]+))/gim,
  )) {
    if (match[1] !== undefined) {
      scopes.push({ value: match[1].trim(), quoted: true, prose: false });
      continue;
    }
    const trailing = content
      .slice(match.index + match[0].length)
      .split(/\r\n|[\r\n]/, 1)[0]!
      .trim();
    scopes.push({
      value: match[2].trim(),
      quoted: false,
      // The unquoted form ends at whitespace; prose after the value means the
      // capture is not a path.
      prose: /[^\s,;()]/.test(trailing),
    });
  }
  const heading = title.trim();
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(heading))
    scopes.push({
      value: heading.replace(/^`|`$/g, ''),
      quoted: false,
      prose: false,
    });
  const strip = (value: string) =>
    value.replace(/[\\/]+$/, '').replace(/[.:!?'"]+$/, '');
  const unique = [...new Set(scopes.map((scope) => strip(scope.value)))];
  if (
    unique.length === 1 &&
    /^(?:\/|[A-Za-z]:[\\/])/.test(unique[0]) &&
    scopes.every(
      (scope) =>
        !scope.prose &&
        !/[*?{}[\]\p{Cc}]|\bcwd\s*[=:]/u.test(scope.value) &&
        (scope.quoted || !/\s/.test(scope.value)),
    )
  )
    return {
      suggestedScope: 'project',
      sourceProject: unique[0],
      reason: 'Source project hint; explicit target mapping is required.',
    };
  if (scopes.length)
    return {
      suggestedScope: 'unassigned',
      reason: 'Ambiguous or unsupported project scope; assign explicitly.',
    };
  if (summary && /^(?:user profile|user preferences)$/i.test(title))
    return {
      suggestedScope: 'user',
      reason: 'Explicit user-level summary section.',
    };
  return {
    suggestedScope: 'unassigned',
    reason: 'No reliable project scope; assign explicitly.',
  };
}
export function previewSource(input: unknown): ImportPreview {
  const source = validateSource(input);
  const sections: ImportSection[] = [];
  const warnings: string[] = [];
  let headingCount = 0;
  let lineCount = 0;
  let markerCount = 0;
  let expandedBytes = 0;
  const paths = new Set(source.files.map((file) => file.path));
  const referenced = new Set<string>();
  for (const file of source.files.filter(
    (f) => !f.path.startsWith('rollout_summaries/'),
  )) {
    for (const match of file.content.matchAll(
      /rollout_summaries\/[\w.-]+\.md/g,
    ))
      referenced.add(match[0]);
  }
  for (const ref of referenced)
    if (!paths.has(ref)) warnings.push(`Missing referenced Markdown: ${ref}`);
  for (const file of source.files) {
    if (
      file.path.startsWith('rollout_summaries/') &&
      !referenced.has(file.path)
    ) {
      warnings.push(`Unreferenced supporting resource excluded: ${file.path}`);
      continue;
    }
    // remark parse cost is super-linear on heading-dense input, so reject an
    // over-approximate ATX count above a slack multiple of the cap before
    // parsing; the exact heading cap below still applies afterwards.
    const atxCandidates =
      file.content.match(/^ {0,3}#{1,6}(?:[\t ]|$)/gm)?.length ?? 0;
    if (headingCount + atxCandidates > 4 * IMPORT_LIMITS.headings)
      throw new MemoryImportRequestError(
        'Source exceeds the supported heading limit.',
      );
    // Bound parser work independently of heading syntax, including setext and
    // pathological inline delimiters. These conservative limits include code.
    for (let i = 0; i < file.content.length; i++) {
      const char = file.content[i];
      if (char === '\n' || (char === '\r' && file.content[i + 1] !== '\n'))
        lineCount++;
      if ('*_~[]<>!`&\\'.includes(char)) markerCount++;
      if (
        lineCount > IMPORT_LIMITS.markdownLines ||
        markerCount > IMPORT_LIMITS.inlineMarkers
      )
        throw new MemoryImportRequestError(
          'Source exceeds the Markdown complexity limit; split it into smaller source sets before importing.',
        );
    }
    const tree = parser.parse(file.content);
    const headings = tree.children
      .filter((node) => node.type === 'heading')
      .map((node, index, nodes) => ({
        offset: node.position!.start.offset!,
        line: node.position!.start.line,
        depth: node.depth as number,
        title: headingTitle(
          file.content.slice(
            node.position!.start.offset!,
            node.position!.end.offset!,
          ),
        ),
        preface: file.content
          .slice(
            node.position!.start.offset!,
            nodes[index + 1]?.position!.start.offset,
          )
          .trim(),
      }));
    headingCount += headings.length;
    if (headingCount > IMPORT_LIMITS.headings)
      throw new MemoryImportRequestError(
        'Source exceeds the supported heading limit.',
      );
    const scopedDepths = headings
      .filter(
        (heading) =>
          /^(?:`?\/|`?[A-Za-z]:[\\/])/.test(heading.title) ||
          /\bcwd\s*[=:]/i.test(heading.preface),
      )
      .map((heading) => heading.depth);
    const minDepth = headings.length
      ? Math.min(...headings.map((h) => h.depth))
      : 1;
    const depth = Math.max(
      file.path === 'memory_summary.md' ? 2 : minDepth,
      ...scopedDepths,
    );
    const boundaries = headings.filter((heading) => heading.depth <= depth);
    if (!boundaries.length || boundaries[0].offset > 0)
      boundaries.unshift({
        offset: 0,
        line: 1,
        title: file.path,
        depth: 0,
        preface: '',
      });
    for (let i = 0; i < boundaries.length; i++) {
      const boundary = boundaries[i];
      const own = file.content
        .slice(boundary.offset, boundaries[i + 1]?.offset)
        .trim();
      if (
        !own ||
        /^v\d+$/.test(own) ||
        own
          .split(/\r\n|[\r\n]/)
          .every((line) => !line.trim() || /^#{1,6}\s/.test(line))
      )
        continue;
      const ancestors: typeof headings = [];
      for (const heading of headings) {
        if (heading.offset >= boundary.offset) break;
        while (ancestors.length && ancestors.at(-1)!.depth >= heading.depth)
          ancestors.pop();
        ancestors.push(heading);
      }
      while (ancestors.length && ancestors.at(-1)!.depth >= boundary.depth)
        ancestors.pop();
      const parts = [...ancestors.map((heading) => heading.preface), own];
      expandedBytes +=
        parts.reduce((bytes, part) => bytes + Buffer.byteLength(part), 0) +
        2 * (parts.length - 1);
      if (expandedBytes > IMPORT_LIMITS.totalBytes)
        throw new MemoryImportRequestError(
          'Source expanded context exceeds 8 MiB; split shared context and project groups before importing.',
        );
      const content = parts.join('\n\n');
      let scope = scopeFor(
        content,
        boundary.title,
        file.path === 'memory_summary.md',
      );
      if (
        scope.suggestedScope === 'unassigned' &&
        !/\bcwd\s*[=:]/i.test(content)
      ) {
        const parent = ancestors.at(-1);
        if (parent)
          scope = scopeFor(
            content,
            parent.title,
            file.path === 'memory_summary.md',
          );
      }
      const references = [
        ...new Set(
          Array.from(
            content.matchAll(/rollout_summaries\/[\w.-]+\.md/g),
            (m) => m[0],
          ),
        ),
      ];
      const selectable =
        Buffer.byteLength(content) <= IMPORT_LIMITS.sectionBytes;
      if (!selectable)
        warnings.push(
          `${file.path}:${boundary.line}: section exceeds ${IMPORT_LIMITS.sectionBytes} bytes; split it before import.`,
        );
      const id = digest(`${file.path}\0${content}`);
      if (sections.some((section) => section.id === id)) continue;
      sections.push({
        id,
        groupId: digest(
          `${scope.suggestedScope}\0${scope.sourceProject ?? ''}`,
        ),
        title: boundary.title,
        path: file.path,
        line: boundary.line,
        content,
        references,
        ...scope,
        selectable,
      });
    }
  }
  const groups = new Map<
    string,
    Omit<ImportPreview['groups'][number], 'estimate'>
  >();
  for (const section of sections) {
    const group = groups.get(section.groupId) ?? {
      id: section.groupId,
      scope: section.suggestedScope,
      sourceProject: section.sourceProject,
      sectionIds: [],
    };
    group.sectionIds.push(section.id);
    groups.set(group.id, group);
  }
  return {
    version: 1,
    kind: 'preview',
    digest: digest(JSON.stringify(source)),
    groups: [...groups.values()].map((group) => ({
      ...group,
      estimate: estimateMemoryImport(
        sections.filter(
          (section) => section.selectable && section.groupId === group.id,
        ),
      ),
    })),
    sections,
    warnings,
    estimate: estimateMemoryImport(
      sections.filter((section) => section.selectable),
    ),
  };
}
export async function readLocalSource(
  directory: string,
): Promise<ImportSource> {
  const root = await fs.realpath(directory);
  const files: ImportSourceFile[] = [];
  const read = async (relative: string) => {
    const file = path.join(root, relative);
    const info = await fs.lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > IMPORT_LIMITS.fileBytes
    )
      throw new Error('Source must contain regular bounded Markdown files.');
    const handle = await fs.open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > IMPORT_LIMITS.fileBytes)
        throw new Error('Source changed while opening.');
      const buffer = Buffer.alloc(IMPORT_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (
        length > IMPORT_LIMITS.fileBytes ||
        files.reduce(
          (sum, entry) => sum + Buffer.byteLength(entry.content),
          length,
        ) > IMPORT_LIMITS.totalBytes
      )
        throw new Error('Source exceeds byte limits.');
      files.push({
        path: relative,
        content: buffer.subarray(0, length).toString('utf8'),
      });
    } finally {
      await handle.close();
    }
  };
  for (const name of ['MEMORY.md', 'memory_summary.md']) {
    try {
      await read(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const refs = new Set(
    files.flatMap((file) =>
      Array.from(
        file.content.matchAll(/rollout_summaries\/[\w.-]+\.md/g),
        (m) => m[0],
      ),
    ),
  );
  if (refs.size + files.length > IMPORT_LIMITS.files)
    throw new Error('Too many referenced source files.');
  if (refs.size) {
    const dir = await fs
      .lstat(path.join(root, 'rollout_summaries'))
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      });
    if (dir && (!dir.isDirectory() || dir.isSymbolicLink()))
      throw new Error('Supporting resource directory must not be a symlink.');
    if (dir)
      for (const ref of refs) {
        try {
          await read(ref);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
  }
  return validateSource({ version: 1, source: 'codex', files });
}
