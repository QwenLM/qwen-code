import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { handleScriptSandbox } from './script-sandbox.ts';

describe('script_sandbox', () => {
  let rootDir: string;
  let sessionDir: string;
  let dataDir: string;
  let siblingDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'script-sandbox-'));
    sessionDir = join(rootDir, 'session');
    dataDir = join(sessionDir, 'data');
    siblingDir = join(rootDir, 'session-evil');

    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });

    writeFileSync(join(sessionDir, 'in.txt'), 'hello sandbox');
    writeFileSync(join(siblingDir, 'outside.txt'), 'evil');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function ctx(): SessionToolContext {
    return {
      sessionId: 'sandbox-session',
      workspacePath: rootDir,
      sourcesPath: join(rootDir, 'sources'),
      skillsPath: join(rootDir, 'skills'),
      plansFolderPath: join(sessionDir, 'plans'),
      callbacks: {
        onPlanSubmitted: () => {},
        onAuthRequest: () => {},
      },
      fs: {
        exists: () => false,
        readFile: () => '',
        readFileBuffer: () => Buffer.from(''),
        writeFile: () => {},
        isDirectory: () => false,
        readdir: () => [],
        stat: () => ({ size: 0, isDirectory: () => false }),
      },
      loadSourceConfig: () => null,
      sessionPath: sessionDir,
      dataPath: dataDir,
    };
  }

  it('rejects input path traversal/sibling-prefix bypass', async () => {
    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: "console.log('ok')",
      inputFiles: [join(rootDir, 'session-evil', 'outside.txt')],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('inputFile must be within the session directory');
  });

  it('enforces network/filesystem isolation or fails with clear diagnostics', async () => {
    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: "console.log('hello')",
      timeoutMs: 1500,
    });

    const text = result.content[0]?.text ?? '';

    if (result.isError) {
      expect(text.length > 0).toBe(true);
      expect(
        text.includes('network isolation') ||
        text.includes('filesystem isolation') ||
        text.includes('networkIsolation:') ||
        text.includes('filesystemIsolation:') ||
        text.includes('runtime') ||
        text.includes('Error running sandboxed script')
      ).toBe(true);
      return;
    }

    expect(text).toContain('networkIsolation: enforced');
    expect(text).toContain('filesystemIsolation: enforced');
    expect(text).toContain('stdout:');
  });

  it('blocks writes outside session directory when sandbox runs', async () => {
    const outsidePath = join(rootDir, 'outside-write.txt');

    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: `require('node:fs').writeFileSync(${JSON.stringify(outsidePath)}, 'nope'); console.log('done')`,
      timeoutMs: 1500,
    });

    const text = result.content[0]?.text ?? '';

    if (
      text.includes('filesystem isolation') ||
      text.includes('network isolation') ||
      text.includes('sandbox_apply') ||
      text.includes('Operation not permitted')
    ) {
      // Backend unavailable or host sandbox denied in this environment.
      expect(result.isError).toBe(true);
      return;
    }

    expect(result.isError).toBe(true);
    expect(existsSync(outsidePath)).toBe(false);
  });

  it('passes stdin through when sandbox backend is available', async () => {
    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()));",
      stdin: 'hello stdin',
      timeoutMs: 1500,
    });

    const text = result.content[0]?.text ?? '';
    if (
      result.isError &&
      (
        text.includes('filesystem isolation') ||
        text.includes('network isolation') ||
        text.includes('sandbox_apply') ||
        text.includes('Operation not permitted')
      )
    ) {
      expect(text.length > 0).toBe(true);
      return;
    }

    expect(result.isError).toBe(false);
    expect(text).toContain('HELLO STDIN');
  });

  it('reports timeout when script exceeds timeoutMs', async () => {
    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: 'setInterval(() => {}, 100);',
      timeoutMs: 200,
    });

    const text = result.content[0]?.text ?? '';
    if (
      result.isError &&
      (
        text.includes('filesystem isolation') ||
        text.includes('network isolation') ||
        text.includes('sandbox_apply') ||
        text.includes('Operation not permitted')
      )
    ) {
      expect(text.length > 0).toBe(true);
      return;
    }

    expect(text).toContain('timedOut: true');
  });
});
