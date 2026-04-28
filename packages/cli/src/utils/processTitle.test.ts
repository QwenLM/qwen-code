/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  composeSessionProcessTitle,
  setSessionProcessTitle,
  shortSessionId,
  shouldSetProcessTitle,
} from './processTitle.js';

describe('shortSessionId', () => {
  it('strips dashes and truncates to 8 chars', () => {
    expect(shortSessionId('12345678-aaaa-bbbb-cccc-dddddddddddd')).toBe(
      '12345678',
    );
  });

  it('passes through short ids unchanged', () => {
    expect(shortSessionId('abc')).toBe('abc');
  });

  it('falls back to the original id when stripping leaves nothing', () => {
    expect(shortSessionId('---')).toBe('---');
  });
});

describe('composeSessionProcessTitle', () => {
  it('renders base + session + cwd in the documented format', () => {
    const title = composeSessionProcessTitle(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
      '/home/user/projects/my-project',
    );
    expect(title).toBe('qwen-code session=12345678 cwd=my-project');
  });

  it('omits cwd when no work_dir is provided', () => {
    const title = composeSessionProcessTitle(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
    );
    expect(title).toBe('qwen-code session=12345678');
  });

  it('honors a custom base name', () => {
    const title = composeSessionProcessTitle('deadbeefcafebabe', undefined, {
      baseName: 'qwen-code-bg',
    });
    expect(title).toBe('qwen-code-bg session=deadbeef');
  });

  it('normalizes a trailing path separator', () => {
    const title = composeSessionProcessTitle(
      'abcdef0123456789',
      '/home/user/projects/my-project/',
    );
    expect(title).toContain('cwd=my-project');
  });

  it('replaces spaces in the cwd basename with underscores', () => {
    const title = composeSessionProcessTitle(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
      '/home/John Doe/my project',
    );
    expect(title).toBe('qwen-code session=12345678 cwd=my_project');
  });

  it('replaces "=" in the cwd basename with underscores', () => {
    const title = composeSessionProcessTitle(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
      '/srv/key=value',
    );
    expect(title).toBe('qwen-code session=12345678 cwd=key_value');
  });

  it('preserves non-ASCII path components', () => {
    const title = composeSessionProcessTitle(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
      // Forward-slash form so the assertion holds on both Win and POSIX.
      '/项目/我的-app',
    );
    expect(title).toBe('qwen-code session=12345678 cwd=我的-app');
  });

  it('split-on-whitespace yields exactly 3 tokens even with spaces in cwd', () => {
    const title = composeSessionProcessTitle(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
      '/x/a b c d',
    );
    expect(title.split(/\s+/)).toEqual([
      'qwen-code',
      'session=12345678',
      'cwd=a_b_c_d',
    ]);
  });

  it('sanitizes whitespace and "=" inside the session id token', () => {
    const title = composeSessionProcessTitle('my id=1', '/tmp/proj');
    expect(title.split(/\s+/)).toEqual([
      'qwen-code',
      'session=my_id_1',
      'cwd=proj',
    ]);
  });

  it('omits the cwd token when work_dir is empty string', () => {
    const title = composeSessionProcessTitle(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
      '',
    );
    expect(title).toBe('qwen-code session=12345678');
  });
});

describe('shouldSetProcessTitle', () => {
  it('skips Windows', () => {
    expect(shouldSetProcessTitle('win32')).toBe(false);
  });

  it.each(['linux', 'darwin', 'freebsd', 'openbsd'] as NodeJS.Platform[])(
    'sets on %s',
    (platform) => {
      expect(shouldSetProcessTitle(platform)).toBe(true);
    },
  );
});

describe('setSessionProcessTitle', () => {
  it('dispatches the composed title to the apply sink on POSIX-like platforms', () => {
    const captured: string[] = [];
    const result = setSessionProcessTitle(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
      '/tmp/proj',
      {
        platform: 'linux',
        apply: (t) => captured.push(t),
      },
    );
    expect(result).toBe('qwen-code session=12345678 cwd=proj');
    expect(captured).toEqual(['qwen-code session=12345678 cwd=proj']);
  });

  it('no-ops and returns null on Windows', () => {
    const captured: string[] = [];
    const result = setSessionProcessTitle(
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
      '/tmp/proj',
      {
        platform: 'win32',
        apply: (t) => captured.push(t),
      },
    );
    expect(result).toBeNull();
    expect(captured).toEqual([]);
  });

  it('swallows errors raised by the apply sink', () => {
    expect(() =>
      setSessionProcessTitle(
        '12345678-aaaa-bbbb-cccc-dddddddddddd',
        '/tmp/proj',
        {
          platform: 'linux',
          apply: () => {
            throw new Error('seccomp says no');
          },
        },
      ),
    ).not.toThrow();
  });

  it('honors custom baseName via options', () => {
    const captured: string[] = [];
    setSessionProcessTitle('abcdef00', '/x/proj', {
      platform: 'linux',
      baseName: 'qwen-code-acp',
      apply: (t) => captured.push(t),
    });
    expect(captured).toEqual(['qwen-code-acp session=abcdef00 cwd=proj']);
  });
});
