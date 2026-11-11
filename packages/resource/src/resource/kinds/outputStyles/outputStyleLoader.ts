/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { parseBooleanFrontmatter } from '../skills/frontmatterParsers.js';
import type {
  OutputStyleConfig,
  OutputStyleSource,
  OutputStyleLoadOptions,
} from './types.js';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/;

function coerceDescriptionToString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return null;
}

function reportError(
  options: OutputStyleLoadOptions | undefined,
  filePath: string,
  error: unknown,
): void {
  options?.onError?.({
    filePath,
    message: error instanceof Error ? error.message : String(error),
  });
}

interface RawStyle {
  filePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  source: OutputStyleSource;
  pluginName?: string;
}

/**
 * Parse a single `.md` file into a `RawStyle`.
 */
async function readMarkdownFile(
  filePath: string,
  source: OutputStyleSource,
  pluginName?: string,
  options?: OutputStyleLoadOptions,
): Promise<RawStyle | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const match = content.match(FRONTMATTER_REGEX);
    let frontmatter: Record<string, unknown> = {};
    let body = content;
    if (match) {
      const fmStr = match[1] ?? '';
      body = (match[2] ?? '').trimStart();
      try {
        const parsed = loadYaml(fmStr);
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed)
        ) {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch (err) {
        reportError(options, filePath, err);
      }
    }
    return { filePath, frontmatter, body, source, pluginName };
  } catch (err) {
    reportError(options, filePath, err);
    return null;
  }
}

async function readMarkdownDir(
  dir: string,
  source: OutputStyleSource,
  pluginName?: string,
  options?: OutputStyleLoadOptions,
): Promise<RawStyle[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      reportError(options, dir, error);
    return [];
  }

  const out: RawStyle[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && options?.recursive) {
      // Recurse into subdirectories for plugin output-styles
      const nested = await readMarkdownDir(
        fullPath,
        source,
        pluginName,
        options,
      );
      out.push(...nested);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    const raw = await readMarkdownFile(
      fullPath,
      source,
      pluginName,
      options,
    );
    if (raw) out.push(raw);
  }
  return out;
}

function extractDescriptionFromBody(
  body: string,
  fallback: string,
): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  if (firstLine) {
    return firstLine.length > 200
      ? firstLine.slice(0, 200) + '…'
      : firstLine;
  }
  return fallback;
}

function rawToConfig(
  raw: RawStyle,
  options?: OutputStyleLoadOptions,
): OutputStyleConfig | null {
  try {
    const fileName = path.basename(raw.filePath);
    const styleName = fileName.replace(/\.md$/i, '');
    const nameField = raw.frontmatter['name'];
    const name =
      typeof nameField === 'string' && nameField.trim().length > 0
        ? nameField.trim()
        : styleName;

    const description =
      coerceDescriptionToString(raw.frontmatter['description']) ??
      extractDescriptionFromBody(
        raw.body,
        `Custom ${styleName} output style`,
      );

    // Parse keep-coding-instructions frontmatter field.
    let keepCodingInstructions: boolean | undefined;
    const rawKCI = raw.frontmatter['keep-coding-instructions'];
    if (rawKCI !== undefined) {
      keepCodingInstructions = parseBooleanFrontmatter(rawKCI);
    }

    // Parse force-for-plugin frontmatter field (only meaningful for plugin styles).
    let forceForPlugin: boolean | undefined;
    const rawForce = raw.frontmatter['force-for-plugin'];
    if (rawForce !== undefined) {
      forceForPlugin = parseBooleanFrontmatter(rawForce);
    }

    // Namespace plugin styles as `pluginName:styleName` to avoid collisions.
    const finalName =
      raw.source === 'plugin' && raw.pluginName
        ? `${raw.pluginName}:${name}`
        : name;

    return {
      name: finalName,
      description,
      prompt: raw.body.trim(),
      source: raw.source,
      pluginName: raw.pluginName,
      keepCodingInstructions,
      forceForPlugin,
    };
  } catch (err) {
    reportError(options, raw.filePath, err);
    return null;
  }
}

/** One-shot directory scan. Workspace directories are owned by the scoped resources. */
export async function loadOutputStylesFromDir(
  dir: string,
  source: OutputStyleSource,
  pluginName?: string,
  options?: OutputStyleLoadOptions,
): Promise<OutputStyleConfig[]> {
  const raws = await readMarkdownDir(dir, source, pluginName, options);
  const configs: OutputStyleConfig[] = [];
  for (const raw of raws) {
    const cfg = rawToConfig(raw, options);
    if (cfg) configs.push(cfg);
  }
  return configs;
}

/**
 * Load output styles from a manifest-declared path that may be either a
 * directory of `.md` files or a single `.md` file. Mirrors how plugin
 * `outputStyles` entries are interpreted at the consumer level.
 */
export async function loadOutputStylesFromPath(
  entryPath: string,
  source: OutputStyleSource,
  pluginName?: string,
  options?: OutputStyleLoadOptions,
): Promise<OutputStyleConfig[]> {
  let stats;
  try {
    stats = await fs.stat(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      reportError(options, entryPath, error);
    return [];
  }
  if (stats.isDirectory()) {
    return loadOutputStylesFromDir(entryPath, source, pluginName, {
      ...options,
      recursive: true,
    });
  }
  if (stats.isFile() && entryPath.toLowerCase().endsWith('.md')) {
    const raw = await readMarkdownFile(
      entryPath,
      source,
      pluginName,
      options,
    );
    if (!raw) return [];
    const cfg = rawToConfig(raw, options);
    return cfg ? [cfg] : [];
  }
  return [];
}
