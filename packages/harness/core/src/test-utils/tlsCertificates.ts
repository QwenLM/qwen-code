/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const opensslAvailable =
  spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

export interface TestCertificate {
  cert: string;
  key: string;
}

/** Generate a short-lived certificate chain for real TLS verification tests. */
export async function createTlsCertificates() {
  const directory = await mkdtemp(path.join(tmpdir(), 'qwen-tls-test-'));

  async function issue(
    name: string,
    issuer?: string,
    extensions =
      'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign',
  ): Promise<TestCertificate> {
    await exec(
      'openssl',
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.csr`,
        '-subj',
        `/CN=${name}`,
      ],
      { cwd: directory },
    );
    await writeFile(path.join(directory, `${name}.ext`), extensions);
    await exec(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        `${name}.csr`,
        '-out',
        `${name}.pem`,
        '-days',
        '2',
        '-sha256',
        '-extfile',
        `${name}.ext`,
        ...(issuer
          ? [
              '-CA',
              `${issuer}.pem`,
              '-CAkey',
              `${issuer}.key`,
              '-CAcreateserial',
            ]
          : ['-signkey', `${name}.key`]),
      ],
      { cwd: directory },
    );
    return {
      cert: await readFile(path.join(directory, `${name}.pem`), 'utf8'),
      key: await readFile(path.join(directory, `${name}.key`), 'utf8'),
    };
  }

  try {
    const root = await issue('root');
    const intermediate = await issue('intermediate', 'root');
    const leaf = await issue(
      'leaf',
      'intermediate',
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost',
    );
    const otherRoot = await issue('otherRoot');
    return {
      root,
      intermediate,
      leaf,
      otherRoot,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
