// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import {
  restoreManagedMcpCommand,
  saveManagedMcpCommand,
  type ManagedMcpCommandAttempt,
  type ManagedMcpCommandTarget,
} from './managed-mcp-command-storage';

const target: ManagedMcpCommandTarget = [
  'https://product.example:managed:tenant:actor',
  'tenant:actor',
  'client',
  'workspace',
  'session',
];
const attempt: ManagedMcpCommandAttempt = {
  command: {
    action: 'edit',
    serverId: 'docs',
    expectedRevision: 3,
    server: {
      serverId: 'docs',
      serverRevision: 7,
      definitionDigest: 'a'.repeat(64),
    },
  },
  requestId: 'original-request',
  idempotencyKey: 'original-command',
  operationId: '00000000-0000-4000-8000-000000000001',
};

beforeEach(() => sessionStorage.clear());

it('saves only the exact command identity in this tab and removes it after confirmation', () => {
  saveManagedMcpCommand(target, attempt);
  const key = sessionStorage.key(0)!;
  expect(key).toContain(JSON.stringify(target));
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({ target, attempt });
  expect(restoreManagedMcpCommand(target)).toEqual(attempt);
  saveManagedMcpCommand(target, undefined);
  expect(restoreManagedMcpCommand(target)).toBeUndefined();
});

it.each([0, 1, 2, 3, 4])('isolates the saved target field %i', (index) => {
  saveManagedMcpCommand(target, attempt);
  const changed: [string, string, string, string, string] = [...target];
  changed[index] += '-other';
  expect(restoreManagedMcpCommand(changed)).toBeUndefined();
  const originalKey = sessionStorage.key(0)!;
  const copiedKey = originalKey.replace(
    JSON.stringify(target),
    JSON.stringify(changed),
  );
  sessionStorage.setItem(copiedKey, sessionStorage.getItem(originalKey)!);
  expect(restoreManagedMcpCommand(changed)).toBeUndefined();
  expect(sessionStorage.getItem(copiedKey)).toBeNull();
});

it.each([
  { ...attempt, env: { SECRET: 'unexpected' } },
  { ...attempt, operationId: 'not-an-operation' },
  { ...attempt, idempotencyKey: '' },
  { ...attempt, requestId: 'x'.repeat(129) },
  { ...attempt, command: { ...attempt.command, action: ['edit'] } },
  { ...attempt, command: { ...attempt.command, action: 'unknown' } },
  { ...attempt, command: { ...attempt.command, expectedRevision: -1 } },
  { ...attempt, command: { ...attempt.command, expectedRevision: 1.5 } },
  {
    ...attempt,
    command: { ...attempt.command, expectedRevision: Number.MAX_SAFE_INTEGER },
  },
  { ...attempt, command: { ...attempt.command, serverId: 'invalid server' } },
  { ...attempt, command: { ...attempt.command, server: undefined } },
  {
    ...attempt,
    command: {
      ...attempt.command,
      server: { ...attempt.command.server, serverId: 'other' },
    },
  },
  {
    ...attempt,
    command: {
      ...attempt.command,
      server: { ...attempt.command.server, serverRevision: 0 },
    },
  },
  {
    ...attempt,
    command: {
      ...attempt.command,
      server: { ...attempt.command.server, definitionDigest: 'not-a-digest' },
    },
  },
  {
    ...attempt,
    command: {
      ...attempt.command,
      server: { ...attempt.command.server, command: 'arbitrary-recipe' },
    },
  },
  { ...attempt, command: { ...attempt.command, action: 'restart' } },
])('rejects closed-schema or invalid persisted commands %#', (invalid) => {
  saveManagedMcpCommand(target, attempt);
  const key = sessionStorage.key(0)!;
  sessionStorage.setItem(key, JSON.stringify({ target, attempt: invalid }));
  expect(restoreManagedMcpCommand(target)).toBeUndefined();
  expect(sessionStorage.getItem(key)).toBeNull();
});

it('rejects an invalid envelope or broken JSON without making a command', () => {
  saveManagedMcpCommand(target, attempt);
  const key = sessionStorage.key(0)!;
  for (const raw of [
    '{',
    JSON.stringify({ target, attempt, credentials: 'unexpected' }),
  ]) {
    sessionStorage.setItem(key, raw);
    expect(restoreManagedMcpCommand(target)).toBeUndefined();
  }
});
