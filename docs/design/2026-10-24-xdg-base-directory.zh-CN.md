# Linux 上全局目录采用 XDG Base Directory

[English](2026-10-24-xdg-base-directory.md) | [简体中文](2026-10-24-xdg-base-directory.zh-CN.md)

## 问题与范围

Qwen Code 在所有平台上都把设置、凭据和其他全局状态保存在 `~/.qwen`。在 Linux 上，XDG Base Directory 规范要求把配置放在 `$XDG_CONFIG_HOME`（默认 `~/.config`）下，issue #1210 也请求 Qwen Code 遵循这一规范。现有安装必须无需迁移即可继续工作，macOS 和 Windows 的行为不得改变。

本次修改只改变全局目录的默认位置。`QWEN_HOME`、`QWEN_RUNTIME_DIR` 和项目级 `.qwen/` 目录的含义保持不变。

## 解析顺序

1. 设置了 `QWEN_HOME` 时使用它。
2. 在 macOS 和 Windows 上使用 `~/.qwen`。
3. 在 Linux 及其他遵循 XDG 的平台上，当 `XDG_CONFIG_HOME` 是绝对路径时，XDG 目录为 `$XDG_CONFIG_HOME/qwen`，否则为 `~/.config/qwen`。规范规定相对路径的值无效，必须忽略。
   - 如果 `~/.qwen` 不存在，使用 XDG 目录（新安装）。
   - 如果 `~/.qwen` 存在，且 XDG 目录中包含 `installation_id` 或 `output-language.md`，使用 XDG 目录。
   - 否则使用 `~/.qwen`。

## 设计决策

- 两个位置都存在时，由 Qwen Code 专属的标记文件而不是目录是否存在来决定。`installation_id` 会在首次运行时写入（除非关闭了使用统计），`output-language.md` 会在每次 CLI 启动时写入（bare 模式除外）。这两个文件名足够特殊，无关程序的 `~/.config/qwen` 不会包含它们。
- 所有各自解析默认目录的组件都采用同一规则，就像它们已经共享 `QWEN_HOME` 规则一样：
  - core 的 `Storage`；
  - CLI 的轻量设置解析和 serve 的运行时目录回退；
  - 启动器（托管更新根目录与 `.env` 预读）；
  - VS Code 插件（IDE 锁文件）；
  - channels 基础包；
  - SDK 的 peer 注册表。
- 原本把全局目录的父目录当作主目录的代码，现在直接使用主目录，因此 `~/.env` 仍然是主目录级的 `.env`。
- 未设置 `QWEN_HOME` 时，Auto 模式的自我修改保护现在覆盖解析后的全局目录。它的路径模式只匹配 `.qwen/...`，而 `~/.config/qwen` 不会被匹配。

## 考虑过的方案

- 只要 `~/.qwen` 存在就使用它，否则使用 XDG（issue 中提出的规则）。有好几个地方会重新创建 `~/.qwen`：Live 发现的约定位置、VS Code 插件内置的旧版 CLI，以及需手动开启的性能分析工具。任何一个都会把新的 XDG 安装拉回几乎为空的 `~/.qwen`，看起来就像设置和凭据丢失了。
- 只要 XDG 目录存在就优先使用它。这样一个无关的 `~/.config/qwen` 会悄悄取代已有的 `~/.qwen`。
- 写入一个专用标记文件。这会增加一条新的写入路径，而现有的首次运行文件已能满足需要。
- 把配置、数据和状态拆分到 `XDG_CONFIG_HOME`、`XDG_DATA_HOME` 和 `XDG_STATE_HOME`。这会涉及所有运行时路径，留待后续处理；`QWEN_RUNTIME_DIR` 已经可以把运行时输出分开存放。
- 在 macOS 上也使用 XDG。没有人提出这个需求，因此 macOS 保持 `~/.qwen`。

## 兼容性与迁移

- 现有安装继续使用 `~/.qwen`，无需迁移。
- Linux 新安装使用 `~/.config/qwen`。
- 要迁移现有安装，运行 `mv ~/.qwen "${XDG_CONFIG_HOME:-$HOME/.config}/qwen"`。迁移后的目录本身已包含标记文件。
- 要在新机器上保留 `~/.qwen`，设置 `QWEN_HOME=~/.qwen`，或在首次运行前创建 `~/.qwen`。
- 在 Linux 上，未设置 `QWEN_HOME` 时，解析默认目录需要一到三次 `existsSync` 调用。
- 伪造主目录或在 mock `node:fs` 时未提供 `existsSync` 的测试，现在会固定 `QWEN_HOME`，因为 Linux CI 使用空的 `HOME` 运行。

## 超出范围

- 自动迁移 `~/.qwen`。
- 仍字面写着 `~/.qwen` 的提示词和文档，这在使用 `QWEN_HOME` 时已是如此。
- 需手动开启的诊断功能（CPU 与启动 profile、内存快照）、Live 发现的约定位置，以及仓库自身的遥测和沙箱辅助脚本，它们仍使用 `~/.qwen`。
- 像 `QWEN_HOME` 那样从用户级 `.env` 文件预先解析 `XDG_CONFIG_HOME`。`XDG_CONFIG_HOME` 从 Qwen Code 启动时的环境读取。

## 验收标准

- 在 Linux 上使用空主目录时，首次运行会创建 `~/.config/qwen`，且不会出现 `~/.qwen`。
- 只有 `~/.qwen` 时，继续使用它。
- 同时存在 `~/.qwen` 和不含标记文件的 `~/.config/qwen` 时，使用 `~/.qwen`。
- 同时存在 `~/.qwen` 和包含 `installation_id` 或 `output-language.md` 的 `~/.config/qwen` 时，使用 XDG 目录。这也包括在 XDG 目录首次运行之后又被重新创建的 `~/.qwen`。
- 绝对路径的 `XDG_CONFIG_HOME` 会被采用，相对路径会被忽略，`QWEN_HOME` 优先于一切。
- macOS 和 Windows 即使存在 `~/.config/qwen` 也使用 `~/.qwen`。
- 所有独立的解析逻辑结果一致，且无论全局目录在哪个位置，Auto 模式都会保护其中的 settings、hooks 和 skills。
