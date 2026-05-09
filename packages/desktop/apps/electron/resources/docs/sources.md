# Sources Configuration Guide

This guide explains how to configure sources (MCP servers, APIs, local filesystems) in Qwen Code.

> **CLI-first workflow (recommended):** Use `craft-agent source ...` commands instead of editing source config files directly.
> - `craft-agent source --help`
> - Canonical command reference: [craft-cli.md](./craft-cli.md)

## Source Setup Process

When a user wants to add a new source, follow this conversational setup process to create a tailored, well-documented integration.

### 0. Search for Specialized Source Guide (REQUIRED FIRST STEP)

**Before doing anything else**, search for a specialized guide using the craft-agents-docs MCP:

```
mcp__craft-agents-docs__SearchCraftAgents({ query: "{service} source setup" })
```

**Available guides:** GitHub, Linear, Slack, Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Outlook, Microsoft Calendar, Teams, SharePoint, Craft, Filesystem, Brave Search, Memory

**If a guide exists for the service:**
1. **Read the guide content** carefully
2. **Pay special attention to the "Setup Hints" section** - it contains critical instructions
3. **Follow any CRITICAL/MANDATORY instructions** before proceeding (e.g., GitHub requires checking for `gh` CLI first)
4. **ALWAYS verify current API endpoints via WebSearch and/or in-app browser** - URLs and docs change frequently

**Why this matters:** Some services have important prerequisites or gotchas that MUST be checked before creating a source. Skipping this step can lead to failed setups or redundant configurations.

### 0.5. Choose Source vs Browser Path (RECOMMENDED PRE-FLIGHT)

Sources remain the default for reusable integrations. Before building a new source, ask: **Is this repeatable integration work, or a one-off/UI-driven task?**

**Prefer creating/using a source when:**
- The workflow is repeatable and likely to be reused
- Structured querying/reporting is needed
- Team consistency and automation matter
- API/MCP auth is stable enough to maintain

**Prefer in-app browser first (or as fallback) when:**
- Auth/setup is known to be brittle (common with some Gmail/Microsoft scenarios)
- The user needs a one-off task completed quickly
- The API is limited, unstable, or missing required operations
- The workflow is UI-first and not worth full integration overhead

If you choose browser-first, still offer optional source setup later when the user needs repeatability.

### 1. Understand User Intent

Before creating any configuration, ask questions to understand:
- **Primary purpose**: What do they want to accomplish with this source?
- **Scope**: Specific projects, teams, repositories, or data to focus on?
- **Common tasks**: What operations will they perform most often?
- **Access level**: Read-only exploration or full access?

Example questions:
> "I'd be happy to help set up Linear! A few questions:
> 1. What will you primarily use Linear for? (issue tracking, sprint planning, etc.)
> 2. Are there specific teams or projects you want to focus on?
> 3. Should I set it up for read-only exploration or full access?"

### 2. Research the Service

Use available tools to learn about the service:
- **WebSearch/WebFetch**: Find official documentation, API references, best practices
- **In-app browser tools**: Use when docs are dynamic, interactive, or behind login
- **Look up**: Rate limits, quotas, authentication methods
- **Identify**: Key endpoints or tools relevant to user's stated goals
- **Note**: Any limitations or gotchas to document

### Source vs Browser: Practical Examples

- **Gmail/Microsoft setup keeps failing auth:** attempt source setup, but confirm browser fallback for immediate task completion.
- **Need a one-off export from an admin UI:** use browser directly; skip full source setup unless recurring.
- **API lacks the required endpoint but UI supports it:** use browser as preferred path and document limitation.

### 3. Configure Intelligently

Based on research and user intent, create `config.json` with **ALL required fields**:

**Core fields:**
- `id` - **REQUIRED**: Unique identifier string. Format: `{slug}_{random}` (e.g., `linear_a1b2c3d4`). Generate the random part with any method (e.g., 8 hex chars).
- `name`, `slug`, `provider`, `type` - Basic identification
- `icon` - **RECOMMENDED**: URL to the service's favicon, logo, or app icon. The icon is auto-downloaded and cached locally. Use an emoji as fallback.
- `tagline` - **RECOMMENDED**: Short description for agent context (e.g., "Issue tracking, sprint planning, and project management")
- Type-specific config (`mcp`, `api`, or `local`)
- Authentication method appropriate for the service

### 4. Configure Explore Mode Permissions (REQUIRED)

Sources should work in Explore mode by default. Create `permissions.json` to allow read-only operations.

**How it works:** Patterns in a source's `permissions.json` are automatically scoped to that source. Write simple patterns like `list` - the system converts them to `mcp__<sourceSlug>__.*list` internally. This prevents cross-source leakage.

**For MCP sources:**
1. After connecting, list the server's available tools
2. Identify read-only tools (list, get, search, find, query operations)
3. Create simple patterns for those operations

```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "All list operations" },
    { "pattern": "get", "comment": "All get/read operations" },
    { "pattern": "search", "comment": "All search operations" },
    { "pattern": "find", "comment": "All find operations" }
  ]
}
```

**For API sources:**
```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests are read-only" },
    { "method": "POST", "path": "^/search", "comment": "Search endpoint (read-only despite POST)" }
  ]
}
```

**For local sources:**
```json
{
  "allowedBashPatterns": [
    { "pattern": "^(ls|cat|head|tail|grep|find|tree)\\s", "comment": "Read-only commands" }
  ]
}
```

> **Goal:** Sources should be fully functional in Explore mode. Allow all read operations by default. Only block actual mutations (create, update, delete).

### 5. Write Comprehensive guide.md

Create a guide.md tailored to the user's context:
- Summarize the source's purpose in their specific use case
- Document capabilities relevant to their workflow
- Include specific project/team/scope references they mentioned
- Add usage examples tailored to their tasks
- Note rate limits, quotas, or limitations

### 6. Test and Validate (MANDATORY)

**You MUST use the `source_test` tool after creating any source.** This applies to ALL source types - MCP, API, and local filesystem sources. This is not optional.

```
mcp__session__source_test({ sourceSlug: "{slug}" })
```

The `source_test` tool:
1. **Validates config.json** against the schema
2. **Downloads and caches the icon** if a URL was provided
3. **Tests the connection** to verify the source is reachable
4. **Reports missing fields** (icon, tagline) that should be added
5. **Auto-enables the source** (default): on a clean run it flips `enabled: true` in config if needed and activates the source in the current session so its tools become available without a restart. Pass `autoEnable: false` to keep pure validation behavior.

After validation passes, trigger the appropriate auth flow:
- OAuth sources: `source_oauth_trigger({ sourceSlug: "{slug}" })`
- Bearer/API key: `source_credential_prompt({ sourceSlug: "{slug}", mode: "bearer" })`
- Google services: `source_google_oauth_trigger({ sourceSlug: "{slug}" })`
- Microsoft services: `source_microsoft_oauth_trigger({ sourceSlug: "{slug}" })`
- Slack: `source_slack_oauth_trigger({ sourceSlug: "{slug}" })`

**Do NOT skip validation** - it catches config errors before they cause runtime failures.

## guide.md Best Practices

The guide.md file is critical; it helps the agent understand how to use the source effectively in future sessions.

### Structure

```markdown
# Source Name

Brief description of what this source provides and the user's specific use case.

## Scope

What data/functionality this provides. Include:
- Specific projects, teams, or repos the user mentioned
- Relevant filters or defaults
- Any limitations on access

## Guidelines

- Best practices for using this source
- Rate limits or quotas to be aware of
- Common patterns the user will need
- Things to avoid or be careful about

## Examples

Concrete examples tailored to the user's workflow:
- "To find issues in the Craft iOS project: ..."
- "To search for recent commits by the mobile team: ..."
```

### Key Principles

1. **Be specific to user context**: Reference the projects, teams, and tasks they mentioned
2. **Include concrete examples**: Use their actual project names and workflows
3. **Document user preferences**: Any preferences they shared for future sessions
4. **Note scope boundaries**: What the source can and cannot do
5. **Keep it actionable**: Focus on what the agent needs to know to help effectively

## Example Conversational Flow

```
User: I want to add Linear

Agent: [FIRST: Searches for Linear guide]
       mcp__craft-agents-docs__SearchCraftAgents({ query: "linear source setup" })

Agent: I found the Linear setup guide! A few questions:
1. What will you primarily use Linear for? (issue tracking, sprint planning, reporting?)
2. Are there specific teams or projects you want to focus on?
3. Should I set it up for read-only exploration or full access?

User: Issue tracking for my iOS team, project called "Craft iOS"

Agent: [Uses WebSearch to verify current Linear MCP URL]
Agent: [Creates config.json with:
        - icon: (searches web for app icon or uses favicon)
        - tagline: "Issue tracking for the Craft iOS team"
        - OAuth authentication]
Agent: [Writes guide.md mentioning "Craft iOS" project and iOS team context]
Agent: [Sets up permissions.json for read-only listing in Explore mode]
Agent: [MANDATORY: Runs source_test to validate]
       mcp__session__source_test({ sourceSlug: "linear" })
Agent: [Triggers source_oauth_trigger for authentication]
       mcp__session__source_oauth_trigger({ sourceSlug: "linear" })

Agent: Linear is now set up! I've configured it to focus on the "Craft iOS" project.
You can use it to:
- Search and view issues in Craft iOS
- Track sprint progress for the iOS team
- Create and update issues

Would you like me to show you what issues are currently open?
```

## Overview

Sources are stored as folders under:
- `~/.craft-agent/workspaces/{workspaceId}/sources/{sourceSlug}/`

Each source folder contains:
- `config.json` - Source configuration (required)
- `guide.md` - Usage documentation for the agent (optional)
- `permissions.json` - Custom permission rules for Explore mode (optional)
- `icon.svg`, `icon.png`, `icon.jpg`, or `icon.jpeg` - Source icon (optional)

## config.json Schema

```json
{
  "id": "linear_a1b2c3d4",        // Unique identifier: {slug}_{random}
  "name": "Human-readable name",
  "slug": "url-safe-identifier",
  "enabled": true,
  "provider": "provider-name",
  "type": "mcp" | "api" | "local",

  // RECOMMENDED: Icon and tagline for better UI and agent context
  "icon": "https://example.com/favicon.ico",  // URL (auto-downloaded) or emoji
  "tagline": "Brief description for agent context",

  // For MCP sources:
  "mcp": {
    "url": "https://mcp.example.com",
    "authType": "oauth" | "bearer" | "none"
  },

  // For API sources:
  "api": {
    "baseUrl": "https://api.example.com/",  // MUST have trailing slash
    "authType": "bearer" | "header" | "query" | "basic" | "oauth" | "none",
    "headerName": "X-API-Key",      // For single header auth
    "headerNames": ["X-API-KEY", "X-APP-KEY"],  // For multi-header auth (2+ headers)
    "queryParam": "api_key",         // For query auth
    "authScheme": "Bearer"           // For bearer auth (default: "Bearer")
  },

  // For local sources:
  "local": {
    "path": "/path/to/folder"
  },

  // Status (updated by source_test):
  "isAuthenticated": true,
  "connectionStatus": "connected" | "needs_auth" | "failed" | "untested",
  "lastTestedAt": 1704067200000,

  // Icon: emoji or URL (auto-downloaded to local icon.* file)
  // Local icon files are auto-discovered, no config needed
  "icon": "🔧",                      // Emoji icon (optional)

  // Timestamps:
  "createdAt": 1704067200000,
  "updatedAt": 1704067200000
}
```

## Source Types

### MCP Sources

Model Context Protocol servers provide tools via HTTP/SSE.

**OAuth authentication (recommended):**
```json
{
  "id": "linear_a1b2c3d4",
  "type": "mcp",
  "provider": "linear",
  "mcp": {
    "url": "https://mcp.linear.app",
    "authType": "oauth"
  }
}
```

After creating, use `source_oauth_trigger` to authenticate.

**Bearer token authentication:**
```json
{
  "type": "mcp",
  "provider": "custom-mcp",
  "mcp": {
    "url": "https://my-mcp-server.com",
    "authType": "bearer"
  }
}
```

After creating, use `source_credential_prompt` with mode "bearer".

**Public (no auth):**
```json
{
  "type": "mcp",
  "provider": "public-mcp",
  "mcp": {
    "url": "https://public-mcp.example.com",
    "authType": "none"
  }
}
```

**Stdio transport (local command):**

For MCP servers that run locally via command line (npx, node, python), use the stdio transport.

Users often provide MCP configs copied from other tools:
```json
{
  "mcpServers": {
    "airbnb": {
      "command": "npx",
      "args": ["-y", "@openbnb/mcp-server-airbnb"]
    }
  }
}
```

Convert to native format:
```json
{
  "type": "mcp",
  "name": "Airbnb",
  "provider": "airbnb",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@openbnb/mcp-server-airbnb"],
    "authType": "none"
  }
}
```

With environment variables:
```json
{
  "type": "mcp",
  "name": "Brave Search",
  "provider": "brave",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": {
      "BRAVE_API_KEY": "your-api-key"
    },
    "authType": "none"
  }
}
```

### API Sources

REST APIs become flexible tools that the agent can call.

**Request bodies:** By default, `params` is JSON-serialized for POST/PUT/PATCH requests. For endpoints that expect non-JSON bodies (plain text, XML, form data, etc.), use the special `_rawBody` and `_contentType` params:

```json
{
  "params": {
    "_rawBody": "raw string content to send as-is",
    "_contentType": "text/plain"
  }
}
```

- `_rawBody` (string) — sent as the request body without JSON encoding
- `_contentType` (string, optional) — sets the Content-Type header (defaults to `text/plain`)

**IMPORTANT:** Authenticated API sources require a `testEndpoint` to validate credentials during `source_test`. Without it, we cannot verify your credentials work.

**Header authentication (X-API-Key style):**
```json
{
  "type": "api",
  "provider": "exa",
  "api": {
    "baseUrl": "https://api.exa.ai/",
    "authType": "header",
    "headerName": "x-api-key",
    "testEndpoint": {
      "method": "POST",
      "path": "search",
      "body": { "query": "test", "numResults": 1 }
    }
  }
}
```

**Bearer token (Authorization header):**
```json
{
  "type": "api",
  "provider": "example",
  "api": {
    "baseUrl": "https://api.example.com/v1/",
    "authType": "bearer",
    "testEndpoint": {
      "method": "GET",
      "path": "models"
    }
  }
}
```

**Query parameter:**
```json
{
  "type": "api",
  "provider": "weather",
  "api": {
    "baseUrl": "https://api.weather.com/",
    "authType": "query",
    "queryParam": "apikey",
    "testEndpoint": {
      "method": "GET",
      "path": "v1/current"
    }
  }
}
```

**Basic authentication:**
```json
{
  "type": "api",
  "provider": "jira",
  "api": {
    "baseUrl": "https://your-domain.atlassian.net/rest/api/3/",
    "authType": "basic",
    "testEndpoint": {
      "method": "GET",
      "path": "myself"
    }
  }
}
```

**Multi-header authentication:**

Some APIs require multiple authentication headers simultaneously. For example, Datadog requires both `DD-API-KEY` and `DD-APPLICATION-KEY`. Use the `headerNames` array to specify all required headers:

```json
{
  "type": "api",
  "provider": "datadog",
  "api": {
    "baseUrl": "https://api.datadoghq.com/api/",
    "authType": "header",
    "headerNames": ["DD-API-KEY", "DD-APPLICATION-KEY"],
    "testEndpoint": {
      "method": "GET",
      "path": "v1/validate"
    }
  }
}
```

When `headerNames` is specified:
- Each header name gets its own input field during authentication
- All header values are stored together as a JSON object
- Each header is added to every API request

To prompt for multi-header credentials:
```typescript
source_credential_prompt({
  sourceSlug: "datadog",
  mode: "multi-header",
  headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"],
  description: "Enter your Datadog API credentials"
})
```

Common multi-header use cases:
- **Datadog**: `DD-API-KEY` + `DD-APPLICATION-KEY`
- **APIs with identity + signing keys**: Separate API key and secret
- **Services with app + user credentials**: Application key plus user token

**Generic OAuth (authType: 'oauth'):**

For API sources that use OAuth 2.0 but aren't Google, Slack, or Microsoft. Two modes:

**Auto-discovery (recommended):** If the API supports RFC 9728 (OAuth Protected Resource Metadata), just set `authType: "oauth"` — endpoints and client registration are discovered automatically:

```json
{
  "name": "Craft Connect",
  "type": "api",
  "provider": "craft",
  "api": {
    "baseUrl": "https://connect.craft.do/my/api/v1/",
    "authType": "oauth"
  }
}
```

**Explicit config:** For APIs without standard OAuth metadata (GitHub, Linear, etc.), provide endpoints manually:

```json
{
  "name": "GitHub",
  "type": "api",
  "provider": "github",
  "api": {
    "baseUrl": "https://api.github.com/",
    "authType": "oauth",
    "oauth": {
      "authorizationUrl": "https://github.com/login/oauth/authorize",
      "tokenUrl": "https://github.com/login/oauth/access_token",
      "clientId": "Iv1.your_client_id",
      "clientSecret": "your_client_secret",
      "scopes": ["repo", "read:user"]
    }
  }
}
```

The `oauth` block fields (only needed for explicit config):
- `authorizationUrl` (required): The OAuth authorization endpoint
- `tokenUrl` (required): The OAuth token exchange endpoint
- `clientId` (required): Your OAuth app's client ID
- `clientSecret` (optional): Client secret — not required for public PKCE clients
- `scopes` (optional): Requested OAuth scopes
- `audience` (optional): Auth0-style audience parameter
- `extraParams` (optional): Additional query params for the authorization URL (e.g. `{"access_type": "offline"}`)

To trigger OAuth authentication, use `source_oauth_trigger` (the same tool used for MCP OAuth):
```typescript
source_oauth_trigger({ sourceSlug: "github" })
```

Tokens are sent as `Authorization: Bearer {token}` on every request. Token refresh is automatic when a refresh token is available.

**Basic auth with optional password:**

Some APIs use HTTP Basic Auth but only require the username field (API key), leaving the password empty. For these APIs, use `passwordRequired: false` when prompting for credentials:

```typescript
source_credential_prompt({
  sourceSlug: "ashby",
  mode: "basic",
  passwordRequired: false,  // Password field becomes optional
  labels: { username: "API Key" },
  description: "Enter your Ashby API key"
})
```

When `passwordRequired: false`:
- The password field shows "(optional)" label and "Optional - leave blank" placeholder
- The Save button enables with just a username
- Empty string is submitted for password (per HTTP Basic Auth spec: `base64(username:)`)

**Note:** `passwordRequired` only applies to `mode: "basic"`. It defaults to `true` for backward compatibility with services like Jira or Amplitude that require both username and password.

### testEndpoint Configuration

The `testEndpoint` specifies which endpoint to call when validating credentials:

```json
{
  "testEndpoint": {
    "method": "GET",           // "GET" or "POST"
    "path": "v1/me",           // Path relative to baseUrl (NO leading slash)
    "body": { ... }            // Optional: request body for POST
  }
}
```

**IMPORTANT URL formatting:**
- `baseUrl` MUST have a trailing slash: `https://api.example.com/v1/`
- `testEndpoint.path` must NOT have a leading slash: `users/me`

**Choose an endpoint that:**
- Requires authentication (to verify credentials work)
- Is lightweight (doesn't fetch much data)
- Returns quickly (health/status endpoints are ideal)

**Common patterns:**
- `me`, `user`, `profile` - User info endpoints
- `v1/status`, `health` - Status endpoints that require auth
- `models`, `projects` - List endpoints with minimal data

**Public APIs (authType: 'none')** don't require testEndpoint - we test by hitting the base URL.

### renewEndpoint Configuration (Optional)

The optional `renewEndpoint` enables automatic token renewal for non-OAuth bearer-token APIs. When the token expires, the system calls this endpoint to get a fresh token — no manual re-authentication needed.

```json
{
  "api": {
    "baseUrl": "https://api.example.com/",
    "authType": "bearer",
    "renewEndpoint": {
      "path": "auth/refresh",
      "method": "POST",
      "tokenField": "access_token",
      "expiresInField": "expires_in"
    }
  }
}
```

**Fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `path` | Yes | — | Renew URL — relative path (resolved against `baseUrl`) or absolute URL |
| `method` | No | `"POST"` | HTTP method: `"GET"` or `"POST"` |
| `body` | No | — | Request body (JSON). Use `{{token}}` as placeholder for the current access token |
| `headers` | No | — | Extra headers. Use `{{token}}` as placeholder. Merged on top of `defaultHeaders` |
| `tokenField` | No | `"access_token"` | JSON field name for the new token in the response |
| `expiresInField` | No | `"expires_in"` | JSON field name for expiry in seconds in the response |
| `fallbackTtlSecs` | No | — | Fallback TTL in seconds when the response doesn't include expiry info |

**How it works:**
1. Before each API request, the system checks if the token is expired or expiring soon (within 5 minutes)
2. If so, it calls the `renewEndpoint` with the current token in the Authorization header
3. The new token and expiry are extracted from the response and stored
4. The refreshed token is used for the API request

**Token substitution:** Use `{{token}}` in `body` or `headers` to insert the current access token. This supports nested objects — all string values are scanned recursively.

**Example with token in request body:**
```json
{
  "renewEndpoint": {
    "path": "auth/refresh",
    "body": { "current_token": "{{token}}" },
    "tokenField": "new_token",
    "expiresInField": "ttl"
  }
}
```

**When `body` is omitted**, the current token is sent via the standard Authorization header (using the source's `authScheme`).

**Note:** This is for APIs with their own token renewal mechanism, not OAuth. For OAuth-based APIs, use `authType: "oauth"` instead.

### Local Sources

Filesystem access for local folders.

```json
{
  "type": "local",
  "provider": "obsidian",
  "local": {
    "path": "/Users/me/Documents/ObsidianVault"
  }
}
```

**After creating, run `source_test`** to validate the path exists and is accessible.

## guide.md Format

The guide.md file helps the agent understand how to use the source effectively.

```markdown
# Source Name

Brief description of what this source provides.

## Scope

What data/functionality this source provides access to.

## Guidelines

- Best practices for using this source
- Rate limits or quotas to be aware of
- Common patterns and examples

## API Reference

For API sources, document the available endpoints:

### POST /search
Search for content.

**Parameters:**
- `query` (string, required): Search query
- `limit` (number, optional): Max results (default: 10)

**Example:**
\`\`\`json
{
  "query": "machine learning",
  "limit": 5
}
\`\`\`
```

## permissions.json Format

Custom rules to extend Explore mode permissions for this source.

```json
{
  "allowedMcpPatterns": [
    {
      "pattern": "^mcp__linear__list",
      "comment": "Allow listing resources in Explore mode"
    }
  ],
  "allowedApiEndpoints": [
    {
      "method": "GET",
      "path": "^/search",
      "comment": "Allow search endpoint in Explore mode"
    },
    {
      "method": "POST",
      "path": "^/v1/query$",
      "comment": "POST allowed for query-only endpoints"
    }
  ],
  "allowedBashPatterns": [
    {
      "pattern": "^ls\\s",
      "comment": "Allow ls commands"
    }
  ]
}
```

## Icon Handling

The `config.icon` field controls the source icon. Resolution follows this priority:

| `config.icon` value | Behavior |
|---------------------|----------|
| Emoji (e.g., `"🔧"`) | Rendered as emoji text |
| Local path `"./icon.svg"` | Loads from `sources/{slug}/icon.svg` |
| URL `"https://..."` | Auto-downloaded to local `icon.*` file by `source_test` |
| Undefined/null | Auto-discovers `sources/{slug}/icon.{svg,png}`, falls back to favicon |

**Examples:**

```json
// Emoji icon
{ "icon": "📝" }

// Explicit local path (rarely needed - auto-discovery handles this)
{ "icon": "./icon.svg" }

// URL (downloaded automatically by source_test)
{ "icon": "https://linear.app/static/favicon.svg" }

// No icon field - auto-discovers icon.svg/icon.png or resolves favicon
{}
```

**Best practice:** Set `icon` to a URL when creating a source. Run `source_test` to download and cache it locally. The app then uses the local file for fast, offline-capable display.

## Provider Domain Cache

For favicon resolution, a cache maps provider names to their canonical domains at:
`~/.craft-agent/provider-domains.json`

**Format:**
```json
{
  "version": 1,
  "domains": {
    "linear": "linear.app",
    "notion": "notion.so",
    "brave": "brave.com"
  },
  "updatedAt": 1704067200000
}
```

**When to update:** If a source's favicon appears incorrect (generic globe, wrong icon), add the provider→domain mapping to this file. The app loads this cache on startup.

**Example:** If "acme-mcp" source shows wrong icon, add:
```json
"acme": "acme.com"
```

## Common Providers

### Gmail (and other Google services)
Provider: `google`, Type: `api`
Requires user-provided OAuth credentials in the source config:
- `googleOAuthClientId`: Your Google OAuth Client ID
- `googleOAuthClientSecret`: Your Google OAuth Client Secret

Create credentials at [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (Desktop app type).
Uses OAuth via `source_google_oauth_trigger`.

### Linear
Provider: `linear`, Type: `mcp`
URL: `https://mcp.linear.app`, OAuth auth.

### GitHub
Provider: `github`, Type: `mcp`
URL: `https://api.github.com/mcp/`, **bearer auth** (PAT required - OAuth will fail).

### Exa (Search)
Provider: `exa`, Type: `api`
Base URL: `https://api.exa.ai`, header auth with `x-api-key`.

### Brave Search
Provider: `brave`, Type: `mcp`
Transport: `stdio`, Command: `npx -y @modelcontextprotocol/server-brave-search`, requires `BRAVE_API_KEY` env.

### Memory
Provider: `memory`, Type: `mcp`
Transport: `stdio`, Command: `npx -y @modelcontextprotocol/server-memory`, no auth.

## Workflow

### Creating a Source

**Always follow the conversational setup process** (see above). The key steps:

1. **Ask before creating**: Understand user intent, scope, and common tasks
2. **Choose the right path**: Confirm if this should be a source or a browser-first one-off workflow
3. **Research before configuring**: Use WebSearch/WebFetch and browser tools as needed
4. **Tailor guide.md to context**: Include specific projects/teams the user mentioned
5. **Test before declaring done**: Validate config, trigger auth, verify connection

Technical steps:

1. Create the source folder:
   ```bash
   mkdir -p ~/.craft-agent/workspaces/{ws}/sources/my-source
   ```

2. Write `config.json` with appropriate settings (see schemas above)

3. Write `guide.md` tailored to user's context and use case

4. **Create `permissions.json` for Explore mode** - List the source's tools, identify read-only operations (list, get, search), and add simple patterns. Patterns are auto-scoped to this source.

5. Run `source_test` to validate configuration and test connection

6. If auth is required, trigger the appropriate flow:
   - `source_oauth_trigger` for MCP OAuth
   - `source_google_oauth_trigger` for Google services (Gmail, Calendar, Drive, Docs, Sheets, YouTube, Search Console)
   - `source_microsoft_oauth_trigger` for Microsoft services
   - `source_slack_oauth_trigger` for Slack
   - `source_credential_prompt` for API keys/tokens
   - For basic auth with optional password: `source_credential_prompt({ mode: "basic", passwordRequired: false })`

7. Confirm with user that the source is working as expected

### Testing a Source

Use `source_test` with the source slug:
- Validates config.json schema
- Tests connectivity
- Downloads icon if needed
- Updates connectionStatus

### Troubleshooting

**"needs_auth" status:**
- Source requires authentication
- Use appropriate auth trigger tool

**"failed" status:**
- Check `connectionError` in config.json
- Verify URL is correct
- Check network connectivity

**Icon not showing:**
- Ensure iconUrl is valid
- Run `source_test` to re-download
- Check file exists in source folder
