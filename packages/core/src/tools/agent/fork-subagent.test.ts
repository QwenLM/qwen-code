/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { ToolNames } from '../tool-names.js';
import {
  buildForkedMessages,
  FORK_PLACEHOLDER_RESULT,
  normalizeForkTurns,
  resolveForkExecutionAllowedTools,
  selectForkHistory,
  validateForkToolList,
} from './fork-subagent.js';

describe('resolveForkExecutionAllowedTools', () => {
  const parentTools = [
    ToolNames.READ_FILE,
    ToolNames.DISPLAY_IMAGE,
    ToolNames.EDIT,
  ];

  it('preserves unrestricted execution when display_image is not advertised', () => {
    expect(
      resolveForkExecutionAllowedTools([ToolNames.READ_FILE], undefined),
    ).toBeUndefined();
  });

  it('filters display_image from an explicit allowlist', () => {
    expect(
      resolveForkExecutionAllowedTools(parentTools, [
        ...parentTools,
        ToolNames.GLOB,
      ]),
    ).toEqual([ToolNames.READ_FILE, ToolNames.EDIT, ToolNames.GLOB]);
  });

  it('cannot re-enable display_image through fork_tools', () => {
    expect(
      resolveForkExecutionAllowedTools(parentTools, [
        ToolNames.DISPLAY_IMAGE,
        ToolNames.READ_FILE,
      ]),
    ).toEqual([ToolNames.READ_FILE]);
  });

  it('fails closed when display_image is advertised without an allowlist', () => {
    expect(resolveForkExecutionAllowedTools(parentTools, undefined)).toEqual(
      [],
    );
  });
});

describe('validateForkToolList', () => {
  it('accepts the inline fork tool contract, including deny-all', () => {
    expect(validateForkToolList([])).toBeUndefined();
    expect(
      validateForkToolList(['read_file', 'mcp__*', 'mcp__github__read_*']),
    ).toBeUndefined();
  });

  it.each([
    { tools: null, expected: /array of non-empty tool names/ },
    { tools: [' read_file'], expected: /array of non-empty tool names/ },
    { tools: ['*'], expected: /does not accept/ },
    { tools: ['mcp__github__*__read'], expected: /wildcard entries/ },
  ])('rejects an invalid tool list $tools', ({ tools, expected }) => {
    expect(validateForkToolList(tools)).toMatch(expected);
  });
});

describe('selectForkHistory', () => {
  const startup: Content = {
    role: 'user',
    parts: [{ text: '<system-reminder>\nstartup\n</system-reminder>' }],
  };
  const firstUser: Content = {
    role: 'user',
    parts: [{ text: 'first question' }],
  };
  const firstModel: Content = {
    role: 'model',
    parts: [{ text: 'first answer' }],
  };
  const toolCall: Content = {
    role: 'model',
    parts: [
      {
        functionCall: {
          id: 'call-1',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
      },
    ],
  };
  const toolResult: Content = {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: 'call-1',
          name: 'read_file',
          response: { output: 'file contents' },
        },
      },
    ],
  };
  const secondUser: Content = {
    role: 'user',
    parts: [{ text: 'second question' }],
  };
  const secondModel: Content = {
    role: 'model',
    parts: [{ text: 'second answer' }],
  };

  it('defaults to all and normalizes explicit values', () => {
    expect(normalizeForkTurns(undefined)).toBe('all');
    expect(normalizeForkTurns('all')).toBe('all');
    expect(normalizeForkTurns('3')).toBe(3);
  });

  it('preserves all history when no bounded window is requested', () => {
    expect(selectForkHistory([startup, firstUser, firstModel], 'all')).toEqual([
      startup,
      firstUser,
      firstModel,
    ]);
  });

  it('counts real user turns rather than tool responses', () => {
    expect(
      selectForkHistory(
        [
          startup,
          firstUser,
          toolCall,
          toolResult,
          firstModel,
          secondUser,
          secondModel,
        ],
        1,
      ),
    ).toEqual([secondUser, secondModel]);
  });

  it('keeps all available context when fewer turns exist than requested', () => {
    expect(selectForkHistory([startup, firstUser, firstModel], 3)).toEqual([
      firstUser,
      firstModel,
    ]);
  });

  it('returns empty when no real user turns exist after the synthetic prefix', () => {
    expect(selectForkHistory([startup], 1)).toEqual([]);
  });

  it('does not count or inherit a compacted-history prefix for a numeric window', () => {
    const compactedSummary: Content = {
      role: 'user',
      parts: [{ text: 'Resume the prior task from this summary.' }],
    };
    const compactedAck: Content = {
      role: 'model',
      parts: [{ text: 'Got it. Thanks for the additional context!' }],
    };

    expect(
      selectForkHistory(
        [startup, compactedSummary, compactedAck, firstUser, firstModel],
        3,
      ),
    ).toEqual([firstUser, firstModel]);
  });

  it('does not count pure reminders as user turns', () => {
    const reminder: Content = {
      role: 'user',
      parts: [{ text: '<system-reminder>\nchanged tools\n</system-reminder>' }],
    };

    expect(
      selectForkHistory(
        [startup, firstUser, firstModel, reminder, secondUser, secondModel],
        1,
      ),
    ).toEqual([secondUser, secondModel]);
  });

  it('does not count empty user content as a real turn', () => {
    const emptyUser: Content = { role: 'user', parts: [] };
    const emptyAck: Content = {
      role: 'model',
      parts: [{ text: 'ignored empty input' }],
    };

    expect(
      selectForkHistory(
        [startup, firstUser, firstModel, emptyUser, emptyAck],
        1,
      ),
    ).toEqual([firstUser, firstModel, emptyUser, emptyAck]);
  });

  it('does not count a tool response mixed with a pure reminder', () => {
    const mixedToolResponse: Content = {
      role: 'user',
      parts: [
        ...toolResult.parts!,
        { text: '<system-reminder>\nchanged tools\n</system-reminder>' },
      ],
    };

    expect(
      selectForkHistory(
        [startup, firstUser, toolCall, mixedToolResponse, firstModel],
        1,
      ),
    ).toEqual([firstUser, toolCall, mixedToolResponse, firstModel]);
  });

  it('does not share nested mutable parts with the parent history', () => {
    const nestedImage = {
      inlineData: { mimeType: 'image/png', data: 'c2hvdA==' },
    };
    const toolResultWithImage: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'captured' },
            parts: [nestedImage],
          },
        },
      ],
    };

    const inherited = selectForkHistory(
      [startup, firstUser, toolCall, toolResultWithImage, firstModel],
      'all',
    );
    const inheritedNestedImage =
      inherited[3]?.parts?.[0]?.functionResponse?.parts?.[0];

    expect(inheritedNestedImage).toEqual(nestedImage);
    expect(inheritedNestedImage).not.toBe(nestedImage);
  });
});

describe('buildForkedMessages', () => {
  // A model launching several forks in one response: the last model message
  // carries one functionCall per sibling fork, each with its own directive in
  // `args.prompt`.
  const launch: Content = {
    role: 'model',
    parts: [
      { text: 'Launching two forks.' },
      {
        functionCall: {
          id: 'call-a',
          name: 'agent',
          args: {
            subagent_type: 'fork',
            prompt: 'ALPHA_DIRECTIVE',
            description: 'task a',
          },
        },
      },
      {
        functionCall: {
          id: 'call-b',
          name: 'agent',
          args: {
            subagent_type: 'fork',
            prompt: 'BETA_DIRECTIVE',
            description: 'task b',
          },
        },
      },
    ],
  };

  it('does not leak sibling fork directives into the forked history', () => {
    const messages = buildForkedMessages('ALPHA_DIRECTIVE', launch);

    // Fork A must not see fork B's directive anywhere in its seed history.
    expect(JSON.stringify(messages)).not.toContain('BETA_DIRECTIVE');

    // The replayed model message carries no directive text at all — the fork's
    // own directive is delivered separately, so no `args.prompt` should survive.
    const [assistant] = messages;
    expect(JSON.stringify(assistant)).not.toContain('ALPHA_DIRECTIVE');
  });

  it('preserves function-call pairing and delivers the own directive once', () => {
    const [assistant, toolResult] = buildForkedMessages(
      'ALPHA_DIRECTIVE',
      launch,
    );

    // Non-functionCall parts pass through unchanged.
    expect(assistant.parts?.[0]?.text).toBe('Launching two forks.');

    // Both calls are retained by id + name so the API can pair the responses.
    const calls = assistant.parts
      ?.filter((part) => part.functionCall)
      .map((part) => part.functionCall);
    expect(calls?.map((call) => call?.id)).toEqual(['call-a', 'call-b']);
    expect(calls?.map((call) => call?.name)).toEqual(['agent', 'agent']);

    // Every retained call has a matching placeholder response.
    const responses = toolResult.parts
      ?.filter((part) => part.functionResponse)
      .map((part) => part.functionResponse);
    expect(responses?.map((response) => response?.id)).toEqual([
      'call-a',
      'call-b',
    ]);
    expect(
      responses?.every(
        (response) =>
          response?.response?.['output'] === FORK_PLACEHOLDER_RESULT,
      ),
    ).toBe(true);

    // The fork's own directive is still delivered, exactly once, via the text.
    const directiveText =
      toolResult.parts?.find((part) => typeof part.text === 'string')?.text ??
      '';
    expect(directiveText).toContain('Directive: ALPHA_DIRECTIVE');
  });
});
