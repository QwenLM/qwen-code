/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { parse } from 'shell-quote';
/* eslint-disable import-x/no-internal-modules */
import {
  getUserSettingsDir,
  SETTINGS_DIRECTORY_NAME,
} from '../config/settings.js';
/* eslint-enable import-x/no-internal-modules */
import type { Config, SandboxConfig } from '@qwen-code/qwen-code-core';
import {
  FatalSandboxError,
  Storage,
  isSubpath,
} from '@qwen-code/qwen-code-core';
import { randomBytes } from 'node:crypto';
import { writeStderrLine } from './stdioHelpers.js';
import { parseSandboxImageName } from './sandboxImageName.js';
import { isContainerPathWithinWorkdir } from './sandbox-path.js';
import { parseSandboxMountSpec } from './sandboxMounts.js';
import {
  execAsync,
  LOCAL_DEV_SANDBOX_IMAGE_NAME,
  SANDBOX_NETWORK_NAME,
  SANDBOX_PROXY_NAME,
  ensureDirectoryAndGetRealPath,
  entrypoint,
  ensureSandboxImageIsPresent,
  getContainerPath,
  ports,
  shouldUseCurrentUserInSandbox,
} from './sandbox-shared.js';

export async function startDockerSandbox(
  config: SandboxConfig,
  nodeArgs: string[] = [],
  cliConfig?: Config,
  cliArgs: string[] = [],
): Promise<number> {
  writeStderrLine(`hopping into sandbox (command: ${config.command}) ...`);

  const gcPath = fs.realpathSync(process.argv[1]);

  const projectSandboxDockerfile = path.join(
    SETTINGS_DIRECTORY_NAME,
    'sandbox.Dockerfile',
  );
  const isCustomProjectSandbox = fs.existsSync(projectSandboxDockerfile);

  const image = config.image;
  const workdir = path.resolve(process.cwd());
  const containerWorkdir = getContainerPath(workdir);

  if (process.env['BUILD_SANDBOX']) {
    if (!gcPath.includes('qwen-code/packages/')) {
      throw new FatalSandboxError(
        'Cannot build sandbox using installed Qwen Code binary; ' +
          'run `npm link ./packages/cli` under QwenCode-cli repo to switch to linked binary.',
      );
    } else {
      writeStderrLine('building sandbox ...');
      const gcRoot = gcPath.split('/packages/')[0];
      let buildArgs = '';
      if (isCustomProjectSandbox) {
        writeStderrLine(`using ${projectSandboxDockerfile} for sandbox`);
        buildArgs += `-f ${path.resolve(projectSandboxDockerfile)} -i ${image}`;
      }
      execSync(
        `cd ${gcRoot} && node scripts/build_sandbox.js -s ${buildArgs}`,
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            QWEN_SANDBOX: config.command,
          },
        },
      );
    }
  }

  if (!(await ensureSandboxImageIsPresent(config.command, image))) {
    const remedy =
      image === LOCAL_DEV_SANDBOX_IMAGE_NAME
        ? 'Try running `npm run build:all` or `npm run build:sandbox` under the qwen-code repo to build it locally, or check the image name and your network connection.'
        : 'Please check the image name, your network connection, or notify qwen-code-dev@service.alibaba.com if the issue persists.';
    throw new FatalSandboxError(
      `Sandbox image '${image}' is missing or could not be pulled. ${remedy}`,
    );
  }

  const args = ['run', '-i', '--rm', '--init', '--workdir', containerWorkdir];

  if (process.env['SANDBOX_FLAGS']) {
    const flags = parse(process.env['SANDBOX_FLAGS'], process.env).filter(
      (f): f is string => typeof f === 'string',
    );
    args.push(...flags);
  }

  if (process.stdin.isTTY) {
    args.push('-t');
  }

  args.push('--add-host', 'host.docker.internal:host-gateway');
  args.push('--volume', `${workdir}:${containerWorkdir}`);

  const userSettingsDirOnHost = getUserSettingsDir();
  const runtimeBaseDirOnHost = Storage.getRuntimeBaseDir();
  const userSettingsDirRealPath = ensureDirectoryAndGetRealPath(
    userSettingsDirOnHost,
  );
  const runtimeBaseDirRealPath =
    ensureDirectoryAndGetRealPath(runtimeBaseDirOnHost);
  const userSettingsDirInSandbox = getContainerPath(
    `/home/node/${SETTINGS_DIRECTORY_NAME}`,
  );
  const userSettingsDirContainerPath = getContainerPath(
    userSettingsDirRealPath,
  );
  const runtimeBaseDirContainerPath = getContainerPath(runtimeBaseDirRealPath);
  const runtimeCoveredByUserSettings = isSubpath(
    userSettingsDirRealPath,
    runtimeBaseDirRealPath,
  );
  const userSettingsCoveredByRuntime = isSubpath(
    runtimeBaseDirRealPath,
    userSettingsDirRealPath,
  );
  const runtimeSameAsUserSettings =
    runtimeCoveredByUserSettings && userSettingsCoveredByRuntime;

  args.push(
    '--volume',
    `${userSettingsDirRealPath}:${userSettingsDirInSandbox}`,
  );
  if (
    (!userSettingsCoveredByRuntime || runtimeSameAsUserSettings) &&
    userSettingsDirInSandbox !== userSettingsDirContainerPath
  ) {
    args.push(
      '--volume',
      `${userSettingsDirRealPath}:${userSettingsDirContainerPath}`,
    );
  }

  args.push('--env', `QWEN_HOME=${userSettingsDirContainerPath}`);

  if (!runtimeCoveredByUserSettings) {
    args.push(
      '--volume',
      `${runtimeBaseDirRealPath}:${runtimeBaseDirContainerPath}`,
    );
  }
  if (!runtimeSameAsUserSettings) {
    args.push('--env', `QWEN_RUNTIME_DIR=${runtimeBaseDirContainerPath}`);
  }

  args.push('--volume', `${os.tmpdir()}:${getContainerPath(os.tmpdir())}`);

  const gcloudConfigDir = path.join(os.homedir(), '.config', 'gcloud');
  if (fs.existsSync(gcloudConfigDir)) {
    args.push(
      '--volume',
      `${gcloudConfigDir}:${getContainerPath(gcloudConfigDir)}:ro`,
    );
  }

  if (process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    const adcFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    if (fs.existsSync(adcFile)) {
      args.push('--volume', `${adcFile}:${getContainerPath(adcFile)}:ro`);
      args.push(
        '--env',
        `GOOGLE_APPLICATION_CREDENTIALS=${getContainerPath(adcFile)}`,
      );
    }
  }

  if (process.env['SANDBOX_MOUNTS']) {
    for (let mount of process.env['SANDBOX_MOUNTS'].split(',')) {
      if (mount.trim()) {
        const { from, to, opts } = parseSandboxMountSpec(mount);
        mount = `${from}:${to}:${opts}`;
        if (!path.isAbsolute(from)) {
          throw new FatalSandboxError(
            `Path '${from}' listed in SANDBOX_MOUNTS must be absolute`,
          );
        }
        if (!fs.existsSync(from)) {
          throw new FatalSandboxError(
            `Missing mount path '${from}' listed in SANDBOX_MOUNTS`,
          );
        }
        writeStderrLine(`SANDBOX_MOUNTS: ${from} -> ${to} (${opts})`);
        args.push('--volume', mount);
      }
    }
  }

  ports().forEach((p) => args.push('--publish', `${p}:${p}`));

  if (process.env['DEBUG']) {
    const debugPort = process.env['DEBUG_PORT'] || '9229';
    args.push(`--publish`, `${debugPort}:${debugPort}`);
  }

  const proxyCommand = process.env['QWEN_SANDBOX_PROXY_COMMAND'];

  if (proxyCommand) {
    let proxy =
      process.env['HTTPS_PROXY'] ||
      process.env['https_proxy'] ||
      process.env['HTTP_PROXY'] ||
      process.env['http_proxy'] ||
      'http://localhost:8877';
    proxy = proxy.replace('localhost', SANDBOX_PROXY_NAME);
    if (proxy) {
      args.push('--env', `HTTPS_PROXY=${proxy}`);
      args.push('--env', `https_proxy=${proxy}`);
      args.push('--env', `HTTP_PROXY=${proxy}`);
      args.push('--env', `http_proxy=${proxy}`);
    }
    const noProxy = process.env['NO_PROXY'] || process.env['no_proxy'];
    if (noProxy) {
      args.push('--env', `NO_PROXY=${noProxy}`);
      args.push('--env', `no_proxy=${noProxy}`);
    }

    if (proxy) {
      execSync(
        `${config.command} network inspect ${SANDBOX_NETWORK_NAME} || ${config.command} network create --internal ${SANDBOX_NETWORK_NAME}`,
      );
      args.push('--network', SANDBOX_NETWORK_NAME);
      if (proxyCommand) {
        execSync(
          `${config.command} network inspect ${SANDBOX_PROXY_NAME} || ${config.command} network create ${SANDBOX_PROXY_NAME}`,
        );
      }
    }
  }

  const imageName = parseSandboxImageName(image);
  const isIntegrationTest =
    process.env['QWEN_CODE_INTEGRATION_TEST'] === 'true';
  let containerName;
  if (isIntegrationTest) {
    containerName = `qwen-code-integration-test-${randomBytes(4).toString('hex')}`;
    writeStderrLine(`ContainerName: ${containerName}`);
  } else {
    let index = 0;
    const containerNameCheck = execSync(
      `${config.command} ps -a --format "{{.Names}}"`,
    )
      .toString()
      .trim();
    while (containerNameCheck.includes(`${imageName}-${index}`)) {
      index++;
    }
    containerName = `${imageName}-${index}`;
    writeStderrLine(`ContainerName (regular): ${containerName}`);
  }
  args.push('--name', containerName, '--hostname', containerName);

  if (process.env['QWEN_CODE_TEST_VAR']) {
    args.push(
      '--env',
      `QWEN_CODE_TEST_VAR=${process.env['QWEN_CODE_TEST_VAR']}`,
    );
  }
  for (const envVar of [
    'QWEN_DEBUG_LOG_FILE',
    'QWEN_CODE_LEGACY_MCP_BLOCKING',
  ] as const) {
    if (process.env[envVar]) {
      args.push('--env', `${envVar}=${process.env[envVar]}`);
    }
  }
  if (process.env['QWEN_CODE_MCP_APPROVALS_PATH']) {
    args.push(
      '--env',
      `QWEN_CODE_MCP_APPROVALS_PATH=${getContainerPath(
        process.env['QWEN_CODE_MCP_APPROVALS_PATH'],
      )}`,
    );
  }

  if (process.env['GEMINI_API_KEY']) {
    args.push('--env', `GEMINI_API_KEY=${process.env['GEMINI_API_KEY']}`);
  }
  if (process.env['GOOGLE_API_KEY']) {
    args.push('--env', `GOOGLE_API_KEY=${process.env['GOOGLE_API_KEY']}`);
  }

  if (process.env['OPENAI_API_KEY']) {
    args.push('--env', `OPENAI_API_KEY=${process.env['OPENAI_API_KEY']}`);
  }
  if (process.env['OPENAI_BASE_URL']) {
    args.push('--env', `OPENAI_BASE_URL=${process.env['OPENAI_BASE_URL']}`);
  }
  if (process.env['OPENAI_MODEL']) {
    args.push('--env', `OPENAI_MODEL=${process.env['OPENAI_MODEL']}`);
  }

  if (process.env['GOOGLE_GENAI_USE_VERTEXAI']) {
    args.push(
      '--env',
      `GOOGLE_GENAI_USE_VERTEXAI=${process.env['GOOGLE_GENAI_USE_VERTEXAI']}`,
    );
  }

  if (process.env['GOOGLE_GENAI_USE_GCA']) {
    args.push(
      '--env',
      `GOOGLE_GENAI_USE_GCA=${process.env['GOOGLE_GENAI_USE_GCA']}`,
    );
  }

  if (process.env['GOOGLE_CLOUD_PROJECT']) {
    args.push(
      '--env',
      `GOOGLE_CLOUD_PROJECT=${process.env['GOOGLE_CLOUD_PROJECT']}`,
    );
  }

  if (process.env['GOOGLE_CLOUD_LOCATION']) {
    args.push(
      '--env',
      `GOOGLE_CLOUD_LOCATION=${process.env['GOOGLE_CLOUD_LOCATION']}`,
    );
  }

  if (process.env['GEMINI_MODEL']) {
    args.push('--env', `GEMINI_MODEL=${process.env['GEMINI_MODEL']}`);
  }

  if (process.env['TERM']) {
    args.push('--env', `TERM=${process.env['TERM']}`);
  }
  if (process.env['COLORTERM']) {
    args.push('--env', `COLORTERM=${process.env['COLORTERM']}`);
  }

  for (const envVar of [
    'QWEN_CODE_IDE_SERVER_PORT',
    'QWEN_CODE_IDE_WORKSPACE_PATH',
    'TERM_PROGRAM',
  ]) {
    if (process.env[envVar]) {
      args.push('--env', `${envVar}=${process.env[envVar]}`);
    }
  }

  const virtualEnv = process.env['VIRTUAL_ENV'];
  if (
    virtualEnv &&
    isContainerPathWithinWorkdir(
      getContainerPath(workdir),
      getContainerPath(virtualEnv),
    )
  ) {
    const sandboxVenvPath = path.resolve(
      SETTINGS_DIRECTORY_NAME,
      'sandbox.venv',
    );
    if (!fs.existsSync(sandboxVenvPath)) {
      fs.mkdirSync(sandboxVenvPath, { recursive: true });
    }
    args.push('--volume', `${sandboxVenvPath}:${getContainerPath(virtualEnv)}`);
    args.push('--env', `VIRTUAL_ENV=${getContainerPath(virtualEnv)}`);
  }

  if (process.env['SANDBOX_ENV']) {
    for (let env of process.env['SANDBOX_ENV'].split(',')) {
      if ((env = env.trim())) {
        if (env.includes('=')) {
          writeStderrLine(`SANDBOX_ENV: ${env}`);
          args.push('--env', env);
        } else {
          throw new FatalSandboxError(
            'SANDBOX_ENV must be a comma-separated list of key=value pairs',
          );
        }
      }
    }
  }

  const existingNodeOptions = process.env['NODE_OPTIONS'] || '';
  const allNodeOptions = [
    ...(existingNodeOptions ? [existingNodeOptions] : []),
    ...nodeArgs,
  ].join(' ');

  if (allNodeOptions.length > 0) {
    args.push('--env', `NODE_OPTIONS="${allNodeOptions}"`);
  }

  args.push('--env', `SANDBOX=${containerName}`);

  if (config.command === 'podman') {
    const emptyAuthFilePath = path.join(os.tmpdir(), 'empty_auth.json');
    fs.writeFileSync(emptyAuthFilePath, '{}', 'utf-8');
    args.push('--authfile', emptyAuthFilePath);
  }

  let userFlag = '';
  const finalEntrypoint = entrypoint(workdir, cliArgs);
  const useCurrentUser = await shouldUseCurrentUserInSandbox();

  if (useCurrentUser) {
    args.push('--user', 'root');

    const uid = execSync('id -u').toString().trim();
    const gid = execSync('id -g').toString().trim();

    const username = 'qwen';
    const homeDir = getContainerPath(os.homedir());

    const setupUserCommands = [
      `groupadd -f -g ${gid} ${username}`,
      `id -u ${username} &>/dev/null || useradd -o -u ${uid} -g ${gid} -d ${homeDir} -s /bin/bash ${username}`,
    ].join(' && ');

    const originalCommand = finalEntrypoint[2];
    const escapedOriginalCommand = originalCommand.replace(/'/g, "'\\''");
    const suCommand = `su -p ${username} -c '${escapedOriginalCommand}'`;
    finalEntrypoint[2] = `${setupUserCommands} && ${suCommand}`;

    userFlag = `--user ${uid}:${gid}`;
    args.push('--env', `HOME=${os.homedir()}`);
  } else if (isIntegrationTest) {
    args.push('--user', 'root');
    userFlag = '--user root';
  }

  args.push(image);
  args.push(...finalEntrypoint);

  let proxyProcess: ChildProcess | undefined = undefined;
  let sandboxProcess: ChildProcess | undefined = undefined;

  if (proxyCommand) {
    const proxyContainerCommand = `${config.command} run --rm --init ${userFlag} --name ${SANDBOX_PROXY_NAME} --network ${SANDBOX_PROXY_NAME} -p 8877:8877 -v ${process.cwd()}:${workdir} --workdir ${workdir} ${image} ${proxyCommand}`;
    const isWindows = os.platform() === 'win32';
    const proxyShell = isWindows ? 'cmd.exe' : 'bash';
    const proxyShellArgs = isWindows
      ? ['/c', proxyContainerCommand]
      : ['-c', proxyContainerCommand];

    proxyProcess = spawn(proxyShell, proxyShellArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const stopProxy = () => {
      writeStderrLine('stopping proxy container ...');
      execSync(`${config.command} rm -f ${SANDBOX_PROXY_NAME}`);
    };
    process.on('exit', stopProxy);
    process.on('SIGINT', stopProxy);
    process.on('SIGTERM', stopProxy);

    proxyProcess.stderr?.on('data', (data: Buffer) => {
      writeStderrLine(data.toString().trim());
    });
    proxyProcess.on(
      'close',
      (code: number | null, signal: NodeJS.Signals | null) => {
        if (sandboxProcess?.pid) {
          process.kill(-sandboxProcess.pid, 'SIGTERM');
        }
        throw new FatalSandboxError(
          `Proxy container command '${proxyContainerCommand}' exited with code ${code}, signal ${signal}`,
        );
      },
    );
    writeStderrLine('waiting for proxy to start ...');
    await execAsync(
      `until timeout 0.25 curl -s http://localhost:8877; do sleep 0.25; done`,
    );
    await execAsync(
      `${config.command} network connect ${SANDBOX_NETWORK_NAME} ${SANDBOX_PROXY_NAME}`,
    );
  }

  process.stdin.pause();
  sandboxProcess = spawn(config.command, args, {
    stdio: 'inherit',
  });

  return new Promise<number>((resolve, reject) => {
    sandboxProcess.on('error', (err: Error) => {
      writeStderrLine(`Sandbox process error: ${err}`);
      reject(err);
    });

    sandboxProcess?.on(
      'close',
      (code: number | null, signal: NodeJS.Signals | null) => {
        process.stdin.resume();
        if (code !== 0 && code !== null) {
          writeStderrLine(
            `Sandbox process exited with code: ${code}, signal: ${signal}`,
          );
        }
        resolve(code ?? 1);
      },
    );
  });
}
