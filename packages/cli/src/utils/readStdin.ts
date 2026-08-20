/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeStderrLine } from './stdioHelpers.js';

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;

  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    end += char.length;
  }

  return value.slice(0, end);
}

export async function readStdin(): Promise<string> {
  const MAX_STDIN_SIZE = 8 * 1024 * 1024; // 8MB
  return new Promise((resolve, reject) => {
    let data = '';
    let totalSize = 0;
    let settled = false;
    process.stdin.setEncoding('utf8');

    const pipedInputShouldBeAvailableInMs = 500;
    let pipedInputTimerId: null | NodeJS.Timeout = setTimeout(() => {
      // stop reading if input is not available yet, this is needed
      // in terminals where stdin is never TTY and nothing's piped
      // which causes the program to get stuck expecting data from stdin
      onEnd();
    }, pipedInputShouldBeAvailableInMs);

    const onReadable = () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        if (pipedInputTimerId) {
          clearTimeout(pipedInputTimerId);
          pipedInputTimerId = null;
        }

        const chunkSize = Buffer.byteLength(chunk, 'utf8');
        if (totalSize + chunkSize > MAX_STDIN_SIZE) {
          const remainingSize = MAX_STDIN_SIZE - totalSize;
          const prefix = takeUtf8Prefix(chunk, remainingSize);
          data += prefix;
          totalSize += Buffer.byteLength(prefix, 'utf8');
          writeStderrLine(
            `Warning: stdin input truncated to ${MAX_STDIN_SIZE} bytes.`,
          );
          finish();
          process.stdin.destroy(); // Stop reading further
          return;
        }
        data += chunk;
        totalSize += chunkSize;
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    const onEnd = () => {
      finish();
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      if (pipedInputTimerId) {
        clearTimeout(pipedInputTimerId);
        pipedInputTimerId = null;
      }
      process.stdin.removeListener('readable', onReadable);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    };

    process.stdin.on('readable', onReadable);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}
