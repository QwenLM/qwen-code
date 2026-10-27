/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { Tokenizer, TokenParser, TokenType } from '@streamparser/json';
import { openNoFollow } from '../utils/no-follow-open.js';

export type ManagedJournalStreamItem =
  | {
      readonly type: 'record';
      readonly record: Record<string, unknown>;
      readonly line: number;
    }
  | {
      readonly type: 'snapshot-field';
      readonly field: string;
      readonly key?: string;
      readonly value: unknown;
    }
  | { readonly type: 'snapshot-end' };

const eventFields = [
  'v',
  'type',
  'sequence',
  'at',
  'activation',
  'identity',
  'lease',
  'workerId',
  'epoch',
  'outcome',
  'message',
  'fence',
  'digest',
];
const maximumItemBytes = 64 * 1024 * 1024;

export async function readManagedJournalStream(
  filePath: string,
  kind: 'activation' | 'inbox',
  consume: (items: readonly ManagedJournalStreamItem[]) => Promise<void>,
): Promise<{ syncedBytes: number; snapshotBytes: number; totalBytes: number }> {
  let handle;
  try {
    handle = await openNoFollow(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { syncedBytes: 0, snapshotBytes: 0, totalBytes: 0 };
    throw error;
  }
  let syncedBytes = 0;
  let snapshotBytes = 0;
  let totalBytes = 0;
  let firstBytes = Buffer.alloc(0);
  let line = 1;
  let lineBytes = 0;
  let boundary = 0;
  let queued: ManagedJournalStreamItem[] = [];
  const collection = kind === 'activation' ? 'activations' : 'messages';
  let root: Record<string, unknown> = {};
  let stateSeen = false;
  let stateFields = new Set<string>();
  let depth: number;
  let rootKey: string;
  let rootExpectKey: boolean;
  let stateField: string;
  let stateExpectKey: boolean;
  let stateCount: number;
  let members: number;
  let digest: ReturnType<typeof createHash>;
  let stateDigest = '';
  let complete = false;
  let failure: unknown;
  let tokenizer = new Tokenizer();
  let parser: TokenParser;
  const reset = () => {
    root = {};
    stateSeen = false;
    stateFields = new Set();
    depth = 0;
    rootKey = '';
    rootExpectKey = true;
    stateField = '';
    stateExpectKey = true;
    stateCount = 0;
    members = 0;
    digest = createHash('sha256');
    stateDigest = '';
    complete = false;
    failure = undefined;
    boundary = 0;
    tokenizer = new Tokenizer({ stringBufferSize: 64 * 1024 });
    parser = new TokenParser({
      paths: [
        ...eventFields.map((field) => `$.${field}`),
        '$.state.nextSequence',
        `$.state.${collection}.*`,
        ...(kind === 'activation' ? ['$.state.nextEpoch.*'] : []),
      ],
      keepStack: false,
    });
    let tokenOffset = 0;
    parser.onValue = ({ value, key, stack }) => {
      if (stack.length === 1) {
        Object.defineProperty(root, String(key), {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else if (stack.length === 2 && key === 'nextSequence') {
        digest.update(JSON.stringify(value));
        if (line === 1 && root['v'] !== 1)
          queued.push({ type: 'snapshot-field', field: 'nextSequence', value });
      } else if (stack.length === 3) {
        const field = String(stack[2].key);
        digest.update(
          `${members++ ? ',' : ''}${field === 'nextEpoch' ? `${JSON.stringify(key)}:` : ''}${JSON.stringify(value)}`,
        );
        boundary = tokenOffset;
        if (line === 1 && root['v'] !== 1)
          queued.push({
            type: 'snapshot-field',
            field,
            ...(field === 'nextEpoch' ? { key: String(key) } : {}),
            value,
          });
      }
    };
    tokenizer.onToken = (token) => {
      tokenOffset = token.offset;
      const { token: type, value } = token;
      if (type === TokenType.STRING) {
        if (depth === 1 && rootExpectKey) {
          rootKey = String(value);
          rootExpectKey = false;
        } else if (depth === 2 && stateSeen && stateExpectKey) {
          stateField = String(value);
          if (
            ![
              'nextSequence',
              collection,
              ...(kind === 'activation' ? ['nextEpoch'] : []),
            ].includes(stateField) ||
            stateFields.has(stateField)
          )
            throw new Error('Journal snapshot state fields are invalid.');
          stateFields.add(stateField);
          digest.update(
            `${stateCount++ ? ',' : ''}${JSON.stringify(stateField)}:`,
          );
          stateExpectKey = false;
        }
      }
      if (type === TokenType.COMMA) {
        if (depth === 1) rootExpectKey = true;
        if (depth === 2 && stateSeen) stateExpectKey = true;
      }
      if (type === TokenType.LEFT_BRACE || type === TokenType.LEFT_BRACKET) {
        if (depth === 0 && type !== TokenType.LEFT_BRACE)
          throw new Error('Journal record must be an object.');
        if (depth === 1 && rootKey === 'state') {
          if (type !== TokenType.LEFT_BRACE || stateSeen)
            throw new Error('Journal snapshot state is invalid.');
          stateSeen = true;
          digest.update('{');
        } else if (depth === 2 && stateSeen) {
          if (
            (stateField === collection && type !== TokenType.LEFT_BRACKET) ||
            (stateField === 'nextEpoch' && type !== TokenType.LEFT_BRACE) ||
            stateField === 'nextSequence'
          )
            throw new Error('Journal snapshot collection is invalid.');
          digest.update(type === TokenType.LEFT_BRACE ? '{' : '[');
          members = 0;
        }
        depth++;
        if (depth > 74)
          throw new Error('Journal JSON exceeds its depth limit.');
      } else if (
        type === TokenType.RIGHT_BRACE ||
        type === TokenType.RIGHT_BRACKET
      ) {
        if (stateSeen && depth === 3)
          digest.update(type === TokenType.RIGHT_BRACE ? '}' : ']');
        if (stateSeen && depth === 2) {
          digest.update('}');
          stateDigest = digest.digest('hex');
        }
        depth--;
        if (depth === 0) complete = true;
      }
      parser.write(token);
    };
  };
  reset();
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new Error('Managed journal must be a regular file.');
    for (;;) {
      const bytes = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, null);
      if (!bytesRead) break;
      const chunk = bytes.subarray(0, bytesRead);
      if (firstBytes.length < 7)
        firstBytes = Buffer.concat([
          firstBytes,
          chunk.subarray(0, 7 - firstBytes.length),
        ]);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.byteLength : newline + 1;
        const part = chunk.subarray(offset, end);
        lineBytes += part.byteLength;
        totalBytes += part.byteLength;
        offset = end;
        if (!failure) {
          try {
            if (lineBytes - boundary > maximumItemBytes)
              throw new Error('Journal item exceeds its byte limit.');
            tokenizer.write(part);
          } catch (error) {
            failure = error;
          }
        }
        if (newline >= 0) {
          if (!failure) {
            try {
              tokenizer.end();
            } catch (error) {
              failure = error;
            }
          }
          if (failure) throw failure;
          if (!complete)
            throw new Error(
              `Managed journal line ${line} is empty or incomplete.`,
            );
          if (stateSeen || root['type'] === `${kind}.snapshot`) {
            if (line !== 1) throw new Error('Journal snapshot must be first.');
            if (
              !stateSeen ||
              root['v'] !== 2 ||
              root['type'] !== `${kind}.snapshot` ||
              root['digest'] !== stateDigest ||
              !stateFields.has('nextSequence') ||
              !stateFields.has(collection) ||
              (kind === 'activation' && !stateFields.has('nextEpoch'))
            )
              throw new Error(
                'Journal snapshot version, state, or digest is invalid.',
              );
            queued.push({ type: 'snapshot-end' });
            snapshotBytes = lineBytes;
          } else {
            queued.push({ type: 'record', record: root, line });
          }
          syncedBytes = totalBytes;
          line++;
          lineBytes = 0;
          reset();
        }
      }
      if (queued.length) {
        await consume(queued);
        queued = [];
      }
    }
    if (
      totalBytes > syncedBytes &&
      syncedBytes === 0 &&
      firstBytes.toString('utf8') !== '{"v":1,'
    )
      throw new Error('Managed journal has no complete record.');
    const after = await handle.stat();
    const current = await lstat(filePath);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Managed journal changed while opening.');
    return { syncedBytes, snapshotBytes, totalBytes };
  } finally {
    await handle.close();
  }
}

export async function* encodeManagedJournalSnapshotStream(
  type: string,
  state: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer> {
  const hasher = createHash('sha256');
  yield Buffer.from(`{"v":2,"type":${JSON.stringify(type)},"state":`);
  for await (const piece of state) {
    hasher.update(piece);
    yield piece;
  }
  yield Buffer.from(`,"digest":${JSON.stringify(hasher.digest('hex'))}}\n`);
}
