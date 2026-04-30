/**
 * @craft-agent/shared
 *
 * Shared business logic for Craft Agent.
 * Used by the Electron app.
 *
 * Import specific modules via subpath exports:
 *   import { CraftAgent } from '@craft-agent/shared/agent';
 *   import { loadStoredConfig } from '@craft-agent/shared/config';
 *   import { getCredentialManager } from '@craft-agent/shared/credentials';
 *   import { CraftMcpClient } from '@craft-agent/shared/mcp';
 *   import { debug } from '@craft-agent/shared/utils';
 *   import { loadSource, createSource, getSourceCredentialManager } from '@craft-agent/shared/sources';
 *   import { createWorkspace, loadWorkspace } from '@craft-agent/shared/workspaces';
 *
 * Available modules:
 *   - agent: CraftAgent SDK wrapper, plan tools
 *   - auth: OAuth, token management, auth state
 *   - clients: Craft API client
 *   - config: Storage, models, preferences
 *   - credentials: Encrypted credential storage
 *   - mcp: MCP client, connection validation
 *   - prompts: System prompt generation
 *   - sources: Workspace-scoped source management (MCP, API, local)
 *   - utils: Debug logging, file handling, summarization
 *   - validation: URL validation
 *   - version: Version and installation management
 *   - workspaces: Workspace management (top-level organizational unit)
 */

// Export branding (standalone, no dependencies)
export * from './branding.ts';
