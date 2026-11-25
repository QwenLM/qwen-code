/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseArguments,
  parseArgumentNames,
  substituteArguments,
  substituteSkillBody,
  generateProgressiveArgumentHint,
} from './argumentSubstitution.js';
import { CONFIG_DIR, GLOBAL_CONFIG_DIR } from './paths.js';

describe('parseArguments', () => {
  it('should return empty array for empty input', () => {
    expect(parseArguments('')).toEqual([]);
    expect(parseArguments('  ')).toEqual([]);
  });

  it('should split simple space-separated args', () => {
    expect(parseArguments('foo bar baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('should handle double-quoted strings', () => {
    expect(parseArguments('foo "hello world" baz')).toEqual([
      'foo',
      'hello world',
      'baz',
    ]);
  });

  it('should handle single-quoted strings', () => {
    expect(parseArguments("foo 'hello world' baz")).toEqual([
      'foo',
      'hello world',
      'baz',
    ]);
  });

  it('should preserve $VARIABLE syntax literally', () => {
    const result = parseArguments('$HOME foo');
    expect(result).toContain('$HOME');
  });
});

describe('parseArgumentNames', () => {
  it('should return empty array for undefined', () => {
    expect(parseArgumentNames(undefined)).toEqual([]);
  });

  it('should parse space-separated string', () => {
    expect(parseArgumentNames('foo bar baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('should pass through array', () => {
    expect(parseArgumentNames(['foo', 'bar'])).toEqual(['foo', 'bar']);
  });

  it('should filter out numeric-only names', () => {
    expect(parseArgumentNames(['foo', '0', 'bar', '1'])).toEqual([
      'foo',
      'bar',
    ]);
  });

  it('should filter out empty strings', () => {
    expect(parseArgumentNames(['foo', '', 'bar'])).toEqual(['foo', 'bar']);
  });
});

describe('generateProgressiveArgumentHint', () => {
  it('should return remaining args as hint', () => {
    expect(generateProgressiveArgumentHint(['a', 'b', 'c'], ['x'])).toBe(
      '[b] [c]',
    );
  });

  it('should return undefined when all args filled', () => {
    expect(
      generateProgressiveArgumentHint(['a', 'b'], ['x', 'y']),
    ).toBeUndefined();
  });
});

describe('substituteArguments', () => {
  it('should return content unchanged when args is undefined', () => {
    expect(substituteArguments('hello $ARGUMENTS', undefined)).toBe(
      'hello $ARGUMENTS',
    );
  });

  it('should replace $ARGUMENTS with full args string', () => {
    expect(substituteArguments('Process: $ARGUMENTS', 'foo bar')).toBe(
      'Process: foo bar',
    );
  });

  it('should replace $ARGUMENTS[N] with indexed args', () => {
    expect(
      substituteArguments(
        'File: $ARGUMENTS[0], Mode: $ARGUMENTS[1]',
        'input.csv fast',
      ),
    ).toBe('File: input.csv, Mode: fast');
  });

  it('should replace $N shorthand with indexed args', () => {
    expect(
      substituteArguments('Source: $0, Target: $1', 'input.csv output.json'),
    ).toBe('Source: input.csv, Target: output.json');
  });

  it('should handle quoted arguments in positional args', () => {
    expect(
      substituteArguments(
        'File: $ARGUMENTS[0], Mode: $ARGUMENTS[1]',
        '"hello world" fast',
      ),
    ).toBe('File: hello world, Mode: fast');
  });

  it('should append ARGUMENTS when no placeholders found', () => {
    const result = substituteArguments('Just do the thing.', 'extra info');
    expect(result).toContain('Just do the thing.');
    expect(result).toContain('ARGUMENTS: extra info');
  });

  it('should not append when appendIfNoPlaceholder is false', () => {
    const result = substituteArguments(
      'Just do the thing.',
      'extra info',
      false,
    );
    expect(result).toBe('Just do the thing.');
  });

  it('should not append when args is empty string', () => {
    const result = substituteArguments('Just do the thing.', '');
    expect(result).toBe('Just do the thing.');
  });

  it('should replace named arguments', () => {
    const result = substituteArguments(
      'Source: $src, Target: $dst',
      'input.csv output.json',
      true,
      ['src', 'dst'],
    );
    expect(result).toBe('Source: input.csv, Target: output.json');
  });

  it('should not partially match named arguments', () => {
    const result = substituteArguments(
      'Value: $foobar, Short: $foo',
      'hello world',
      true,
      ['foo'],
    );
    expect(result).toContain('$foobar');
    expect(result).toContain('Short: hello');
  });

  it('should handle missing positional args gracefully', () => {
    expect(substituteArguments('A: $0, B: $1, C: $2', 'only-one')).toBe(
      'A: only-one, B: , C: ',
    );
  });
});

describe('substituteSkillBody', () => {
  it.each([false, true])(
    'keeps brand template markers literal (builtin: %s)',
    (isBuiltin) => {
      const body =
        'Create an agent for ${BRAND_CLI_NAME} (${BRAND_CLI_NAME_SHELL}): ${BRAND_ENV_PLUGIN_ROOT} ${BRAND_ENV_CONFIG_DIR} ~/${BRAND_ENV_USER_CONFIG_DIR}';

      expect(
        substituteSkillBody(
          { body, isBuiltin },
          {
            skillDir: '/skills/custom',
            sessionId: 'session',
          },
        ),
      ).toBe(body);
    },
  );

  it('should substitute args, QWEN_SKILL_DIR, and QWEN_SESSION_ID in one call', () => {
    const skill = {
      body: 'Run ${QWEN_SKILL_DIR}/run.sh with $ARGUMENTS (session: ${QWEN_SESSION_ID})',
      arguments: [{ name: 'file' }],
    };
    const result = substituteSkillBody(skill, {
      args: 'test.txt',
      skillDir: '/skills/my-skill',
      sessionId: 'abc-123',
    });
    expect(result).toBe(
      'Run /skills/my-skill/run.sh with test.txt (session: abc-123)',
    );
  });

  it('should work without arguments defined', () => {
    const skill = { body: 'Dir: ${QWEN_SKILL_DIR}' };
    const result = substituteSkillBody(skill, {
      skillDir: '/skills/x',
      sessionId: 'id-1',
    });
    expect(result).toBe('Dir: /skills/x');
  });

  it('should substitute ${QWEN_CONFIG_DIR} with brand config dir', () => {
    const skill = {
      body: 'Settings: ${QWEN_CONFIG_DIR}/settings.json, Hooks: ${QWEN_CONFIG_DIR}/hooks/',
    };
    const result = substituteSkillBody(skill, {
      skillDir: '/skills/x',
      sessionId: 'id-1',
    });
    expect(result).toBe(
      `Settings: ${CONFIG_DIR}/settings.json, Hooks: ${CONFIG_DIR}/hooks/`,
    );
  });

  it('should substitute ${QWEN_USER_CONFIG_DIR} with user-level config dir', () => {
    const skill = {
      body: 'User skills: ~/${QWEN_USER_CONFIG_DIR}/skills/, settings: ~/${QWEN_USER_CONFIG_DIR}/settings.json',
    };
    const result = substituteSkillBody(skill, {
      skillDir: '/skills/x',
      sessionId: 'id-1',
    });
    expect(result).toBe(
      `User skills: ~/${GLOBAL_CONFIG_DIR}/skills/, settings: ~/${GLOBAL_CONFIG_DIR}/settings.json`,
    );
  });

  it('leaves unsupported config directory placeholders unchanged', () => {
    const body = [
      '${UNKNOWN_CONFIG_DIR}/agents',
      '~/${UNKNOWN_USER_CONFIG_DIR}/skills',
      '${UNKNOWN_USER_CONFIG_DIR}',
    ].join('\n');

    expect(
      substituteSkillBody(
        { body },
        { skillDir: '/skills/x', sessionId: 'id-1' },
      ),
    ).toBe(body);
  });

  it('should substitute ${QWEN_PLUGIN_ROOT} (and CLAUDE alias) when plugin context is provided', () => {
    const skill = {
      body: 'Q=${QWEN_PLUGIN_ROOT}/a C=${CLAUDE_PLUGIN_ROOT}/b',
    };
    const result = substituteSkillBody(skill, {
      skillDir: '/skills/x',
      sessionId: 'id-1',
      pluginPath: '/plugins/demo',
    });
    expect(result).toBe('Q=/plugins/demo/a C=/plugins/demo/b');
  });

  it('should leave ${QWEN_PLUGIN_ROOT} literal without plugin context', () => {
    const skill = { body: 'Root: ${QWEN_PLUGIN_ROOT}/x' };
    const result = substituteSkillBody(skill, {
      skillDir: '/skills/x',
      sessionId: 'id-1',
    });
    expect(result).toBe('Root: ${QWEN_PLUGIN_ROOT}/x');
  });

  it('leaves ${CLAUDE_SESSION_ID} literal when not in plugin context', () => {
    const skill = {
      body: 'Q=${QWEN_SESSION_ID} C=${CLAUDE_SESSION_ID}',
    };
    const result = substituteSkillBody(skill, {
      skillDir: '/skills/x',
      sessionId: 'sess-42',
    });
    // CLAUDE_-prefixed alias is plugin-only — non-plugin skills must not pick
    // it up, otherwise we leak upstream-flavoured names into first-party
    // skill bodies.
    expect(result).toBe('Q=sess-42 C=${CLAUDE_SESSION_ID}');
  });

  it('substitutes ${CLAUDE_SESSION_ID} via plugin layer when pluginPath is set', () => {
    const skill = {
      body: 'Q=${QWEN_SESSION_ID} C=${CLAUDE_SESSION_ID}',
    };
    const result = substituteSkillBody(skill, {
      skillDir: '/plugins/demo',
      sessionId: 'sess-42',
      pluginPath: '/plugins/demo',
    });
    expect(result).toBe('Q=sess-42 C=sess-42');
  });
});
