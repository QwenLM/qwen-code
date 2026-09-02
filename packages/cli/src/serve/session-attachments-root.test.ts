/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { tmpdir, homedir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_ATTACHMENTS_ROOT_ENV,
  defaultSessionAttachmentsRoot,
  resolveConfiguredSessionAttachmentsRoot,
  sessionAttachmentsRoots,
} from './session-attachments-root.js';

const originalEnvValue = process.env[SESSION_ATTACHMENTS_ROOT_ENV];

beforeEach(() => {
  delete process.env[SESSION_ATTACHMENTS_ROOT_ENV];
});

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[SESSION_ATTACHMENTS_ROOT_ENV];
  } else {
    process.env[SESSION_ATTACHMENTS_ROOT_ENV] = originalEnvValue;
  }
});

describe('session attachment root resolution', () => {
  const workspace = path.join(tmpdir(), 'qwen-attachments-workspace');
  const runtimeBaseDir = path.join(tmpdir(), 'qwen-runtime');
  const configuredRoot = path.join(tmpdir(), 'qwen-configured-attachments');
  const defaultRoot = defaultSessionAttachmentsRoot(workspace, runtimeBaseDir);
  const projectHash = path.basename(path.dirname(defaultRoot));

  it('defaults to the runtime temp dir under the workspace hash when unset', () => {
    expect(sessionAttachmentsRoots(workspace, runtimeBaseDir)).toEqual({
      root: defaultRoot,
    });
  });

  it('pins the default root to the legacy runtime temp layout', () => {
    // The fallback only works while the default root equals the pre-env
    // layout; assert it from the raw segments, not via the resolver.
    expect(defaultRoot).toBe(
      path.join(runtimeBaseDir, 'tmp', projectHash, 'attachments'),
    );
  });

  it('treats an empty env value as unset', () => {
    process.env[SESSION_ATTACHMENTS_ROOT_ENV] = '';
    expect(sessionAttachmentsRoots(workspace, runtimeBaseDir)).toEqual({
      root: defaultRoot,
    });
  });

  it('treats a whitespace-only env value as unset', () => {
    process.env[SESSION_ATTACHMENTS_ROOT_ENV] = '   ';
    expect(sessionAttachmentsRoots(workspace, runtimeBaseDir)).toEqual({
      root: defaultRoot,
    });
  });

  it('trims surrounding whitespace from a configured root', () => {
    process.env[SESSION_ATTACHMENTS_ROOT_ENV] = `  ${configuredRoot}  `;
    expect(sessionAttachmentsRoots(workspace, runtimeBaseDir)).toEqual({
      root: path.join(configuredRoot, projectHash, 'attachments'),
      fallback: defaultRoot,
    });
  });

  it('uses an absolute configured root and falls back to the default', () => {
    process.env[SESSION_ATTACHMENTS_ROOT_ENV] = configuredRoot;
    expect(sessionAttachmentsRoots(workspace, runtimeBaseDir)).toEqual({
      root: path.join(configuredRoot, projectHash, 'attachments'),
      fallback: defaultRoot,
    });
  });

  it('expands a leading tilde to the home directory', () => {
    process.env[SESSION_ATTACHMENTS_ROOT_ENV] = '~/attachments';
    expect(sessionAttachmentsRoots(workspace, runtimeBaseDir)).toEqual({
      root: path.join(homedir(), 'attachments', projectHash, 'attachments'),
      fallback: defaultRoot,
    });
  });

  it('resolves a bare tilde to the home directory itself', () => {
    process.env[SESSION_ATTACHMENTS_ROOT_ENV] = '~';
    expect(sessionAttachmentsRoots(workspace, runtimeBaseDir)).toEqual({
      root: path.join(homedir(), projectHash, 'attachments'),
      fallback: defaultRoot,
    });
  });

  it('resolves relative paths against the process cwd', () => {
    process.env[SESSION_ATTACHMENTS_ROOT_ENV] = 'relative/attachments';
    expect(sessionAttachmentsRoots(workspace, runtimeBaseDir)).toEqual({
      root: path.resolve(
        process.cwd(),
        'relative/attachments',
        projectHash,
        'attachments',
      ),
      fallback: defaultRoot,
    });
  });

  it('keeps the workspace hash segment separate per workspace', () => {
    const otherWorkspace = path.join(
      tmpdir(),
      'qwen-attachments-other-workspace',
    );
    const otherHash = path.basename(
      path.dirname(
        defaultSessionAttachmentsRoot(otherWorkspace, runtimeBaseDir),
      ),
    );
    process.env[SESSION_ATTACHMENTS_ROOT_ENV] = configuredRoot;
    expect(sessionAttachmentsRoots(otherWorkspace, runtimeBaseDir).root).toBe(
      path.join(configuredRoot, otherHash, 'attachments'),
    );
    expect(
      sessionAttachmentsRoots(otherWorkspace, runtimeBaseDir).root,
    ).not.toBe(sessionAttachmentsRoots(workspace, runtimeBaseDir).root);
  });

  it('expands a bare tilde in the standalone resolver', () => {
    expect(resolveConfiguredSessionAttachmentsRoot('~')).toBe(homedir());
  });

  it('keeps an absolute path unchanged in the standalone resolver', () => {
    expect(resolveConfiguredSessionAttachmentsRoot(configuredRoot)).toBe(
      configuredRoot,
    );
  });
});
