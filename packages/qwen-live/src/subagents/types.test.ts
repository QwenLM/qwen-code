/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SUBAGENTS_CONTROL_BYTES,
  parseSubagentsSnapshot,
  parseSubagentsControlRequest,
  parseSubagentsControlResult,
} from './types.js';

const task = {
  id: 'job:1',
  kind: 'harness',
  status: 'running',
  title: 'Task',
  request: 'Request',
  createdAt: 0,
  updatedAt: 0,
  activity: '',
  output: '',
  events: [],
};
const snapshot = {
  revision: 1,
  omitted: 0,
  counts: {
    running: 1,
    completed: 0,
    needsAttention: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  },
  tasks: [task],
};
describe('subagent snapshot identity and value validation', () => {
  it('rejects coerced enums and duplicate task ids', () => {
    expect(parseSubagentsSnapshot(snapshot)).toBeDefined();
    for (const invalid of [
      { ...task, kind: ['harness'] },
      { ...task, notification: ['delivered'] },
      { ...task, events: [{ at: 0, text: 'x', kind: ['status'] }] },
    ])
      expect(
        parseSubagentsSnapshot({ ...snapshot, tasks: [invalid] }),
      ).toBeUndefined();
    expect(
      parseSubagentsSnapshot({
        ...snapshot,
        tasks: [task, { ...task, title: 'Other task' }],
      }),
    ).toBeUndefined();
  });
});

describe('subagent management contracts', () => {
  it('bounds approval descriptions and never offers Allow for incomplete descriptions', () => {
    const permission = {
      requestHandle: 'req:1',
      title: 'x'.repeat(4096),
      titleTruncated: true,
      choices: [{ decision: 'deny', scope: 'once' }],
    };
    const response = (value: unknown) => ({
      type: 'page',
      page: { snapshot, offset: 0, total: 1, unassignedPermissions: [value] },
    });
    expect(parseSubagentsControlResult(response(permission))).toBeDefined();
    expect(
      parseSubagentsControlResult(
        response({ ...permission, title: 'x'.repeat(4097) }),
      ),
    ).toBeUndefined();
    expect(
      parseSubagentsControlResult(
        response({
          ...permission,
          choices: [{ decision: 'allow', scope: 'once' }],
        }),
      ),
    ).toBeUndefined();
    expect(
      parseSubagentsControlResult(
        response({ ...permission, titleTruncated: 'true' }),
      ),
    ).toBeUndefined();
  });

  it('accepts only exact bounded action fields and offered decision types', () => {
    for (const action of [
      { action: 'list' },
      { action: 'list', offset: 32, selectedId: 'job:1' },
      { action: 'stop', taskId: 'job:1' },
      { action: 'permission', requestHandle: 'req:1', decision: 'allow' },
    ])
      expect(parseSubagentsControlRequest(action)).toEqual(action);
    for (const action of [
      { action: 'stop', taskId: '' },
      { action: 'stop', taskId: 'x'.repeat(129) },
      { action: 'stop', taskId: 'job:1', all: true },
      { action: 'list', offset: -1 },
      { action: 'list', offset: 1.5 },
      { action: 'permission', requestHandle: 'req:1', decision: 'always' },
      { action: ['stop'], taskId: 'job:1' },
    ])
      expect(parseSubagentsControlRequest(action)).toBeUndefined();
  });

  it('validates selected detail, permissions, paging and owned results', () => {
    const result = {
      type: 'page',
      page: {
        snapshot,
        offset: 32,
        total: 40,
        selected: {
          ...task,
          canStop: false,
          stopReason: 'stopping',
          permissions: [
            {
              requestHandle: 'req:1',
              title: 'Write file',
              choices: [
                { decision: 'allow', scope: 'once' },
                { decision: 'deny', scope: 'once' },
              ],
            },
          ],
          permissionsOmitted: 1,
        },
      },
    };
    expect(parseSubagentsControlResult(result)).toEqual(result);
    expect(
      parseSubagentsControlResult({
        ...result,
        page: {
          ...result.page,
          unassignedPermissions: [
            {
              requestHandle: 'req:other',
              title: 'External approval',
              choices: [],
            },
          ],
        },
      }),
    ).toBeDefined();
    for (const bad of [
      { ...result, page: { ...result.page, offset: 40 } },
      {
        ...result,
        page: { ...result.page, selected: { ...task, canStop: 'yes' } },
      },
      {
        ...result,
        page: {
          ...result.page,
          selected: { ...task, stopReason: 'cancel_all' },
        },
      },
      { ...result, page: { ...result.page, unassignedPermissionsOmitted: -1 } },
      {
        ...result,
        page: {
          ...result.page,
          unassignedPermissions: [
            {
              requestHandle: 'req:long',
              title: 'Request',
              backend: 'x'.repeat(257),
              choices: [],
            },
          ],
        },
      },
      {
        ...result,
        page: {
          ...result.page,
          selected: {
            ...task,
            permissions: [
              {
                requestHandle: 'req:1',
                title: 'Bad',
                choices: [{ decision: 'allow', scope: 'all' }],
              },
            ],
          },
        },
      },
      { type: 'error', code: 'raw_backend_error' },
      { type: 'outcome', outcome: 'stopped' },
      { type: 'outcome', outcome: ['stopped'], taskId: 'job:1' },
      { type: 'outcome', outcome: 'allowed', requestHandle: '' },
      { ...result, extra: 'x'.repeat(MAX_SUBAGENTS_CONTROL_BYTES + 1) },
    ])
      expect(parseSubagentsControlResult(bad)).toBeUndefined();
    expect(
      parseSubagentsControlResult({
        type: 'outcome',
        outcome: 'stopped',
        taskId: 'job:1',
      }),
    ).toBeDefined();
    expect(
      parseSubagentsControlResult({
        type: 'outcome',
        outcome: 'allowed',
        requestHandle: 'req:1',
      }),
    ).toBeDefined();
  });
});
