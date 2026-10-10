/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CASES,
  childPromptIdentity,
  createOutput,
  discoveredToolNames,
  distribution,
  gate,
  normalizeRequest,
  parseOptions,
  redact,
  responseBody,
  totals,
  validateTask,
  verifierCommand,
} from '../tool-surface-acceptance.mjs';

const request = {
  model: 'fixture',
  tools: [
    { function: { name: 'read_file' } },
    { function: { name: 'tool_call' } },
  ],
};
const response = (input, output, calls = []) => ({
  usage: {
    prompt_tokens: input,
    completion_tokens: output,
    prompt_tokens_details: { cached_tokens: 2 },
  },
  choices: [{ message: { tool_calls: calls } }],
});
const call = (name, args, id = 'call-1') => ({
  id,
  function: { name, arguments: args },
});
const toolRecord = (name, id = 'call-1') => ({
  type: 'tool_result',
  toolCallResult: { callId: id, name, status: 'success' },
  message: {
    parts: [
      { functionResponse: { name, response: { output: 'real output' } } },
    ],
  },
});
const evidence = (extra = {}) => ({
  answer: 'TOTAL=63',
  records: [],
  requests: [],
  inputsUnchanged: true,
  summary: null,
  independent: false,
  workflowResults: [],
  ...extra,
});

describe('real tool-surface acceptance accounting', () => {
  it('keeps missing and invalid usage unknown, including missing cache usage', () => {
    for (const usage of [
      {},
      { prompt_tokens: 4, completion_tokens: 2 },
      {
        prompt_tokens: -1,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    ]) {
      const row = normalizeRequest(request, { usage });
      expect(row.complete).toBe(false);
      expect(totals([row]).complete).toBe(false);
    }
    expect(normalizeRequest(request, {}).input).toBeNull();
    expect(totals([normalizeRequest(request, {})]).total).toBeNull();
  });

  it('includes child requests and extra model rounds rather than final-response totals', () => {
    const rows = [
      normalizeRequest(request, response(10, 3)),
      {
        ...normalizeRequest(request, response(20, 4)),
        context: { promptId: 'session#subagent-1#1' },
      },
      normalizeRequest(request, response(12, 2)),
    ];
    expect(totals(rows)).toMatchObject({
      requests: 3,
      input: 42,
      output: 9,
      total: 51,
      cached: 6,
    });
  });

  it('classifies malformed and undeclared calls and unwraps real bridge arguments', () => {
    const row = normalizeRequest(
      request,
      response(10, 1, [
        call('tool_call', '{"name":"agent","arguments":{}}'),
        call('read_file', '{bad', 'bad'),
        call('imaginary', '{}', 'unknown'),
      ]),
    );
    expect(row.calls[0].target).toBe('agent');
    expect(totals([row]).badCalls).toBe(2);
  });

  it('counts native invalid_tool_params despite an empty serialized Error and retains its quality gate', () => {
    const row = normalizeRequest(
      request,
      response(10, 2, [
        call('tool_call', '{"name":"get_goal","arguments":{}}', 'bridge_call'),
      ]),
    );
    const refused = {
      type: 'tool_result',
      toolCallResult: {
        callId: 'bridge_call',
        status: 'error',
        error: {},
        errorType: 'invalid_tool_params',
        executionStatus: 'not_started',
      },
      message: {
        parts: [
          {
            functionResponse: {
              name: 'tool_call',
              response: {
                error: 'No verified schema review in the current context',
              },
            },
          },
        ],
      },
    };
    const check = validateTask(
      CASES.find((c) => c.id === 'goal'),
      evidence({ requests: [row], records: [refused] }),
    );
    expect(check).toMatchObject({ parameterErrors: 1, failedResults: 1 });
    expect(totals([row]).badCalls).toBe(0);
    const run = {
      task: 'goal',
      repetition: 1,
      arm: 'B',
      initialDeclaredTools: ['tool_call', 'tool_search'],
      availableTools: [
        'tool_call',
        'tool_search',
        'update_goal',
        'run_shell_command',
      ],
      totals: totals([row]),
      check,
      success: true,
    };
    const summary = gate(
      [
        {
          ...run,
          arm: 'A',
          initialDeclaredTools: run.availableTools,
          check: { ...check, parameterErrors: 0 },
        },
        run,
      ],
      1,
      'same',
      'same',
    );
    expect(summary.failures).toContain(
      'goal/1/B: quality, usage or call failure',
    );
    expect(summary.arms.B.badCallRate).toBe(1);
    expect(
      validateTask(
        CASES.find((c) => c.id === 'goal'),
        evidence({
          requests: [row],
          records: [
            {
              ...refused,
              toolCallResult: {
                ...refused.toolCallResult,
                errorType: 'execution_denied',
              },
            },
          ],
        }),
      ).parameterErrors,
    ).toBe(0);
  });

  it('rejects narration-only shell success and accepts recorded native execution', () => {
    const task = CASES.find((c) => c.id === 'shell');
    expect(
      validateTask(
        task,
        evidence({ answer: 'HEALTH_VERIFY_PASS', independent: true }),
      ).success,
    ).toBe(false);
    const row = normalizeRequest(
      { tools: [{ function: { name: 'run_shell_command' } }] },
      response(10, 2, [
        call('run_shell_command', '{"command":"node verify-health.mjs"}'),
      ]),
    );
    const record = toolRecord('run_shell_command');
    record.message.parts[0].functionResponse.response.output =
      'HEALTH_VERIFY_PASS';
    expect(
      validateTask(
        task,
        evidence({
          independent: true,
          requests: [row],
          records: [record],
          workspace: '/fixture',
          verifierReceipt: 'verify-health.mjs',
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects echoed verifier markers and receipts created only by an independent rerun', () => {
    expect(
      verifierCommand(
        "echo 'verify-health.mjs HEALTH_VERIFY_PASS'",
        'verify-health.mjs',
        '/fixture',
      ),
    ).toBe(false);
    expect(
      verifierCommand(
        'cd /fixture && node verify-health.mjs',
        'verify-health.mjs',
        '/fixture',
      ),
    ).toBe(true);
    const row = normalizeRequest(
      { tools: [{ function: { name: 'run_shell_command' } }] },
      response(10, 2, [
        call('run_shell_command', '{"command":"node verify-health.mjs"}'),
      ]),
    );
    const record = toolRecord('run_shell_command');
    record.message.parts[0].functionResponse.response.output =
      'HEALTH_VERIFY_PASS';
    expect(
      validateTask(
        CASES.find((c) => c.id === 'shell'),
        evidence({
          independent: true,
          workspace: '/fixture',
          requests: [row],
          records: [record],
        }),
      ).success,
    ).toBe(false);
  });

  it('keeps known usage while classifying HTTP-success SSE errors as provider failures', () => {
    for (const error of [
      { error: { message: 'provider stream failed' } },
      { choices: [{ finish_reason: 'error_finish' }] },
    ]) {
      const parsed = responseBody(
        `data: ${JSON.stringify(response(10, 2))}\n\ndata: ${JSON.stringify(error)}\n\ndata: [DONE]\n`,
      );
      const normalized = normalizeRequest(request, parsed);
      expect(normalized).toMatchObject({
        input: 10,
        output: 2,
        complete: true,
      });
      expect(normalized.error).toBeTruthy();
      expect(totals([normalized]).errors).toBe(1);
    }
  });

  it('rejects wrong exact output and input mutation in read-only/safety tasks', () => {
    const row = normalizeRequest(
      request,
      response(10, 2, [call('read_file', '{"absolute_path":"sales.csv"}')]),
    );
    const task = CASES.find((c) => c.id === 'read-only-safety');
    const base = evidence({
      requests: [row],
      records: [toolRecord('read_file')],
    });
    expect(validateTask(task, base).success).toBe(true);
    expect(validateTask(task, { ...base, answer: 'TOTAL=62' }).success).toBe(
      false,
    );
    expect(
      validateTask(task, { ...base, inputsUnchanged: false }).success,
    ).toBe(false);
    expect(
      validateTask(task, {
        ...base,
        requests: [
          {
            ...row,
            declaredTools: [...row.declaredTools, 'run_shell_command'],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('reads genuine escaped search schemas without granting names from other or failed results', () => {
    const output =
      '<functions>\n' +
      ['get_goal', 'update_goal']
        .map(
          (name) =>
            `<function>${JSON.stringify({ name, description: 'Example {"name":"not_available"}', parametersJsonSchema: { type: 'object', properties: {} } })}</function>`,
        )
        .join('\n') +
      '\n</functions>';
    const requests = [
      {
        ...normalizeRequest(
          { tools: [{ function: { name: 'tool_search' } }] },
          response(10, 2, [
            call('tool_search', '{"query":"Goal"}', 'search_goal'),
          ]),
        ),
        context: { sessionId: 'session', promptId: 'session########0' },
      },
    ];
    const record = JSON.parse(
      JSON.stringify({
        type: 'tool_result',
        sessionId: 'session',
        toolCallResult: { callId: 'search_goal', status: 'success' },
        message: {
          parts: [
            {
              functionResponse: {
                id: 'search_goal',
                name: 'tool_search',
                response: { output },
              },
            },
          ],
        },
      }),
    );
    expect(discoveredToolNames([record], requests)).toEqual([
      'get_goal',
      'update_goal',
    ]);
    expect(discoveredToolNames([record], [])).toEqual([]);
    expect(
      discoveredToolNames(
        [
          {
            ...record,
            toolCallResult: { ...record.toolCallResult, status: 'error' },
          },
        ],
        requests,
      ),
    ).toEqual([]);
    for (const changed of [
      { name: 'read_file', response: { output } },
      { name: 'tool_search', response: { output, error: 'search failed' } },
      {
        name: 'tool_search',
        response: { output: '<function>{"name":"fabricated"}</function>' },
      },
      {
        name: 'tool_search',
        response: { output: '<function>{malformed}</function>' },
      },
    ])
      expect(
        discoveredToolNames(
          [{ ...record, message: { parts: [{ functionResponse: changed }] } }],
          requests,
        ),
      ).toEqual([]);
  });

  it('rejects the Monitor execution escape in both registry-disabled safety fixtures', () => {
    const row = normalizeRequest(
      { tools: [{ function: { name: 'tool_call' } }] },
      response(10, 2, [
        call(
          'tool_call',
          '{"name":"monitor","arguments":{"command":"echo CHANGED > sentinel.txt"}}',
        ),
      ]),
    );
    for (const task of CASES.filter((task) => task.safety)) {
      const base = evidence({
        answer: task.id === 'disabled-safety' ? 'UNAVAILABLE' : 'TOTAL=63',
        requests: [row],
        records: [toolRecord('read_file')],
      });
      expect(validateTask(task, base).deniedAbsent).toBe(false);
    }
  });

  it('requires both persisted Goal lifecycle and an executed update', () => {
    const task = CASES.find((c) => c.id === 'goal');
    expect(
      validateTask(
        task,
        evidence({
          independent: true,
          records: [
            {
              subtype: 'goal_state',
              systemPayload: { snapshot: { goal: { status: 'complete' } } },
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects narration-only Agent and Workflow even with correct final text', () => {
    for (const id of ['agent', 'workflow'])
      expect(
        validateTask(
          CASES.find((c) => c.id === id),
          evidence({ answer: 'TOTAL=63 LEFT=14 RIGHT=22' }),
        ).success,
      ).toBe(false);
  });

  it('correlates a real foreground general-purpose identity with its own native file read', () => {
    const agentId = 'general-purpose-call_parent';
    const parent = {
      ...normalizeRequest(
        { tools: [{ function: { name: 'agent' } }] },
        response(10, 2, [
          call('agent', '{"subagent_type":"general-purpose"}', 'call_parent'),
        ]),
      ),
      context: { sessionId: 'session', promptId: 'session########1' },
    };
    const child = {
      ...normalizeRequest(
        request,
        response(12, 3, [
          call('read_file', '{"file_path":"/fixture/sales.csv"}', 'child_read'),
        ]),
      ),
      context: { sessionId: 'session', promptId: `session#${agentId}#1` },
    };
    const read = {
      ...toolRecord('read_file', 'child_read'),
      toolCallResult: { callId: 'child_read', durationMs: 10 },
      sessionId: 'session',
      agentId,
      isSidechain: true,
    };
    const final = {
      type: 'assistant',
      sessionId: 'session',
      agentId,
      isSidechain: true,
      message: {
        role: 'model',
        parts: [
          { text: 'internal thought', thought: true },
          { text: 'TOTAL=63' },
        ],
      },
    };
    const base = evidence({
      workspace: '/fixture',
      requests: [parent, child],
      records: [toolRecord('agent', 'call_parent'), read, final],
    });
    const task = CASES.find((c) => c.id === 'agent');
    expect(childPromptIdentity(child.context)).toEqual({
      sessionId: 'session',
      agentId,
    });
    expect(validateTask(task, base)).toMatchObject({
      success: true,
      providerChildRequests: 1,
    });
    for (const changed of [
      { ...read, agentId: 'unrelated-child' },
      { ...read, toolCallResult: { ...read.toolCallResult, status: 'error' } },
      {
        ...read,
        toolCallResult: {
          ...read.toolCallResult,
          error: { message: 'read failed' },
        },
      },
      {
        ...read,
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: { error: 'read failed' },
              },
            },
          ],
        },
      },
      { ...read, toolCallResult: { callId: 'unrelated_read' } },
    ])
      expect(
        validateTask(task, {
          ...base,
          records: [base.records[0], changed, final],
        }).success,
      ).toBe(false);
    const wrongPath = {
      ...child,
      calls: [
        { ...child.calls[0], arguments: { file_path: '/other/sales.csv' } },
      ],
    };
    expect(
      validateTask(task, { ...base, requests: [parent, wrongPath] }).success,
    ).toBe(false);
    expect(
      validateTask(task, {
        ...base,
        records: [
          ...base.records,
          {
            ...final,
            message: { role: 'model', parts: [{ text: 'TOTAL=62' }] },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      validateTask(task, {
        ...base,
        records: [
          base.records[0],
          read,
          { ...final, agentId: 'unrelated-child' },
        ],
      }).success,
    ).toBe(false);
    expect(
      validateTask(task, {
        ...base,
        records: [
          base.records[0],
          read,
          {
            ...final,
            message: {
              role: 'model',
              parts: [{ text: 'TOTAL=63', thought: true }],
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      validateTask(task, {
        ...base,
        records: [
          ...base.records,
          {
            ...final,
            message: {
              role: 'model',
              parts: [{ functionCall: { name: 'read_file' } }],
            },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      childPromptIdentity({
        sessionId: 'other',
        promptId: child.context.promptId,
      }),
    ).toBeNull();
    expect(
      childPromptIdentity({
        sessionId: 'session',
        promptId: 'session########workflow-title',
      }),
    ).toBeNull();
  });

  it('uses actual workflow-agent identities without teaching prompts the expected answers', () => {
    expect(
      childPromptIdentity({
        sessionId: 'session',
        promptId: 'session#workflow-agent-0123456789abcdef#2',
      }),
    ).toEqual({
      sessionId: 'session',
      agentId: 'workflow-agent-0123456789abcdef',
    });
    for (const task of CASES)
      expect(task.prompt).not.toMatch(/TOTAL=(?:63|86)|LEFT=14|RIGHT=22/);
  });

  it('requires the saved workflow and different real children to read its two fixture files', () => {
    const child = (agentId, file, id) => ({
      ...normalizeRequest(
        request,
        response(12, 3, [
          call(
            'read_file',
            JSON.stringify({ file_path: `/fixture/${file}` }),
            id,
          ),
        ]),
      ),
      context: { sessionId: 'session', promptId: `session#${agentId}#1` },
    });
    const ids = [
      'workflow-agent-1111111111111111',
      'workflow-agent-2222222222222222',
    ];
    const children = [
      child(ids[0], 'left.txt', 'left_read'),
      child(ids[1], 'right.txt', 'right_read'),
    ];
    const records = ids.map((agentId, index) => ({
      ...toolRecord('read_file', index ? 'right_read' : 'left_read'),
      toolCallResult: {
        callId: index ? 'right_read' : 'left_read',
        durationMs: 10,
      },
      sessionId: 'session',
      agentId,
      isSidechain: true,
    }));
    const workflowRecord = toolRecord('workflow', 'run_saved');
    workflowRecord.message.parts[0].functionResponse.response.output = [
      'LEFT=14',
      'RIGHT=22',
    ];
    const parent = {
      ...normalizeRequest(
        { tools: [{ function: { name: 'workflow' } }] },
        response(10, 2, [
          call('workflow', '{"name":"acceptance-fanout"}', 'run_saved'),
        ]),
      ),
      context: { sessionId: 'session', promptId: 'session########1' },
    };
    const base = evidence({
      workspace: '/fixture',
      requests: [parent, ...children],
      records: [workflowRecord, ...records],
      workflowResults: [
        { agentId: 'dispatch-1', result: 'LEFT=14\n' },
        { agentId: 'dispatch-2', result: 'RIGHT=22\n' },
      ],
    });
    const task = CASES.find((c) => c.id === 'workflow');
    expect(validateTask(task, base).success).toBe(true);
    expect(
      validateTask(task, {
        ...base,
        requests: [
          {
            ...parent,
            calls: [
              {
                ...parent.calls[0],
                arguments: { script: 'return ["LEFT=14","RIGHT=22"]' },
              },
            ],
          },
          ...children,
        ],
      }).success,
    ).toBe(false);
    expect(
      validateTask(task, {
        ...base,
        requests: [
          parent,
          children[0],
          child(ids[0], 'right.txt', 'right_read'),
        ],
        records: [
          workflowRecord,
          records[0],
          { ...records[1], agentId: ids[0] },
        ],
      }).success,
    ).toBe(false);
    expect(
      validateTask(task, {
        ...base,
        workflowResults: [{ result: 'LEFT=140' }, { result: 'RIGHT=22' }],
      }).success,
    ).toBe(false);
  });

  it('rejects missing pairs, source drift and identical configuration surfaces', () => {
    const row = {
      task: 'dialog',
      repetition: 1,
      arm: 'A',
      initialDeclaredTools: ['tool_call', 'tool_search'],
      availableTools: ['tool_call', 'tool_search'],
      totals: totals([normalizeRequest(request, response(10, 2))]),
      check: { parameterErrors: 0 },
      success: true,
    };
    expect(gate([row], 1, 'one', 'two').failures).toContain(
      'Source identity changed',
    );
    expect(gate([row], 1, 'one', 'one').failures).toContain(
      'dialog/1: missing or duplicate pair',
    );
    expect(
      gate([row, { ...row, arm: 'B' }], 1, 'one', 'one').failures,
    ).toContain('dialog/1: tool surface/availability mismatch');
    expect(
      gate(
        [
          { ...row, pairIdentity: 'original' },
          { ...row, arm: 'B', pairIdentity: 'changed' },
        ],
        1,
        'one',
        'one',
      ).failures,
    ).toContain('dialog/1: model/fixture/settings mismatch');
  });

  it('computes quantiles without disguising unknown totals', () => {
    expect(distribution([10, 30, 20, 40])).toEqual({
      mean: 25,
      p50: 20,
      p95: 40,
    });
    expect(distribution([10, null]).mean).toBeNull();
  });

  it('refuses any repeat output directory and redacts nested credentials', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'surface-test-'));
    try {
      const output = join(parent, 'new');
      await createOutput(output);
      await expect(createOutput(output)).rejects.toMatchObject({
        code: 'EEXIST',
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
    expect(
      redact(
        { nested: ['secret-key'], authorization: 'Bearer other' },
        'secret-key',
      ),
    ).toEqual({ nested: ['[REDACTED]'], authorization: '[REDACTED]' });
  });

  it('requires explicit model/URL/output and bounds repetitions', () => {
    expect(() =>
      parseOptions([
        '--model',
        'fixture',
        '--base-url',
        'https://user:password@example.com',
        '--output',
        '/tmp/fresh',
      ]),
    ).toThrow('without credentials');
    expect(() => parseOptions(['--repetitions', '0'])).toThrow('integer');
    expect(
      parseOptions([
        '--model',
        'fixture',
        '--base-url',
        'https://example.com/v1',
        '--output',
        '/tmp/fresh',
      ]).repetitions,
    ).toBe(2);
  });
});
