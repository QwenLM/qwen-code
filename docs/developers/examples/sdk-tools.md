# SDK MCP Tool Examples

Examples of creating and using MCP tools with the SDK, both in-process and external.

## In-process tool with Zod schema

Define tools using `tool()` and serve them via `createSdkMcpServer()`. The tool runs in your SDK process -- no separate server needed.

```typescript
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '@qwen-code/sdk';

const lookupUser = tool(
  'lookup_user',
  'Look up a user by email address',
  {
    email: z.string().email().describe('The user email to look up'),
  },
  async (args) => {
    const user = await db.users.findByEmail(args.email);
    if (!user) {
      return {
        content: [{ type: 'text', text: `No user found for ${args.email}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(user, null, 2) }],
    };
  },
);

const server = createSdkMcpServer({
  name: 'user-service',
  tools: [lookupUser],
});

const conversation = query({
  prompt: 'Find the account for alice@example.com and summarize it',
  options: {
    permissionMode: 'auto-edit',
    mcpServers: { 'user-service': server },
  },
});

for await (const message of conversation) {
  if (message.type === 'assistant') {
    console.log(message.message.content);
  }
}
```

## Multiple tools on one server

A single SDK MCP server can expose many tools:

```typescript
const listOrders = tool(
  'list_orders',
  'List recent orders for a user',
  { userId: z.string(), limit: z.number().default(10) },
  async (args) => {
    const orders = await db.orders.list(args.userId, args.limit);
    return { content: [{ type: 'text', text: JSON.stringify(orders) }] };
  },
);

const cancelOrder = tool(
  'cancel_order',
  'Cancel an order by ID',
  { orderId: z.string(), reason: z.string().optional() },
  async (args) => {
    await db.orders.cancel(args.orderId, args.reason);
    return {
      content: [{ type: 'text', text: `Order ${args.orderId} cancelled` }],
    };
  },
);

const server = createSdkMcpServer({
  name: 'order-service',
  tools: [listOrders, cancelOrder],
});
```

## External MCP server (stdio)

Connect to an MCP server running as a separate process:

```typescript
const conversation = query({
  prompt: 'Query the production database for slow queries',
  options: {
    mcpServers: {
      'db-tools': {
        command: 'node',
        args: ['./mcp-servers/db-tools/index.js'],
        env: { DATABASE_URL: process.env.DATABASE_URL! },
      },
    },
  },
});
```

## External MCP server (SSE)

Connect to a remote MCP server over Server-Sent Events:

```typescript
const conversation = query({
  prompt: 'Check deployment status',
  options: {
    mcpServers: {
      'deploy-server': {
        url: 'https://deploy.internal.example.com/sse',
      },
    },
  },
});
```

## External MCP server (Streamable HTTP)

Connect over HTTP with custom headers:

```typescript
const conversation = query({
  prompt: 'Fetch the latest metrics',
  options: {
    mcpServers: {
      'metrics-api': {
        httpUrl: 'https://metrics.example.com/mcp',
        headers: {
          Authorization: `Bearer ${process.env.METRICS_TOKEN}`,
        },
      },
    },
  },
});
```

## Mixing SDK and external servers

Use both in the same session. The agent sees all tools from all servers:

```typescript
const internalTools = createSdkMcpServer({
  name: 'internal',
  tools: [lookupUser, listOrders],
});

const conversation = query({
  prompt: 'Look up the user, then check their deploy history',
  options: {
    mcpServers: {
      internal: internalTools,
      'deploy-server': {
        command: 'npx',
        args: ['-y', '@company/deploy-mcp-server'],
      },
    },
  },
});
```

## Tool with rich return types

Tools can return text, images, or embedded resources:

```typescript
const generateChart = tool(
  'generate_chart',
  'Generate a chart image from data points',
  {
    data: z.array(z.object({ x: z.number(), y: z.number() })),
    title: z.string(),
  },
  async (args) => {
    const pngBuffer = await renderChart(args.data, args.title);
    return {
      content: [
        { type: 'text', text: `Chart: ${args.title}` },
        {
          type: 'image',
          data: pngBuffer.toString('base64'),
          mimeType: 'image/png',
        },
      ],
    };
  },
);
```

## Filtering tools per server

Use `includeTools` or `excludeTools` on external servers to control which tools the agent sees:

```typescript
const conversation = query({
  prompt: 'Read-only analysis of the database',
  options: {
    mcpServers: {
      'db-tools': {
        command: 'node',
        args: ['./mcp-servers/db-tools/index.js'],
        excludeTools: ['drop_table', 'truncate', 'delete_rows'],
      },
    },
  },
});
```
