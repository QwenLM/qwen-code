/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { execSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import cliPkgJson from '../packages/cli/package.json' with { type: 'json' };

const argv = yargs(hideBin(process.argv))
  .option('s', {
    alias: 'skip-npm-install-build',
    type: 'boolean',
    default: false,
    description: 'skip npm install + npm run build',
  })
  .option('f', {
    alias: 'dockerfile',
    type: 'string',
    default: 'Dockerfile',
    description: 'use <dockerfile> for custom image',
  })
  .option('i', {
    alias: 'image',
    type: 'string',
    default: cliPkgJson.config.sandboxImageUri,
    description: 'use <image> name for custom image',
  })
  .option('output-file', {
    type: 'string',
    description:
      'Path to write the final image URI. Used for CI/CD pipeline integration.',
  })
  .option('prune', {
    type: 'boolean',
    default: true,
    description: 'prune dangling images after the build',
  }).argv;

let sandboxCommand;
try {
  sandboxCommand = execSync('node scripts/sandbox_command.js')
    .toString()
    .trim();
} catch (e) {
  console.warn('ERROR: could not detect sandbox container command');
  console.error(e);
  process.exit(process.env.CI ? 1 : 0);
}

if (sandboxCommand === 'sandbox-exec') {
  console.warn(
    'WARNING: container-based sandboxing is disabled (see README.md#sandboxing)',
  );
  process.exit(0);
}

console.log(`using ${sandboxCommand} for sandboxing`);

const image = argv.i;
const dockerFile = argv.f;

if (!image.length) {
  console.warn(
    'No default image tag specified in gemini-cli/packages/cli/package.json',
  );
}

if (!argv.s) {
  execSync('npm install', { stdio: 'inherit' });
  execSync('npm run build', { stdio: 'inherit' });

  console.log('bundling...');
  execSync('npm run bundle', { stdio: 'inherit' });

  console.log('preparing package...');
  execSync('npm run prepare:package', { stdio: 'inherit' });

  console.log('packing...');
  const distDir = join(process.cwd(), 'dist');
  for (const f of readdirSync(distDir)) {
    if (f.endsWith('.tgz')) {
      rmSync(join(distDir, f), { force: true });
    }
  }
  execSync('npm pack', { stdio: 'ignore', cwd: distDir });
}

// The image build is the longest step this script runs, and its output used to
// be discarded unless VERBOSE was set: a failure surfaced as an execSync stack
// trace with `stdout: null`, so the line that actually failed inside the
// Dockerfile (a packaging guard, an apt failure, an OOM kill) was gone and the
// only way to see it was to re-run the whole build by hand. CI always streams
// it; interactive runs stay quiet but keep the output so a failure can print
// it.
const streamBuildOutput = Boolean(process.env.VERBOSE || process.env.CI);
const buildStdio = streamBuildOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'];
// A non-verbose build still writes megabytes of layer progress. execSync kills
// the child once maxBuffer is exceeded, so this has to clear a real build's
// output by a wide margin — otherwise capturing it would itself fail the build.
const BUILD_OUTPUT_MAX_BUFFER = 128 * 1024 * 1024;
const BUILD_OUTPUT_TAIL_LINES = 200;

function printCapturedBuildOutput(error) {
  const captured = [error?.stdout, error?.stderr]
    .map((stream) => stream?.toString() ?? '')
    .join('')
    .split('\n');
  const tail = captured.slice(-BUILD_OUTPUT_TAIL_LINES).join('\n').trim();
  if (!tail) return;
  console.error(
    `\n--- last ${BUILD_OUTPUT_TAIL_LINES} lines of ${sandboxCommand} build output ---`,
  );
  console.error(tail);
  console.error(
    '--- end of build output (set VERBOSE=true to stream it) ---\n',
  );
}

// Determine the appropriate shell based on OS
const isWindows = os.platform() === 'win32';
const shellToUse = isWindows ? 'powershell.exe' : '/bin/bash';

function buildImage(imageName, dockerfile) {
  console.log(`building ${imageName} ... (can be slow first time)`);

  let buildCommandArgs = '';
  let tempAuthFile = '';

  if (sandboxCommand === 'podman') {
    if (isWindows) {
      // PowerShell doesn't support <() process substitution.
      // Create a temporary auth file that we will clean up after.
      tempAuthFile = join(os.tmpdir(), `qwen-auth-${Date.now()}.json`);
      writeFileSync(tempAuthFile, '{}');
      buildCommandArgs = `--authfile="${tempAuthFile}"`;
    } else {
      // Use bash-specific syntax for Linux/macOS
      buildCommandArgs = `--authfile=<(echo '{}')`;
    }
  }

  const npmPackageVersion = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
  ).version;

  const imageTag =
    process.env.QWEN_SANDBOX_IMAGE_TAG || imageName.split(':')[1] || 'latest';
  const finalImageName = `${imageName.split(':')[0]}:${imageTag}`;

  try {
    execSync(
      `${sandboxCommand} build ${buildCommandArgs} ${
        process.env.BUILD_SANDBOX_FLAGS || ''
      } --build-arg CLI_VERSION_ARG=${npmPackageVersion} -f "${dockerfile}" -t "${finalImageName}" .`,
      {
        stdio: buildStdio,
        shell: shellToUse,
        maxBuffer: BUILD_OUTPUT_MAX_BUFFER,
      },
    );
    console.log(`built ${finalImageName}`);

    // If an output file path was provided via command-line, write the final image URI to it.
    if (argv.outputFile) {
      console.log(
        `Writing final image URI for CI artifact to: ${argv.outputFile}`,
      );
      // The publish step only supports one image. If we build multiple, only the last one
      // will be published. Throw an error to make this failure explicit if the file already exists.
      if (existsSync(argv.outputFile)) {
        throw new Error(
          `CI artifact file ${argv.outputFile} already exists. Refusing to overwrite.`,
        );
      }
      writeFileSync(argv.outputFile, finalImageName);
    }
  } catch (error) {
    if (!streamBuildOutput && (error?.stdout || error?.stderr)) {
      printCapturedBuildOutput(error);
      error.message = `${sandboxCommand} build failed — output printed above`;
    }
    throw error;
  } finally {
    // If we created a temp file, delete it now.
    if (tempAuthFile) {
      rmSync(tempAuthFile, { force: true });
    }
  }
}

buildImage(image, dockerFile);

if (argv.prune) {
  execSync(`${sandboxCommand} image prune -f`, { stdio: 'ignore' });
}
