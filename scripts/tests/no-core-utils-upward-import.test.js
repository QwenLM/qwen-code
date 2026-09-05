import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import rule from '../../eslint-rules/no-core-utils-upward-import.js';

function runRule(code, filename) {
  const linter = new Linter({ configType: 'flat', cwd: '/' });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.{ts,js}'],
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        plugins: {
          architecture: {
            rules: { 'no-core-utils-upward-import': rule },
          },
        },
        rules: { 'architecture/no-core-utils-upward-import': 'error' },
      },
    ],
    { filename },
  );
}

describe('no-core-utils-upward-import', () => {
  it('rejects value imports that leave utils/', () => {
    expect(
      runRule(
        "import { ToolErrorType } from '../tools/tool-error.js';",
        'packages/core/src/utils/fileUtils.ts',
      ),
    ).toHaveLength(1);
    expect(
      runRule(
        "import { DEFAULT_QWEN_MODEL } from '../config/models.js';",
        'packages/core/src/utils/sideQuery.ts',
      ),
    ).toHaveLength(1);
    expect(
      runRule(
        "import { X } from '../core/foo.js';",
        'packages/core/src/utils/bar.ts',
      ),
    ).toHaveLength(1);
  });

  it('rejects value re-exports and dynamic imports that leave utils/', () => {
    expect(
      runRule(
        "export { X } from '../tools/foo.js';",
        'packages/core/src/utils/bar.ts',
      ),
    ).toHaveLength(1);
    expect(
      runRule(
        "export * from '../tools/foo.js';",
        'packages/core/src/utils/bar.ts',
      ),
    ).toHaveLength(1);
    expect(
      runRule("import('../tools/foo.js');", 'packages/core/src/utils/bar.ts'),
    ).toHaveLength(1);
    expect(
      runRule('import(`../tools/foo.js`);', 'packages/core/src/utils/bar.ts'),
    ).toHaveLength(1);
  });

  it('rejects deep package self-references that leave utils/', () => {
    expect(
      runRule(
        "import { Storage } from '@qwen-code/qwen-code-core/src/config/storage.js';",
        'packages/core/src/utils/foo.ts',
      ),
    ).toHaveLength(1);
    expect(
      runRule(
        "import { Storage } from '@qwen-code/qwen-code-core/dist/src/config/storage.js';",
        'packages/core/src/utils/foo.ts',
      ),
    ).toHaveLength(1);
    expect(
      runRule(
        "import { wireGoal } from '@qwen-code/qwen-code-core/goalWire';",
        'packages/core/src/utils/foo.ts',
      ),
    ).toHaveLength(1);
  });

  it('allows type-only imports', () => {
    expect(
      runRule(
        "import type { AnyDeclarativeTool } from '../tools/tools.js';",
        'packages/core/src/utils/is-tool.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "export type { X } from '../tools/foo.js';",
        'packages/core/src/utils/bar.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "export type * from '../tools/foo.js';",
        'packages/core/src/utils/bar.ts',
      ),
    ).toHaveLength(0);
  });

  it('allows sibling, intra-utils, and external imports', () => {
    expect(
      runRule(
        "import { X } from './bar.js';",
        'packages/core/src/utils/foo.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import { X } from '../utils/bar.js';",
        'packages/core/src/utils/foo.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule("import fs from 'node:fs';", 'packages/core/src/utils/foo.ts'),
    ).toHaveLength(0);
    expect(
      runRule(
        "import { X } from '@qwen-code/qwen-code-core';",
        'packages/core/src/utils/foo.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import { TranscriptRecordType } from '@qwen-code/qwen-code-core/transcriptRecords';",
        'packages/core/src/utils/foo.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import { ToolError } from '@qwen-code/qwen-code-core/dist/src/utils/errors.js';",
        'packages/core/src/utils/foo.ts',
      ),
    ).toHaveLength(0);
  });

  it('allowlists the deferred debugLogger inversions', () => {
    expect(
      runRule(
        "import { Storage } from '../config/storage.js';",
        'packages/core/src/utils/debugLogger.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import { getTraceContext, type TraceContext } from '../telemetry/trace-context.js';",
        'packages/core/src/utils/debugLogger.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import { Storage } from '@qwen-code/qwen-code-core/src/config/storage.js';",
        'packages/core/src/utils/debugLogger.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import { Storage } from '@qwen-code/qwen-code-core/dist/src/config/storage.js';",
        'packages/core/src/utils/debugLogger.ts',
      ),
    ).toHaveLength(0);
  });

  it('limits deferred inversions to debugLogger', () => {
    expect(
      runRule(
        "import { Storage } from '../config/storage.js';",
        'packages/core/src/utils/other.ts',
      ),
    ).toHaveLength(1);
  });

  it('anchors the core source root on the last marker', () => {
    const nestedRoot =
      '/tmp/packages/core/src/checkout/repo/packages/core/src/utils/';
    expect(
      runRule(
        "import { Storage } from '../config/storage.js';",
        `${nestedRoot}debugLogger.ts`,
      ),
    ).toHaveLength(0);
    expect(
      runRule("import { X } from '../tools/foo.js';", `${nestedRoot}bar.ts`),
    ).toHaveLength(1);
  });

  it('ignores test files and non-utils consumers', () => {
    expect(
      runRule(
        "import { X } from '../tools/foo.js';",
        'packages/core/src/utils/foo.test.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import { X } from '../tools/foo.js';",
        'packages/core/src/utils/foo.spec.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import { X } from '../tools/foo.js';",
        'packages/core/src/tools/bar.ts',
      ),
    ).toHaveLength(0);
  });
});
