# Development Guide for Qwen CLI Chrome Extension

This document outlines the development process for the Qwen CLI Chrome Extension.

## Directory Structure

```
packages/chrome-extension/
├── src/                           # Source code
│   ├── background/                # Background script source
│   ├── content/                   # Content script source
│   ├── sidepanel/                 # Side panel React components
│   ├── common/                    # Shared utilities
│   └── types/                     # TypeScript definitions
├── extension/                     # Build output (production-ready extension)
│   ├── background/
│   ├── content/
│   ├── popup/
│   ├── sidepanel/
│   ├── icons/
│   └── manifest.json
├── native-host/                   # Native messaging host
│   ├── src/                       # Source files
│   ├── dist/                      # Built files
│   ├── scripts/                   # Installation scripts
│   └── config/                    # Configuration templates
├── docs/                          # Documentation
├── scripts/                       # Build and development scripts
├── test/                          # Test files
├── config/                        # Configuration files
├── README.md
├── DEVELOPMENT.md                 # This file
├── DEBUGGING.md
├── INSTALL.md
├── QUICK_START.md
└── package.json
```

## Development Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start development server:
   ```bash
   npm run dev
   ```

## Building

To build the extension:
```bash
npm run build
```

This will compile the source files and output the production-ready extension to the `extension/` directory.

## Testing

Unit tests are located in the `test/unit/` directory.
Integration tests are located in the `test/integration/` directory.
End-to-end tests are located in the `test/e2e/` directory.

Run all tests:
```bash
npm run test
```
