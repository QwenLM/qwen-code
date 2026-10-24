import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

// Flat config keeps only the last setting of a rule per file, so the
// mid-turn-constants leaf's static-import guard must sit below the cli-wide
// core-barrel block or the core-barrel block silently replaces it (and the
// relocated leaf block must re-carry the core-barrel paths).
describe('mid-turn-constants leaf flat-config integration', () => {
  const leaf = 'packages/cli/src/peerMessaging/mid-turn-constants.ts';

  const restricted = (results) =>
    results
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId === '@typescript-eslint/no-restricted-imports');

  it('reports static runtime imports from the leaf and keeps type-only exempt', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const [runtimeImport, coreBarrelImport, typeOnlyImport] = await Promise.all(
      [
        eslint.lintText(
          "import { MAX_ACCEPTED_BACKLOG } from './peer-messaging.js';\nexport const X = MAX_ACCEPTED_BACKLOG;\n",
          { filePath: leaf },
        ),
        eslint.lintText(
          "import { Storage } from '@qwen-code/qwen-code-core';\nexport const X = Storage;\n",
          { filePath: leaf },
        ),
        eslint.lintText(
          "import type { PeerQueuedDelivery } from './peer-messaging.js';\nexport const X = 1;\n",
          { filePath: leaf },
        ),
      ],
    );

    const runtimeMsgs = restricted(runtimeImport);
    expect(
      runtimeMsgs.some((m) =>
        m.message.includes(
          'mid-turn-constants.ts must import nothing at runtime',
        ),
      ),
    ).toBe(true);

    // The core-barrel paths carried into the leaf block: a value import from
    // the core package root stays reported for the leaf.
    expect(restricted(coreBarrelImport).length).toBeGreaterThan(0);

    expect(restricted(typeOnlyImport)).toEqual([]);
  });

  it('resolves the leaf rule to the core-barrel paths plus the leaf patterns', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const config = await eslint.calculateConfigForFile(leaf);
    const rule = config.rules['@typescript-eslint/no-restricted-imports'];
    expect(rule).toBeDefined();
    const options = rule[1];
    expect(options.paths.map((p) => p.name)).toContain(
      '@qwen-code/qwen-code-core',
    );
    expect(
      options.patterns.some(
        (p) =>
          typeof p.message === 'string' &&
          p.message.includes(
            'mid-turn-constants.ts must import nothing at runtime',
          ),
      ),
    ).toBe(true);
  });
});
