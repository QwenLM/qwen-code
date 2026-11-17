/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  extensionInstructionText,
  extensionToolDeclaration,
  extensionToolInput,
} from './hosted-extension-tool-context.js';

const source = {
  extensionId: 'one',
  packageRevision: 2,
  packageDigest: 'a'.repeat(64),
};
const pin = { ...source, settingsRevision: 3 };
const config = {
  revision: 7,
  packages: [{ pin, assetRoot: 'extension://one/' }],
};

describe('Hosted extension native tool context', () => {
  it('binds a model-selected exact package to the current Harness revision and private settings pin', () => {
    expect(
      extensionToolInput('root', config, 'read_file', {
        file_path: 'asset.txt',
        extension_source: source,
      }),
    ).toEqual({
      file_path: 'asset.txt',
      managedExtension: { harnessSessionId: 'root', configRevision: 7, pin },
    });
    expect(
      extensionToolInput('root', config, 'run_shell_command', {
        command: 'pwd',
        extension_context: source,
      }),
    ).toMatchObject({ command: 'pwd', managedExtension: { pin } });
    expect(
      extensionToolInput('root', config, 'read_file', {
        file_path: 'workspace.txt',
      }),
    ).toEqual({ file_path: 'workspace.txt' });
  });

  it('rejects fabricated private metadata, stale pins, writes, and background execution', () => {
    for (const [tool, input] of [
      ['read_file', { managedExtension: { pin } }],
      ['read_file', { extension_source: { ...source, packageRevision: 1 } }],
      ['read_file', { extension_source: pin }],
      ['write_file', { extension_source: source }],
      ['run_shell_command', { extension_source: source }],
      ['read_file', { extension_context: source }],
      ['run_shell_command', { extension_context: source, is_background: true }],
      ['run_shell_command', { extension_context: source, is_monitor: true }],
    ] as const)
      expect(() => extensionToolInput('root', config, tool, input)).toThrow();
  });

  it('publishes only public pin selectors without mutating the original native schema', () => {
    const declaration = {
      name: 'read_file',
      description: 'Read',
      parametersJsonSchema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
      },
    };
    const augmented = extensionToolDeclaration(declaration, config);
    expect(augmented.parametersJsonSchema).toMatchObject({
      properties: {
        extension_source: {
          additionalProperties: false,
          required: ['extensionId', 'packageRevision', 'packageDigest'],
          oneOf: [
            {
              properties: {
                extensionId: { const: 'one' },
                packageRevision: { const: 2 },
                packageDigest: { const: 'a'.repeat(64) },
              },
            },
          ],
        },
      },
    });
    expect(declaration.parametersJsonSchema.properties).not.toHaveProperty(
      'extension_source',
    );
    expect(JSON.stringify(augmented)).not.toContain('settingsRevision');
    expect(
      extensionToolDeclaration({ ...declaration, name: 'write_file' }, config)
        .parametersJsonSchema,
    ).toBe(declaration.parametersJsonSchema);
  });

  it('maps instruction assets to the selected logical package without exposing a Runtime path', () => {
    expect(
      extensionInstructionText(
        'Read ${extensionPath}/references/guide.md and ${CLAUDE_PLUGIN_ROOT}/data.txt',
        'one',
      ),
    ).toBe(
      'Read extension://one/references/guide.md and extension://one/data.txt',
    );
    expect(
      extensionToolInput('root', config, 'read_file', {
        extension_source: source,
        file_path: 'extension://one/references/guide.md',
      }),
    ).toMatchObject({
      file_path: 'references/guide.md',
      managedExtension: { pin },
    });
    expect(
      extensionToolInput('root', config, 'glob', {
        extension_source: source,
        path: 'extension://one/references',
        pattern: '**/*.md',
      }),
    ).toMatchObject({ path: 'references', pattern: '**/*.md' });
    for (const file_path of [
      'extension://other/data.txt',
      'extension://one/../private.txt',
      'extension://one//../../private.txt',
    ])
      expect(() =>
        extensionToolInput('root', config, 'read_file', {
          extension_source: source,
          file_path,
        }),
      ).toThrow();
  });
});
