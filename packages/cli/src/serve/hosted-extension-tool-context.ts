/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import {
  parseManagedExtensionPin,
  type ManagedExtensionPin,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import { normalizeWorkspaceRelativePath } from './managed-workspace-binding.js';

export interface HostedExtensionToolConfig {
  readonly revision: number;
  readonly packages: ReadonlyArray<{
    readonly pin: ManagedExtensionPin;
    readonly assetRoot: string;
  }>;
}

const sourceSchema = {
  type: 'object',
  properties: {
    extensionId: { type: 'string' },
    packageRevision: { type: 'integer', minimum: 1 },
    packageDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
  required: ['extensionId', 'packageRevision', 'packageDigest'],
  additionalProperties: false,
};

export function extensionToolDeclaration(
  tool: FunctionDeclaration,
  config?: HostedExtensionToolConfig,
): FunctionDeclaration {
  if (
    !config?.packages.length ||
    !['read_file', 'glob', 'run_shell_command'].includes(tool.name ?? '')
  )
    return tool;
  const schema = structuredClone(tool.parametersJsonSchema) as {
    properties: Record<string, unknown>;
  };
  schema.properties[
    tool.name === 'run_shell_command' ? 'extension_context' : 'extension_source'
  ] = {
    ...sourceSchema,
    oneOf: config.packages.map(({ pin }) => ({
      properties: {
        extensionId: { const: pin.extensionId },
        packageRevision: { const: pin.packageRevision },
        packageDigest: { const: pin.packageDigest },
      },
    })),
  };
  return {
    ...tool,
    parametersJsonSchema: schema,
    description: `${tool.description ?? ''} Select one of the listed exact extension pins to read its read-only assets using a package-relative path or extension://<extensionId>/<path>. For Shell, select extension_context and use $QWEN_EXTENSION_ROOT for package files; cwd stays the Session working directory.`,
  };
}

export function extensionToolInput(
  harnessSessionId: string,
  config: HostedExtensionToolConfig | undefined,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { extension_source: source, extension_context: context } = input;
  const ordinary: Record<string, unknown> = { ...input };
  delete ordinary['extension_source'];
  delete ordinary['extension_context'];
  if (Object.hasOwn(input, 'managedExtension'))
    throw new Error('Private extension tool metadata is not a model argument.');
  if (source === undefined && context === undefined) return ordinary;
  const shell = toolName === 'run_shell_command';
  if (
    (!shell && !['read_file', 'glob'].includes(toolName)) ||
    (shell ? source !== undefined : context !== undefined) ||
    !config
  )
    throw new Error('This tool does not admit the selected extension context.');
  const requested = shell ? context : source;
  if (
    !requested ||
    typeof requested !== 'object' ||
    Array.isArray(requested) ||
    Object.keys(requested).sort().join(',') !==
      'extensionId,packageDigest,packageRevision'
  )
    throw new Error('Select an exact extension package pin.');
  const pin = parseManagedExtensionPin(requested);
  const selected = config.packages.find(
    (entry) =>
      entry.pin.extensionId === pin.extensionId &&
      entry.pin.packageRevision === pin.packageRevision &&
      entry.pin.packageDigest === pin.packageDigest,
  );
  if (!selected)
    throw new Error(
      'The extension package is not selected in this Session configuration.',
    );
  if (!shell) {
    for (const field of ['file_path', 'path', 'pattern']) {
      const value = ordinary[field];
      if (typeof value !== 'string' || !value.startsWith('extension://'))
        continue;
      const prefix = `extension://${pin.extensionId}/`;
      if (!value.startsWith(prefix))
        throw new Error('Asset path names another extension.');
      ordinary[field] = normalizeWorkspaceRelativePath(
        value.slice(prefix.length),
      );
    }
  }
  if (
    shell &&
    (ordinary['is_background'] === true || ordinary['is_monitor'] === true)
  )
    throw new Error('Extension Shell requires a foreground invocation.');
  return {
    ...ordinary,
    managedExtension: {
      harnessSessionId,
      configRevision: config.revision,
      pin: selected.pin,
    },
  };
}

export function extensionInstructionText(
  body: string,
  extensionId: string,
): string {
  return body
    .replaceAll('${extensionPath}', `extension://${extensionId}`)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', `extension://${extensionId}`);
}
