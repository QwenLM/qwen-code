# Sandbox

This document explains tool execution confinement on Linux and the existing whole-CLI sandbox methods.

## Linux tool execution sandbox

On Linux, install `bwrap` (Bubblewrap) and enable the tool execution boundary in your **User** settings (`~/.qwen/settings.json`, or the directory selected by `QWEN_HOME`) or administrator **System** settings:

```json
{
  "tools": {
    "executionSandbox": {
      "backend": "auto",
      "filesystem": "workspace-write",
      "network": "closed"
    }
  }
}
```

`filesystem` and `network` are required. `backend` defaults to `auto`; both `auto` and `bwrap` currently select bwrap. Landlock is not available in this release. Use `read-only` to deny workspace writes, or `workspace-write` to permit writes inside the current canonical workspace. Each command also gets private scratch space. Ordinary `includeDirectories` settings do not grant write access. Keep the workspace separate from the Qwen installation, user configuration and runtime state directories.

The CLI, model transport, authentication and session storage remain on the host. Shell, terminal `!`, prompt shell interpolation, Monitor, Read/Write/Edit and supported nested in-process Agent/Code Mode calls use the same runtime policy. `network: closed` blocks ordinary host/external IP connections from commands, while `open` shares the host network. Reads remain broad: this mode does not hide host secrets or promise to isolate pathname Unix sockets and host services. Approval and YOLO do not expand the filesystem or network policy.

Workspace settings cannot enable, disable or modify this policy, even in a trusted project. Effective precedence is System over User over SystemDefaults, selecting a complete policy object. Values must be literals; environment substitutions, unknown fields and incomplete objects are rejected. `--bare` and `--safe-mode` retain operator confinement. Changes require a new runtime. A malformed operator settings file fails startup instead of resetting an unknown sandbox policy to empty settings.

This initial public mode supports the ordinary headless CLI and both terminal UIs. ACP, `qwen serve` and web terminals explicitly reject it. MCP/LSP, executable hooks/extensions, worktree/arena management, external agents, speculative execution, file checkpoints, automatic skill/memory maintenance, and unported process or mutation tools are disabled or rejected. Ordinary same-workspace in-process agents cannot add hooks, MCP servers, external executors or worktree isolation. Custom status commands, external Markdown/image renderers, IDE detection and connection, file restore, and host Git diff previews are disabled. Conversation-only rewind remains available.

Explicit operator diagnostics such as `/doctor`, opening or editing files and folders through `/memory`, and changing settings through `/skills` remain trusted host actions. These management commands are not exposed as model-invocable commands. Picking a skill fills the input field; submitting `/skill-name` currently reports an unsupported-mode error before preparing arguments or updating usage records. Skill command execution and the model Skill tool remain unavailable until their preparation writes are confined. Automatic memory and skill maintenance remain disabled in this runtime even if you change their saved settings.

Inspect and verify the active boundary before running a task:

```bash
qwen sandbox
qwen sandbox --verify
qwen sandbox -- sh -c 'printf "confined command\n"'
qwen -y -p "Update the project and run its tests"
```

The report names the tool boundary, requested/effective backend, workspace, filesystem and command network policy. `--verify` checks workspace writes, denial against a file known to be writable on the host, private PID namespace identity and the selected network namespace. Backend setup errors fail before payload execution and never rerun the command on the host. The one-command subcommand forwards literal arguments and streams textual output; use terminal `!` for interactive PTY commands.

### Migrating from whole-CLI bwrap

Replace `--sandbox bwrap` and remove `tools.sandbox: "bwrap"`, `QWEN_SANDBOX=bwrap`, `QWEN_SANDBOX_NET` and `QWEN_SANDBOX_PROXY_COMMAND` (including its `PROXY_COMMAND` alias), then configure `tools.executionSandbox` as above. Restart from a shell outside the old sandbox; inherited `SANDBOX=bwrap` is rejected. `proxied` is not a supported network policy. Do not combine this mode with Docker, Podman, Seatbelt or an inherited whole-CLI sandbox marker. Old bwrap settings produce an explicit migration error.

The Docker, Podman and macOS Seatbelt methods below still run the whole CLI in their existing environment.

## Prerequisites

Before using sandboxing, you need to install and set up Qwen Code:

```bash
npm install -g @qwen-code/qwen-code
```

To verify the installation

```bash
qwen --version
```

## Overview of sandboxing

Sandboxing isolates potentially dangerous operations (such as shell commands or file modifications) from your host system, providing a security barrier between the CLI and your environment.

The benefits of sandboxing include:

- **Security**: Prevent accidental system damage or data loss.
- **Isolation**: Limit file system access to project directory.
- **Consistency**: Ensure reproducible environments across different systems.
- **Safety**: Reduce risk when working with untrusted code or experimental commands.

> [!note]
>
> **Naming note:** Some sandbox-related environment variables may have used the `GEMINI_*` prefix historically. All new environment variables use the `QWEN_*` prefix.

## Sandboxing methods

Your ideal method of sandboxing may differ depending on your platform and your preferred container solution.

### 1. macOS Seatbelt (macOS only)

Lightweight, built-in sandboxing using `sandbox-exec`.

**Default profile**: `permissive-open` - restricts writes outside the project directory, but allows most other operations and outbound network access.

**Best for**: Fast, no Docker required, strong guardrails for file writes.

### 2. Container-based (Docker/Podman)

Cross-platform sandboxing with complete process isolation.

By default, Qwen Code uses a published sandbox image (configured in the CLI package) and will pull it as needed.

The container sandbox mounts your workspace and your `~/.qwen` directory into the container so auth and settings persist between runs.

**Best for**: Strong isolation on any OS, consistent tooling inside a known image.

### Choosing a method

- **On macOS**:
  - Use Seatbelt when you want lightweight sandboxing (recommended for most users).
  - Use Docker/Podman when you need a full Linux userland (e.g., tools that require Linux binaries).
- **On Linux/Windows**:
  - Use Docker or Podman.

## Quickstart

```bash
# Enable sandboxing with command flag
qwen -s -p "analyze the code structure"

# Or enable sandboxing for your shell session (recommended for CI / scripts)
export QWEN_SANDBOX=true   # true auto-picks a provider (see notes below)
qwen -p "run the test suite"

# Configure in settings.json
{
  "tools": {
    "sandbox": true
  }
}
```

> [!tip]
>
> **Provider selection notes:**
>
> - On **macOS**, `QWEN_SANDBOX=true` typically selects `sandbox-exec` (Seatbelt) if available.
> - On **Linux/Windows**, `QWEN_SANDBOX=true` requires `docker` or `podman` to be installed.
> - To force a provider, set `QWEN_SANDBOX=docker|podman|sandbox-exec`.

## Configuration

### Enable sandboxing (in order of precedence)

1. **Environment variable**: `QWEN_SANDBOX=true|false|docker|podman|sandbox-exec`
2. **Command flag / argument**: `-s`, `--sandbox`, or `--sandbox=<provider>`
3. **Settings file**: `tools.sandbox` in your `settings.json` (e.g., `{"tools": {"sandbox": true}}`).

> [!important]
>
> If `QWEN_SANDBOX` is set, it **overrides** the CLI flag and `settings.json`.

### Configure the sandbox image (Docker/Podman)

- **CLI flag**: `--sandbox-image <image>`
- **Environment variable**: `QWEN_SANDBOX_IMAGE=<image>`
- **Settings file**: `tools.sandboxImage` in your `settings.json` (e.g., `{"tools": {"sandboxImage": "ghcr.io/qwenlm/qwen-code:0.14.1"}}`)

Priority order (highest to lowest):

1. `--sandbox-image`
2. `QWEN_SANDBOX_IMAGE`
3. `tools.sandboxImage`
4. Built-in default image from the CLI package (for example `ghcr.io/qwenlm/qwen-code:<version>`)

`settings.env.QWEN_SANDBOX_IMAGE` also works as a generic env injection mechanism, but `tools.sandboxImage` is the preferred persistent setting.

Custom images are user-managed. Rebuild them with an up-to-date Qwen Code installation to receive the safe update handoff; older images may still use their original in-process updater.

### macOS Seatbelt profiles

Built-in profiles (set via `SEATBELT_PROFILE` env var):

- `permissive-open` (default): Write restrictions, network allowed
- `permissive-closed`: Write restrictions, no network
- `permissive-proxied`: Write restrictions, network via proxy
- `restrictive-open`: Strict restrictions, network allowed
- `restrictive-closed`: Maximum restrictions
- `restrictive-proxied`: Strict restrictions, network via proxy

> [!tip]
>
> Start with `permissive-open`, then tighten to `restrictive-closed` if your workflow still works.

### Custom Seatbelt profiles (macOS)

To use a custom Seatbelt profile:

1. Create a file named `.qwen/sandbox-macos-<profile_name>.sb` in your project.
2. Set `SEATBELT_PROFILE=<profile_name>`.

### Custom Sandbox Flags

For container-based sandboxing, you can inject custom flags into the `docker` or `podman` command using the `SANDBOX_FLAGS` environment variable. This is useful for advanced configurations, such as disabling security features for specific use cases.

**Example (Podman)**:

To disable SELinux labeling for volume mounts, you can set the following:

```bash
export SANDBOX_FLAGS="--security-opt label=disable"
```

Multiple flags can be provided as a space-separated string:

```bash
export SANDBOX_FLAGS="--flag1 --flag2=value"
```

### Network proxying (all sandbox methods)

If you want to restrict outbound network access to an allowlist, you can run a local proxy alongside the sandbox:

- Set `QWEN_SANDBOX_PROXY_COMMAND=<command>`
- The command must start a proxy server that listens on `:::8877`

This is especially useful with `*-proxied` Seatbelt profiles.

For a working allowlist-style proxy example, see: [Example Proxy Script](../../developers/examples/proxy-script.md).

## Linux UID/GID handling

On Linux, Qwen Code defaults to enabling UID/GID mapping so the sandbox runs as your user (and reuses the mounted `~/.qwen`). Override with:

```bash
export SANDBOX_SET_UID_GID=true   # Force host UID/GID
export SANDBOX_SET_UID_GID=false  # Disable UID/GID mapping
```

## Troubleshooting

### Common issues

**"Operation not permitted"**

- Operation requires access outside sandbox.
- On macOS Seatbelt: try a more permissive `SEATBELT_PROFILE`.
- On Docker/Podman: verify the workspace is mounted and your command doesn’t require access outside the project directory.

**Missing commands**

- Container sandbox: add them via `.qwen/sandbox.Dockerfile` or `.qwen/sandbox.bashrc`.
- Seatbelt: your host binaries are used, but the sandbox may restrict access to some paths.

**Java not available in Docker sandbox**

The official Qwen Code Docker image is intentionally minimal to keep the image small, secure, and fast to pull. Different users require different language runtimes (Java, Python, Node.js, etc.), and bundling all environments into a single image is not practical. Therefore, Java is **not included by default** in the Docker sandbox.

If your workflow requires Java, you can extend the base image by creating a `.qwen/sandbox.Dockerfile` in your project:

```dockerfile
FROM ghcr.io/qwenlm/qwen-code:latest

RUN apt-get update && \
    apt-get install -y openjdk-17-jre && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
```

Then rebuild the sandbox image:

```bash
QWEN_SANDBOX=docker BUILD_SANDBOX=1 qwen -s
```

For more details on customizing the sandbox, see [Customizing the sandbox environment](../../developers/tools/sandbox.md).

**Network issues**

- Check sandbox profile allows network.
- Verify proxy configuration.

### Debug mode

```bash
DEBUG=1 qwen -s -p "debug command"
```

**Note:** If you have `DEBUG=true` in a project's `.env` file, it won't affect the CLI due to automatic exclusion. Use `.qwen/.env` files for Qwen Code-specific debug settings.

### Inspect sandbox

```bash
# Check environment
qwen -s -p "run shell command: env | grep SANDBOX"

# List mounts
qwen -s -p "run shell command: mount | grep workspace"
```

## Security notes

- Sandboxing reduces but doesn't eliminate all risks.
- Use the most restrictive profile that allows your work.
- Container overhead is minimal after the first pull/build.
- GUI applications may not work in sandboxes.

## Related documentation

- [Configuration](../configuration/settings): Full configuration options.
- [Commands](../features/commands): Available commands.
- [Troubleshooting](../support/troubleshooting): General troubleshooting.
