# Core Test Utilities (`@qwen-code/core/test-utils`)

Shared test utilities used across the monorepo. These helpers live in Core and are exposed through its separate test entry.

## Key Modules

- `test-rig.ts`: The primary test rig for spinning up end-to-end CLI
  sessions with mock responses.
- `file-system-test-helpers.ts`: Helpers for creating temporary file system
  fixtures.
- `test-mcp-server.ts`: Helper for building test MCP servers for tests.
- `test-mcp-server-template.mjs`: Generic template script for running
  isolated MCP processes.

## Test MCP Servers

The `TestRig` provides a fully isolated, compliant way to test tool triggers and
workflows using local test MCP servers. This isolates your tests from live API
endpoints and rate-limiting.

### Usage

Use `TestMcpServerBuilder` to define only the mock tools needed by each test:

```typescript
import { TestMcpServerBuilder } from '@qwen-code/core/test-utils';

const builder = new TestMcpServerBuilder('weather-server').addTool(
  'get_weather',
  'Get weather',
  'It is rainy',
);

rig.addTestMcpServer('weather-server', builder.build());
```

## Usage

Import from `@qwen-code/core/test-utils` in test files across the monorepo.
