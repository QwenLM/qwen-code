/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// End-to-end coverage for `qwen update --target-version` (issue #11484
// acceptance criterion 7): a disposable standalone installation is updated
// from a local HTTPS release root while the npm registry is unreachable.
// The run must install exactly the requested version and must not touch the
// registry — the sink server fails the test if any request reaches it.
//
// The scratch root stays in os.tmpdir(), outside the repository checkout.
// getInstallationInfo only reports "local git clone" — which disables
// standalone update — when the CLI's cwd sits inside a git worktree AND the
// resolved CLI path lies inside that same cwd (installationInfo.ts). Keeping
// cwd under os.tmpdir() defeats the first half, and install/ and cwd/ being
// siblings defeats the second, so the fixture classifies as standalone
// regardless of where this suite itself runs from.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', '..', 'dist');
const bundlePath = path.join(distDir, 'cli.js');

const INSTALLED_VERSION = '0.0.1';
const TARGET_VERSION = '0.23.1';

// Self-signed loopback pair (CN/SAN 127.0.0.1, CA:TRUE, valid to 2126), the
// same fixture packages/core/src/tools/mcp-client.test.ts embeds — it never
// leaves the local loopback server below.
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDQgVXO0KxbNqR8
QpXVihSXYn/q9CkzT74dLRtDzYZnhD89XhICg9vW6KhRbB7L6MTKQ0Lg501AC74f
hkPrxEjgR6EHmUPiRizGZcb0h165OoQEuQfkceNGmOnH4R+EZbrWdDeVkdtjuQdI
dG0jM4ZWs1ibqfCxScO2QWcovEmxRO/ZvISNWfzJCIIwr0SC3uC6dmgvj34ZSMNY
kJww3G0de8wGG01QPUYBFol9e0iQok5DmPrbnped4Ms1TWe+L4ws+EcFm9CNVPoX
05POJqTVKbVNy8/sU/5zTiRS8E5r28pTfUiijIFEyK5qQyE1T6C0kdB0PAGMhDPR
ZXMijfkhAgMBAAECggEAD8giVw+bZCIMLC2cCrgzW8wEU6PcdHpOMQYngKfPSwmL
Admbcl5JpwggKV2OLS/2qTqTFtPbGIRrBRbUEEXgoD07togGx9s462FrwDl41XtU
38ijjMqEAeV0GIF1Mb/DdxT/2g3atb8dCoJpelcdjXVwuQORaNHlAugLZ11tFII4
yEp+FQgkc5YIJwQWTvyqdZ1qJ4l31FhRvB7GhVDnYRHv1y27jCJiB6vPrv0AQzgh
jVPXS03dswlkMI+ur2Lt3s8qVtdMD2M7Q5dmjHHuKuQvA2rg6iAf2raXOE9oAXQy
MQTgi3bF4s/8uuzgm8hmM+/Gz91sTKJCSQ2742okGQKBgQDvTgxXm+xxLk1DqHGZ
DEtplyl9fQ2qNSpzCgUtIdL3UyWFDRBDS2g9o+8Z8SSWUTiKlcrVU88vepVLduTk
g5cNF2W/qKg+ycRR76E+t6+ApnF13atEr2DCIrLq8nqwbG3ZsU/XD04MWI496/ov
4ZXpvTcyxxW/TRb259qJWWSE/QKBgQDfDTWWh/tWngkBOEMs0GaLLElkwIMmjOtm
CWplylna1vBUsct/lozTNIVrvVSlE41VeQq6TtpSVrEGhQ2KlFXow7iBHkRQkujl
8MmJJF/wF/6EQGvfvtg+7e9s8CD22P9Cf35cec+PPQA5Rw8j644OKnjyy8Q4sojg
xsIPHcVv9QKBgQCUO/CBRGDOKzRJOMpFV8xO+AgHZ7NTP+OvpwFV16Hq+mI/bLwq
M0e7BxVRKILVajJwBiHCy0uHyZM5T8ixlKG4xkmM01iErE8jwiBLzVS1iGS38jvp
LAnvt7bEurctGb1iH+eo/B4In8JcsRQlHMPUKhVLKu9ZtNMI1s4UTn9psQKBgBCj
sqC1KjnO9ksCAHjiXxP4zMzYU7BXiOQGxcosK0HZEPqwfMba20ySOXXNHPhnmf6L
VhKJ+V11HCWpXVY+NJ51o1j2ghAktX0Z1l8FuKZ3k8QX7jQ1z3n6VAcjbsIbdAdo
7WtGpwY/fbnIJEgAtYs2/ejW7J9yKiXije2EwgrVAoGBAIiZcGSxIs4biak00HmY
XXncJp8jBl9HdqrBH7wn9IuCRU4G2a1gLi0LTHcuIo4HMpMqXmrsuCMh8a9teCpP
ZEyVOb7bwmXfTJrL0iFThl/nXzvUyQ5J0/jXqBwIdQu4DbORAtjwRlZRxe05yrza
N8JEixv6MDQEx9NiIqpn+V6Y
-----END PRIVATE KEY-----`;
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUCjr0jOOpgv0drL4OfEIp85UQ6mwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDcxOTA0NDAxNloYDzIxMjYw
NjI1MDQ0MDE2WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDQgVXO0KxbNqR8QpXVihSXYn/q9CkzT74dLRtDzYZn
hD89XhICg9vW6KhRbB7L6MTKQ0Lg501AC74fhkPrxEjgR6EHmUPiRizGZcb0h165
OoQEuQfkceNGmOnH4R+EZbrWdDeVkdtjuQdIdG0jM4ZWs1ibqfCxScO2QWcovEmx
RO/ZvISNWfzJCIIwr0SC3uC6dmgvj34ZSMNYkJww3G0de8wGG01QPUYBFol9e0iQ
ok5DmPrbnped4Ms1TWe+L4ws+EcFm9CNVPoX05POJqTVKbVNy8/sU/5zTiRS8E5r
28pTfUiijIFEyK5qQyE1T6C0kdB0PAGMhDPRZXMijfkhAgMBAAGjZDBiMB0GA1Ud
DgQWBBSYkNfOElpRlCq/zavOPLU9fIFgbzAfBgNVHSMEGDAWgBSYkNfOElpRlCq/
zavOPLU9fIFgbzAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAGKk+sZgU1OnjK/NObfqVcpdRdA4gP15Nn3kUvsU8H6m
A+gMgFwr20G+0uMsvxrWCBJwm/Q16XT/ctCIClRf98t3reu685h/fD/akLv0g/qo
FIgZqCVyMgOBWGLSdDIyNBQHs16ZcV178/WyHfobnMcmtNOQpVg6vDKawBGyopmI
nV5F0SDrn4lpQexUfJqikDj8VDgKEovDsSPdXJv9J2aJChqkeQHAexbbj3P+SDyr
MxT7pKQh7HN5ulX1fgCsf+VCiF/Sbd5QCkn4i4obIC95CU3MCOCQCiPo1B43HpHc
lOTTGqPpwFUbw2EMOOpFYuIyzGMIpUNMBjE2gvJiqFQ=
-----END CERTIFICATE-----`;

function standaloneTarget(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  throw new Error(`Unsupported platform: ${process.platform}`);
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runUpdate(
  installDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(installDir, 'lib', 'cli.js'),
        'update',
        '--target-version',
        TARGET_VERSION,
      ],
      { cwd, env, stdio: 'pipe' },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', reject);
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`update timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, 120_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe.skipIf(process.platform === 'win32')(
  'qwen update --target-version (standalone, registry blocked)',
  () => {
    let target: string;
    let tmpRoot: string;
    let installDir: string;
    let releaseServer: https.Server;
    let registrySink: http.Server;
    let releaseRequests: string[];
    let registryRequests: string[];
    let caPath: string;
    let homeDir: string;

    // (Re)builds the disposable standalone installation at INSTALLED_VERSION,
    // running the real bundled CLI as its lib/cli.js.
    function seedInstallation() {
      fs.rmSync(installDir, { recursive: true, force: true });
      fs.rmSync(`${installDir}.old`, { recursive: true, force: true });
      fs.mkdirSync(path.join(installDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(installDir, 'bin'));
      fs.mkdirSync(path.join(installDir, 'node', 'bin'), { recursive: true });
      // The bundle is code-split: cli.js imports ./chunks and loads locales
      // from a sibling directory, so both ship inside the fake install's lib/.
      fs.copyFileSync(bundlePath, path.join(installDir, 'lib', 'cli.js'));
      fs.cpSync(
        path.join(distDir, 'chunks'),
        path.join(installDir, 'lib', 'chunks'),
        {
          recursive: true,
        },
      );
      fs.cpSync(
        path.join(distDir, 'locales'),
        path.join(installDir, 'lib', 'locales'),
        { recursive: true },
      );
      fs.writeFileSync(
        path.join(installDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target,
          version: INSTALLED_VERSION,
        }),
      );
      fs.writeFileSync(path.join(installDir, 'bin', 'qwen'), '#!/bin/sh\n', {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(installDir, 'node', 'bin', 'node'),
        '#!/bin/sh\n',
        { mode: 0o755 },
      );
    }

    // Per-spawn environment. The pins after the spread keep the run hermetic:
    // the fixture serves no SHA256SUMS.sig, so an ambient
    // QWEN_REQUIRE_SIGNATURE=1 would abort the update; QWEN_CODE_LANG
    // outranks the fixture's language setting, so an ambient zh turns the
    // asserted English output Chinese; and QWEN_HOME must point at the
    // isolated home or the child refills cleared variables from the host's
    // settings.json.
    function updateEnv(): NodeJS.ProcessEnv {
      const releasePort = (releaseServer.address() as { port: number }).port;
      const sinkPort = (registrySink.address() as { port: number }).port;
      return {
        ...process.env,
        QWEN_UPDATE_BASE_URL: `https://127.0.0.1:${releasePort}`,
        npm_config_registry: `http://127.0.0.1:${sinkPort}`,
        NODE_EXTRA_CA_CERTS: caPath,
        HOME: homeDir,
        SHELL: '',
        NO_COLOR: '1',
        QWEN_REQUIRE_SIGNATURE: '',
        QWEN_CODE_LANG: 'en',
        QWEN_HOME: path.join(homeDir, '.qwen'),
      };
    }

    beforeAll(async () => {
      target = standaloneTarget();
      tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'qwen-update-target-e2e-'),
      );

      installDir = path.join(tmpRoot, 'install', 'qwen-code');
      caPath = path.join(tmpRoot, 'loopback-ca.pem');
      fs.writeFileSync(caPath, SELF_SIGNED_CERT);
      homeDir = path.join(tmpRoot, 'home');
      fs.mkdirSync(homeDir, { recursive: true });

      // Project dir the CLI runs in: settings only, auto-update off so no
      // background check can fire.
      const cwd = path.join(tmpRoot, 'cwd');
      fs.mkdirSync(path.join(cwd, '.qwen'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, '.qwen', 'settings.json'),
        JSON.stringify({
          general: { enableAutoUpdate: false, language: 'en' },
          telemetry: { enabled: false },
        }),
      );

      // Release fixture: archive whose manifest and executable both report
      // TARGET_VERSION.
      const fixtureDir = path.join(tmpRoot, 'fixture');
      fs.mkdirSync(path.join(fixtureDir, 'qwen-code', 'node', 'bin'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(fixtureDir, 'qwen-code', 'lib'));
      // Mirrors the official archive manifest — create-standalone-package.js
      // always writes name/target/version, and the updater's manifest gate
      // rejects archives missing any of them.
      fs.writeFileSync(
        path.join(fixtureDir, 'qwen-code', 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target,
          version: TARGET_VERSION,
        }),
      );
      fs.writeFileSync(
        path.join(fixtureDir, 'qwen-code', 'node', 'bin', 'node'),
        `#!/bin/sh\nprintf '%s\\n' '${TARGET_VERSION}'\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fixtureDir, 'qwen-code', 'lib', 'cli.js'),
        `// fixture ${TARGET_VERSION}\n`,
      );
      const archivePath = path.join(tmpRoot, 'release.tar.gz');
      await execFileAsync('tar', [
        '-czf',
        archivePath,
        '-C',
        fixtureDir,
        'qwen-code',
      ]);
      const archive = fs.readFileSync(archivePath);
      const checksum = createHash('sha256').update(archive).digest('hex');
      const filename = `qwen-code-${target}.tar.gz`;

      releaseRequests = [];
      releaseServer = https.createServer(
        { key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT },
        (req, res) => {
          releaseRequests.push(req.url ?? '');
          if (req.url === `/v${TARGET_VERSION}/${filename}`) {
            res.writeHead(200, { 'Content-Type': 'application/gzip' });
            res.end(archive);
          } else if (req.url === `/v${TARGET_VERSION}/SHA256SUMS`) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(`${checksum}  ${filename}\n`);
          } else {
            res.writeHead(404);
            res.end();
          }
        },
      );
      await new Promise<void>((resolve) =>
        releaseServer.listen(0, '127.0.0.1', resolve),
      );

      // Any npm registry discovery lands here and fails the run.
      registryRequests = [];
      registrySink = http.createServer((req, res) => {
        registryRequests.push(req.url ?? '');
        res.writeHead(503);
        res.end();
      });
      await new Promise<void>((resolve) =>
        registrySink.listen(0, '127.0.0.1', resolve),
      );
    });

    beforeEach(() => {
      // vitest retries the test task, not the file: without re-seeding, a
      // retry after a successful activation would run the update against the
      // archive's own fixture body and report a fabricated empty-stdout
      // failure.
      seedInstallation();
      releaseRequests.length = 0;
      registryRequests.length = 0;
    });

    afterAll(async () => {
      // Either server is still undefined when beforeAll threw before creating
      // it; an unconditional close-promise would never settle, hanging the
      // hook until timeout and leaking tmpRoot.
      await Promise.all([
        releaseServer
          ? new Promise<void>((resolve) => releaseServer.close(() => resolve()))
          : Promise.resolve(),
        registrySink
          ? new Promise<void>((resolve) => registrySink.close(() => resolve()))
          : Promise.resolve(),
      ]);
      if (tmpRoot && process.env['KEEP_OUTPUT'] !== 'true') {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('installs exactly the requested version with zero registry access', async () => {
      // Stage the hostile ambient environment the per-spawn pins must
      // defeat: with any one of the three pins removed, the spawned CLI
      // picks the ambient value up and this test fails — a zh locale flips
      // the asserted English output, QWEN_REQUIRE_SIGNATURE=1 aborts on the
      // missing .sig, and the hostile home's settings env block refills it.
      const hostileHome = path.join(tmpRoot, 'hostile-home');
      fs.mkdirSync(hostileHome, { recursive: true });
      fs.writeFileSync(
        path.join(hostileHome, 'settings.json'),
        JSON.stringify({ env: { QWEN_REQUIRE_SIGNATURE: '1' } }),
      );
      vi.stubEnv('QWEN_CODE_LANG', 'zh');
      vi.stubEnv('QWEN_REQUIRE_SIGNATURE', '1');
      vi.stubEnv('QWEN_HOME', hostileHome);
      const result = await runUpdate(
        installDir,
        path.join(tmpRoot, 'cwd'),
        updateEnv(),
      ).finally(() => {
        vi.unstubAllEnvs();
      });

      expect(
        result.code,
        `update failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain('Update successful');

      // Exactly the requested version is now installed.
      const manifest = JSON.parse(
        fs.readFileSync(path.join(installDir, 'manifest.json'), 'utf-8'),
      ) as { version?: string };
      expect(manifest.version).toBe(TARGET_VERSION);
      expect(
        fs.readFileSync(path.join(installDir, 'lib', 'cli.js'), 'utf-8'),
      ).toBe(`// fixture ${TARGET_VERSION}\n`);

      // The previous installation is retained for rollback.
      const oldManifest = JSON.parse(
        fs.readFileSync(`${installDir}.old/manifest.json`, 'utf-8'),
      ) as { version?: string };
      expect(oldManifest.version).toBe(INSTALLED_VERSION);

      // No npm registry request or discovery subprocess reached the network.
      expect(registryRequests).toEqual([]);

      // Downloads came only from the configured release root.
      const filename = `qwen-code-${target}.tar.gz`;
      expect(releaseRequests).toContain(`/v${TARGET_VERSION}/${filename}`);
      expect(releaseRequests).toContain(`/v${TARGET_VERSION}/SHA256SUMS`);
      for (const url of releaseRequests) {
        expect([
          `/v${TARGET_VERSION}/${filename}`,
          `/v${TARGET_VERSION}/SHA256SUMS`,
          `/v${TARGET_VERSION}/SHA256SUMS.sig`,
        ]).toContain(url);
      }
    }, 180_000);

    it('re-runs the update cleanly after a previous activation', async () => {
      // Witness for the beforeEach re-seed: without it this runs against the
      // post-activation tree the first test left behind — lib/cli.js is then
      // the archive's fixture body — and fails on fabricated empty stdout.
      const result = await runUpdate(
        installDir,
        path.join(tmpRoot, 'cwd'),
        updateEnv(),
      );

      expect(
        result.code,
        `update failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain('Update successful');
      const manifest = JSON.parse(
        fs.readFileSync(path.join(installDir, 'manifest.json'), 'utf-8'),
      ) as { version?: string };
      expect(manifest.version).toBe(TARGET_VERSION);
      expect(registryRequests).toEqual([]);
    }, 180_000);
  },
);
