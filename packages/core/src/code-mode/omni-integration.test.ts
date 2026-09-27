/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import { ApprovalMode } from '../config/approval-mode.js';
import { CoreToolScheduler } from '../core/coreToolScheduler.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ExecTool } from '../tools/exec.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { Kind, type MediaPolicyToolDescriptor } from '../tools/tools.js';

class PolicyTool extends MockTool {
  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return {
      kind: 'media_policy',
      inputMediaTypes: ['image'],
      outputs: [{ kind: 'media', required: true }],
    };
  }
}

function setup(omniEnabled = false) {
  const config = makeFakeConfig({
    codeModeOnly: true,
    omniEnabled,
    approvalMode: ApprovalMode.DEFAULT,
    targetDir: '/tmp',
    cwd: '/tmp',
  });
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  const completed = vi.fn();
  const scheduler = new CoreToolScheduler({
    config,
    onAllToolCallsComplete: async (calls) => completed(calls),
    onToolCallsUpdate: vi.fn(),
    getPreferredEditor: () => undefined,
    onEditorClose: vi.fn(),
  });
  return { config, registry, completed, scheduler };
}

describe('Omni integration with CodeModeOnly', () => {
  it.each([true, false])(
    'admits fixed_policy only for a media tool (descriptor=%s)',
    async (policy) => {
      const { registry, completed, scheduler } = setup();
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'processed',
        returnDisplay: 'processed',
      });
      registry.registerTool(
        new (policy ? PolicyTool : MockTool)({
          name: 'omni_downsample_image',
          kind: Kind.Read,
          execute,
        }),
      );
      await scheduler.schedule(
        {
          callId: 'fixed-policy',
          name: 'omni_downsample_image',
          args: {},
          isClientInitiated: false,
          prompt_id: 'policy-prompt',
          executionOrigin: {
            kind: 'fixed_policy',
            policyId: 'guard',
            stage: 'transport_guard',
          },
        },
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
      const call = completed.mock.calls[0]?.[0][0];
      expect(call?.status).toBe(policy ? 'success' : 'error');
      expect(execute).toHaveBeenCalledTimes(policy ? 1 : 0);
      if (!policy) expect(call.response.executionStatus).toBe('not_started');
    },
  );

  it.each([false, true])(
    'retains uploaded media and annotations even after a later script error (%s)',
    async (scriptFails) => {
      const { config, registry, completed, scheduler } = setup(true);
      registry.registerTool(new ExecTool(config));
      const parts: Part[] = [
        { text: '【媒体资源】sample.png：media-1-ab' },
        { text: '【媒体处理说明】sample.png：2048px → 768px' },
        { fileData: { mimeType: 'image/png', fileUri: 'oss://sample' } },
        { text: 'derived transcript' },
      ];
      registry.registerTool(
        new MockTool({
          name: 'read_media',
          kind: Kind.Read,
          execute: async () => ({
            llmContent: [
              {
                functionResponse: {
                  name: 'read_media',
                  id: 'exec-media:code:1',
                  response: { output: 'read sample.png' },
                  parts,
                },
              },
            ],
            returnDisplay: 'read sample.png',
          }),
        }),
      );
      await scheduler.schedule(
        {
          callId: 'exec-media',
          name: 'exec',
          args: {
            source: `const result = await tools.read_media({}); result.content?.forEach(image); ${scriptFails ? "throw new Error('later failure');" : ''}`,
          },
          isClientInitiated: false,
          prompt_id: 'media-prompt',
        },
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
      const call = completed.mock.calls[0]?.[0][0];
      expect(call?.status).toBe('success');
      const response = call.response.responseParts[0].functionResponse;
      expect(response.parts).toEqual(parts);
      expect(response.response.output).toContain('read sample.png');
      if (scriptFails)
        expect(response.response.output).toContain('later failure');
    },
    10_000,
  );
});
