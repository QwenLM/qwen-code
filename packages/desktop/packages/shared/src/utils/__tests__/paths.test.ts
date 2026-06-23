import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandPath, hasPathVariables } from '../paths.ts';

describe('expandPath', () => {
  it('expands Windows-style tilde prefixes under home', () => {
    expect(expandPath('~\\Documents\\Qwen')).toBe(
      join(homedir(), 'Documents\\Qwen'),
    );
  });

  it('expands $HOME followed by a Windows separator', () => {
    const expanded = expandPath('$HOME\\Documents');
    expect(expanded.startsWith(homedir())).toBe(true);
    expect(expanded).not.toContain(`${process.cwd()}\\~`);
  });
});

describe('hasPathVariables', () => {
  it('detects $HOME followed by a Windows separator', () => {
    expect(hasPathVariables('$HOME\\Documents')).toBe(true);
  });
});
