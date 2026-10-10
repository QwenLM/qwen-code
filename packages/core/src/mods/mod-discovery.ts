/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { openNoFollow } from '../utils/no-follow-open.js';
import { isPathWithin } from '../extension/gemini-converter.js';
import {
  hasModControlCharacters,
  isModRecord,
  validateModDeclarations,
} from './mod-contract.js';
import type { ModDescriptor, ModDiagnostic } from './mod-types.js';

const HOOKS_FILE = 'hooks/hooks.json';

export class ModFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModFileError';
  }
}

function fileError(error: unknown): ModFileError {
  if (error instanceof ModFileError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new ModFileError('MOD_PATH_MISSING', 'A Mod file is missing.');
  }
  if (code === 'ELOOP' || code === 'EUNVERIFIABLE') {
    return new ModFileError(
      'MOD_ANALYSIS_INCOMPLETE',
      'A Mod file identity could not be verified.',
    );
  }
  return new ModFileError(
    'MOD_PATH_UNREADABLE',
    'A Mod file could not be read.',
  );
}

export async function resolveModFile(root: string, relativePath: string) {
  try {
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relativePath) ||
      relativePath.includes('\\') ||
      hasModControlCharacters(relativePath)
    ) {
      throw new ModFileError(
        'MOD_PATH_OUTSIDE',
        'A Mod path must be relative and contained in the package.',
      );
    }
    const realRoot = await fs.realpath(root);
    if (!(await fs.stat(realRoot)).isDirectory()) {
      throw new ModFileError(
        'MOD_PATH_NOT_FILE',
        'The Mod package root must be a directory.',
      );
    }
    const lexicalPath = path.resolve(realRoot, relativePath);
    if (!isPathWithin(lexicalPath, realRoot)) {
      throw new ModFileError(
        'MOD_PATH_OUTSIDE',
        'A Mod path escapes the package.',
      );
    }
    const realPath = await fs.realpath(lexicalPath);
    if (!isPathWithin(realPath, realRoot)) {
      throw new ModFileError(
        'MOD_PATH_OUTSIDE',
        'A Mod path resolves outside the package.',
      );
    }
    const stat = await fs.stat(realPath, { bigint: true });
    if (!stat.isFile()) {
      throw new ModFileError(
        'MOD_PATH_NOT_FILE',
        'A Mod path must identify a regular file.',
      );
    }
    return { realPath, lexicalPath, stat };
  } catch (error) {
    throw fileError(error);
  }
}

export async function readModFile(
  root: string,
  relativePath: string,
  maxBytes = 1024 * 1024,
): Promise<{ text: string; realPath: string }> {
  try {
    const checked = await resolveModFile(root, relativePath);
    if (checked.stat.size > BigInt(maxBytes)) {
      throw new ModFileError(
        'MOD_ANALYSIS_LIMIT',
        'A Mod file exceeds the analysis size limit.',
      );
    }
    const handle = await openNoFollow(checked.realPath);
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.ino === 0n ||
        before.dev !== checked.stat.dev ||
        before.ino !== checked.stat.ino ||
        before.size !== checked.stat.size ||
        before.mtimeNs !== checked.stat.mtimeNs ||
        before.ctimeNs !== checked.stat.ctimeNs
      ) {
        throw new ModFileError(
          'MOD_ANALYSIS_INCOMPLETE',
          'A Mod file changed during analysis.',
        );
      }
      const buffer = Buffer.alloc(maxBytes + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await handle.read(
          buffer,
          bytes,
          buffer.length - bytes,
          bytes,
        );
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      if (bytes > maxBytes) {
        throw new ModFileError(
          'MOD_ANALYSIS_LIMIT',
          'A Mod file exceeds the analysis size limit.',
        );
      }
      const after = await handle.stat({ bigint: true });
      const currentPath = await fs.realpath(checked.lexicalPath);
      const current = await fs.stat(currentPath, { bigint: true });
      if (
        currentPath !== checked.realPath ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      ) {
        throw new ModFileError(
          'MOD_ANALYSIS_INCOMPLETE',
          'A Mod file changed during analysis.',
        );
      }
      return {
        text: buffer.subarray(0, bytes).toString('utf8'),
        realPath: checked.realPath,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw fileError(error);
  }
}

export function splitModHooks(value: unknown): Record<string, unknown> {
  if (!isModRecord(value)) return {};
  const hooks = isModRecord(value['hooks']) ? value['hooks'] : value;
  return Object.fromEntries(
    Object.entries(hooks).filter(
      ([key]) => key !== 'modules' && key !== 'description' && key !== 'hooks',
    ),
  );
}

function hasModules(value: unknown): boolean {
  const pending = [value];
  let count = 0;
  while (pending.length > 0) {
    if (++count > 128) {
      throw new ModFileError(
        'MOD_ANALYSIS_LIMIT',
        'Hook declarations exceeded the analysis limit.',
      );
    }
    const current = pending.pop();
    if (Array.isArray(current)) pending.push(...current.slice(0, 128));
    else if (isModRecord(current)) {
      if ('modules' in current) return true;
      if (current['hooks'] !== undefined) pending.push(current['hooks']);
    }
  }
  return false;
}

function diagnostic(error: unknown, file: string): ModDiagnostic {
  const safe = fileError(error);
  return { code: safe.code, severity: 'error', message: safe.message, file };
}

async function readJson(root: string, file: string): Promise<unknown> {
  const { text } = await readModFile(root, file);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModFileError(
      'MOD_MANIFEST_INVALID',
      'A Mod declaration file is not valid JSON.',
    );
  }
}

async function optionalJson(root: string, file: string): Promise<unknown> {
  try {
    return await readJson(root, file);
  } catch (error) {
    if (error instanceof ModFileError && error.code === 'MOD_PATH_MISSING') {
      // A dangling link is an invalid declaration, rather than an absent file.
      try {
        await fs.lstat(path.resolve(root, file));
      } catch {
        return undefined;
      }
    }
    throw error;
  }
}

export async function discoverMod(
  root: string,
  suppliedManifest?: Record<string, unknown>,
  options: { strict?: boolean } = {},
): Promise<ModDescriptor> {
  const descriptor: ModDescriptor = {
    root: path.resolve(root),
    discovery: 'absent',
    diagnostics: [],
  };
  let manifest = suppliedManifest;
  let manifestFile = 'qwen-extension.json';
  let diagnosticFile = manifestFile;
  try {
    const realRoot = await fs.realpath(root);
    if (!(await fs.stat(realRoot)).isDirectory()) {
      throw new ModFileError(
        'MOD_PATH_NOT_FILE',
        'The Mod package root must be a directory.',
      );
    }
    descriptor.root = realRoot;
    if (!manifest) {
      let agent: unknown;
      try {
        agent = await optionalJson(realRoot, 'plugin.json');
      } catch (error) {
        if (
          error instanceof ModFileError &&
          [
            'MOD_PATH_OUTSIDE',
            'MOD_ANALYSIS_INCOMPLETE',
            'MOD_ANALYSIS_LIMIT',
          ].includes(error.code)
        ) {
          diagnosticFile = 'plugin.json';
          throw error;
        }
        agent = undefined;
      }
      if (
        isModRecord(agent) &&
        typeof agent['$schema'] === 'string' &&
        agent['$schema'].startsWith('https://agent-plugins.org/schemas/')
      )
        return descriptor;
      const qwen = await optionalJson(realRoot, manifestFile);
      if (qwen !== undefined) {
        if (!isModRecord(qwen))
          throw new ModFileError(
            'MOD_MANIFEST_INVALID',
            'The extension manifest must contain an object.',
          );
        manifest = qwen;
      } else {
        diagnosticFile = 'gemini-extension.json';
        const gemini = await optionalJson(realRoot, 'gemini-extension.json');
        if (
          isModRecord(gemini) &&
          typeof gemini['name'] === 'string' &&
          typeof gemini['version'] === 'string'
        ) {
          return descriptor;
        }
        diagnosticFile = '.qoder-plugin/plugin.json';
        try {
          await resolveModFile(realRoot, '.qoder-plugin/plugin.json');
          return descriptor;
        } catch (error) {
          if (
            !(error instanceof ModFileError) ||
            error.code !== 'MOD_PATH_MISSING'
          )
            throw error;
        }
        manifestFile = '.claude-plugin/plugin.json';
        diagnosticFile = manifestFile;
        const claude = await readJson(realRoot, manifestFile);
        if (!isModRecord(claude))
          throw new ModFileError(
            'MOD_MANIFEST_INVALID',
            'The plugin manifest must contain an object.',
          );
        manifest = claude;
      }
      if (
        typeof manifest['name'] !== 'string' ||
        manifest['name'].trim().length === 0
      ) {
        throw new ModFileError(
          'MOD_MANIFEST_INVALID',
          'The manifest must declare a nonempty plugin name.',
        );
      }
    }
    descriptor.userConfig = manifest['userConfig'];
    descriptor.types = manifest['types'];
    descriptor.dependencies = manifest['dependencies'];
    const unsupported = (file: string) =>
      descriptor.diagnostics.push({
        code: 'MOD_UNSUPPORTED_LOCATION',
        severity: 'error',
        file,
        message:
          'modules must be declared at the top level of hooks/hooks.json.',
      });
    if (Object.hasOwn(manifest, 'modules')) unsupported(manifestFile);
    const isCanonicalHooks = (value: string) =>
      !path.isAbsolute(value) &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) &&
      !value.includes('\\') &&
      !hasModControlCharacters(value) &&
      path.resolve(realRoot, value) === path.resolve(realRoot, HOOKS_FILE);
    const customHooks = Array.isArray(manifest['hooks'])
      ? manifest['hooks']
      : [manifest['hooks']];
    const unreadableHooks: unknown[] = [];
    for (const value of customHooks.slice(0, 128)) {
      if (typeof value === 'string') {
        if (isCanonicalHooks(value)) continue;
        let parsed: unknown;
        try {
          parsed = await readJson(realRoot, value);
        } catch (error) {
          unreadableHooks.push(error);
          continue;
        }
        if (hasModules(parsed)) unsupported(value);
      } else if (hasModules(value)) unsupported(manifestFile);
    }
    if (customHooks.length > 128) {
      descriptor.diagnostics.push({
        code: 'MOD_ANALYSIS_LIMIT',
        severity: 'error',
        message: 'Hook declarations exceeded the analysis limit.',
        file: manifestFile,
      });
    }
    diagnosticFile = HOOKS_FILE;
    let hooks: unknown;
    let canonicalReadFailed = false;
    try {
      hooks = await optionalJson(realRoot, HOOKS_FILE);
    } catch (error) {
      canonicalReadFailed = true;
      if (options.strict !== false)
        descriptor.diagnostics.push(diagnostic(error, HOOKS_FILE));
    }
    if (hooks !== undefined && !isModRecord(hooks)) {
      if (options.strict !== false) {
        descriptor.diagnostics.push({
          code: 'MOD_MODULES_INVALID',
          severity: 'error',
          message: 'The canonical hooks declaration must contain an object.',
          file: HOOKS_FILE,
        });
      } else if (hasModules(hooks)) unsupported(HOOKS_FILE);
    }
    if (isModRecord(hooks) && 'modules' in hooks) {
      descriptor.discovery = 'declared';
      for (const unreadable of unreadableHooks) {
        descriptor.diagnostics.push(diagnostic(unreadable, manifestFile));
      }
      if (Array.isArray(manifest['hooks'])) unsupported(manifestFile);
      const modules = hooks['modules'];
      if (
        !Array.isArray(modules) ||
        modules.length !== 1 ||
        typeof modules[0] !== 'string' ||
        modules[0].trim().length === 0
      ) {
        descriptor.diagnostics.push({
          code: 'MOD_MODULES_INVALID',
          severity: 'error',
          message:
            'modules must contain exactly one nonempty relative entry path.',
          file: HOOKS_FILE,
        });
      } else {
        const modulePath = modules[0];
        try {
          if (
            path.isAbsolute(modulePath) ||
            /^[A-Za-z][A-Za-z0-9+.-]*:/.test(modulePath) ||
            modulePath.includes('\\') ||
            hasModControlCharacters(modulePath)
          ) {
            throw new ModFileError(
              'MOD_PATH_OUTSIDE',
              'A Mod entry must be relative to hooks/hooks.json.',
            );
          }
          const relative = path.posix.normalize(
            path.posix.join('hooks', modulePath),
          );
          await resolveModFile(realRoot, relative);
          descriptor.entry = relative;
        } catch (error) {
          descriptor.diagnostics.push(diagnostic(error, HOOKS_FILE));
        }
      }
    } else if (isModRecord(hooks) && hasModules(hooks)) unsupported(HOOKS_FILE);
    if (
      descriptor.discovery === 'declared' ||
      descriptor.diagnostics.length > 0
    ) {
      descriptor.diagnostics.push(
        ...validateModDeclarations(
          {
            userConfig: descriptor.userConfig,
            types: descriptor.types,
            dependencies: descriptor.dependencies,
          },
          manifestFile,
        ),
      );
    }
    if (options.strict !== false && descriptor.discovery === 'absent') {
      if (unreadableHooks.length > 0) {
        descriptor.diagnostics.push({
          code: 'MOD_ANALYSIS_INCOMPLETE',
          severity: 'error',
          file: manifestFile,
          message: 'A custom hooks declaration could not be inspected.',
        });
      }
      if (
        !canonicalReadFailed &&
        hooks === undefined &&
        customHooks.some(
          (value) => typeof value === 'string' && isCanonicalHooks(value),
        )
      ) {
        descriptor.diagnostics.push({
          code: 'MOD_ANALYSIS_INCOMPLETE',
          severity: 'error',
          file: HOOKS_FILE,
          message: 'An explicitly declared hooks file could not be inspected.',
        });
      }
    }
  } catch (error) {
    descriptor.diagnostics.push(diagnostic(error, diagnosticFile));
  }
  if (descriptor.diagnostics.length > 100) {
    descriptor.diagnostics = descriptor.diagnostics.slice(0, 99);
    descriptor.diagnostics.push({
      code: 'MOD_ANALYSIS_LIMIT',
      severity: 'error',
      message: 'Declaration diagnostics exceeded the analysis limit.',
    });
  }
  if (descriptor.diagnostics.some((item) => item.severity === 'error'))
    descriptor.discovery = 'invalid';
  return descriptor;
}
