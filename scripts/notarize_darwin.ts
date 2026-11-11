#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Submits a signed darwin binary to Apple's notarization service.
 *
 * Prerequisites:
 *   - The binary is already hardened-runtime code-signed with a Developer ID
 *     identity (bun-binary-compiler.ts does this when CODESIGN_IDENTITY is set).
 *   - One of the two auth modes below is configured via environment.
 *
 * Auth modes (API key is preferred — no 2FA, works for org accounts):
 *   A) App Store Connect API key:
 *      APPLE_API_KEY_PATH   — path to the .p8 file
 *      APPLE_API_KEY_ID     — key ID (10-char alphanumeric)
 *      APPLE_API_ISSUER     — issuer UUID
 *   B) Apple ID + app-specific password:
 *      APPLE_ID                        — developer Apple ID email
 *      APPLE_TEAM_ID                   — 10-char team ID
 *      APPLE_APP_SPECIFIC_PASSWORD     — from appleid.apple.com
 *
 * Stapling note: `stapler` cannot staple a bare mach-O executable — it only
 * works on .app / .dmg / .pkg. The notarization itself registers the binary's
 * hash with Apple, so Gatekeeper will accept it with a network round-trip on
 * first launch. If offline first-run matters, wrap the binary in a .dmg or
 * .pkg downstream and staple that artifact instead.
 *
 * Usage:
 *   bun run scripts/notarize_darwin.ts dist-bun/qwen
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function requireEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

type AuthArgs = { args: string[]; redact: string[] };

function buildAuthArgs(): AuthArgs {
  const keyPath = requireEnv('APPLE_API_KEY_PATH');
  const keyId = requireEnv('APPLE_API_KEY_ID');
  const issuer = requireEnv('APPLE_API_ISSUER');
  if (keyPath && keyId && issuer) {
    if (!existsSync(keyPath)) {
      throw new Error(`APPLE_API_KEY_PATH does not exist: ${keyPath}`);
    }
    return {
      args: ['--key', keyPath, '--key-id', keyId, '--issuer', issuer],
      redact: [keyId, issuer],
    };
  }

  const appleId = requireEnv('APPLE_ID');
  const teamId = requireEnv('APPLE_TEAM_ID');
  const pw = requireEnv('APPLE_APP_SPECIFIC_PASSWORD');
  if (appleId && teamId && pw) {
    return {
      args: ['--apple-id', appleId, '--team-id', teamId, '--password', pw],
      redact: [pw, appleId],
    };
  }

  throw new Error(
    'notarize_darwin: no auth configured. Set either ' +
      'APPLE_API_KEY_PATH+APPLE_API_KEY_ID+APPLE_API_ISSUER or ' +
      'APPLE_ID+APPLE_TEAM_ID+APPLE_APP_SPECIFIC_PASSWORD.',
  );
}

function redact(s: string, needles: string[]): string {
  let out = s;
  for (const n of needles) {
    if (n) out = out.replaceAll(n, '******');
  }
  return out;
}

function run(cmd: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? -1,
  };
}

function verifySignature(binaryPath: string): void {
  const v = run([
    'codesign',
    '--verify',
    '--strict',
    '--verbose=2',
    binaryPath,
  ]);
  if (v.exitCode !== 0) {
    throw new Error(
      `Binary is not validly signed; notarization will reject it:\n${v.stderr.trim()}`,
    );
  }
  // Notarization requires the hardened runtime flag. Detect it via
  // `codesign -d` — if the flags line omits "runtime", bail early rather
  // than waiting for Apple to reject.
  const d = run(['codesign', '-d', '--verbose=2', binaryPath]);
  if (!/flags=.*runtime/i.test(`${d.stdout}${d.stderr}`)) {
    throw new Error(
      'Binary is signed without the hardened runtime. Re-sign with ' +
        '`codesign --options runtime ...` (bun-binary-compiler.ts already does ' +
        'this when CODESIGN_IDENTITY is set).',
    );
  }
}

function zipForSubmission(binaryPath: string, workDir: string): string {
  // `ditto -c -k --sequesterRsrc --keepParent` is Apple's own recommendation
  // for packaging bare executables for notarytool — see TN2206.
  const zipPath = path.join(workDir, `${path.basename(binaryPath)}.zip`);
  const r = run([
    'ditto',
    '-c',
    '-k',
    '--sequesterRsrc',
    '--keepParent',
    binaryPath,
    zipPath,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`ditto failed: ${r.stderr.trim()}`);
  }
  return zipPath;
}

function submitAndWait(zipPath: string, auth: AuthArgs): void {
  const cmd = [
    'xcrun',
    'notarytool',
    'submit',
    zipPath,
    ...auth.args,
    '--wait',
    '--output-format',
    'json',
  ];
  console.log(
    `notarize_darwin: submitting ${path.basename(zipPath)} (this usually takes 30s–5min)...`,
  );
  const r = run(cmd);
  const safeOut = redact(r.stdout, auth.redact);
  const safeErr = redact(r.stderr, auth.redact);
  if (r.exitCode !== 0) {
    throw new Error(
      `notarytool submit failed (exit ${r.exitCode}):\n${safeErr || safeOut}`,
    );
  }

  let parsed: { status?: string; id?: string; message?: string } = {};
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `notarytool returned non-JSON output:\n${safeOut}\n${safeErr}`,
    );
  }

  if (parsed.status !== 'Accepted') {
    const id = parsed.id;
    let logDump = '';
    if (id) {
      const logR = run(['xcrun', 'notarytool', 'log', id, ...auth.args]);
      logDump = `\n--- notarytool log ${id} ---\n${redact(logR.stdout || logR.stderr, auth.redact)}`;
    }
    throw new Error(
      `Notarization rejected: status=${parsed.status ?? 'unknown'}` +
        (parsed.message ? ` message=${parsed.message}` : '') +
        logDump,
    );
  }
  console.log(
    `notarize_darwin: accepted (submission id=${parsed.id ?? 'unknown'}).`,
  );
}

const [, , binaryArg] = process.argv;
if (!binaryArg) {
  console.error('Usage: bun run scripts/notarize_darwin.ts <binary-path>');
  process.exit(2);
}
const binaryPath = path.resolve(binaryArg);
if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
  console.error(`notarize_darwin: binary not found at ${binaryPath}`);
  process.exit(2);
}

if (process.platform !== 'darwin') {
  console.error(
    'notarize_darwin: notarytool only runs on macOS — skip this step on other hosts.',
  );
  process.exit(2);
}

const auth = buildAuthArgs();
verifySignature(binaryPath);

const workDir = mkdtempSync(path.join(tmpdir(), 'qwen-notarize-'));
try {
  const zipPath = zipForSubmission(binaryPath, workDir);
  submitAndWait(zipPath, auth);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(
  'notarize_darwin: done. Note: stapling is not supported for bare mach-O ' +
    'binaries — Gatekeeper will fetch the ticket online on first launch. ' +
    'Wrap the binary in a .dmg or .pkg and staple that if offline first-run is required.',
);
