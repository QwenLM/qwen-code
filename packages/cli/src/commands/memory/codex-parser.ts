/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

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

function headings(lines: string[]): Heading[] {
  const result: Heading[] = [];
  let fence: string | undefined;
  for (const [start, line] of lines.entries()) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) {
      if (result.length > 0) result[result.length - 1].end = start;
      result.push({
        title: match[2].trim(),
        level: match[1].length,
        start,
        end: lines.length,
      });
    }
  }
  return result;
}

function metadata(lines: string[]): string[] {
  const result: string[] = [];
  let section = '';
  let fence: string | undefined;
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
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
    appliesTo.length > 0 ? appliesTo : explicit.length > 0 ? explicit : lines;
  const ambiguous = {
    reason:
      'Multiple or alternative project scopes. Choose one project in a reviewed source export.',
  };
  const unsupported = {
    reason:
      'Unsupported project scope annotation. Use an explicit cwd in a reviewed source export.',
  };
  const values = new Set<string>();
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
      /^on\s+(?:branch\s+)?(?:`[^`]+`|(?!\/|[A-Za-z]:[\\/])[^\s`,;()|]+)/i,
    );
    if (branch) {
      suffix = suffix.slice(branch[0].length).trim();
    } else if (supplemental) {
      const parenthetical = suffix.startsWith('(');
      const end = suffix.indexOf(parenthetical ? ')' : ';');
      if (parenthetical && end < 0) return unsupported;
      suffix =
        end < 0 ? '' : suffix.slice(end + (parenthetical ? 1 : 0)).trim();
    }
    if (/(?:^|[,;|]\s*)(?:\/|[A-Za-z]:[\\/])/.test(suffix)) {
      return ambiguous;
    }
    if (suffix && !/^[,;)]/.test(suffix)) return unsupported;
    values.add(value);
  }
  if (!values.size) {
    return {
      reason:
        'Missing project metadata (cwd). Add an explicit absolute cwd to a reviewed source export.',
    };
  }
  return values.size === 1 ? { sourceProject: [...values][0] } : ambiguous;
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
  section: Heading,
  warnings: string[],
  sourceFile: string,
): Array<{ content: string; line: number }> {
  const result: Array<{ content: string; line: number }> = [];
  let current: { content: string; line: number } | undefined;
  let blank = false;
  let fence: string | undefined;
  for (let index = section.start + 1; index < section.end; index++) {
    const line = lines[index];
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) {
        if (current) result.push(current);
        current = undefined;
        fence = marker;
        warnings.push(
          `${sourceFile}:${index + 1}: fenced code or transcript skipped.`,
        );
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
    const bullet = line.match(/^[-*+]\s+(.+)/);
    if (bullet) {
      if (current) result.push(current);
      current = { content: bullet[1], line: index + 1 };
    } else if (line.trim() === '') {
      blank = true;
      continue;
    } else if (current && (!blank || /^\s+/.test(line))) {
      current.content += `${blank ? '\n\n' : '\n'}${line}`;
    } else {
      if (current) result.push(current);
      current = { content: line.trim(), line: index + 1 };
    }
    blank = false;
  }
  if (current) result.push(current);
  return result.map((entry) => ({
    ...entry,
    content: entry.content
      .replace(/\s*\[Task\s+\d+(?:\s*[,;]\s*(?:Task\s+)?\d+)*\]\s*$/gim, '')
      .trim(),
  }));
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
    const allHeadings = headings(lines);
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
      for (const [ordinal, entry] of entries(
        lines,
        heading,
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
