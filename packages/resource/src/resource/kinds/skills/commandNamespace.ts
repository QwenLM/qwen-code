/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import nodePath from 'node:path';

const SEGMENT_RE = /[/\\]+/;

export interface PathImpl {
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
}

export interface DeriveCommandNameInput {
  filePath: string;
  baseDir: string;
  isSkillFile: boolean;
  pluginName?: string;
  path?: PathImpl;
}

export interface DerivedCommandName {
  identity: string;
  displayBase: string;
  namespace: string;
  leaf: string;
}

export function deriveCommandName(
  opts: DeriveCommandNameInput,
): DerivedCommandName | null {
  const p: PathImpl = opts.path ?? nodePath;
  const { filePath, baseDir, isSkillFile, pluginName } = opts;

  const targetDir = isSkillFile
    ? p.dirname(p.dirname(filePath))
    : p.dirname(filePath);

  const namespace = pathToNamespace(targetDir, baseDir, p);
  const leaf = isSkillFile
    ? p.basename(p.dirname(filePath))
    : p.basename(filePath, '.md');
  if (!leaf) return null;

  if (
    isSkillFile &&
    namespace === '' &&
    p.dirname(filePath) === stripTrailingSep(baseDir)
  ) {
    return null;
  }

  const displayBase = namespace ? `${namespace}:${leaf}` : leaf;
  const identity = pluginName !== undefined ? `${pluginName}:${displayBase}` : displayBase;
  if (!identity) return null;
  return { identity, displayBase, namespace, leaf };
}

export function pathToNamespace(
  targetDir: string,
  baseDir: string,
  p: PathImpl = nodePath,
): string {
  const normTarget = stripTrailingSep(targetDir);
  const normBase = stripTrailingSep(baseDir);
  if (normTarget === normBase) return '';

  const rel = p.relative(normBase, normTarget);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    p.isAbsolute(rel)
  ) {
    return '';
  }
  return rel.split(SEGMENT_RE).filter(Boolean).join(':');
}

function stripTrailingSep(s: string): string {
  return s.replace(/[/\\]+$/, '');
}
