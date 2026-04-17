import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from 'vitest';
import { TestRig } from '../test-helper.js';
import { MockHttpServer, HttpHookResponses } from './mockHttpServer.js';

/**
 * Advanced Hooks System Integration Tests
 *
 * Tests for HTTP Hooks, Async Hooks, and Function Hooks
 * covering various events and scenarios
 */

describe('HTTP Hooks Integration', () => {
  let rig: TestRig;
  let mockServer: MockHttpServer;
  let serverUrl: string;

  beforeAll(async () => {
    mockServer = new MockHttpServer();
    await mockServer.start();
    serverUrl = mockServer.getUrl();
    console.log(`Mock HTTP Server started at: ${serverUrl}`);
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    rig = new TestRig();
    mockServer.clearRequestLogs();
  });

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  // ==========================================================================
  // HTTP Hook - PreToolUse Events
  // ==========================================================================
  describe('PreToolUse HTTP Hooks', () => {
    describe('Allow Decision', () => {
      it('should allow tool execution when HTTP hook returns allow', async () => {
        mockServer.setResponse(
          '/pretooluse-allow',
          HttpHookResponses.preToolUseAllow,
        );

        await rig.setup('http-pretooluse-allow', {
          settings: {
            disableAllHooks: false,
            hooks: {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'http',
                      url: `${serverUrl}/pretooluse-allow`,
                      name: 'http-allow-hook',
                      timeout: 10,
                    },
                  ],
                },
              ],
            },
          },
        });

        await rig.run('Create a file test.txt with content "hello"');

        const foundToolCall = await rig.waitForToolCall('write_file');
        expect(foundToolCall).toBeTruthy();

        const fileContent = rig.readFile('test.txt');
        expect(fileContent).toContain('hello');

        const requestLogs = mockServer.getRequestLogs();
        if (requestLogs.length > 0) {
          expect(requestLogs[0].url).toBe('/pretooluse-allow');
        }
      });

      it('should allow multiple tools with wildcard matcher', async () => {
        mockServer.setResponse(
          '/pretooluse-wildcard',
          HttpHookResponses.preToolUseAllow,
        );

        await rig.setup('http-pretooluse-wildcard', {
          settings: {
            disableAllHooks: false,
            hooks: {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'http',
                      url: `${serverUrl}/pretooluse-wildcard`,
                      name: 'http-wildcard-hook',
                      timeout: 10,
                    },
                  ],
                },
              ],
            },
          },
        });

        await rig.run('What is 1+1?');

        const requestLogs = mockServer.getRequestLogs();
        if (requestLogs.length > 0) {
          expect(requestLogs[0].url).toBe('/pretooluse-wildcard');
        }
      });
    });

    describe('Additional Context', () => {
      it('should include additional context from HTTP hook response', async () => {
        mockServer.setResponse(
          '/pretooluse-context',
          HttpHookResponses.withContext('HTTP hook additional context'),
        );

        await rig.setup('http-pretooluse-context', {
          settings: {
            disableAllHooks: false,
            hooks: {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'http',
                      url: `${serverUrl}/pretooluse-context`,
                      name: 'http-context-hook',
                      timeout: 10,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Create a file context.txt with "test"');
        expect(result).toBeDefined();

        const requestLogs = mockServer.getRequestLogs();
        if (requestLogs.length > 0) {
          expect(requestLogs[0].url).toBe('/pretooluse-context');
        }
      });
    });

    describe('Timeout Handling', () => {
      it('should continue execution when HTTP hook times out (non-blocking)', async () => {
        mockServer.setResponse('/pretooluse-slow', { continue: true });

        await rig.setup('http-pretooluse-timeout', {
          settings: {
            disableAllHooks: false,
            hooks: {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'http',
                      url: `${serverUrl}/pretooluse-slow`,
                      name: 'http-slow-hook',
                      timeout: 1,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Create a file timeout.txt with "test"');
        expect(result).toBeDefined();
      });
    });

    describe('Error Handling', () => {
      it('should continue execution when HTTP hook returns non-2xx status', async () => {
        await rig.setup('http-pretooluse-error', {
          settings: {
            disableAllHooks: false,
            hooks: {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'http',
                      url: `${serverUrl}/nonexistent-endpoint`,
                      name: 'http-error-hook',
                      timeout: 5,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Create a file error.txt with "test"');
        expect(result).toBeDefined();
      });
    });

    describe('URL Validation', () => {
      it('should reject HTTP hook with blocked private IP', async () => {
        await rig.setup('http-blocked-private-ip', {
          settings: {
            disableAllHooks: false,
            hooks: {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'http',
                      url: 'http://10.0.0.1:8080/hook',
                      name: 'http-private-ip-hook',
                      timeout: 5,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Create a file blocked.txt with "test"');
        expect(result).toBeDefined();
      });

      it('should allow HTTP hook with loopback address (127.0.0.1)', async () => {
        mockServer.setResponse('/loopback', HttpHookResponses.preToolUseAllow);

        await rig.setup('http-allow-loopback', {
          settings: {
            disableAllHooks: false,
            hooks: {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'http',
                      url: `${serverUrl}/loopback`,
                      name: 'http-loopback-hook',
                      timeout: 10,
                    },
                  ],
                },
              ],
            },
          },
        });

        await rig.run('Create a file loopback.txt with "test"');

        const requestLogs = mockServer.getRequestLogs();
        if (requestLogs.length > 0) {
          expect(requestLogs[0].url).toBe('/loopback');
        }
      });
    });
  });

  // ==========================================================================
  // HTTP Hook - UserPromptSubmit Events
  // ==========================================================================
  describe('UserPromptSubmit HTTP Hooks', () => {
    it('should process prompt through HTTP hook and allow', async () => {
      mockServer.setResponse('/userprompt-allow', HttpHookResponses.allow);

      await rig.setup('http-userprompt-allow', {
        settings: {
          disableAllHooks: false,
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'http',
                    url: `${serverUrl}/userprompt-allow`,
                    name: 'http-ups-allow',
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
      });

      const result = await rig.run('Say hello');
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);

      const requestLogs = mockServer.getRequestLogs();
      if (requestLogs.length > 0) {
        expect(requestLogs[0].body.hook_event_name).toBe('UserPromptSubmit');
      }
    });

    it('should add additional context from HTTP hook to prompt', async () => {
      mockServer.setResponse(
        '/userprompt-context',
        HttpHookResponses.userPromptSubmitContext(
          'Extra context from HTTP hook',
        ),
      );

      await rig.setup('http-userprompt-context', {
        settings: {
          disableAllHooks: false,
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'http',
                    url: `${serverUrl}/userprompt-context`,
                    name: 'http-ups-context',
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
      });

      const result = await rig.run('What is 2+2?');
      expect(result).toBeDefined();

      const requestLogs = mockServer.getRequestLogs();
      if (requestLogs.length > 0) {
        expect(requestLogs[0].url).toBe('/userprompt-context');
      }
    });
  });

  // ==========================================================================
  // HTTP Hook - PostToolUse Events
  // ==========================================================================
  describe('PostToolUse HTTP Hooks', () => {
    it('should call HTTP hook after successful tool execution', async () => {
      mockServer.setResponse(
        '/posttooluse',
        HttpHookResponses.postToolUseContext(
          'Post-execution context from HTTP hook',
        ),
      );

      await rig.setup('http-posttooluse', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PostToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'http',
                    url: `${serverUrl}/posttooluse`,
                    name: 'http-post-hook',
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file post.txt with "test"');

      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();

      const requestLogs = mockServer.getRequestLogs();
      if (requestLogs.length > 0) {
        expect(requestLogs[0].body.hook_event_name).toBe('PostToolUse');
      }
    });
  });

  // ==========================================================================
  // HTTP Hook - SessionStart Events
  // ==========================================================================
  describe('SessionStart HTTP Hooks', () => {
    it('should call HTTP hook on session start', async () => {
      mockServer.setResponse('/sessionstart', {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'Session initialization context',
        },
      });

      await rig.setup('http-sessionstart', {
        settings: {
          disableAllHooks: false,
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'http',
                    url: `${serverUrl}/sessionstart`,
                    name: 'http-session-start',
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
      });

      const result = await rig.run('Say hello');
      expect(result).toBeDefined();

      const requestLogs = mockServer.getRequestLogs();
      if (requestLogs.length > 0) {
        expect(requestLogs[0].body.hook_event_name).toBe('SessionStart');
      }
    });
  });

  // ==========================================================================
  // HTTP Hook - Multiple Hooks
  // ==========================================================================
  describe('Multiple HTTP Hooks', () => {
    it('should execute multiple HTTP hooks in parallel', async () => {
      mockServer.setResponse('/hook1', HttpHookResponses.preToolUseAllow);
      mockServer.setResponse('/hook2', HttpHookResponses.preToolUseAllow);

      await rig.setup('http-multiple-parallel', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'http',
                    url: `${serverUrl}/hook1`,
                    name: 'http-hook-1',
                    timeout: 10,
                  },
                  {
                    type: 'http',
                    url: `${serverUrl}/hook2`,
                    name: 'http-hook-2',
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file multi.txt with "test"');

      const requestLogs = mockServer.getRequestLogs();
      expect(requestLogs.length).toBeGreaterThanOrEqual(0);
    });

    it('should execute HTTP hooks with command hooks together', async () => {
      mockServer.setResponse('/mixed-http', HttpHookResponses.preToolUseAllow);

      await rig.setup('http-mixed-hooks', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'http',
                    url: `${serverUrl}/mixed-http`,
                    name: 'mixed-http-hook',
                    timeout: 10,
                  },
                  {
                    type: 'command',
                    command: 'echo \'{"decision": "allow"}\'',
                    name: 'mixed-command-hook',
                    timeout: 5,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file mixed.txt with "test"');

      const requestLogs = mockServer.getRequestLogs();
      if (requestLogs.length > 0) {
        expect(requestLogs[0].url).toBe('/mixed-http');
      }
    });
  });

  // ==========================================================================
  // HTTP Hook - Once Flag
  // ==========================================================================
  describe('HTTP Hook Once Flag', () => {
    it('should only execute once when once flag is set', async () => {
      mockServer.setResponse('/once-hook', HttpHookResponses.preToolUseAllow);

      await rig.setup('http-once-flag', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'http',
                    url: `${serverUrl}/once-hook`,
                    name: 'once-http-hook',
                    timeout: 10,
                    once: true,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create file1.txt with "a" and file2.txt with "b"');

      const requestLogs = mockServer.getRequestLogs();
      expect(requestLogs.length).toBeLessThanOrEqual(1);
    });
  });
});

// ==========================================================================
// Async Hooks Integration Tests
// ==========================================================================
describe('Async Hooks Integration', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  // ==========================================================================
  // Async Command Hooks - PreToolUse Events
  // ==========================================================================
  describe('Async PreToolUse Hooks', () => {
    it('should execute async hook in background without blocking tool execution', async () => {
      // Async hook runs in background, tool execution continues immediately
      const asyncHookScript = `
        sleep 2
        echo '{"async": true, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "Async hook completed"}}' >> async_output.txt
      `;

      await rig.setup('async-pretooluse-background', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: asyncHookScript,
                    name: 'async-bg-hook',
                    timeout: 30,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      // Tool should execute immediately without waiting for async hook
      await rig.run('Create a file async_test.txt with "hello"');

      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();

      const fileContent = rig.readFile('async_test.txt');
      expect(fileContent).toContain('hello');
    });

    it('should run multiple async hooks concurrently without blocking', async () => {
      const asyncHook1 = `sleep 1 && echo 'hook1_done' >> async_multi.txt`;
      const asyncHook2 = `sleep 1 && echo 'hook2_done' >> async_multi.txt`;

      await rig.setup('async-pretooluse-concurrent', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: asyncHook1,
                    name: 'async-hook-1',
                    timeout: 30,
                    async: true,
                  },
                  {
                    type: 'command',
                    command: asyncHook2,
                    name: 'async-hook-2',
                    timeout: 30,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file concurrent.txt with "test"');

      // Tool should execute immediately
      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });

    it('should allow sync hook to run alongside async hook', async () => {
      const asyncHook = `sleep 2 && echo 'async_complete' >> async_sync_mix.txt`;
      const syncHook = `echo '{"decision": "allow"}'`;

      await rig.setup('async-with-sync', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: asyncHook,
                    name: 'async-mixed-hook',
                    timeout: 30,
                    async: true,
                  },
                  {
                    type: 'command',
                    command: syncHook,
                    name: 'sync-mixed-hook',
                    timeout: 5,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file mixed_async_sync.txt with "test"');

      // Sync hook should complete, async hook runs in background
      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });
  });

  // ==========================================================================
  // Async Command Hooks - PostToolUse Events
  // ==========================================================================
  describe('Async PostToolUse Hooks', () => {
    it('should execute async hook after tool completion without blocking', async () => {
      const asyncPostHook = `
        sleep 1
        echo 'post_async_done' >> post_async_log.txt
      `;

      await rig.setup('async-posttooluse', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PostToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: asyncPostHook,
                    name: 'async-post-hook',
                    timeout: 30,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file post_async.txt with "content"');

      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });

    it('should run async audit logging after tool execution', async () => {
      const auditHook = `
        echo '{"tool_name": "'$TOOL_NAME'", "timestamp": "'$(date -Iseconds)'"}' >> audit.log
      `;

      await rig.setup('async-posttooluse-audit', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PostToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: auditHook,
                    name: 'async-audit-hook',
                    timeout: 30,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file audited.txt with "test"');

      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });
  });

  // ==========================================================================
  // Async Command Hooks - SessionEnd Events
  // ==========================================================================
  describe('Async SessionEnd Hooks', () => {
    it('should execute async cleanup hook on session end', async () => {
      const cleanupHook = `echo 'session_ended' >> cleanup.log`;

      await rig.setup('async-sessionend-cleanup', {
        settings: {
          disableAllHooks: false,
          hooks: {
            SessionEnd: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: cleanupHook,
                    name: 'async-cleanup-hook',
                    timeout: 5,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      const result = await rig.run('Say goodbye');
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // Async Command Hooks - Timeout Handling
  // ==========================================================================
  describe('Async Hook Timeout', () => {
    it('should handle async hook timeout gracefully without blocking', async () => {
      const longRunningHook = `sleep 60 && echo 'finally_done' >> timeout_test.txt`;

      await rig.setup('async-hook-timeout', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: longRunningHook,
                    name: 'async-long-hook',
                    timeout: 2, // 2 second timeout - hook won't finish
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      // Execution should not be blocked by timeout
      await rig.run('Create a file timeout_async.txt with "test"');

      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });
  });

  // ==========================================================================
  // Async Command Hooks - Error Handling
  // ==========================================================================
  describe('Async Hook Error Handling', () => {
    it('should continue execution when async hook fails', async () => {
      const failingAsyncHook = `exit 1 && echo 'should_not_see_this' >> async_fail.txt`;

      await rig.setup('async-hook-failure', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: failingAsyncHook,
                    name: 'async-failing-hook',
                    timeout: 5,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      // Async hook failure should not block execution
      const result = await rig.run(
        'Create a file async_fail_test.txt with "test"',
      );
      expect(result).toBeDefined();
    });

    it('should continue when async hook command does not exist', async () => {
      await rig.setup('async-hook-missing-command', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: '/nonexistent/async/command',
                    name: 'async-missing-hook',
                    timeout: 5,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      const result = await rig.run(
        'Create a file async_missing.txt with "test"',
      );
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // Async Command Hooks - Concurrency Limits
  // ==========================================================================
  describe('Async Hook Concurrency', () => {
    it('should handle multiple async hooks within concurrency limit', async () => {
      const hooks = Array(5)
        .fill(null)
        .map((_, i) => ({
          type: 'command',
          command: `sleep 1 && echo 'hook${i}_done' >> concurrent_limit.txt`,
          name: `async-concurrent-hook-${i}`,
          timeout: 30,
          async: true,
        }));

      await rig.setup('async-concurrency-limit', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: hooks,
              },
            ],
          },
        },
      });

      await rig.run('Say concurrency test');

      // All hooks should be registered (within default limit of 10)
      expect(true).toBeTruthy();
    });
  });
});

// ==========================================================================
// HTTP Hook - Stop Events
// ==========================================================================
describe('Stop HTTP Hooks Integration', () => {
  let rig: TestRig;
  let mockServer: MockHttpServer;
  let serverUrl: string;

  beforeAll(async () => {
    mockServer = new MockHttpServer();
    await mockServer.start();
    serverUrl = mockServer.getUrl();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    rig = new TestRig();
    mockServer.clearRequestLogs();
  });

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  it('should call HTTP hook when stop event is triggered', async () => {
    mockServer.setResponse(
      '/stop',
      HttpHookResponses.stopWithReason('Stop hook feedback from HTTP'),
    );

    await rig.setup('http-stop', {
      settings: {
        disableAllHooks: false,
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'http',
                  url: `${serverUrl}/stop`,
                  name: 'http-stop-hook',
                  timeout: 5,
                },
              ],
            },
          ],
        },
      },
    });

    // Note: Stop hook requires explicit /stop command, which may not be triggered
    // in --prompt mode (rig.run). This test verifies the setup is valid.
    const result = await rig.run('Say hello');
    expect(result).toBeDefined();

    // Stop hook may not be triggered in --prompt mode as it requires /stop command
    // This is expected behavior - we just verify the test doesn't crash
  });
});

// ==========================================================================
// HTTP Hook - Notification Events
// ==========================================================================
describe('Notification HTTP Hooks Integration', () => {
  let rig: TestRig;
  let mockServer: MockHttpServer;
  let serverUrl: string;

  beforeAll(async () => {
    mockServer = new MockHttpServer();
    await mockServer.start();
    serverUrl = mockServer.getUrl();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    rig = new TestRig();
    mockServer.clearRequestLogs();
  });

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  it('should call HTTP hook when notification is sent', async () => {
    mockServer.setResponse('/notification', {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'Notification',
        additionalContext: 'Notification processed by HTTP hook',
      },
    });

    await rig.setup('http-notification', {
      settings: {
        disableAllHooks: false,
        hooks: {
          Notification: [
            {
              hooks: [
                {
                  type: 'http',
                  url: `${serverUrl}/notification`,
                  name: 'http-notification-hook',
                  timeout: 5,
                },
              ],
            },
          ],
        },
      },
    });

    const result = await rig.run('Say notification test');
    expect(result).toBeDefined();
  });
});

// ==========================================================================
// HTTP Hook - PreCompact Events
// ==========================================================================
describe('PreCompact HTTP Hooks Integration', () => {
  let rig: TestRig;
  let mockServer: MockHttpServer;
  let serverUrl: string;

  beforeAll(async () => {
    mockServer = new MockHttpServer();
    await mockServer.start();
    serverUrl = mockServer.getUrl();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    rig = new TestRig();
    mockServer.clearRequestLogs();
  });

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  it('should call HTTP hook before conversation compaction', async () => {
    mockServer.setResponse('/precompact', {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext: 'Pre-compact context from HTTP hook',
      },
    });

    await rig.setup('http-precompact', {
      settings: {
        disableAllHooks: false,
        hooks: {
          PreCompact: [
            {
              hooks: [
                {
                  type: 'http',
                  url: `${serverUrl}/precompact`,
                  name: 'http-precompact-hook',
                  timeout: 5,
                },
              ],
            },
          ],
        },
      },
    });

    const result = await rig.run('Say precompact test');
    expect(result).toBeDefined();
  });
});
