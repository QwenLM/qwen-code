import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composePostCompactHistory,
  extractRecentFilePaths,
} from './postCompactAttachments.js';
import { content, fnCall, fnResponse } from '../test-utils/model-fixtures.js';

describe('post-compaction file permission boundary', () => {
  it('excludes denied direct reads while keeping a successful read', () => {
    const history = [
      content(
        'model',
        fnCall('read_file', { file_path: '/ws/ok.ts' }, 'ok'),
        fnCall('read_file', { file_path: '/ws/.env' }, 'denied'),
      ),
      content(
        'user',
        fnResponse('read_file', { output: 'allowed' }, 'ok'),
        fnResponse('read_file', { error: 'Permission denied' }, 'denied'),
      ),
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual(['/ws/ok.ts']);
  });

  it.each([
    {
      name: 'success',
      response: { output: 'done' },
      expected: ['/ws/file.ts'],
    },
    { name: 'denied', response: { error: 'Permission denied' }, expected: [] },
    { name: 'cancelled', response: { error: 'Cancelled' }, expected: [] },
    { name: 'failed', response: { error: 'Execution failed' }, expected: [] },
    { name: 'unfinished', response: undefined, expected: [] },
  ])(
    'requires a successful bridge response: $name',
    ({ response, expected }) => {
      const history = [
        content(
          'model',
          fnCall(
            'tool_call',
            {
              name: 'read_file',
              arguments: { file_path: '/ws/file.ts' },
            },
            'outer',
          ),
        ),
      ];
      if (response)
        history.push(
          content('user', fnResponse('tool_call', response, 'outer')),
        );
      expect(extractRecentFilePaths(history, 5)).toEqual(expected);
    },
  );
});

it('restores an inside file while excluding outside files and escaping symlinks', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'post-compact-boundary-'));
  try {
    const workspace = join(temp, 'workspace');
    const sibling = join(temp, 'workspace-sibling');
    await mkdir(workspace);
    await mkdir(sibling);
    const inside = join(workspace, 'inside.txt');
    const outside = join(sibling, 'outside.txt');
    const secret = join(sibling, 'secret.txt');
    const link = join(workspace, 'link.txt');
    await writeFile(inside, 'INSIDE_CONTENT_MARKER');
    await writeFile(outside, 'OUTSIDE_CONTENT_MARKER');
    await writeFile(secret, 'SYMLINK_SECRET_MARKER');
    await symlink(secret, link);
    const paths = [inside, outside, link];
    const result = await composePostCompactHistory(
      [
        content(
          'model',
          ...paths.map((file_path, index) =>
            fnCall('read_file', { file_path }, String(index)),
          ),
        ),
        content(
          'user',
          ...paths.map((_, index) =>
            fnResponse('read_file', { output: 'read' }, String(index)),
          ),
        ),
      ],
      'SUMMARY',
      { workspaceRoot: workspace },
    );
    const text = result
      .flatMap((item) => item.parts ?? [])
      .map((part) => part.text ?? '')
      .join('\n');
    expect(text).toContain('INSIDE_CONTENT_MARKER');
    expect(text).not.toContain('OUTSIDE_CONTENT_MARKER');
    expect(text).not.toContain('SYMLINK_SECRET_MARKER');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
