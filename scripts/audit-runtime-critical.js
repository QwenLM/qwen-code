#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const AUDIT_URL =
  'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

export function createAuditPayload(lock) {
  const versions = new Map();

  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path || pkg.link || pkg.dev || !pkg.version) continue;
    const name = pkg.name ?? path.slice(path.lastIndexOf('node_modules/') + 13);
    const values = versions.get(name) ?? new Set();
    values.add(pkg.version);
    versions.set(name, values);
  }

  return Object.fromEntries(
    [...versions].map(([name, values]) => [name, [...values]]),
  );
}

export function decodeAuditResponse(body) {
  // The registry can omit Content-Encoding even when returning gzip.
  return body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
}

export function findCriticalAdvisories(report) {
  return Object.entries(report).flatMap(([name, advisories]) => {
    if (!Array.isArray(advisories)) {
      throw new Error(`Invalid audit response for ${name}`);
    }
    return advisories
      .filter(({ severity }) => severity === 'critical')
      .map((advisory) => ({ name, ...advisory }));
  });
}

function requestAudit(payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = https.request(
      AUDIT_URL,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json',
        },
      },
      (response) => {
        const chunks = [];
        response.on('error', reject);
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const result = Buffer.concat(chunks);
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Audit endpoint returned ${response.statusCode}: ${result}`,
              ),
            );
            return;
          }
          resolve(JSON.parse(decodeAuditResponse(result)));
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function main() {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const critical = findCriticalAdvisories(
    await requestAudit(createAuditPayload(lock)),
  );

  if (critical.length === 0) {
    console.log('No critical runtime vulnerabilities found.');
    return;
  }

  for (const { name, title, url } of critical) {
    console.error(`${name}: ${title} (${url})`);
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
