# Qwen Code Context Settings Reference

## `context` — Context Management

Controls the context information provided to the model.

```jsonc
// ~/.qwen/settings.json
{
  "context": {
    "fileName": "QWEN.md", // context file name
    // accepts a string or array of strings
    // e.g. ["QWEN.md", "CONTEXT.md"]
    "importFormat": "tree", // memory import format: "tree" | "flat"
    "includeDirectories": [
      // additional directories to include (concat merge)
      "/path/to/shared/libs",
      "../common-utils",
    ],
    "loadFromIncludeDirectories": false, // whether to load memory files from include directories
    "fileFiltering": {
      // file filtering settings
      "respectGitIgnore": true, // respect .gitignore files (default: true)
      "respectQwenIgnore": true, // respect .qwenignore files (default: true)
      "enableRecursiveFileSearch": true, // enable recursive file search (default: true)
      "enableFuzzySearch": true, // enable fuzzy search for files (default: true)
    },
  },
}
```

### Common Scenarios

#### Multiple Context Files

```jsonc
{
  "context": {
    "fileName": ["QWEN.md", "CONTEXT.md", "PROJECT.md"],
  },
}
```

#### Include Shared Directories

```jsonc
{
  "context": {
    "includeDirectories": ["../shared/libs", "/path/to/common-utils"],
    "loadFromIncludeDirectories": true,
  },
}
```

#### Disable Fuzzy Search

```jsonc
{
  "context": {
    "fileFiltering": {
      "enableFuzzySearch": false,
    },
  },
}
```

#### Ignore Git and Qwen Ignore Files

```jsonc
{
  "context": {
    "fileFiltering": {
      "respectGitIgnore": false,
      "respectQwenIgnore": false,
    },
  },
}
```

---

## `.qwenignore` File

Similar to `.gitignore`, used to exclude files/directories from the agent's context:

```gitignore
# .qwenignore
node_modules/
dist/
*.log
.env
secrets/
```

Place it in the project root or any subdirectory. Syntax is identical to `.gitignore`.

### Common `.qwenignore` Patterns

```gitignore
# Dependencies
node_modules/
vendor/
.pnp.*

# Build outputs
dist/
build/
*.min.js
*.min.css

# Logs and caches
*.log
.npm/
.yarn/
.cache/

# Environment and secrets
.env
.env.local
secrets/
*.pem
*.key

# IDE and editor files
.vscode/
.idea/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db
```
