/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const markdown = unified().use(remarkParse);
type MarkdownNode = ReturnType<typeof markdown.parse>['children'][number];

export interface CodexMemoryCandidate {
  id: string;
  name: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  content: string;
  sourceFile: string;
  sourceLine: number;
  sourceProject?: string;
  reason?: string;
  updatedAt?: string;
}

interface SourceFile {
  path: string;
  content: string;
  mtimeMs: number;
}

interface Heading {
  title: string;
  level: number;
  start: number;
  end: number;
}

const MAX_ENTRY_CHARS = 4_000;
const HANDBOOK_SECTIONS = new Map<string, CodexMemoryCandidate['type']>([
  ['user preferences', 'feedback'],
  ['reusable knowledge', 'project'],
  ['failures and how to do differently', 'feedback'],
]);
const SUMMARY_SECTIONS = new Map<string, CodexMemoryCandidate['type']>([
  ['user profile', 'user'],
  ['user preferences', 'feedback'],
]);

function headings(nodes: MarkdownNode[], lines: string[]): Heading[] {
  const result: Heading[] = [];
  for (const node of nodes) {
    if (node.type !== 'heading') continue;
    const start = node.position!.start.line - 1;
    if (result.length) result[result.length - 1].end = start;
    result.push({
      title: lines[start]
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/\s+#+\s*$/, ''),
      level: node.depth,
      start,
      end: lines.length,
    });
  }
  return result;
}

function metadata(lines: string[]): string[] {
  const result: string[] = [];
  let section = '';
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) section = heading[1].toLowerCase();
    if (
      ((!section || /^task\s+\d+:/.test(section)) &&
        /^(?:applies_to|cwd|updated_at):\s*/i.test(line)) ||
      (section === 'rollout_summary_files' &&
        /^\s*-\s+rollout_summaries\/[^\n]+\(/.test(line))
    ) {
      result.push(line);
    }
  }
  return result;
}

function resolveProject(
  lines: string[],
): Pick<CodexMemoryCandidate, 'sourceProject' | 'reason'> {
  const appliesTo = lines.filter((line) => /^applies_to:/i.test(line));
  const explicit = lines.filter((line) => /^cwd:/i.test(line));
  const scopeLines =
    appliesTo.length || explicit.length ? [...appliesTo, ...explicit] : lines;
  const ambiguous = {
    reason:
      'Multiple or alternative project scopes. Choose one project in a reviewed source export.',
  };
  const unsupported = {
    reason:
      'Unsupported project scope annotation. Use an explicit cwd in a reviewed source export.',
  };
  const values = new Map<string, string>();
  for (const line of scopeLines) {
    const scope = line.split(/;\s*reuse_rule\s*=/i)[0];
    const assignment = /\bcwd\s*[=:]\s*/i.exec(scope);
    if (!assignment) continue;
    const rest = scope.slice(assignment.index + assignment[0].length);
    const quoted = rest.match(/^`([^`]+)`/);
    const boundary = rest.search(/[,;)]|\s+(?:(?:and|or|with|on)\b|\()/i);
    const value = quoted
      ? quoted[1]
      : (boundary < 0 ? rest : rest.slice(0, boundary)).trim();
    if (!quoted && /\s[\w.-]+\s*[=:]/.test(value)) return ambiguous;
    let suffix = rest.slice(quoted ? quoted[0].length : value.length).trim();
    suffix = suffix.replace(
      /^\(rollout metadata\s+cwd\s*[=:]\s*[^()\r\n]+\)\s*/i,
      '',
    );
    if (/\bcwd\s*[=:]/i.test(suffix)) return ambiguous;
    const family = suffix.match(
      /^or\s+([^\s,;()]+)\s+worktrees?(?=\s|[,;)]|$)/i,
    );
    const basename = value
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop();
    if (family && family[1] === basename)
      suffix = suffix.slice(family[0].length).trim();
    if (/[*?[\]{}]/.test(value)) {
      return {
        reason:
          'Wildcard project path. Replace it with an explicit project directory in a reviewed source export.',
      };
    }
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(value) || /[`\p{Cc}]/u.test(value)) {
      return {
        reason:
          'Invalid project path. Use an absolute path; quote paths containing scope delimiters with backticks.',
      };
    }
    if (
      (!quoted && /(?:\s+|\|)(?:\/|[A-Za-z]:[\\/])/.test(value)) ||
      /\b(?:and|or)\s+(?:\/|[A-Za-z]:[\\/])/i.test(suffix) ||
      /^or\b/i.test(suffix) ||
      /[;|]\s*(?:\/|[A-Za-z]:[\\/])/.test(suffix) ||
      (!/^(?:and|with)\s+(?:implementation\s+)?worktrees\s*=/i.test(suffix) &&
        /,\s*(?:\/|[A-Za-z]:[\\/])/.test(suffix))
    ) {
      return ambiguous;
    }
    const annotation = suffix.match(
      /^(?:(?:and|with)\s+(?:[\w-]+\s+){0,3}worktrees?|and\s+local\s+(?:macOS|Windows|Linux)\s+(?:[\w-]+\s+)?installation)(?=\s*(?:[,;)]|$))/i,
    );
    if (annotation) suffix = suffix.slice(annotation[0].length).trim();
    const supplemental = [
      /^(?:and|with)\s+(?:(?:implementation\s+)?worktrees?\s*=|isolated\b.*\bworktrees?\b)/i,
      /^with\s+(?:related\b|(?:[\w-]+\s+)?implementation\s+references\s+in\b)/i,
      /^\((?:source checkout\b|source investigation in\b|investigation began in\b|with\s+(?:[\w-]+\s+)?source\s+at\b)/i,
    ].some((pattern) => pattern.test(suffix));
    const branch = suffix.match(
      /^on\s+(?:branch\s+)?(?:`(?!\/|[A-Za-z]:[\\/])[^`]+`|(?!\/|[A-Za-z]:[\\/])[^\s`,;()|]+)/i,
    );
    if (branch) {
      suffix = suffix.slice(branch[0].length).trim();
    } else if (supplemental) {
      const parenthetical = suffix.startsWith('(');
      const end = suffix.indexOf(parenthetical ? ')' : ';');
      const annotation = end < 0 ? suffix : suffix.slice(0, end);
      if (
        Array.from(annotation.matchAll(/(?:^|[\s=,|`])(?:\/|[A-Za-z]:[\\/])/g))
          .length > 1
      )
        return ambiguous;
      if (parenthetical && end < 0) return unsupported;
      suffix =
        end < 0 ? '' : suffix.slice(end + (parenthetical ? 1 : 0)).trim();
    }
    if (/(?:^|[\s,;|(`])(?:\/|[A-Za-z]:[\\/])/.test(suffix)) {
      return ambiguous;
    }
    if (
      suffix &&
      !/^(?:[,;)]\s*)*(?:(?:updated_at|thread_id)\s*[=:]\s*[^\s,;)]+(?:[,;)]\s*)*)*$/i.test(
        suffix,
      )
    )
      return unsupported;
    const key =
      value.replace(/^[A-Za-z]:[\\/]/.test(value) ? /[\\/]+$/ : /\/+$/, '') ||
      value;
    if (!values.has(key)) values.set(key, value);
  }
  if (!values.size) {
    return {
      reason:
        'Missing project metadata (cwd). Add an explicit absolute cwd to a reviewed source export.',
    };
  }
  return values.size === 1
    ? { sourceProject: [...values.values()][0] }
    : ambiguous;
}

function sourceDate(lines: string[]): string | undefined {
  const dates = lines.flatMap((line) =>
    Array.from(
      line.matchAll(
        /\bupdated_at[=:]\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?=[,;\s)]|$)/g,
      ),
      (match) => match[1],
    ),
  );
  const valid = dates.filter((value) => {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    return (
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) ===
        value.slice(0, 10)
    );
  });
  valid.sort((a, b) => Date.parse(b) - Date.parse(a));
  return valid[0];
}

function entries(
  lines: string[],
  nodes: MarkdownNode[],
  section: Heading,
  warnings: string[],
  sourceFile: string,
): Array<{ content: string; line: number }> {
  const result: Array<{ content: string; line: number }> = [];
  for (const node of nodes) {
    const start = node.position!.start.line - 1;
    if (start <= section.start || start >= section.end) continue;
    if (
      node.type === 'heading' ||
      node.type === 'thematicBreak' ||
      node.type === 'code'
    )
      continue;
    if (node.type !== 'list' && node.type !== 'paragraph') {
      warnings.push(
        `${sourceFile}:${start + 1}: unsupported Markdown block skipped.`,
      );
      continue;
    }
    for (const item of node.type === 'list' ? node.children : [node]) {
      const first = item.position!.start.line - 1;
      const content = lines
        .slice(first, item.position!.end.line)
        .join('\n')
        .replace(node.type === 'list' ? /^\s*(?:[-*+]|\d+[.)])\s+/ : /$^/, '')
        .replace(/\s*\[Task\s+\d+(?:\s*[,;]\s*(?:Task\s+)?\d+)*\]\s*$/gim, '')
        .trim();
      result.push({ content, line: first + 1 });
    }
  }
  return result;
}

function candidateName(content: string): string {
  return content
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*#[\]"']/g, '')
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[\uD800-\uDBFF]$/, '');
}

export function parseCodexMemories(files: SourceFile[]): {
  candidates: CodexMemoryCandidate[];
  warnings: string[];
} {
  const candidates: CodexMemoryCandidate[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    if (file.path !== 'MEMORY.md' && file.path !== 'memory_summary.md') {
      warnings.push(`${file.path}: unsupported source file; skipped.`);
      continue;
    }
    const lines = file.content.replace(/\r\n?/g, '\n').split('\n');
    const tree = markdown.parse(lines.join('\n'));
    const codeBlocks: Array<{ start: number; end: number }> = [];
    const pending = [...tree.children];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'code' || node.type === 'html') {
        const start = node.position!.start.line - 1;
        const end = node.position!.end.line;
        codeBlocks.push({ start, end });
        for (let index = start; index < end; index++) lines[index] = '';
      } else if (
        'children' in node &&
        node.type !== 'paragraph' &&
        node.type !== 'heading'
      )
        pending.push(...node.children);
    }
    const allHeadings = headings(tree.children, lines);
    const skippedSections = allHeadings
      .filter((heading) =>
        ['general tips', 'rollout_summary_files'].includes(
          heading.title.toLowerCase(),
        ),
      )
      .map((heading) => ({
        start: heading.start,
        end:
          allHeadings.find(
            (next) => next.start > heading.start && next.level <= heading.level,
          )?.start ?? lines.length,
      }));
    const isSkipped = (line: number) =>
      skippedSections.some((range) => line > range.start && line < range.end);
    const summary = file.path === 'memory_summary.md';
    const sectionTypes = summary ? SUMMARY_SECTIONS : HANDBOOK_SECTIONS;
    const groupOccurrences = new Map<string, number>();
    const sectionOccurrences = new Map<string, number>();
    let group: Heading | undefined;
    let task: Heading | undefined;
    let groupKey = '';
    let groupMetadata: string[] = [];
    let canonicalScope: string[] = [];
    let recognized = 0;
    for (const heading of allHeadings) {
      if (isSkipped(heading.start)) continue;
      if (!summary && heading.level === 1) {
        group = /^Task Group:\s*\S/i.test(heading.title) ? heading : undefined;
        task = undefined;
        groupMetadata = [];
        canonicalScope = [];
        if (group) {
          const occurrence = (groupOccurrences.get(group.title) ?? 0) + 1;
          groupOccurrences.set(group.title, occurrence);
          groupKey = `${group.title}\0${occurrence}`;
          const end =
            allHeadings.find(
              (next) => next.start > heading.start && next.level === 1,
            )?.start ?? lines.length;
          groupMetadata = metadata(lines.slice(heading.start + 1, end));
          canonicalScope = metadata(
            lines.slice(heading.start + 1, heading.end),
          ).filter((line) => /^(?:applies_to|cwd):/i.test(line));
        }
      }
      if (!summary && heading.level === 2) {
        task = /^Task\s+\d+:/i.test(heading.title) ? heading : undefined;
      }
      const section = heading.title.toLowerCase();
      const type = sectionTypes.get(section);
      if (section === 'general tips') {
        warnings.push(
          `${file.path}:${heading.start + 1}: General Tips skipped because its scope is ambiguous.`,
        );
      }
      if (!type) continue;
      if ((!summary && !group) || (summary && heading.level > 2)) {
        warnings.push(
          `${file.path}:${heading.start + 1}: recognized section has unsupported ownership; skipped.`,
        );
        continue;
      }
      recognized++;
      let sourceMetadata = groupMetadata;
      if (task) {
        const end =
          allHeadings.find(
            (next) => next.start > task!.start && next.level <= task!.level,
          )?.start ?? lines.length;
        const taskMetadata = metadata(lines.slice(task.start + 1, end));
        sourceMetadata = [...canonicalScope, ...taskMetadata];
      }
      const resolution = summary
        ? {}
        : resolveProject(
            canonicalScope.length ? canonicalScope : sourceMetadata,
          );
      if (resolution.reason) {
        warnings.push(
          `${file.path}:${heading.start + 1}: ${resolution.reason}`,
        );
      }
      const updatedAt = summary ? undefined : sourceDate(sourceMetadata);
      const sectionKey = `${groupKey}\0${task?.title ?? ''}\0${section}`;
      const occurrence = (sectionOccurrences.get(sectionKey) ?? 0) + 1;
      sectionOccurrences.set(sectionKey, occurrence);
      const end =
        allHeadings.find(
          (next) => next.start > heading.start && next.level <= heading.level,
        )?.start ?? lines.length;
      const nested = allHeadings
        .filter(
          (next) =>
            next.start > heading.start &&
            next.start < end &&
            sectionTypes.has(next.title.toLowerCase()),
        )
        .map((next) => ({
          start: next.start,
          end:
            allHeadings.find(
              (after) => after.start > next.start && after.level <= next.level,
            )?.start ?? lines.length,
        }));
      const belongs = (line: number) =>
        !isSkipped(line) &&
        !nested.some((range) => line > range.start && line < range.end);
      for (const block of codeBlocks) {
        if (
          block.start > heading.start &&
          block.start < end &&
          belongs(block.start)
        )
          warnings.push(
            `${file.path}:${block.start + 1}-${block.end}: fenced code, transcript, or HTML skipped.`,
          );
      }
      for (const [ordinal, entry] of entries(
        lines,
        tree.children.filter((node) => belongs(node.position!.start.line - 1)),
        { ...heading, end },
        warnings,
        file.path,
      ).entries()) {
        if (entry.content.length === 0) continue;
        if (entry.content.length > MAX_ENTRY_CHARS) {
          warnings.push(
            `${file.path}:${entry.line}: entry exceeds ${MAX_ENTRY_CHARS} characters; skipped without truncation.`,
          );
          continue;
        }
        const id = createHash('sha256')
          .update(`${file.path}\0${sectionKey}\0${occurrence}\0${ordinal}`)
          .digest('hex')
          .slice(0, 20);
        candidates.push({
          id,
          name: candidateName(entry.content) || 'Codex memory',
          type,
          content: entry.content,
          sourceFile: file.path,
          sourceLine: entry.line,
          ...resolution,
          updatedAt,
        });
      }
    }
    if (recognized === 0) {
      warnings.push(`${file.path}: no supported memory sections found.`);
    }
  }
  return { candidates, warnings };
}
