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

### `.qwenignore` File

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
