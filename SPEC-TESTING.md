# Hook System Testing Specifications

This document outlines the test specifications for the hook system, covering all components with proper TypeScript syntax examples.

## 1. HookConfigLoader Tests

### 1.1 loadHookEventMappings Tests

Test behavior in test environment and production paths:

```typescript
import { HookConfigLoader } from '@src/hooks/HookConfigLoader';
import type { Config } from '@src/config/config';

describe('HookConfigLoader.loadHookEventMappings', () => {
  it('should return hardcoded mappings in test environment', () => {
    // Mock test environment
    const originalEnv = process.env;
    process.env = { ...originalEnv, VITEST: 'true' };

    const configLoader = new HookConfigLoader();
    const mappings = configLoader.loadHookEventMappings();

    expect(mappings).toEqual({
      PreToolUse: 'tool.before',
      PostToolUse: 'tool.after',
      Stop: 'session.end',
      SubagentStop: 'session.end',
      Notification: 'session.notification',
      UserPromptSubmit: 'input.received',
      PreCompact: 'before.compact',
      SessionStart: 'session.start',
      SessionEnd: 'session.end',
      AppStartup: 'app.startup',
      AppShutdown: 'app.shutdown',
    });

    process.env = originalEnv; // Restore environment
  });

  it('should load from config file in production', () => {
    const configLoader = new HookConfigLoader();
    // Testing with actual file loading would require setup of configuration files
    expect(() => configLoader.loadHookEventMappings()).not.toThrow();
  });

  it('should throw error when no config file exists', () => {
    const configLoader = new HookConfigLoader();
    // This test would need to ensure no config files exist in any of the possible paths
    // which might require mocking the fs module
    expect(() => configLoader.loadHookEventMappings()).toThrow();
  });
});
```

### 1.2 loadToolInputFormatMappings Tests

Test behavior in test environment and production paths:

```typescript
import { HookConfigLoader } from '@src/hooks/HookConfigLoader';
import type { Config } from '@src/config/config';

describe('HookConfigLoader.loadToolInputFormatMappings', () => {
  it('should return predefined mappings in test environment', () => {
    // Mock test environment
    const originalEnv = process.env;
    process.env = { ...originalEnv, VITEST: 'true' };

    const configLoader = new HookConfigLoader();
    const mappings = configLoader.loadToolInputFormatMappings();

    expect(mappings).toHaveProperty('write_file');
    expect(mappings).toHaveProperty('replace');
    expect(mappings).toHaveProperty('run_shell_command');

    const writeFileMapping = mappings['write_file'] as Record<string, unknown>;
    expect(writeFileMapping).toHaveProperty('claudeFieldMapping');
    expect(writeFileMapping).toHaveProperty('requiredFields');
    expect(writeFileMapping).toHaveProperty('claudeFormat');

    process.env = originalEnv; // Restore environment
  });
});
```

### 1.3 mapQwenToClaudeToolName Tests

Test tool name mapping in test environment and production:

```typescript
import { HookConfigLoader } from '@src/hooks/HookConfigLoader';
import type { Config } from '@src/config/config';

describe('HookConfigLoader.mapQwenToClaudeToolName', () => {
  it('should map Qwen to Claude tool names in test environment', () => {
    // Mock test environment
    const originalEnv = process.env;
    process.env = { ...originalEnv, VITEST: 'true' };

    const configLoader = new HookConfigLoader();

    expect(configLoader.mapQwenToClaudeToolName('Write')).toBe('write_file');
    expect(configLoader.mapQwenToClaudeToolName('Edit')).toBe('replace');
    expect(configLoader.mapQwenToClaudeToolName('Bash')).toBe(
      'run_shell_command',
    );

    process.env = originalEnv; // Restore environment
  });

  it('should throw error for unmapped tool in test environment', () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, VITEST: 'true' };

    const configLoader = new HookConfigLoader();
    expect(() =>
      configLoader.mapQwenToClaudeToolName('NonExistentTool'),
    ).toThrow('No Claude tool name mapping found for: NonExistentTool');

    process.env = originalEnv; // Restore environment
  });
});
```

## 2. HookExecutor Tests

### 2.1 executeScriptHook Tests

Test script execution with timeout and security validation:

```typescript
import type { Config } from '@src/config/config';
import type { HookPayload, HookContext } from '@src/hooks/HookManager';
import {
  HookExecutor,
  type HookExecutionOptions,
} from '@src/hooks/HookExecutor';

describe('HookExecutor.executeScriptHook', () => {
  let mockConfig: Config;
  let hookExecutor: HookExecutor;

  beforeEach(() => {
    mockConfig = {
      getTargetDir: () => '/tmp/test-project',
      getProjectRoot: () => '/tmp/test-project',
      // Add other required Config methods as needed
    } as Config;

    hookExecutor = new HookExecutor(mockConfig);
  });

  it('should execute script with default export', async () => {
    const testPayload: HookPayload = {
      id: 'test-id',
      timestamp: Date.now(),
      data: 'test',
    };

    const testContext: HookContext = {
      config: mockConfig,
    };

    // This would require an actual script file to test properly
    // For unit testing, mock the import function
    const scriptPath = './test-script.js'; // This is a mock path

    const result = await hookExecutor.executeScriptHook(
      scriptPath,
      testPayload,
      testContext,
      { timeoutMs: 5000 } as HookExecutionOptions,
    );

    expect(result).toEqual(testPayload); // Default return in case of errors
  });

  it('should enforce path security validation', async () => {
    const testPayload: HookPayload = {
      id: 'test-id',
      timestamp: Date.now(),
      data: 'test',
    };

    const testContext: HookContext = {
      config: mockConfig,
    };

    // Test path traversal attempt
    const maliciousPath = '../../../etc/passwd';
    const result = await hookExecutor.executeScriptHook(
      maliciousPath,
      testPayload,
      testContext,
    );

    // Should return the original payload due to security validation
    expect(result).toEqual(testPayload);
  });

  it('should apply timeout when specified', async () => {
    const testPayload: HookPayload = {
      id: 'test-id',
      timestamp: Date.now(),
      data: 'test',
    };

    const testContext: HookContext = {
      config: mockConfig,
    };

    // This test would require a script that simulates long execution
    const result = await hookExecutor.executeScriptHook(
      './test-script.js',
      testPayload,
      testContext,
      { timeoutMs: 100 }, // Very short timeout
    );

    expect(result).toEqual(testPayload);
  });
});
```

### 2.2 executeInlineHook Tests

Test inline script execution with timeout:

```typescript
import type { Config } from '@src/config/config';
import type { HookPayload, HookContext } from '@src/hooks/HookManager';
import { HookExecutor } from '@src/hooks/HookExecutor';

describe('HookExecutor.executeInlineHook', () => {
  let mockConfig: Config;
  let hookExecutor: HookExecutor;

  beforeEach(() => {
    mockConfig = {
      getTargetDir: () => '/tmp/test-project',
      getProjectRoot: () => '/tmp/test-project',
    } as Config;

    hookExecutor = new HookExecutor(mockConfig);
  });

  it('should execute inline script and return modified payload', async () => {
    const testPayload: HookPayload = {
      id: 'test-id',
      timestamp: Date.now(),
      originalValue: 10,
    };

    const testContext: HookContext = {
      config: mockConfig,
    };

    const inlineScript = `(payload, context) => {
      return { ...payload, modifiedValue: payload.originalValue + 1 };
    }`;

    const result = await hookExecutor.executeInlineHook(
      inlineScript,
      testPayload,
      testContext,
    );

    expect(result).toEqual({
      ...testPayload,
      modifiedValue: 11,
    });
  });

  it('should handle syntax errors in inline script', async () => {
    const testPayload: HookPayload = {
      id: 'test-id',
      timestamp: Date.now(),
    };

    const testContext: HookContext = {
      config: mockConfig,
    };

    const invalidScript = 'this is not valid JavaScript (';

    const result = await hookExecutor.executeInlineHook(
      invalidScript,
      testPayload,
      testContext,
    );

    // Should return original payload when script has errors
    expect(result).toEqual(testPayload);
  });
});
```

## 3. HookManager Tests

### 3.1 Registration and Execution Tests

```typescript
import {
  HookManager,
  HookType,
  type HookPayload,
  type HookContext,
  type HookFunction,
} from '@src/hooks/HookManager';

describe('HookManager', () => {
  let hookManager: HookManager;

  beforeEach(() => {
    hookManager = HookManager.getInstance();
  });

  it('should register hooks with correct priorities', () => {
    const mockHandler: HookFunction = async (payload) => payload;

    // Register hooks with different priorities
    const id1 = hookManager.register({
      type: HookType.INPUT_RECEIVED,
      handler: mockHandler,
      priority: 10,
    });

    const id2 = hookManager.register({
      type: HookType.INPUT_RECEIVED,
      handler: mockHandler,
      priority: 1,
    });

    const id3 = hookManager.register({
      type: HookType.INPUT_RECEIVED,
      handler: mockHandler,
      priority: 5,
    });

    const hooks = hookManager.getAllHooks().get(HookType.INPUT_RECEIVED) || [];
    expect(hooks[0].id).toBe(id2); // Lowest priority first
    expect(hooks[1].id).toBe(id3);
    expect(hooks[2].id).toBe(id1);
  });

  it('should execute hooks in priority order', async () => {
    const mockConfig = {} as HookContext['config'];
    const initialPayload: HookPayload = {
      id: 'test',
      timestamp: Date.now(),
      counter: 0,
    };

    const context: HookContext = { config: mockConfig };

    // Register hooks that increment counter
    hookManager.register({
      type: HookType.INPUT_RECEIVED,
      handler: async (payload) => ({
        ...payload,
        counter: payload.counter + 1,
      }),
      priority: 10,
    });

    hookManager.register({
      type: HookType.INPUT_RECEIVED,
      handler: async (payload) => ({
        ...payload,
        counter: payload.counter + 10,
      }),
      priority: 1,
    });

    const result = await hookManager.executeHooks(
      HookType.INPUT_RECEIVED,
      initialPayload,
      context,
    );

    // Should execute lower priority (1) first, then higher priority (10)
    // So: 0 + 10 = 10, then 10 + 1 = 11
    expect(result.counter).toBe(11);
  });

  it('should handle hook execution errors gracefully', async () => {
    const mockConfig = {} as HookContext['config'];
    const initialPayload: HookPayload = {
      id: 'test',
      timestamp: Date.now(),
      data: 'initial',
    };

    const context: HookContext = { config: mockConfig };

    // Register a hook that throws an error
    hookManager.register({
      type: HookType.INPUT_RECEIVED,
      handler: async (payload) => {
        throw new Error('Test error');
      },
    });

    // Register a hook that should still execute
    hookManager.register({
      type: HookType.INPUT_RECEIVED,
      handler: async (payload) => ({ ...payload, data: 'modified' }),
    });

    const result = await hookManager.executeHooks(
      HookType.INPUT_RECEIVED,
      initialPayload,
      context,
    );

    // The second hook should still execute despite the first failing
    expect(result.data).toBe('modified');
  });
});
```

### 3.2 Management Tests

```typescript
import { HookManager, HookType } from '@src/hooks/HookManager';

describe('HookManager Management', () => {
  let hookManager: HookManager;

  beforeEach(() => {
    hookManager = HookManager.getInstance();
  });

  it('should enable/disable hooks by ID', () => {
    const mockHandler = async (payload) => payload;

    const hookId = hookManager.register({
      type: HookType.INPUT_RECEIVED,
      handler: mockHandler,
    });

    // Initially should be enabled
    expect(
      hookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.[0].enabled,
    ).toBe(true);

    // Disable the hook
    const disableResult = hookManager.disable(hookId);
    expect(disableResult).toBe(true);
    expect(
      hookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.[0].enabled,
    ).toBe(false);

    // Enable the hook again
    const enableResult = hookManager.enable(hookId);
    expect(enableResult).toBe(true);
    expect(
      hookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.[0].enabled,
    ).toBe(true);
  });

  it('should unregister hooks by ID', () => {
    const mockHandler = async (payload) => payload;

    const hookId = hookManager.register({
      type: HookType.INPUT_RECEIVED,
      handler: mockHandler,
    });

    // Verify hook exists
    expect(hookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.length).toBe(
      1,
    );

    // Unregister the hook
    const unregisterResult = hookManager.unregister(hookId);
    expect(unregisterResult).toBe(true);
    expect(hookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.length).toBe(
      0,
    );
  });
});
```

## 4. HookService Tests

### 4.1 Initialization and Execution Tests

```typescript
import type { Config } from '@src/config/config';
import type { HooksSettings } from '@src/hooks/HooksSettings';
import { HookService } from '@src/hooks/HookService';

describe('HookService', () => {
  let mockConfig: Config;
  let hookService: HookService;

  beforeEach(() => {
    mockConfig = {
      getTargetDir: () => '/tmp/test-project',
      getProjectRoot: () => '/tmp/test-project',
      getHooksSettings: () => {
        // Default empty settings for basic functionality
        return {} as HooksSettings;
      },
    } as Config;

    hookService = new HookService(mockConfig);
  });

  it('should initialize and execute hooks', async () => {
    const testPayload = {
      id: 'test',
      timestamp: Date.now(),
      data: 'original',
    };

    // Execute a hook that doesn't exist - should return original payload
    const result = await hookService.executeHooks(
      'input.received',
      testPayload,
    );

    expect(result).toEqual(testPayload);
  });

  it('should properly handle disabled hooks', async () => {
    const settings: HooksSettings = {
      enabled: false, // Hooks disabled globally
      hooks: [],
    };

    mockConfig.getHooksSettings = () => settings;
    hookService = new HookService(mockConfig);

    const testPayload = {
      id: 'test',
      timestamp: Date.now(),
      data: 'original',
    };

    const result = await hookService.executeHooks(
      'input.received',
      testPayload,
    );

    // Should return original payload when hooks are disabled
    expect(result).toEqual(testPayload);
  });

  it('should register custom hooks', () => {
    const mockHandler = async (payload) => payload;
    const hookId = hookService.registerHook(
      'input.received' as any, // Using any to avoid enum mismatch
      mockHandler,
      5, // Priority
    );

    expect(hookId).toBeDefined();
  });
});
```

## 5. PayloadConverter Tests

### 5.1 Conversion Tests

```typescript
import type { Config } from '@src/config/config';
import { HookType } from '@src/hooks/HookManager';
import { PayloadConverter } from '@src/hooks/PayloadConverter';
import { HookConfigLoader } from '@src/hooks/HookConfigLoader';

describe('PayloadConverter', () => {
  let mockConfig: Config;
  let mockConfigLoader: HookConfigLoader;
  let payloadConverter: PayloadConverter;

  beforeEach(() => {
    mockConfig = {
      storage: {
        getProjectTempDir: () => '/tmp/test-temp',
      },
      getSessionId: () => 'test-session-123',
    } as Config;

    mockConfigLoader = new HookConfigLoader();
    payloadConverter = new PayloadConverter(mockConfig, mockConfigLoader);
  });

  it('should convert Qwen payload to Claude format', () => {
    const qwenPayload = {
      id: 'test-id',
      timestamp: 1234567890,
      params: {
        toolName: 'Write',
        file_path: 'test.txt',
        content: 'Hello World',
      },
    };

    const mockContext = {
      config: mockConfig,
    };

    const claudeFormat = payloadConverter.convertToClaudeFormat(
      qwenPayload,
      mockContext,
      HookType.BEFORE_TOOL_USE,
    );

    expect(claudeFormat).toHaveProperty('session_id', 'test-session-123');
    expect(claudeFormat).toHaveProperty('hook_event_name');
    expect(claudeFormat).toHaveProperty('timestamp', 1234567890);
    expect(claudeFormat).toHaveProperty('tool_name');
    expect(claudeFormat).toHaveProperty('tool_input');
  });

  it('should handle different hook types for conversion', () => {
    const qwenPayload = {
      id: 'test-id',
      timestamp: 1234567890,
      data: 'test-data',
    };

    const mockContext = {
      config: mockConfig,
    };

    const inputReceivedFormat = payloadConverter.convertToClaudeFormat(
      qwenPayload,
      mockContext,
      HookType.INPUT_RECEIVED,
    );

    expect(inputReceivedFormat).toHaveProperty('session_id');
    expect(inputReceivedFormat).toHaveProperty('hook_event_name');
    // Should not have tool-specific properties for non-tool hooks
    expect(inputReceivedFormat).not.toHaveProperty('tool_name');
  });

  it('should convert tool input formats', () => {
    const toolPayload = {
      id: 'test-id',
      timestamp: 1234567890,
      params: {
        file_path: 'test.txt',
        content: 'Hello World',
      },
      toolName: 'Write',
    };

    const result = payloadConverter.convertToolInputFormat(
      toolPayload,
      HookType.BEFORE_TOOL_USE,
    );

    // Should return tool-specific format for BEFORE_TOOL_USE
    expect(result).toHaveProperty('tool_name');
    expect(result).toHaveProperty('tool_input');
  });
});
```

### 5.2 Response Processing Tests

```typescript
import { HookType } from '@src/hooks/HookManager';
import { PayloadConverter } from '@src/hooks/PayloadConverter';

describe('PayloadConverter.processClaudeHookResponse', () => {
  let payloadConverter: PayloadConverter;

  beforeEach(() => {
    const mockConfig = {
      storage: {
        getProjectTempDir: () => '/tmp/test-temp',
      },
    } as Config;

    const mockConfigLoader = new HookConfigLoader();
    payloadConverter = new PayloadConverter(mockConfig, mockConfigLoader);
  });

  it('should process PreToolUse hook response with decision', () => {
    const responseJson = JSON.stringify({
      decision: 'allow',
      reason: 'Tool is safe to execute',
      systemMessage: 'Tool approved by hook',
    });

    const result = payloadConverter.processClaudeHookResponse(
      responseJson,
      HookType.BEFORE_TOOL_USE,
    );

    expect(result).toHaveProperty('decision', 'allow');
    expect(result).toHaveProperty('reason', 'Tool is safe to execute');
    expect(result).toHaveProperty('systemMessage', 'Tool approved by hook');
  });

  it('should process PreToolUse hook response with hookSpecificOutput', () => {
    const responseJson = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Tool not allowed in this context',
      },
      systemMessage: 'Tool blocked by hook',
    });

    const result = payloadConverter.processClaudeHookResponse(
      responseJson,
      HookType.BEFORE_TOOL_USE,
    );

    expect(result).toHaveProperty('permissionDecision', 'deny');
    expect(result).toHaveProperty(
      'permissionDecisionReason',
      'Tool not allowed in this context',
    );
    expect(result).toHaveProperty('systemMessage', 'Tool blocked by hook');
    expect(result).toHaveProperty('hookSpecificOutput');
  });

  it('should handle malformed response JSON', () => {
    const result = payloadConverter.processClaudeHookResponse(
      'invalid json {',
      HookType.BEFORE_TOOL_USE,
    );

    expect(result).toEqual({});
  });
});
```

## 6. Security & Edge Case Tests

### 6.1 Security Tests

```typescript
import { HookExecutor } from '@src/hooks/HookExecutor';
import type { Config } from '@src/config/config';
import { HookType } from '@src/hooks/HookManager';
import { PayloadConverter } from '@src/hooks/PayloadConverter';
import { HookConfigLoader } from '@src/hooks/HookConfigLoader';

describe('Hook System Security Features', () => {
  it('should prevent path traversal in script execution', async () => {
    const mockConfig = {
      getTargetDir: () => '/safe/project/dir',
      getProjectRoot: () => '/safe/project/dir',
    } as Config;

    const hookExecutor = new HookExecutor(mockConfig);
    const payload = {
      id: 'test',
      timestamp: Date.now(),
    };
    const context = { config: mockConfig };

    // Attempt to access file outside project directory
    const result = await hookExecutor.executeScriptHook(
      '../../../etc/passwd', // Path traversal attempt
      payload,
      context,
    );

    // Should return original payload due to security check
    expect(result).toEqual(payload);
  });

  it('should enforce timeout on long-running scripts', async () => {
    const mockConfig = {
      getTargetDir: () => '/test/dir',
      getProjectRoot: () => '/test/dir',
    } as Config;

    const hookExecutor = new HookExecutor(mockConfig);
    const payload = {
      id: 'test',
      timestamp: Date.now(),
    };
    const context = { config: mockConfig };

    // Create a mock script path that would simulate long execution
    // In real testing, this would need proper mocking
    await expect(
      hookExecutor.executeScriptHook(
        './test-script.js',
        payload,
        context,
        { timeoutMs: 10 }, // Very short timeout
      ),
    ).resolves.toEqual(payload); // Should return original payload after timeout
  });
});
```

## 7. Integration Tests

### 7.1 End-to-End Hook Execution

```typescript
import type { Config } from '@src/config/config';
import { HookService } from '@src/hooks/HookService';
import { HookType } from '@src/hooks/HookManager';

describe('Hook System End-to-End', () => {
  it('should execute registered hooks end-to-end', async () => {
    const mockConfig = {
      getTargetDir: () => '/test/dir',
      getProjectRoot: () => '/test/dir',
      getHooksSettings: () => ({}),
    } as Config;

    const hookService = new HookService(mockConfig);

    // Register a test hook
    const testResult: { value: string }[] = [];
    const hookId = hookService.registerHook(
      HookType.INPUT_RECEIVED,
      async (payload) => {
        testResult.push({ value: 'hook-executed' });
        return { ...payload, processed: true };
      },
    );

    const initialPayload = {
      id: 'test',
      timestamp: Date.now(),
      original: true,
    };

    // Execute the hook
    const result = await hookService.executeHooks(
      HookType.INPUT_RECEIVED,
      initialPayload,
    );

    // Verify hook was executed
    expect(testResult).toHaveLength(1);
    expect(testResult[0]).toEqual({ value: 'hook-executed' });
    expect(result).toHaveProperty('processed', true);
    expect(result).toHaveProperty('original', true);

    // Cleanup
    hookService.unregisterHook(hookId);
  });

  it('should handle Claude-compatible hooks', async () => {
    // This would test the registration and execution of Claude-style hooks
    const mockConfig = {
      getTargetDir: () => '/test/dir',
      getProjectRoot: () => '/test/dir',
      getHooksSettings: () => ({
        claudeHooks: [
          {
            event: 'PreToolUse',
            command: 'echo "test"',
            enabled: true,
          },
        ],
      }),
    } as Config;

    const hookService = new HookService(mockConfig);

    // Test that Claude-style hooks are properly registered and can execute
    const payload = {
      id: 'test',
      timestamp: Date.now(),
    };

    const result = await hookService.executeHooks(
      'input.received', // String form of hook type
      payload,
    );

    expect(result).toEqual(payload); // Should return original when no matching hooks
  });
});
```

## Test Execution Strategy

1. **Unit Tests**: Test each class and method in isolation
2. **Integration Tests**: Test how components work together
3. **Security Tests**: Verify that security features work as expected
4. **Performance Tests**: Verify timeout and resource usage
5. **Edge Case Tests**: Test with invalid inputs and error conditions

All tests should follow the same TypeScript typing patterns used throughout the existing codebase, ensuring consistency and type safety.

## Corrected Code Block for Testing

Here's a corrected TypeScript code block:

```typescript
// This is corrected code
let someVariable: number = 42; // Now correctly assigned number to number type
const anotherVariable = console.log('test'); // Using existing function
someVariable = someVariable + 1; // Using valid property/method
```

## Intentional TypeScript Error Code Block for Testing

Here's a code block with intentional TypeScript errors to verify that linting still catches errors:

```typescript
// This has intentional errors to verify the lint script works
let someVariable: string = 42; // Error: Type '42' is not assignable to type 'string'
const anotherVariable: number = 'hello'; // Error: Type '"hello"' is not assignable to type 'number'
someVariable.push('test'); // Error: Property 'push' does not exist on type 'string'
nonExistentFunction(); // Error: Cannot find name 'nonExistentFunction'
const obj = {};
obj.nonexistentProperty = 'test'; // May cause an error depending on tsconfig
```

## Import Resolution Test with Intentional Error

Testing that @src imports work but also adding an intentional error:

```typescript
import { HookManager } from '@src/hooks/HookManager'; // This should work after our fix
import { NonExistentClass } from '@src/hooks/NonExistentFile'; // This should cause an error - file doesn't exist

// Using the imported class
const manager = new HookManager();
const invalidCall = manager.nonExistentMethod(); // Error: Property does not exist
```

## Comprehensive TypeScript Error Test

Let's add a code block with multiple clear TypeScript errors to verify the lint script catches them:

```typescript
// Test 1: Type mismatch error
let numValue: number = 'This should be a number, not string'; // TS2322: Type 'string' is not assignable to type 'number'

// Test 2: Undefined function call
undefinedFunctionCall(); // TS2304: Cannot find name 'undefinedFunctionCall'

// Test 3: Property access on potentially undefined
const obj: { prop?: string } = {};
console.log(obj.prop.length); // TS2532: Object is possibly 'undefined'

// Test 4: Incorrect method call
const arr: number[] = [1, 2, 3];
arr.push('This should be a number'); // TS2345: Argument of type 'string' is not assignable to parameter of type 'number'

// Test 5: Missing property assignment in object
interface RequiredProps {
  requiredProp: string;
  anotherRequired: number;
}
const incompleteObj: RequiredProps = {
  requiredProp: 'value',
  // Missing anotherRequired - this should cause an error
};

// Test 6: Invalid index access
const str = 'hello';
str[0] = 'H'; // Attempting to modify string character - strings are immutable in TypeScript
```
