import process from 'node:process';
import {
  MODEL_PORT,
  MODEL_BASE_URL,
  createResidentModel,
} from './resident-model.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const required = (name) => {
  const value = process.env[name];
  if (!value || value.includes('\0')) throw new Error(`Missing ${name}`);
  return value;
};
const secret = async (name) => {
  const value = await readFile(required(name), 'utf8');
  if (!value || value.length > 8192 || /[\r\n\0]/.test(value))
    throw new Error(`Invalid ${name}`);
  return value;
};
const capabilityDigest = required('RESIDENT_ACK_CAPABILITY_DIGEST');
if (!/^sha256:[a-f0-9]{64}$/.test(capabilityDigest))
  throw new Error('Invalid capability digest');
const sessionStoreUrl = required('RESIDENT_ACK_SESSION_STORE_URL');
if (sessionStoreUrl !== 'http://127.0.0.1:8081')
  throw new Error('Invalid private Session Store URL');
const run = required('RESIDENT_ACK_RUN_ID');
if (!/^[A-Za-z0-9_-]{8,64}$/.test(run)) throw new Error('Invalid run ID');
const harnessToken = await secret('RESIDENT_ACK_HARNESS_TOKEN_FILE');
const brokerToken = await secret('RESIDENT_ACK_BROKER_TOKEN_FILE');
const home = '/tmp/qwen-ack/home';
const runtime = '/tmp/qwen-ack/runtime';
const decoy = '/tmp/qwen-ack/harness-decoy';
for (const path of [home + '/.qwen', runtime, decoy])
  await mkdir(path, { recursive: true, mode: 0o700 });
await writeFile(
  home + '/.qwen/settings.json',
  JSON.stringify({
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'resident-ack-local' },
    telemetry: { enabled: false },
    modelProviders: {
      openai: [
        {
          id: 'resident-ack-local',
          envKey: 'OPENAI_API_KEY',
          baseUrl: MODEL_BASE_URL,
        },
      ],
    },
  }),
  { mode: 0o600 },
);
const evidenceDirectory = '/tmp/resident-ack-evidence/' + run;
await mkdir('/tmp/resident-ack-evidence', { recursive: true, mode: 0o700 });
await mkdir(evidenceDirectory, { mode: 0o700 });
const model = createResidentModel(run, evidenceDirectory);
await new Promise((resolve, reject) =>
  model.once('error', reject).listen(MODEL_PORT, '127.0.0.1', resolve),
);
const child = spawn(
  process.execPath,
  [
    '/opt/qwen/dist/cli.js',
    'serve',
    '--profile',
    'hosted-harness',
    '--http-bridge',
    '--hostname',
    '127.0.0.1',
    '--port',
    '4170',
    '--require-auth',
    '--no-web',
    '--workspace',
    decoy,
    '--managed-runtime-broker-url',
    'http://127.0.0.1:4182',
    '--managed-runtime-broker-token',
    brokerToken,
  ],
  {
    cwd: decoy,
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      QWEN_HOME: home + '/.qwen',
      QWEN_RUNTIME_DIR: runtime,
      OPENAI_API_KEY: 'resident-local-only-no-paid-model',
      OPENAI_BASE_URL: MODEL_BASE_URL,
      QWEN_SERVER_TOKEN: harnessToken,
      QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: capabilityDigest,
      QWEN_HOSTED_CSI_SESSION_STORE_URL: sessionStoreUrl,
      TMPDIR: '/tmp/qwen-ack',
      TMP: '/tmp/qwen-ack',
      TEMP: '/tmp/qwen-ack',
      QWEN_CODE_SYSTEM_SETTINGS_PATH: '/tmp/qwen-ack/no-system-settings.json',
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/tmp/qwen-ack/no-system-defaults.json',
      QWEN_CODE_TRUSTED_FOLDERS_PATH: '/tmp/qwen-ack/no-trusted-folders.json',
    },
  },
);
child.once('error', () => {
  model.close();
  process.exitCode = 1;
});
child.once('exit', (code) => {
  model.close();
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    child.kill(signal);
    model.close();
  });
