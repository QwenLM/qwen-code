/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { expandMcpEnvVars } from './mcpEnvExpansion.js';

describe('expandMcpEnvVars', () => {
  const env = {
    API_HOST: 'https://api.example.com',
    TOKEN: 'secret123',
    EMPTY: '',
  };

  it('expands ${VAR}', () => {
    expect(expandMcpEnvVars('${API_HOST}/mcp', env)).toBe(
      'https://api.example.com/mcp',
    );
  });

  it('expands ${VAR:-default} when var exists', () => {
    expect(expandMcpEnvVars('${API_HOST:-fallback}/mcp', env)).toBe(
      'https://api.example.com/mcp',
    );
  });

  it('uses default value when var is missing', () => {
    expect(expandMcpEnvVars('${MISSING:-fallback}/mcp', env)).toBe(
      'fallback/mcp',
    );
  });

  it('preserves original when var is missing with no default', () => {
    expect(expandMcpEnvVars('${MISSING}/mcp', env)).toBe('${MISSING}/mcp');
  });

  it('does NOT expand bare $VAR', () => {
    expect(expandMcpEnvVars('$API_HOST/mcp', env)).toBe('$API_HOST/mcp');
  });

  it('does NOT expand Windows %VAR%', () => {
    expect(expandMcpEnvVars('%API_HOST%/mcp', env)).toBe('%API_HOST%/mcp');
  });

  it('preserves URL percent-encoding', () => {
    const input =
      'http://127.0.0.1:52347/legokit/ai-slides?workspace=C%3A%5CUsers%5Cexample%5Cworkspace%5Cmq7h382zcsw8dk3u';
    expect(expandMcpEnvVars(input, env)).toBe(input);
  });

  it('returns empty string unchanged', () => {
    expect(expandMcpEnvVars('', env)).toBe('');
  });

  it('handles empty env value', () => {
    expect(expandMcpEnvVars('prefix-${EMPTY}-suffix', env)).toBe(
      'prefix--suffix',
    );
  });

  it('handles multiple vars in one string', () => {
    expect(expandMcpEnvVars('${API_HOST}/auth?token=${TOKEN}', env)).toBe(
      'https://api.example.com/auth?token=secret123',
    );
  });

  it('preserves multiple missing vars', () => {
    expect(expandMcpEnvVars('${FOO}/${BAR}', env)).toBe('${FOO}/${BAR}');
  });

  it('splits on first :- only', () => {
    expect(expandMcpEnvVars('${MISSING:-http://default}', env)).toBe(
      'http://default',
    );
  });
});
