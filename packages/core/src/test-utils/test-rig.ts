/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs, { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BRAND_CLI_BIN,
  BRAND_ENV_PREFIX,
  ENV_CLI_HOME,
  ENV_TEST_VAR,
  ENV_INTEGRATION_TEST,
  ENV_FORCE_FILE_STORAGE,
} from '../config/brand.js';
import { AuthType } from '../core/contentGenerator.js';
import { CONFIG_DIR } from '../utils/paths.js';
export { CONFIG_DIR };
import * as pty from '@lydell/node-pty';
import stripAnsi from 'strip-ansi';
import * as os from 'node:os';
import type { TestMcpConfig } from './test-mcp-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve the same repository root from src/test-utils and dist/src/test-utils.
const corePackageDir = fs.existsSync(
  join(__dirname, '..', '..', 'package.json'),
)
  ? join(__dirname, '..', '..')
  : join(__dirname, '..', '..', '..');
const repoRoot = join(corePackageDir, '..', '..');
const BUNDLE_PATH = join(repoRoot, 'bundle', `${BRAND_CLI_BIN}.js`);

// Get timeout based on environment
export function getDefaultTimeout() {
  if (env['CI']) return 60000; // 1 minute in CI
  return 15000; // 15s locally
}

export async function poll(
  predicate: () => boolean,
  timeout: number,
  interval: number,
): Promise<boolean> {
  const startTime = Date.now();
  let attempts = 0;
  while (Date.now() - startTime < timeout) {
    attempts++;
    const result = predicate();
    if (env['VERBOSE'] === 'true' && attempts % 5 === 0) {
      console.log(
        `Poll attempt ${attempts}: ${result ? 'success' : 'waiting...'}`,
      );
    }
    if (result) {
      return true;
    }
    await sleep(interval);
  }
  if (env['VERBOSE'] === 'true') {
    console.log(`Poll timed out after ${attempts} attempts`);
  }
  return false;
}

export function sanitizeTestName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-');
}

// Helper to create detailed error messages
export function createToolCallErrorMessage(
  expectedTools: string | string[],
  foundTools: string[],
  result: string,
) {
  const expectedStr = Array.isArray(expectedTools)
    ? expectedTools.join(' or ')
    : expectedTools;
  return (
    `Expected to find ${expectedStr} tool call(s). ` +
    `Found: ${foundTools.length > 0 ? foundTools.join(', ') : 'none'}. ` +
    `Output preview: ${result ? result.substring(0, 200) + '...' : 'no output'}`
  );
}

// Helper to print debug information when tests fail
export function printDebugInfo(
  _rig: TestRig,
  result: string,
  context: Record<string, unknown> = {},
) {
  console.error('Test failed - Debug info:');
  console.error('Result length:', result.length);
  console.error('Result (first 500 chars):', result.substring(0, 500));
  console.error(
    'Result (last 500 chars):',
    result.substring(result.length - 500),
  );

  // Print any additional context provided
  Object.entries(context).forEach(([key, value]) => {
    console.error(`${key}:`, value);
  });
}

// Helper to assert that the model returned some output
export function assertModelHasOutput(result: string) {
  if (!result || result.trim().length === 0) {
    throw new Error('Expected LLM to return some output');
  }
}

function contentExists(result: string, content: string | RegExp): boolean {
  if (typeof content === 'string') {
    return result.toLowerCase().includes(content.toLowerCase());
  } else if (content instanceof RegExp) {
    return content.test(result);
  }
  return false;
}

function findMismatchedContent(
  result: string,
  content: string | (string | RegExp)[],
  shouldExist: boolean,
): (string | RegExp)[] {
  const contents = Array.isArray(content) ? content : [content];
  return contents.filter((c) => contentExists(result, c) !== shouldExist);
}

function logContentWarning(
  problematicContent: (string | RegExp)[],
  isMissing: boolean,
  originalContent: string | (string | RegExp)[] | null | undefined,
  result: string,
) {
  const message = isMissing
    ? 'LLM did not include expected content in response'
    : 'LLM included forbidden content in response';

  console.warn(
    `Warning: ${message}: ${problematicContent.join(', ')}.`,
    'This is not ideal but not a test failure.',
  );

  const label = isMissing ? 'Expected content' : 'Forbidden content';
  console.warn(`${label}:`, originalContent);
  console.warn('Actual output:', result);
}

// Helper to check model output and warn about unexpected content
export function checkModelOutputContent(
  result: string,
  {
    expectedContent = null,
    testName = '',
    forbiddenContent = null,
  }: {
    expectedContent?: string | (string | RegExp)[] | null;
    testName?: string;
    forbiddenContent?: string | (string | RegExp)[] | null;
  } = {},
): boolean {
  let isValid = true;

  // If expectedContent is provided, check for it and warn if missing
  if (expectedContent) {
    const missingContent = findMismatchedContent(result, expectedContent, true);

    if (missingContent.length > 0) {
      logContentWarning(missingContent, true, expectedContent, result);
      isValid = false;
    }
  }

  // If forbiddenContent is provided, check for it and warn if present
  if (forbiddenContent) {
    const foundContent = findMismatchedContent(result, forbiddenContent, false);

    if (foundContent.length > 0) {
      logContentWarning(foundContent, false, forbiddenContent, result);
      isValid = false;
    }
  }

  if (isValid && env['VERBOSE'] === 'true') {
    console.log(`${testName}: Model output content checked successfully.`);
  }

  return isValid;
}

export class InteractiveRun {
  ptyProcess: pty.IPty;
  public output = '';

  constructor(ptyProcess: pty.IPty) {
    this.ptyProcess = ptyProcess;
    ptyProcess.onData((data) => {
      this.output += data;
      if (env['KEEP_OUTPUT'] === 'true' || env['VERBOSE'] === 'true') {
        process.stdout.write(data);
      }
    });
  }

  async expectText(text: string, timeout?: number) {
    if (!timeout) {
      timeout = getDefaultTimeout();
    }
    await poll(
      () => stripAnsi(this.output).toLowerCase().includes(text.toLowerCase()),
      timeout,
      200,
    );
    expect(stripAnsi(this.output).toLowerCase()).toContain(text.toLowerCase());
  }

  // This types slowly to make sure command is correct, but only work for short
  // commands that are not multi-line, use sendKeys to type long prompts
  async type(text: string) {
    let typedSoFar = '';
    for (const char of text) {
      if (char === '\r') {
        // wait >30ms before `enter` to avoid fast return conversion
        // from bufferFastReturn() in KeypressContent.tsx
        await sleep(50);
      }

      this.ptyProcess.write(char);
      typedSoFar += char;

      // Wait for the typed sequence so far to be echoed back.
      const found = await poll(
        () => stripAnsi(this.output).includes(typedSoFar),
        5000, // 5s timeout per character (generous for CI)
        10, // check frequently
      );

      if (!found) {
        throw new Error(
          `Timed out waiting for typed text to appear in output: "${typedSoFar}".\nStripped output:\n${stripAnsi(
            this.output,
          )}`,
        );
      }
    }
  }

  // Types an entire string at once, necessary for some things like commands
  // but may run into paste detection issues for larger strings.
  async sendText(text: string) {
    this.ptyProcess.write(text);
    await sleep(5);
  }

  // Simulates typing a string one character at a time to avoid paste detection.
  async sendKeys(text: string) {
    const delay = 5;
    for (const char of text) {
      this.ptyProcess.write(char);
      await sleep(delay);
    }
  }

  async kill() {
    this.ptyProcess.kill();
  }

  expectExit(): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Test timed out: process did not exit within a minute.`),
          ),
        60000,
      );
      this.ptyProcess.onExit(({ exitCode }) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
  }
}

function isObject(item: any): item is Record<string, any> {
  return !!(item && typeof item === 'object' && !Array.isArray(item));
}

function deepMerge(target: any, source: any): any {
  if (!isObject(target) || !isObject(source)) {
    return source;
  }
  const output = { ...target };
  Object.keys(source).forEach((key) => {
    const targetValue = target[key];
    const sourceValue = source[key];
    if (isObject(targetValue) && isObject(sourceValue)) {
      output[key] = deepMerge(targetValue, sourceValue);
    } else {
      output[key] = sourceValue;
    }
  });
  return output;
}

export class TestRig {
  testDir: string | null = null;
  homeDir: string | null = null;
  testName?: string;
  _lastRunStdout?: string;
  _lastRunStderr?: string;
  // Path to the copied fake responses file for this test.
  fakeResponsesPath?: string;
  // Original fake responses file path for rewriting goldens in record mode.
  originalFakeResponsesPath?: string;
  private _interactiveRuns: InteractiveRun[] = [];
  private _spawnedProcesses: ChildProcess[] = [];
  private _initialized = false;

  setup(
    testName: string,
    options: {
      settings?: Record<string, unknown>;
      state?: Record<string, unknown>;
      fakeResponsesPath?: string;
    } = {},
  ) {
    this.testName = testName;
    const sanitizedName = sanitizeTestName(testName);
    const testFileDir =
      env['INTEGRATION_TEST_FILE_DIR'] ||
      join(os.tmpdir(), `${BRAND_CLI_BIN}-tests`);
    this.testDir = join(testFileDir, sanitizedName);
    this.homeDir = join(testFileDir, sanitizedName + '-home');

    if (!this._initialized) {
      // Clean up existing directories from previous runs (e.g. retries)
      this._cleanDir(this.testDir);
      this._cleanDir(this.homeDir);
      this._initialized = true;
    }

    mkdirSync(this.testDir, { recursive: true });
    mkdirSync(this.homeDir, { recursive: true });
    if (options.fakeResponsesPath) {
      this.fakeResponsesPath = join(this.testDir, 'fake-responses.json');
      this.originalFakeResponsesPath = options.fakeResponsesPath;
      if (process.env['REGENERATE_MODEL_GOLDENS'] !== 'true') {
        fs.copyFileSync(options.fakeResponsesPath, this.fakeResponsesPath);
      }
    }

    // Create a settings file to point the CLI to the local collector
    this._createSettingsFile(options.settings);

    // Create persistent state file
    this._createStateFile(options.state);
  }

  private _cleanDir(dir: string) {
    if (fs.existsSync(dir)) {
      for (let i = 0; i < 10; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        } catch (err) {
          if (i === 9) {
            console.error(
              `Failed to clean directory ${dir} after 10 attempts:`,
              err,
            );
            throw err;
          }
          const delay = Math.min(Math.pow(2, i) * 1000, 10000); // Max 10s delay
          try {
            const sharedBuffer = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(sharedBuffer, 0, 0, delay);
          } catch {
            // Fallback for environments where SharedArrayBuffer might be restricted
            const start = Date.now();
            while (Date.now() - start < delay) {
              /* busy wait */
            }
          }
        }
      }
    }
  }

  private _createSettingsFile(overrideSettings?: Record<string, unknown>) {
    const projectConfigDir = join(this.testDir!, CONFIG_DIR);
    mkdirSync(projectConfigDir, { recursive: true });

    const userConfigDir = join(this.homeDir!, CONFIG_DIR);
    mkdirSync(userConfigDir, { recursive: true });

    const settings = deepMerge(
      {
        general: {
          // Nightly releases sometimes becomes out of sync with local code and
          // triggers auto-update, which causes tests to fail.
          enableAutoUpdate: false,
        },
        security: {
          auth: {
            selectedType: AuthType.QODER_PAT,
            useExternal: true,
          },
          folderTrust: {
            enabled: false,
          },
        },
        ui: {
          useAlternateBuffer: true,
        },
        ...(env['CLI_TEST_TYPE'] === 'integration'
          ? {
              model: {
                name: 'auto',
              },
            }
          : {}),
      },
      overrideSettings ?? {},
    );
    writeFileSync(
      join(projectConfigDir, 'settings.json'),
      JSON.stringify(settings, null, 2),
    );
    writeFileSync(
      join(userConfigDir, 'settings.json'),
      JSON.stringify(settings, null, 2),
    );
  }

  private _createStateFile(overrideState?: Record<string, unknown>) {
    if (!this.homeDir) throw new Error('TestRig homeDir is not initialized');
    const userConfigDir = join(this.homeDir, CONFIG_DIR);
    mkdirSync(userConfigDir, { recursive: true });

    const state = deepMerge(
      {
        terminalSetupPromptShown: true, // Default to true in tests to avoid blocking prompts
      },
      overrideState ?? {},
    );

    writeFileSync(
      join(userConfigDir, 'state.json'),
      JSON.stringify(state, null, 2),
    );
  }

  createFile(fileName: string, content: string) {
    const filePath = join(this.testDir!, fileName);
    writeFileSync(filePath, content);
    return filePath;
  }

  mkdir(dir: string) {
    mkdirSync(join(this.testDir!, dir), { recursive: true });
  }

  sync() {
    if (os.platform() === 'win32') return;
    // ensure file system is done before spawning
    execSync('sync', { cwd: this.testDir! });
  }

  /**
   * The command and args to use to invoke the CLI. Allows us to switch
   * between using the bundled qwen.js (the default) and using the installed
   * 'qwen' (used to verify npm bundles).
   */
  private _getCommandAndArgs(extraInitialArgs: string[] = []): {
    command: string;
    initialArgs: string[];
  } {
    const binaryPath = env['INTEGRATION_TEST_CLI_BINARY_PATH'];
    let command = 'node';
    let initialArgs = [BUNDLE_PATH, ...extraInitialArgs];
    if (binaryPath) {
      command = binaryPath;
      initialArgs = extraInitialArgs;
    }
    if (this.fakeResponsesPath) {
      if (process.env['REGENERATE_MODEL_GOLDENS'] === 'true') {
        initialArgs.push('--record-responses', this.fakeResponsesPath);
      } else {
        initialArgs.push('--fake-responses', this.fakeResponsesPath);
      }
    }
    return { command, initialArgs };
  }

  createScript(fileName: string, content: string) {
    if (!this.testDir) {
      throw new Error(
        'TestRig.setup must be called before creating files or scripts',
      );
    }
    const scriptPath = join(this.testDir, fileName);
    writeFileSync(scriptPath, content);
    return normalizePath(scriptPath)!;
  }

  /**
   * Adds a test MCP server to the test workspace.
   * @param name The name of the server
   * @param config Configuration object describing the test tools
   */
  addTestMcpServer(name: string, config: TestMcpConfig) {
    if (!this.testDir) {
      throw new Error(
        'TestRig.setup must be called before adding test servers',
      );
    }

    const configFileName = `test-mcp-${name}.json`;
    const scriptFileName = `test-mcp-${name}.mjs`;

    const configFilePath = join(this.testDir, configFileName);
    const scriptFilePath = join(this.testDir, scriptFileName);

    // Write config
    fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2));

    // Copy template script
    const templatePath = join(__dirname, 'test-mcp-server-template.mjs');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Test template not found at ${templatePath}`);
    }

    fs.copyFileSync(templatePath, scriptFilePath);

    // Calculate path to monorepo node_modules
    const monorepoNodeModules = join(repoRoot, 'node_modules');

    // Create symlink to node_modules in testDir for ESM resolution
    const testNodeModules = join(this.testDir, 'node_modules');
    if (!fs.existsSync(testNodeModules)) {
      fs.symlinkSync(monorepoNodeModules, testNodeModules, 'dir');
    }

    // Update settings in workspace and home
    const updateSettings = (dir: string) => {
      const settingsPath = join(dir, CONFIG_DIR, 'settings.json');
      let settings: any = {};
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } else {
        fs.mkdirSync(join(dir, CONFIG_DIR), { recursive: true });
      }

      if (!settings.mcpServers) {
        settings.mcpServers = {};
      }

      settings.mcpServers[name] = {
        command: 'node',
        args: [scriptFilePath, configFilePath],
        // Removed env.NODE_PATH as it is ignored in ESM
      };

      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    };

    updateSettings(this.testDir);
    if (this.homeDir) {
      updateSettings(this.homeDir);
    }
  }

  private _getCleanEnv(
    extraEnv?: Record<string, string | undefined>,
  ): Record<string, string | undefined> {
    const cleanEnv: Record<string, string | undefined> = { ...process.env };

    // Env vars to preserve even though they match the brand prefixes.
    const keepExact = new Set([
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_DEBUG',
      ENV_TEST_VAR,
      ENV_INTEGRATION_TEST,
      ENV_FORCE_FILE_STORAGE,
    ]);

    for (const key of Object.keys(cleanEnv)) {
      if (
        (key.startsWith('GOOGLE_GEMINI_') ||
          key.startsWith(BRAND_ENV_PREFIX)) &&
        !keepExact.has(key)
      ) {
        delete cleanEnv[key];
      }
    }

    return {
      ...cleanEnv,
      [ENV_CLI_HOME]: this.homeDir!,
      ...extraEnv,
    };
  }

  run(options: {
    args?: string | string[];
    stdin?: string;
    stdinDoesNotEnd?: boolean;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    timeout?: number;
    env?: Record<string, string | undefined>;
  }): Promise<string> {
    const permissionMode = options.permissionMode ?? 'bypassPermissions';
    const { command, initialArgs } = this._getCommandAndArgs([
      `--permission-mode=${permissionMode}`,
    ]);
    const commandArgs = [...initialArgs];
    const execOptions: {
      cwd: string;
      encoding: 'utf-8';
      input?: string;
    } = {
      cwd: this.testDir!,
      encoding: 'utf-8',
    };

    if (options.args) {
      if (Array.isArray(options.args)) {
        commandArgs.push(...options.args);
      } else {
        commandArgs.push(options.args);
      }
    }

    if (options.stdin) {
      execOptions.input = options.stdin;
    }

    const child = spawn(command, commandArgs, {
      cwd: this.testDir!,
      stdio: 'pipe',
      env: this._getCleanEnv(options.env),
    });
    this._spawnedProcesses.push(child);

    let stdout = '';
    let stderr = '';

    // Handle stdin if provided
    if (execOptions.input) {
      child.stdin!.write(execOptions.input);
    }

    if (!options.stdinDoesNotEnd) {
      child.stdin!.end();
    }

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (data: string) => {
      stdout += data;
      if (env['KEEP_OUTPUT'] === 'true' || env['VERBOSE'] === 'true') {
        process.stdout.write(data);
      }
    });

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (data: string) => {
      stderr += data;
      if (env['KEEP_OUTPUT'] === 'true' || env['VERBOSE'] === 'true') {
        process.stderr.write(data);
      }
    });

    const timeout = options.timeout ?? 300000;
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `Process timed out after ${timeout}ms.\nStdout:\n${stdout}\nStderr:\n${stderr}`,
          ),
        );
      }, timeout);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code: number) => {
        clearTimeout(timer);
        this._lastRunStderr = stderr;
        if (code === 0) {
          // Retain raw stdout for callers that inspect the last run.
          this._lastRunStdout = stdout;

          const result = stdout;

          // Check if this is a JSON output test - if so, don't include stderr
          // as it would corrupt the JSON
          const isJsonOutput =
            commandArgs.includes('--output-format') &&
            commandArgs.includes('json');

          // If we have stderr output and it's not a JSON test, include that also
          const finalResult =
            stderr && !isJsonOutput
              ? `${result}\n\nStdErr:\n${stderr}`
              : result;

          resolve(finalResult);
        } else {
          reject(new Error(`Process exited with code ${code}:\n${stderr}`));
        }
      });
    });

    return promise;
  }

  /**
   * Runs the CLI and returns stdout and stderr separately.
   * Useful for tests that need to verify correct stream routing.
   */
  runWithStreams(
    args: string[],
    options?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const { command, initialArgs } = this._getCommandAndArgs([
        '--permission-mode=bypassPermissions',
      ]);

      const allArgs = [...initialArgs, ...args];

      const child = spawn(command, allArgs, {
        cwd: this.testDir!,
        stdio: 'pipe',
        env: this._getCleanEnv(),
        signal: options?.signal,
      });
      this._spawnedProcesses.push(child);

      let stdout = '';
      let stderr = '';

      child.on('error', reject);

      child.stdout!.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr!.on('data', (chunk) => {
        stderr += chunk;
      });

      child.stdin!.end();
      child.on('close', (exitCode) => {
        resolve({ stdout, stderr, exitCode });
      });
    });
  }

  runCommand(
    args: string[],
    options: {
      stdin?: string;
      timeout?: number;
      env?: Record<string, string | undefined>;
    } = {},
  ): Promise<string> {
    const { command, initialArgs } = this._getCommandAndArgs();
    const commandArgs = [...initialArgs, ...args];

    const child = spawn(command, commandArgs, {
      cwd: this.testDir!,
      stdio: 'pipe',
      env: this._getCleanEnv(options.env),
    });
    this._spawnedProcesses.push(child);

    let stdout = '';
    let stderr = '';

    if (options.stdin) {
      child.stdin!.write(options.stdin);
      child.stdin!.end();
    }

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (data: string) => {
      stdout += data;
      if (env['KEEP_OUTPUT'] === 'true' || env['VERBOSE'] === 'true') {
        process.stdout.write(data);
      }
    });

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (data: string) => {
      stderr += data;
      if (env['KEEP_OUTPUT'] === 'true' || env['VERBOSE'] === 'true') {
        process.stderr.write(data);
      }
    });

    const timeout = options.timeout ?? 300000;
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `Process timed out after ${timeout}ms.\nStdout:\n${stdout}\nStderr:\n${stderr}`,
          ),
        );
      }, timeout);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code: number) => {
        clearTimeout(timer);
        this._lastRunStderr = stderr;
        if (code === 0) {
          this._lastRunStdout = stdout;
          const result = stdout;

          // Check if this is a JSON output test - if so, don't include stderr
          // as it would corrupt the JSON
          const isJsonOutput =
            commandArgs.includes('--output-format') &&
            commandArgs.includes('json');

          const finalResult =
            stderr && !isJsonOutput
              ? `${result}\n\nStdErr:\n${stderr}`
              : result;
          resolve(finalResult);
        } else {
          reject(new Error(`Process exited with code ${code}:\n${stderr}`));
        }
      });
    });

    return promise;
  }

  readFile(fileName: string) {
    const filePath = join(this.testDir!, fileName);
    const content = readFileSync(filePath, 'utf-8');
    if (env['KEEP_OUTPUT'] === 'true' || env['VERBOSE'] === 'true') {
      console.log(`--- FILE: ${filePath} ---`);
      console.log(content);
      console.log(`--- END FILE: ${filePath} ---`);
    }
    return content;
  }

  async cleanup() {
    // Kill any interactive runs that are still active
    for (const run of this._interactiveRuns) {
      try {
        if (process.platform === 'win32') {
          // @ts-ignore - access private ptyProcess
          const pid = run.ptyProcess?.pid;
          if (pid) {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
          }
        }
        await run.kill();
      } catch (error) {
        if (env['VERBOSE'] === 'true') {
          console.warn('Failed to kill interactive run during cleanup:', error);
        }
      }
    }
    this._interactiveRuns = [];

    // Kill any other spawned processes that are still running
    for (const child of this._spawnedProcesses) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (process.platform === 'win32' && child.pid) {
            execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
          }
          child.kill('SIGKILL');
        } catch (error) {
          if (env['VERBOSE'] === 'true') {
            console.warn(
              'Failed to kill spawned process during cleanup:',
              error,
            );
          }
        }
      }
    }
    this._spawnedProcesses = [];

    if (
      process.env['REGENERATE_MODEL_GOLDENS'] === 'true' &&
      this.fakeResponsesPath
    ) {
      fs.copyFileSync(this.fakeResponsesPath, this.originalFakeResponsesPath!);
    }
    // Clean up test directory and home directory
    if (this.testDir && !env['KEEP_OUTPUT']) {
      try {
        this._cleanDir(this.testDir);
      } catch (error) {
        // Ignore cleanup errors
        if (env['VERBOSE'] === 'true' || env['CI'] === 'true') {
          console.warn('Cleanup warning (testDir):', (error as Error).message);
        }
      }
    }
    if (this.homeDir && !env['KEEP_OUTPUT']) {
      try {
        this._cleanDir(this.homeDir);
      } catch (error) {
        // Ignore cleanup errors
        if (env['VERBOSE'] === 'true' || env['CI'] === 'true') {
          console.warn('Cleanup warning (homeDir):', (error as Error).message);
        }
      }
    }
  }

  async runInteractive(options?: {
    args?: string | string[];
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    env?: Record<string, string | undefined>;
  }): Promise<InteractiveRun> {
    const permissionMode = options?.permissionMode ?? 'bypassPermissions';
    const { command, initialArgs } = this._getCommandAndArgs([
      `--permission-mode=${permissionMode}`,
    ]);
    const commandArgs = [...initialArgs];

    const envVars = this._getCleanEnv(options?.env);

    // node-pty on windows often needs these to spawn correctly
    if (process.platform === 'win32') {
      const windowsCriticalVars = [
        'SystemRoot',
        'COMSPEC',
        'windir',
        'PATHEXT',
        'TEMP',
        'TMP',
      ];
      for (const v of windowsCriticalVars) {
        if (process.env[v] && !envVars[v]) {
          envVars[v] = process.env[v]!;
        }
      }
    }

    const ptyOptions: pty.IPtyForkOptions = {
      name: 'xterm-color',
      cols: 80,
      rows: 80,
      cwd: this.testDir!,
      env: Object.fromEntries(
        Object.entries(envVars).filter(([, v]) => v !== undefined),
      ) as { [key: string]: string },
    };

    const executable = command === 'node' ? process.execPath : command;
    const ptyProcess = pty.spawn(executable, commandArgs, ptyOptions);

    const run = new InteractiveRun(ptyProcess);
    this._interactiveRuns.push(run);
    // Wait for the app to be ready
    await run.expectText('  Type your message or @path/to/file', 30000);
    return run;
  }

  async pollCommand(
    commandFn: () => Promise<void>,
    predicateFn: () => boolean,
    timeout: number = 30000,
    interval: number = 1000,
  ) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      await commandFn();
      // Give it a moment to process
      await sleep(500);
      if (predicateFn()) {
        return;
      }
      await sleep(interval);
    }
    throw new Error(`pollCommand timed out after ${timeout}ms`);
  }
}

/**
 * Normalizes a path for cross-platform matching (replaces backslashes with forward slashes).
 */
export function normalizePath(p: string | undefined): string | undefined {
  if (!p) return p;
  return p.replace(/\\/g, '/');
}
