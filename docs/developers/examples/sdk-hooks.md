# SDK Hook Callback Examples

Examples of SDK-side hook callbacks using `hookCallbacks` in `QueryOptions`.

## Audit logger

Log every tool invocation with timestamps:

```typescript
import { query, type HookCallback } from '@qwen-code/sdk';

const auditLogger: HookCallback = async (input, toolUseId) => {
  const data = input as { tool_name?: string };
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'PreToolUse',
      tool: data.tool_name,
      toolUseId,
    }),
  );
  return {};
};

const conversation = query({
  prompt: 'Refactor the auth module',
  options: {
    hookCallbacks: { PreToolUse: auditLogger },
  },
});
```

## Security gate

Block specific tools or patterns:

```typescript
const securityGate: HookCallback = async (input) => {
  const data = input as {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
  };

  // Block shell commands that modify files outside the project
  if (data.tool_name === 'Bash') {
    const cmd = String(data.tool_input?.command ?? '');
    if (cmd.includes('rm -rf') || cmd.includes('sudo')) {
      return {
        shouldSkip: true,
        message: 'Destructive or privileged commands are not allowed',
      };
    }
  }

  return {};
};
```

## PostToolUse result validator

Inspect tool output after execution:

```typescript
const resultValidator: HookCallback = async (input) => {
  const data = input as { tool_name?: string; tool_output?: string };

  if (data.tool_name === 'Bash' && data.tool_output?.includes('FATAL')) {
    return {
      shouldInterrupt: true,
      message: 'Fatal error detected in shell output. Stopping agent.',
    };
  }

  return {};
};

const conversation = query({
  prompt: 'Run the test suite and fix failures',
  options: {
    hookCallbacks: {
      PreToolUse: [auditLogger, securityGate],
      PostToolUse: resultValidator,
    },
  },
});
```

## Multiple callbacks per event

When an array of callbacks is registered for one event, they execute in order. The first `shouldSkip` or `shouldInterrupt` result short-circuits the rest:

```typescript
const conversation = query({
  prompt: 'Implement the feature',
  options: {
    hookCallbacks: {
      PreToolUse: [
        auditLogger, // always runs first
        securityGate, // skips tool if dangerous (short-circuits)
        rateLimiter, // only runs if securityGate didn't skip
      ],
    },
  },
});
```

## Stop hook

Run cleanup when the agent finishes:

```typescript
const conversation = query({
  prompt: 'Analyze the codebase',
  options: {
    hookCallbacks: {
      Stop: async (input) => {
        console.log('Agent finished. Flushing audit log...');
        await flushAuditLog();
        return {};
      },
    },
  },
});
```
