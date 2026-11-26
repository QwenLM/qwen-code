/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  subscribeConfigValue: vi.fn(),
}));

vi.mock('../index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  subscribeConfigValue: mocks.subscribeConfigValue,
}));
import { coreEvents } from '../../utils/events.js';
import {
  getDynamicCommandDefinitions,
  parseDynamicCommandsValue,
  registerDynamicCommandsFeature,
  DYNAMIC_COMMANDS_GATE,
  resetDynamicCommandsForTesting,
} from './dynamicCommands.js';

vi.mock('../../utils/runLogger.js', () => ({
  runLogger: {
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../utils/events.js', () => ({
  coreEvents: {
    emitDynamicCommandsChanged: vi.fn(),
  },
}));

const NOW_MS = Date.parse('2026-07-10T00:00:00Z');
const ACTIVE_WINDOW = {
  startTime: '2000-01-01T00:00:00Z',
  endTime: '2999-12-31T23:59:59Z',
};

describe('config-service/features/dynamicCommands', () => {
  let valueListener: ((value: unknown) => void) | undefined;

  beforeEach(() => {
    resetDynamicCommandsForTesting();
    mocks.getConfigValue.mockReset();
    mocks.subscribeConfigValue.mockReset();
    valueListener = undefined;
    mocks.subscribeConfigValue.mockImplementation((_key, listener) => {
      valueListener = listener;
      return () => {};
    });
    vi.mocked(coreEvents.emitDynamicCommandsChanged).mockClear();
  });

  it('registers the dynamic_commands feature gate', () => {
    registerDynamicCommandsFeature();

    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      DYNAMIC_COMMANDS_GATE,
      expect.any(Function),
    );
  });

  it('uses an empty command list when the gate is missing', () => {
    expect(getDynamicCommandDefinitions()).toEqual([]);
  });

  it('treats boolean feature gate values as no dynamic commands', () => {
    expect(parseDynamicCommandsValue(false)).toEqual({ commands: [] });
    expect(parseDynamicCommandsValue('true')).toEqual({ commands: [] });
  });

  it('parses a single command object', () => {
    const parsed = parseDynamicCommandsValue({
      command: {
        name: '/review',
        prompt: 'Review $ARGUMENTS',
        description: 'Review current changes',
        ...ACTIVE_WINDOW,
        altNames: ['cr'],
        argumentHint: '<scope>',
        argNames: ['scope'],
        allowed_tools: ['Read', 'Grep'],
        model: 'qwen-model',
        effort: 'high',
        whenToUse: 'Use for code review',
        hidden: 'false',
        autoExecute: 'true',
      },
    });

    expect(parsed?.commands).toEqual([
      {
        name: 'review',
        content: 'Review $ARGUMENTS',
        description: 'Review current changes',
        ...ACTIVE_WINDOW,
        altNames: ['cr'],
        argumentHint: '<scope>',
        argNames: ['scope'],
        allowedTools: ['Read', 'Grep'],
        model: 'qwen-model',
        effort: 'high',
        whenToUse: 'Use for code review',
        hidden: false,
        autoExecute: true,
      },
    ]);
  });

  it('parses detail and interaction endpoint configs', () => {
    const parsed = parseDynamicCommandsValue({
      commands: [
        {
          name: 'ask-docs',
          description: 'Ask docs service',
          loadingMessage: 'Loading docs...',
          errorMessages: {
            detail: 'Failed to load docs.',
            interaction: 'Failed to ask docs.',
          },
          ...ACTIVE_WINDOW,
          detail: [
            {
              domain: 'api.example.test',
              path: '/commands/detail',
              method: 'GET',
              params: { id: 'ask-docs' },
            },
          ],
          interaction: {
            domain: 'https://chat.example.test',
            path: '/commands/interact',
            method: 'POST',
            params: { query: '$ARGUMENTS' },
            headers: { 'x-source': 'qwen' },
          },
        },
      ],
    });

    expect(parsed?.commands).toEqual([
      {
        name: 'ask-docs',
        description: 'Ask docs service',
        loadingMessage: 'Loading docs...',
        errorMessages: {
          detail: 'Failed to load docs.',
          interaction: 'Failed to ask docs.',
        },
        ...ACTIVE_WINDOW,
        detail: [
          {
            domain: 'api.example.test',
            path: '/commands/detail',
            method: 'GET',
            params: { id: 'ask-docs' },
          },
        ],
        interaction: {
          domain: 'https://chat.example.test',
          path: '/commands/interact',
          method: 'POST',
          params: { query: '$ARGUMENTS' },
          headers: { 'x-source': 'qwen' },
        },
      },
    ]);
  });

  it('parses camelCase and snake_case eligibility options', () => {
    const parsed = parseDynamicCommandsValue({
      commands: [
        {
          name: 'claim-camel',
          content: 'Claim camel',
          ineligibleMessage: 'This account is not eligible.',
          requiresCanClaim: true,
          ...ACTIVE_WINDOW,
        },
        {
          name: 'claim-snake',
          content: 'Claim snake',
          ineligible_message: 'This activity is unavailable.',
          requires_can_claim: 'true',
          ...ACTIVE_WINDOW,
        },
      ],
    });

    expect(parsed?.commands).toEqual([
      {
        name: 'claim-camel',
        content: 'Claim camel',
        description: 'Dynamic command claim-camel',
        ineligibleMessage: 'This account is not eligible.',
        requiresCanClaim: true,
        ...ACTIVE_WINDOW,
      },
      {
        name: 'claim-snake',
        content: 'Claim snake',
        description: 'Dynamic command claim-snake',
        ineligibleMessage: 'This activity is unavailable.',
        requiresCanClaim: true,
        ...ACTIVE_WINDOW,
      },
    ]);
  });

  it('parses camelCase and snake_case confirmation prompts', () => {
    const parsed = parseDynamicCommandsValue({
      commands: [
        {
          name: 'confirm-camel',
          content: 'Run camel action',
          confirmationPrompt: 'Run the camel action?',
          ...ACTIVE_WINDOW,
        },
        {
          name: 'confirm-snake',
          content: 'Run snake action',
          confirmation_prompt: 'Run the snake action?',
          ...ACTIVE_WINDOW,
        },
      ],
    });

    expect(parsed?.commands).toEqual([
      {
        name: 'confirm-camel',
        content: 'Run camel action',
        description: 'Dynamic command confirm-camel',
        confirmationPrompt: 'Run the camel action?',
        ...ACTIVE_WINDOW,
      },
      {
        name: 'confirm-snake',
        content: 'Run snake action',
        description: 'Dynamic command confirm-snake',
        confirmationPrompt: 'Run the snake action?',
        ...ACTIVE_WINDOW,
      },
    ]);
  });

  it('parses a configured display with required detail fields', () => {
    const parsed = parseDynamicCommandsValue({
      commands: [
        {
          name: 'invite',
          ...ACTIVE_WINDOW,
          detail: [
            {
              domain: 'OpenAPI',
              path: '/sash/api/v1/me/invitationCode',
            },
          ],
          display: {
            required_fields: ['code'],
            lines: [
              '/invite to get 400 credits when a friend signs up',
              'Your invite link',
              'https://example.com/invite?code=${CLI_DETAIL.code}',
            ],
          },
        },
      ],
    });

    expect(parsed?.commands[0].display).toEqual({
      requiredFields: ['code'],
      lines: [
        '/invite to get 400 credits when a friend signs up',
        'Your invite link',
        'https://example.com/invite?code=${CLI_DETAIL.code}',
      ],
    });
  });

  it('rejects an invalid configured display', () => {
    const parsed = parseDynamicCommandsValue({
      commands: [
        {
          name: 'invalid-display',
          ...ACTIVE_WINDOW,
          detail: [
            {
              domain: 'OpenAPI',
              path: '/commands/detail',
            },
          ],
          display: { lines: [] },
        },
      ],
    });

    expect(parsed).toEqual({ commands: [] });
  });

  it('rejects invalid requiresCanClaim values', () => {
    const parsed = parseDynamicCommandsValue({
      commands: [
        {
          name: 'valid-guard',
          content: 'Valid guard',
          requiresCanClaim: true,
          ...ACTIVE_WINDOW,
        },
        {
          name: 'invalid-string-guard',
          content: 'Invalid string guard',
          requiresCanClaim: 'yes',
          ...ACTIVE_WINDOW,
        },
        {
          name: 'invalid-number-guard',
          content: 'Invalid number guard',
          requires_can_claim: 2,
          ...ACTIVE_WINDOW,
        },
      ],
    });

    expect(parsed?.commands.map((command) => command.name)).toEqual([
      'valid-guard',
    ]);
  });

  it('rejects a single detail endpoint object', () => {
    const parsed = parseDynamicCommandsValue({
      commands: [
        {
          name: 'legacy-detail',
          ...ACTIVE_WINDOW,
          detail: {
            domain: 'api.example.test',
            path: '/commands/detail',
          },
          interaction: {
            domain: 'api.example.test',
            path: '/commands/interact',
          },
        },
      ],
    });

    expect(parsed).toEqual({ commands: [] });
  });

  it('parses multiple detail endpoint configs in order', () => {
    const parsed = parseDynamicCommandsValue({
      commands: [
        {
          name: 'claim-ultimate',
          description: 'Claim 200 Ultimate uses',
          ...ACTIVE_WINDOW,
          detail: [
            {
              domain: 'https://test-openapi.example.com',
              path: '/api/v2/activity/claim/eligibility',
              auth: 'bearer',
            },
            {
              domain: 'https://test-api2.example.com',
              path: '/algo/api/v2/activity',
              auth: 'wasm',
              headers: { 'Accept-Language': 'en-US' },
            },
          ],
        },
      ],
    });

    expect(parsed?.commands[0].detail).toEqual([
      {
        domain: 'https://test-openapi.example.com',
        path: '/api/v2/activity/claim/eligibility',
        auth: 'bearer',
      },
      {
        domain: 'https://test-api2.example.com',
        path: '/algo/api/v2/activity',
        auth: 'wasm',
        headers: { 'Accept-Language': 'en-US' },
      },
    ]);
  });

  it('parses JSON commands and filters disabled or invalid entries', () => {
    const parsed = parseDynamicCommandsValue(
      JSON.stringify({
        commands: [
          { name: 'ship', content: 'Ship it', ...ACTIVE_WINDOW },
          {
            name: 'off',
            content: 'Disabled',
            enabled: false,
            ...ACTIVE_WINDOW,
          },
          { name: 'bad' },
          { content: 'Missing name' },
        ],
      }),
    );

    expect(parsed?.commands).toEqual([
      {
        name: 'ship',
        content: 'Ship it',
        description: 'Dynamic command ship',
        ...ACTIVE_WINDOW,
      },
    ]);
  });

  it('parses the commands array', () => {
    const parsed = parseDynamicCommandsValue({
      commands: [
        { name: 'dynamic', content: 'Run dynamic command', ...ACTIVE_WINDOW },
      ],
    });

    expect(parsed?.commands).toEqual([
      {
        name: 'dynamic',
        content: 'Run dynamic command',
        description: 'Dynamic command dynamic',
        ...ACTIVE_WINDOW,
      },
    ]);
  });

  it('supports a top-level command string with a name', () => {
    const parsed = parseDynamicCommandsValue({
      name: 'hello',
      command: 'Say hello to $ARGUMENTS',
      ...ACTIVE_WINDOW,
    });

    expect(parsed?.commands).toEqual([
      {
        name: 'hello',
        content: 'Say hello to $ARGUMENTS',
        description: 'Dynamic command hello',
        ...ACTIVE_WINDOW,
      },
    ]);
  });

  it('filters commands outside the configured time window', () => {
    const parsed = parseDynamicCommandsValue(
      {
        commands: [
          {
            name: 'future',
            content: 'Not started',
            startTime: '2026-07-11T00:00:00Z',
            endTime: '2026-07-12T00:00:00Z',
          },
          {
            name: 'expired',
            content: 'Expired',
            startTime: '2026-07-08T00:00:00Z',
            endTime: '2026-07-09T00:00:00Z',
          },
          {
            name: 'active',
            content: 'Active',
            startTime: '2026-07-09T00:00:00Z',
            endTime: '2026-07-11T00:00:00Z',
          },
        ],
      },
      NOW_MS,
    );

    expect(parsed?.commands).toEqual([
      {
        name: 'active',
        content: 'Active',
        description: 'Dynamic command active',
        startTime: '2026-07-09T00:00:00Z',
        endTime: '2026-07-11T00:00:00Z',
      },
    ]);
  });

  it('requires a valid start and end time for each command', () => {
    const parsed = parseDynamicCommandsValue(
      {
        commands: [
          { name: 'missing-start', content: 'No start', endTime: ACTIVE_WINDOW.endTime },
          {
            name: 'missing-end',
            content: 'No end',
            startTime: ACTIVE_WINDOW.startTime,
          },
          {
            name: 'invalid-start',
            content: 'Bad start',
            startTime: 'not-a-date',
            endTime: ACTIVE_WINDOW.endTime,
          },
          {
            name: 'invalid-range',
            content: 'Bad range',
            startTime: '2026-07-11T00:00:00Z',
            endTime: '2026-07-10T00:00:00Z',
          },
        ],
      },
      NOW_MS,
    );

    expect(parsed).toEqual({ commands: [] });
  });

  it('accepts snake_case and startAt/endAt time window aliases', () => {
    const parsed = parseDynamicCommandsValue(
      {
        commands: [
          {
            name: 'snake',
            content: 'Snake',
            start_time: '2026-07-09T00:00:00Z',
            end_time: '2026-07-11T00:00:00Z',
          },
          {
            name: 'at-alias',
            content: 'Alias',
            startAt: '2026-07-09T00:00:00Z',
            endAt: '2026-07-11T00:00:00Z',
          },
        ],
      },
      NOW_MS,
    );

    expect(parsed?.commands).toEqual([
      {
        name: 'snake',
        content: 'Snake',
        description: 'Dynamic command snake',
        startTime: '2026-07-09T00:00:00Z',
        endTime: '2026-07-11T00:00:00Z',
      },
      {
        name: 'at-alias',
        content: 'Alias',
        description: 'Dynamic command at-alias',
        startTime: '2026-07-09T00:00:00Z',
        endTime: '2026-07-11T00:00:00Z',
      },
    ]);
  });

  it('updates current state from onChange and emits a reload event', () => {
    registerDynamicCommandsFeature();
    valueListener?.({
      command: {
        name: 'dynamic',
        content: 'Run dynamic command',
        ...ACTIVE_WINDOW,
      },
    });

    expect(getDynamicCommandDefinitions()).toEqual([
      {
        name: 'dynamic',
        content: 'Run dynamic command',
        description: 'Dynamic command dynamic',
        ...ACTIVE_WINDOW,
      },
    ]);
    expect(coreEvents.emitDynamicCommandsChanged).toHaveBeenCalledTimes(1);
  });

  it('rechecks cached commands against the current time window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
      registerDynamicCommandsFeature();
      valueListener?.({
        commands: [
          {
            name: 'scheduled',
            content: 'Scheduled command',
            startTime: '2026-07-11T00:00:00Z',
            endTime: '2026-07-12T00:00:00Z',
          },
        ],
      });

      expect(getDynamicCommandDefinitions()).toEqual([]);

      vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
      expect(getDynamicCommandDefinitions()).toEqual([
        {
          name: 'scheduled',
          content: 'Scheduled command',
          description: 'Dynamic command scheduled',
          startTime: '2026-07-11T00:00:00Z',
          endTime: '2026-07-12T00:00:00Z',
        },
      ]);

      vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
      expect(getDynamicCommandDefinitions()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last valid value when a fresh gate value is invalid', () => {
    registerDynamicCommandsFeature();
    valueListener?.({
      command: {
        name: 'dynamic',
        content: 'Run dynamic command',
        ...ACTIVE_WINDOW,
      },
    });

    mocks.getConfigValue.mockReturnValue('not-json');

    expect(getDynamicCommandDefinitions()).toEqual([
      {
        name: 'dynamic',
        content: 'Run dynamic command',
        description: 'Dynamic command dynamic',
        ...ACTIVE_WINDOW,
      },
    ]);
  });
});
