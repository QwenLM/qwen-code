# ADR 0002: MCP stdio entrypoint for Qwen CLI

**Date**: 2026-02-01
**Status**: Accepted

## Context

Docs inconsistently referenced `dist/index.js` vs `dist/mcp/mcp-server-stdio.js` as the Qwen CLI MCP server entrypoint.

## Decision

- Qwen CLI uses **`app/native-server/dist/mcp/mcp-server-stdio.js`** as the MCP server entrypoint.
- `app/native-server/dist/index.js` is reserved for the Native Messaging host process invoked by Chrome.

## Consequences

- All MCP usage docs must point to `dist/mcp/mcp-server-stdio.js`.
- Operational scripts should distinguish between MCP server and native host.
