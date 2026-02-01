# Development Guide for Qwen Code Chrome Integration

This document outlines the development process for the **mcp-chrome-integration** package.

> Note: the legacy `chrome-extension` package has been archived at `archive/chrome-extension`.

## Directory Structure

```
packages/mcp-chrome-integration/
├── app/
│   ├── chrome-extension/           # React 19 Chrome extension (MV3)
│   │   ├── public/                 # Manifest + static assets
│   │   ├── src/
│   │   │   ├── background/         # Service worker + native messaging bridge
│   │   │   ├── content/            # Content script
│   │   │   └── sidepanel/          # Side panel React UI
│   │   ├── config/                 # esbuild + tailwind config
│   │   ├── scripts/                # Build/dev scripts
│   │   └── dist/extension/         # Build output (load this in Chrome)
│   └── native-server/              # MCP native server (Node.js)
│       ├── src/
│       ├── dist/
│       └── scripts/
├── docs/                           # Documentation
├── scripts/                        # Repo-level helpers
└── package.json
```

## Development Setup

1. Install dependencies (repo root):
   ```bash
   npm install
   ```

2. Start development:
   ```bash
   npm run dev --workspace=@qwen-code/mcp-chrome-integration
   ```

This builds the extension and starts the native server in dev mode.

## Building

```bash
npm run build --workspace=@qwen-code/mcp-chrome-integration
```

Extension output: `packages/mcp-chrome-integration/app/chrome-extension/dist/extension`.

## Testing

The native server has unit tests under `app/native-server/src/__tests__`.
Run typechecks/tests via:

```bash
npm run typecheck --workspace=@qwen-code/mcp-chrome-integration
```
