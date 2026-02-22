# LSP Configuration Guide

Qwen Code supports Language Server Protocol (LSP) for enhanced code intelligence features like go-to-definition, find-references, hover information, and more.

## Configuration-Driven LSP

**Important**: LSP servers must be explicitly configured. Qwen Code will not automatically start LSP servers based on detected languages.

## Quick Start

1. Copy the example configuration:
   ```bash
   cp .lsp.json.example .lsp.json
   ```

2. Install the LSP servers you need (see [Installation Guides](#installation-guides) below)

3. Edit `.lsp.json` to enable only the languages you need

4. Restart Qwen Code

## Configuration Format

The `.lsp.json` file uses the following structure:

```json
{
  "language-id": {
    "command": "lsp-server-command",
    "args": ["--stdio"],
    "transport": "stdio",
    "env": {
      "KEY": "value"
    },
    "initializationOptions": {},
    "settings": {},
    "extensionToLanguage": {
      "ext": "language"
    },
    "startupTimeout": 10000,
    "shutdownTimeout": 5000,
    "restartOnCrash": true,
    "maxRestarts": 3,
    "trustRequired": true
  }
}
```

### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `command` | string | Executable command to start the LSP server |
| `args` | string[] | Command line arguments |
| `transport` | "stdio" \| "tcp" \| "socket" | Communication method (default: "stdio") |
| `env` | object | Environment variables for the server |
| `initializationOptions` | object | Options sent during LSP initialize request |
| `settings` | object | Server-specific settings |
| `extensionToLanguage` | object | Custom file extension mappings |
| `startupTimeout` | number | Timeout for server startup (ms) |
| `shutdownTimeout` | number | Timeout for server shutdown (ms) |
| `restartOnCrash` | boolean | Whether to restart on crash |
| `maxRestarts` | number | Maximum restart attempts |
| `trustRequired` | boolean | Whether trusted workspace is required |

## Installation Guides

### TypeScript / JavaScript

**Server**: `typescript-language-server`

```bash
# Install globally
npm install -g typescript-language-server typescript

# Or use local installation
npm install --save-dev typescript-language-server typescript
```

**Configuration**:
```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"]
  }
}
```

---

### Python

**Server**: `pylsp` (python-lsp-server)

```bash
# Using pip
pip install python-lsp-server

# Or with conda
conda install -c conda-forge python-lsp-server

# For additional features
pip install python-lsp-server[all]
```

**Configuration**:
```json
{
  "python": {
    "command": "pylsp",
    "args": []
  }
}
```

---

### Go

**Server**: `gopls`

```bash
# Install (Go 1.18+)
go install golang.org/x/tools/gopls@latest

# Ensure $GOPATH/bin or $GOBIN is in your PATH
export PATH=$PATH:$(go env GOPATH)/bin
```

**Configuration**:
```json
{
  "go": {
    "command": "gopls",
    "args": []
  }
}
```

---

### Java

**Server**: `jdtls` (Eclipse JDT Language Server)

**Prerequisites**:
- Java 21+ (JRE or JDK)

**Installation**:

```bash
# macOS (Homebrew)
brew install jdtls

# Linux - Download manually
wget http://download.eclipse.org/jdtls/milestones/latest/jdtls-latest.tar.gz
tar -xzf jdtls-latest.tar.gz -C ~/.local/share/
ln -s ~/.local/share/jdtls/bin/jdtls ~/.local/bin/jdtls

# Verify installation
jdtls --version
```

**Important**: The `jdtls` command is a wrapper script that requires Python 3.

**Configuration**:
```json
{
  "java": {
    "command": "jdtls",
    "args": [
      "-configuration", "~/.cache/jdtls",
      "-data", ".jdtls-workspace"
    ],
    "initializationOptions": {
      "settings": {
        "java": {
          "format": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

**Arguments explained**:
- `-configuration`: Directory for server configuration (will be created)
- `-data`: Workspace data directory (project-specific)

---

### C / C++

**Server**: `clangd`

**Prerequisites**:
- A compilation database (`compile_commands.json`) or `compile_flags.txt`

**Installation**:

```bash
# macOS (Homebrew)
brew install llvm
# clangd will be at /opt/homebrew/opt/llvm/bin/clangd or /usr/local/opt/llvm/bin/clangd

# Ubuntu/Debian
sudo apt-get install clangd

# Arch Linux
sudo pacman -S clang

# Or download from LLVM releases
```

**Generate compilation database**:

```bash
# For CMake projects
cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON .

# For other projects using Bear
bear -- make

# Or create compile_flags.txt manually
echo "-std=c++20
-I./include
-I/usr/local/include" > compile_flags.txt
```

**Configuration**:
```json
{
  "cpp": {
    "command": "clangd",
    "args": [
      "--background-index",
      "--clang-tidy",
      "--header-insertion=iwyu",
      "--completion-style=detailed"
    ],
    "initializationOptions": {
      "clangdFileStatus": true,
      "usePlaceholders": true,
      "completeUnimported": true
    }
  }
}
```

**Arguments explained**:
- `--background-index`: Index project in background for better performance
- `--clang-tidy`: Enable clang-tidy diagnostics
- `--header-insertion=iwyu`: Auto-insert headers (Include What You Use style)
- `--completion-style=detailed`: Show detailed completion signatures

---

### Rust

**Server**: `rust-analyzer`

```bash
# Using rustup
rustup component add rust-analyzer

# Or download pre-built binary
# https://github.com/rust-lang/rust-analyzer/releases
```

**Configuration**:
```json
{
  "rust": {
    "command": "rust-analyzer",
    "args": []
  }
}
```

## Troubleshooting

### Check if LSP command is available

```bash
# Check if command exists
which typescript-language-server
which jdtls
which clangd

# Check version
typescript-language-server --version
jdtls --version
clangd --version
```

### LSP not starting

1. **Check configuration**: Verify your `.lsp.json` syntax is valid
   ```bash
   cat .lsp.json | python -m json.tool
   ```

2. **Check trust**: Ensure your workspace is trusted in Qwen Code

3. **Check logs**: Look for error messages in Qwen Code output

4. **Test manually**: Try running the LSP command directly
   ```bash
   typescript-language-server --stdio
   ```

### Java-specific issues

**"jdtls: command not found"**
- Ensure `jdtls` is in your PATH
- If using manual installation, create a symlink: `ln -s ~/.local/share/jdtls/bin/jdtls ~/.local/bin/`

**"Java version not supported"**
- JDTLS requires Java 21+
- Check: `java -version`
- Set JAVA_HOME if needed: `export JAVA_HOME=/path/to/java21`

### C++ specific issues

**"compile_commands.json not found"**
- clangd needs compile database for accurate results
- For CMake: add `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`
- For other build systems: use `bear` or create `compile_flags.txt`

**Headers not found**
- Create a `.clangd` file in project root:
  ```yaml
  CompileFlags:
    Add: [-I/path/to/include, -I/another/include]
  ```

## Extension Support

Extensions can also provide LSP configurations via their `manifest.json`:

```json
{
  "lspServers": {
    "my-language": {
      "command": "my-lsp-server",
      "args": ["--stdio"]
    }
  }
}
```

## Migration from Auto-Detection

Previous versions of Qwen Code automatically detected languages and started LSP servers. This behavior has been changed to give users full control over which LSP servers are started.

To migrate:
1. Create a `.lsp.json` file based on the example
2. Install the LSP servers you need
3. Configure only the languages you work with

## References

- [LSP Specification](https://microsoft.github.io/language-server-protocol/)
- [Eclipse JDT Language Server](https://github.com/eclipse-jdtls/eclipse.jdt.ls)
- [clangd Documentation](https://clangd.llvm.org/)
