/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getReadFileDescription } from './read-file.js';
import { getReplaceDescription } from './edit.js';
import { getWriteFileDescription } from './write-file.js';
import { ReadFileTool } from '../../read-file.js';
import { EditTool } from '../../edit.js';
import { WriteFileTool } from '../../write-file.js';
import type { Config } from '../../../config/config.js';
import { SIMPLE_SYSTEM_PROMPT_ENV } from '../../../prompts/bundle-resolver.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getReadFileDescription', () => {
  it('provides concise Read guidance with bounded whole-file and targeted reads', () => {
    const full = getReadFileDescription('full');
    const lean = getReadFileDescription('lean');

    expect(lean).toContain('Reads a file from the local filesystem.');
    expect(lean).toContain('`file_path` must be an absolute path');
    for (const description of [full, lean]) {
      expect(description).toContain(
        'When you already know which part of the file you need, only read that part.',
      );
      expect(description).not.toContain('recommended to read the whole file');
    }
    expect(lean).toContain('Jupyter notebooks');
    expect(lean).toContain('Reads up to 2000 lines by default.');
    expect(full).toContain(
      'By default, it reads up to 2000 lines starting from the beginning of the file',
    );
    expect(lean.length).toBeLessThan(full.length);
  });

  it('discourages a redundant verification read after a successful edit', () => {
    expect(getReadFileDescription()).toContain(
      'Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.',
    );
  });
});

describe('Edit and Write Lean descriptions', () => {
  it('keeps exact-match and parameter guidance in the Lean Edit description', () => {
    const full = getReplaceDescription(false, 'full');
    const lean = getReplaceDescription(false, 'lean');

    expect(lean).toContain('exact string replacement');
    expect(lean).toContain('including indentation');
    expect(lean).toContain('line number + tab');
    expect(lean).toContain('`allow_multiple: true`');
    expect(lean).not.toContain('replace_all');
    expect(lean.length).toBeLessThan(full.length);
  });

  it('limits the Lean Edit read-first requirement to files outside the working directory', () => {
    expect(getReplaceDescription(true, 'lean')).toContain(
      'If the file is outside the working directory, you must Read it',
    );
    expect(getReplaceDescription(false, 'lean')).toContain(
      'You must Read the file in this conversation before editing',
    );
  });

  it('uses the same working-directory scope in full Edit and Write descriptions', () => {
    expect(getReplaceDescription(true, 'full')).toContain(
      'If the file is outside the working directory',
    );
    expect(getWriteFileDescription(true, 'full')).toContain(
      'If this is an existing file outside the working directory',
    );
    expect(getWriteFileDescription(false, 'full')).toContain(
      'If this is an existing file, you MUST use the Read tool first',
    );
  });

  it('reserves Lean Write for new files and complete replacements', () => {
    const full = getWriteFileDescription(false, 'full');
    const lean = getWriteFileDescription(false, 'lean');

    expect(lean).toContain('overwriting if one exists');
    expect(lean).toContain('creating a new file');
    expect(lean).toContain('fully replacing');
    expect(lean).toContain('For partial changes, use Edit instead');
    expect(lean.length).toBeLessThan(full.length);
  });

  it('routes all three tool schemas through the existing Lean bundle resolver', () => {
    vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, '1');
    const config = {} as Config;

    const descriptions = [
      new ReadFileTool(config).getSchema('lean-model').description ?? '',
      new EditTool(config).getSchema('lean-model').description ?? '',
      new WriteFileTool(config).getSchema('lean-model').description ?? '',
    ];

    expect(descriptions[0]).not.toContain('You can access any file directly');
    expect(descriptions[1]).toContain('`allow_multiple: true`');
    expect(descriptions[2]).toContain('For partial changes, use Edit instead');
  });
});
