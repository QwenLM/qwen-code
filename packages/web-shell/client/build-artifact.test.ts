import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST_PATH = resolve(__dirname, '../dist/index.js');

function readBundle(): string {
  return readFileSync(DIST_PATH, 'utf8');
}

describe('build artifact — package boundary', () => {
  it('externalizes @qwen-code/webui/daemon-react-sdk', () => {
    const bundle = readBundle();
    expect(bundle).toContain('from "@qwen-code/webui/daemon-react-sdk"');
  });

  it('does not inline DaemonSessionProvider source code', () => {
    const bundle = readBundle();
    expect(bundle).not.toMatch(/DaemonStoreContext\s*=\s*createContext/);
  });

  it('does not inline createContext from React for provider contexts', () => {
    const bundle = readBundle();
    const contextMatches = bundle.match(/createContext\(/g) ?? [];
    // WebShell's own ThemeContext is fine; but there should be at most
    // a small number of createContext calls (WebShell internal only).
    // If webui Provider got bundled, we'd see many more.
    expect(contextMatches.length).toBeLessThanOrEqual(3);
  });

  it('externalizes react and react-dom', () => {
    const bundle = readBundle();
    expect(bundle).toContain('from "react"');
    expect(bundle).toContain('from "react/jsx-runtime"');
    expect(bundle).not.toContain('react/jsx-dev-runtime');
    expect(bundle).not.toContain('jsxDEV');
    expect(bundle).not.toContain('fileName:');
  });

  it('externalizes @qwen-code/sdk subpaths', () => {
    const bundle = readBundle();
    // Should not contain raw SDK implementation
    expect(bundle).not.toMatch(/DaemonSessionClient\s*\{/);
  });
});
