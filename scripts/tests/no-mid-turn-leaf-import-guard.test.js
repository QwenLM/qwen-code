import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

// `packages/cli/src/peerMessaging/mid-turn-constants.ts` must import nothing at
// runtime (see the eslint.config.js leaf block). Its two guards live on
// separate rule keys, and flat config keeps only the last setting of a rule
// per file, so both blocks must sit AFTER the cli-wide core-barrel block that
// sets `@typescript-eslint/no-restricted-imports` for all of
// `packages/cli/src/**/*.{ts,tsx}` — and the leaf block must carry the
// core-barrel paths so the relocation does not strip them. These tests fail if
// the leaf block is moved back above the core-barrel block (the patterns group
// goes dead and the runtime-import error disappears) or if the paths are
// dropped from the leaf block.

const leaf = 'packages/cli/src/peerMessaging/mid-turn-constants.ts';

describe('mid-turn-constants leaf runtime-import guards', () => {
  it('resolves the leaf to both core-barrel paths and the leaf patterns group (last-wins pin)', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const config = await eslint.calculateConfigForFile(leaf);
    const rule = config.rules['@typescript-eslint/no-restricted-imports'];
    expect(rule).toBeDefined();
    const options = rule[1] ?? {};
    expect(options.paths?.map((entry) => entry.name)).toContain(
      '@qwen-code/qwen-code-core',
    );
    expect(options.paths).toHaveLength(5);
    expect(options.patterns).toHaveLength(1);
    expect(options.patterns[0].allowTypeImports).toBe(true);
    expect(options.patterns[0].group).toContain('*');
  });

  it('rejects static and dynamic runtime imports on the leaf, allows type-only imports', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const [staticRuntime, typeOnly, dynamicImport] = await Promise.all([
      eslint.lintText(
        "import { MAX_ACCEPTED_BACKLOG } from './peer-messaging.js';\nexport const X = MAX_ACCEPTED_BACKLOG;",
        { filePath: leaf },
      ),
      eslint.lintText(
        "import type { PeerMessage } from '../types.js';\nexport const X: PeerMessage | null = null;",
        { filePath: leaf },
      ),
      eslint.lintText(
        "export async function load() { return await import('./peer-messaging.js'); }",
        { filePath: leaf },
      ),
    ]);

    const messagesFor = (results, ruleId) =>
      results
        .flatMap((result) => result.messages)
        .filter((message) => message.ruleId === ruleId);

    const staticMessages = messagesFor(
      staticRuntime,
      '@typescript-eslint/no-restricted-imports',
    );
    expect(staticMessages).toHaveLength(1);
    expect(staticMessages[0].message).toMatch(
      /mid-turn-constants\.ts must import nothing at runtime/,
    );

    expect(
      messagesFor(typeOnly, '@typescript-eslint/no-restricted-imports'),
    ).toEqual([]);

    const dynamicMessages = messagesFor(dynamicImport, 'no-restricted-syntax');
    expect(
      dynamicMessages.some((message) =>
        /mid-turn-constants\.ts must import nothing at runtime/.test(
          message.message,
        ),
      ),
    ).toBe(true);
  });
});

describe('config modules must not reach the peer runtime (reverse leaf guard)', () => {
  const configFile = 'packages/cli/src/config/settingsUtils.ts';

  it('resolves a config file to core-barrel paths plus the peer-runtime pattern (last-wins pin)', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const config = await eslint.calculateConfigForFile(configFile);
    const rule = config.rules['@typescript-eslint/no-restricted-imports'];
    expect(rule).toBeDefined();
    const options = rule[1] ?? {};
    // Carrying the core-barrel paths is load-bearing: without them the
    // relocated block would strip core-barrel coverage from the config files.
    expect(options.paths?.map((entry) => entry.name)).toContain(
      '@qwen-code/qwen-code-core',
    );
    expect(options.paths).toHaveLength(5);
    expect(options.patterns).toHaveLength(1);
    expect(options.patterns[0].group).toContain('**/peerMessaging/**');
    expect(options.patterns[0].group).toContain(
      '!**/peerMessaging/mid-turn-constants.js',
    );
    expect(options.patterns[0].allowTypeImports).toBe(true);
  });

  it('rejects a config-file runtime import of the peer runtime, allows the leaf constant and type-only', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const [peerRuntime, leafConstant, typeOnly] = await Promise.all([
      eslint.lintText(
        "import { peerMidTurnBudgetOf } from '../peerMessaging/peer-messaging.js';\nexport const X = peerMidTurnBudgetOf(1);",
        { filePath: configFile },
      ),
      eslint.lintText(
        "import { PEER_MID_TURN_BUDGET_DEFAULT } from '../peerMessaging/mid-turn-constants.js';\nexport const X = PEER_MID_TURN_BUDGET_DEFAULT;",
        { filePath: configFile },
      ),
      eslint.lintText(
        "import type { PeerMessage } from '../peerMessaging/peer-frames.js';\nexport const X: PeerMessage | null = null;",
        { filePath: configFile },
      ),
    ]);

    const messagesFor = (results, ruleId) =>
      results
        .flatMap((result) => result.messages)
        .filter((message) => message.ruleId === ruleId);

    const peerMessages = messagesFor(
      peerRuntime,
      '@typescript-eslint/no-restricted-imports',
    );
    expect(peerMessages).toHaveLength(1);
    expect(peerMessages[0].message).toMatch(
      /config must not import the peer runtime at runtime/,
    );

    expect(
      messagesFor(leafConstant, '@typescript-eslint/no-restricted-imports'),
    ).toEqual([]);
    expect(
      messagesFor(typeOnly, '@typescript-eslint/no-restricted-imports'),
    ).toEqual([]);
  });
});
