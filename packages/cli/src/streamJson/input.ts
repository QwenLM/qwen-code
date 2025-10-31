/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import {
  parseStreamJsonEnvelope,
  type StreamJsonControlRequestEnvelope,
  type StreamJsonOutputEnvelope,
} from './types.js';
import { FatalInputError } from '@qwen-code/qwen-code-core';
import { extractUserMessageText, writeStreamJsonEnvelope } from './io.js';

export interface ParsedStreamJsonInput {
  prompt: string;
}

export async function readStreamJsonInput(): Promise<ParsedStreamJsonInput> {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: false,
  });

  try {
    return await parseStreamJsonInputFromIterable(rl);
  } finally {
    rl.close();
  }
}

export async function parseStreamJsonInputFromIterable(
  lines: AsyncIterable<string>,
  emitEnvelope: (
    envelope: StreamJsonOutputEnvelope,
  ) => void = writeStreamJsonEnvelope,
): Promise<ParsedStreamJsonInput> {
  const promptParts: string[] = [];
  let receivedUserMessage = false;

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const envelope = parseStreamJsonEnvelope(line);

    switch (envelope.type) {
      case 'user':
        promptParts.push(extractUserMessageText(envelope));
        receivedUserMessage = true;
        break;
      case 'control_request':
        handleControlRequest(envelope, emitEnvelope);
        break;
      case 'control_response':
      case 'control_cancel_request':
        // Currently ignored on CLI side.
        break;
      default:
        throw new FatalInputError(
          `Unsupported stream-json input type: ${envelope.type}`,
        );
    }
  }

  if (!receivedUserMessage) {
    throw new FatalInputError(
      'No user message provided via stream-json input.',
    );
  }

  return {
    prompt: promptParts.join('\n').trim(),
  };
}

function handleControlRequest(
  envelope: StreamJsonControlRequestEnvelope,
  emitEnvelope: (envelope: StreamJsonOutputEnvelope) => void,
) {
  const subtype = envelope.request?.subtype;
  if (subtype === 'initialize') {
    emitEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: true,
      response: {
        subtype,
        capabilities: {},
      },
    });
    return;
  }

  emitEnvelope({
    type: 'control_response',
    request_id: envelope.request_id,
    success: false,
    error: `Unsupported control_request subtype: ${subtype ?? 'unknown'}`,
  });
}

export { extractUserMessageText } from './io.js';
