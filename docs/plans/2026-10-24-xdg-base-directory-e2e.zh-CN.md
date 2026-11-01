# XDG Base Directory 全局目录 E2E 计划

[English](2026-10-24-xdg-base-directory-e2e.md) | [简体中文](2026-10-24-xdg-base-directory-e2e.zh-CN.md)

本计划用于验证[设计说明](../design/2026-10-24-xdg-base-directory.zh-CN.md)（[English](../design/2026-10-24-xdg-base-directory.md)）。

每个测试组都从一个全新的一次性主目录开始，这样既不会读写操作者的真实配置，也不会让一个测试组看到另一个测试组的文件。有两个测试组有意沿用“全新安装”测试组的主目录，因为它们需要该次运行写入的标记：重新创建 `~/.qwen` 的测试组和 `~/.qwen/.env` 测试组。

```bash
export HOME=$(mktemp -d)
unset QWEN_HOME XDG_CONFIG_HOME QWEN_USAGE_STATISTICS_ENABLED QWEN_CODE_SIMPLE
```

在 Windows 上，Node 从 `USERPROFILE` 而不是 `HOME` 读取主目录，因此还需设置 `export USERPROFILE="$HOME"`（使用 cmd 或 PowerShell 时还需设置 `HOMEDRIVE`/`HOMEPATH`），或者使用一个一次性的用户账户。否则运行会读写真实的用户目录。

不带凭据运行 `qwen -p "say hi"` 即可。该运行会完成首次运行的初始化，然后停在 "No auth type is selected"，因此不会调用任何模型。

## 测试组

### Linux 上的全新安装

在空主目录中运行 `qwen -p "say hi"`。预期 `~/.config/qwen` 中有 `.qwen-global-dir`、`installation_id` 和 `output-language.md`，且没有 `~/.qwen`。

### 关闭使用统计的 bare 模式全新安装

在空主目录中运行 `QWEN_USAGE_STATISTICS_ENABLED=false qwen --bare -p "say hi"`。预期即使 `installation_id` 和 `output-language.md` 都没有写入，也会有 `~/.config/qwen/.qwen-global-dir`。然后执行 `mkdir ~/.qwen` 并运行 `qwen -p "say hi"`：预期仍使用 `~/.config/qwen`。

### Linux 上的已有安装

先创建 `~/.qwen`，再运行同一命令。预期首次运行的文件写在 `~/.qwen` 下，且没有 `~/.config/qwen/.qwen-global-dir`。

### 无关的 ~/.config/qwen

创建 `~/.qwen` 和内容为 `{}` 的 `~/.config/qwen/settings.json`，然后运行该命令。预期仍使用 `~/.qwen`，且 `~/.config/qwen` 保持不变。

### XDG 安装之后重新创建的 ~/.qwen

在“全新安装”测试组的主目录中执行 `mkdir ~/.qwen`，然后再次运行该命令。预期仍使用 `~/.config/qwen`。

### 遗留在重新创建的 ~/.qwen 中的登录信息

在一个全新的主目录中先运行一次该命令，然后执行 `mkdir ~/.qwen`，并向 `~/.qwen/settings.json` 和 `~/.qwen/oauth_creds.json` 写入 `{}`，模拟旧版本在那里登录。再次运行该命令。预期仍使用 `~/.config/qwen`，出现一条列出这两个文件、`/auth` 和 `~/.config/qwen/.qwen-global-dir` 的警告，`~/.qwen` 中的两个文件保持不变，`~/.config/qwen` 中也没有它们的副本。再向 `~/.config/qwen/settings.json` 写入 `{}` 并再次运行：预期警告只列出 `oauth_creds.json`。

### 全新安装上的其他入口

各自使用一个全新的主目录：运行 `qwen mcp list`；启动 `qwen serve --port 0`，在它打印监听信息后停止。预期每次之后都有 `~/.config/qwen/.qwen-global-dir`。`qwen --version` 和 `qwen --help` 仍不会在 `HOME` 下创建任何内容。

### XDG 安装上遗留的 ~/.qwen/.env

在“全新安装”测试组的主目录中执行 `mkdir ~/.qwen`，然后运行 `printf 'QWEN_HOME=%s/legacy\nDEMO_VAR=1\n' "$HOME" > ~/.qwen/.env`，让文件中保存绝对路径（`.env` 中的值不会做 shell 展开），再运行该命令。预期仍使用 `~/.config/qwen`，没有 `$HOME/legacy`，并出现一条提到 `~/.qwen/.env` 和 `QWEN_HOME` 的警告。

### 自定义 XDG_CONFIG_HOME 与重新创建的 ~/.qwen

在一个全新的主目录中，以 `XDG_CONFIG_HOME=$HOME/xdg` 运行该命令。预期有 `$HOME/xdg/qwen/.qwen-global-dir`。然后执行 `mkdir ~/.qwen`，并以相同的 `XDG_CONFIG_HOME` 再次运行：预期仍使用 `$HOME/xdg/qwen`。

### 迁移已有安装

创建带有 `settings.json` 的 `~/.qwen`，然后运行设计说明中的迁移命令。预期有 `~/.config/qwen/settings.json` 和 `~/.config/qwen/.qwen-global-dir`，且没有 `~/.qwen`。在 `XDG_CONFIG_HOME=relative`、设置了 `QWEN_HOME`、在 macOS 上，或第二次运行时，它必须打印原因并保持一切不变。

### 把 QWEN_HOME 指向 XDG 目录

创建 `~/.qwen`，运行 `QWEN_HOME=$HOME/.config/qwen qwen -p "say hi"`，然后不带它运行 `qwen -p "say hi"`。预期第二次运行使用 `~/.qwen`，且没有 `~/.config/qwen/.qwen-global-dir`。

### 覆盖设置

各自使用一个全新的主目录，且没有 `~/.qwen`：

- `XDG_CONFIG_HOME=$HOME/xdg`：文件出现在 `$HOME/xdg/qwen` 下。
- `XDG_CONFIG_HOME=relative`：该值被忽略，使用 `~/.config/qwen`。
- 把 `XDG_CONFIG_HOME=$HOME/xdg` 写入 `~/.env` 而不是环境变量：该值被忽略，使用 `~/.config/qwen`。
- `QWEN_HOME=$HOME/custom`：无论其他目录是否存在，文件都出现在 `$HOME/custom` 下。

### macOS 和 Windows

运行“全新安装”这一步。预期使用 `~/.qwen`，即使 `~/.config/qwen` 存在。

## 基线 dry-run

验证所用的机器上没有安装全局 `qwen`，因此在 macOS 上使用了仓库的启动器（`node scripts/cli-entry.js`，0.26.0）。它在 `env -i` 下运行，使用一次性的 `HOME` 和 `TMPDIR`，环境中没有任何凭据：

- `--version` 打印 `0.26.0`，未在 `HOME` 下创建任何内容。
- `-p "say hi"` 停在 "No auth type is selected"。它创建了 `~/.qwen`，其中有 `installation_id`、`output-language.md`、`extension-store/`、`extensions/` 和 `skills/`。
- 加上 `QWEN_USAGE_STATISTICS_ENABLED=false` 的同一运行创建了除 `installation_id` 之外的全部内容。

因此这两个文件都不能作为标记：每个都会被其中一个开关跳过，而同时打开两个开关的首次运行两者都不会写入。CLI 改为写入 `.qwen-global-dir`。

## 本地验证

所有运行都使用一次性的 `HOME`，且未设置 `QWEN_HOME` 和 `XDG_CONFIG_HOME`。

- `cd packages/core && npx vitest run src/config/storage.test.ts src/permissions/autoMode.test.ts src/skills/bundled/stuck/SKILL.test.ts`，以及其他读取全局目录的测试套件。
- `cd packages/cli && npx vitest run src/cli.test.ts src/llm.test.tsx src/config/storage-paths-lite.test.ts src/config/shared-env-keys.test.ts src/config/environment.test.ts src/config/settings.test.ts src/config/path-freshness.test.ts src/serve/fast-path.test.ts src/serve/run-qwen-serve.test.ts src/utils/userStartupWarnings.test.ts`，以及 profiler 相关的测试套件。
- `cd packages/vscode-ide-companion && npx vitest run src/utils/paths.test.ts src/ide-server.test.ts`。
- `cd packages/channels/base && npx vitest run src/paths.test.ts`。
- `cd packages/sdk-typescript && npx vitest run test/unit/peer/registry.test.ts`。
- `npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/cli-entry.test.js scripts/tests/global-dir-marker.test.js scripts/tests/xdg-migration-command.test.js`。
- Linux 模拟：临时关闭每个解析逻辑中的 macOS 例外并重新构建 `dist/` 后，上述测试套件在一次性的 `HOME` 下通过。唯一的失败是断言 macOS 继续使用 `~/.qwen` 的用例，这是模拟有意关闭的行为。

## 未运行

上述测试组没有在 Linux 或 Windows 上执行。两种机器都不可用，也没有正在运行的容器运行时。Linux 规则由模拟平台的单元测试以及上述模拟运行覆盖。
