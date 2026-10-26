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
   - 如果 `~/.qwen` 存在，且 XDG 目录中包含标记文件 `.qwen-global-dir`，使用 XDG 目录。
   - 否则使用 `~/.qwen`。

## 设计决策

- 两个位置都存在时，由标记文件而不是目录是否存在来决定。只要 CLI 把 XDG 目录用作默认全局目录且标记缺失，就会向其中写入 `.qwen-global-dir`。每个入口都在读取主目录 `.env` 之后立即这样做：主 CLI 在解析参数之前写入，因此子命令、bare 模式、关闭使用统计以及沙箱运行的宿主一侧都被覆盖；`mcp` 和 `memory` 快速路径以及 `qwen serve` 也会写入。设置了 `QWEN_HOME` 时从不写入标记，因此某一次运行把 `QWEN_HOME` 指向 `~/.config/qwen`，并不会让该目录成为默认目录。沙箱子进程总是在设置了 `QWEN_HOME` 的情况下运行。这个文件名足够特殊，无关程序的 `~/.config/qwen` 不会包含它。
- 所有各自解析默认目录的组件都采用同一规则，就像它们已经共享 `QWEN_HOME` 规则一样：
  - core 的 `Storage`；
  - CLI 的轻量设置解析和 serve 的运行时目录回退；
  - 启动器（托管更新根目录与 `.env` 预读）；
  - VS Code 插件（IDE 锁文件）；
  - channels 基础包；
  - SDK 的 peer 注册表；
  - 内置 `/stuck` skill 的 shell 前置脚本。
- `XDG_CONFIG_HOME`、`HOME` 和 `USERPROFILE` 只从 Qwen Code 启动时的环境读取。`QWEN_HOME` 还可以来自全局目录的 `.env` 和 `~/.env`，它们在解析全局目录之前读取。之后加载的任何 `.env` 文件以及 `settings.json` 中的 `env` 部分都不能设置这四个变量，包括 XDG 安装上遗留的 `~/.qwen/.env`，因为之后再出现的值会把设置和凭据拆分到两个目录。
- 原本把全局目录的父目录当作主目录的代码，现在直接使用主目录，因此 `~/.env` 仍然是主目录级的 `.env`。
- Auto 模式的自我修改保护覆盖解析后的全局目录，因此 `~/.config/qwen/settings.json` 及其 `hooks/`、`skills/` 与 `~/.qwen/...` 一样受到路径模式的保护。写成 `~/...` 形式的 `QWEN_HOME` 也同样适用。在 Linux 上，即使正在使用 `~/.qwen`，它也会保护 XDG 目录及其标记，因为在那里写入标记会让 XDG 目录在下一次启动时成为全局目录。
- 需手动开启的诊断功能（启动与 CPU profile、堆快照）写入全局目录，因此在 XDG 安装上不会再创建 `~/.qwen`。

## 考虑过的方案

- 只要 `~/.qwen` 存在就使用它，否则使用 XDG（issue 中提出的规则）。有些地方会重新创建 `~/.qwen`：Live 发现的约定位置，以及 VS Code 插件内置的旧版 CLI。任何一个都会把新的 XDG 安装拉回几乎为空的 `~/.qwen`，看起来就像设置和凭据丢失了。
- 只要 XDG 目录存在就优先使用它。这样一个无关的 `~/.config/qwen` 会悄悄取代已有的 `~/.qwen`。
- 用 Qwen Code 首次运行时已经写入的文件（`installation_id`、`output-language.md`）作为标记。这两个文件都有条件：关闭使用统计时不写 `installation_id`，bare 模式下不写 `output-language.md`，这样的首次运行不会留下任何标记。而且设置了 `QWEN_HOME` 时它们同样会被写入，被重定向的运行会把所指向的目录据为己有。
- 把配置、数据和状态拆分到 `XDG_CONFIG_HOME`、`XDG_DATA_HOME` 和 `XDG_STATE_HOME`。这会涉及所有运行时路径，留待后续处理；`QWEN_RUNTIME_DIR` 已经可以把运行时输出分开存放。
- 在 macOS 上也使用 XDG。没有人提出这个需求，因此 macOS 保持 `~/.qwen`。

## 兼容性与迁移

- 现有安装继续使用 `~/.qwen`，无需迁移。
- Linux 新安装使用 `~/.config/qwen`。
- 要在 Linux 上迁移现有安装，运行：

  ```sh
  dest="${XDG_CONFIG_HOME:-$HOME/.config}/qwen"
  if uname -s | grep -qE '^(Darwin|MINGW|MSYS|CYGWIN)'; then
    echo "macOS and Windows keep using ~/.qwen" >&2; false
  elif [ -n "${QWEN_HOME:-}" ]; then
    echo "unset QWEN_HOME first" >&2; false
  elif [ -z "${HOME:-}" ]; then
    echo "HOME is not set" >&2; false
  elif [ "${dest#/}" = "$dest" ]; then
    echo "XDG_CONFIG_HOME must be unset or absolute" >&2; false
  elif [ -e "$dest" ]; then
    echo "$dest already exists; merge it with ~/.qwen by hand" >&2; false
  elif [ ! -d "$HOME/.qwen" ]; then
    echo "there is no ~/.qwen to move" >&2; false
  else
    mkdir -p "$(dirname "$dest")" && mv "$HOME/.qwen" "$dest" &&
      touch "$dest/.qwen-global-dir"
  fi
  ```

  它在移动之后写入标记，因此在下一次启动之前被重新创建的 `~/.qwen` 无法把安装拉回去。在 macOS 和 Windows 上、设置了 `QWEN_HOME` 或未设置 `HOME` 时、`XDG_CONFIG_HOME` 为相对路径时、不存在 `~/.qwen` 时，或者目标已存在时，它不做任何改动并说明原因；最后一种情况请手动合并两个目录。复制而保留 `~/.qwen` 的做法会继续使用 `~/.qwen`。当两个目录都存在时，删除 XDG 目录中的 `.qwen-global-dir` 会让 Qwen Code 重新使用 `~/.qwen`。

- 要在新机器上保留 `~/.qwen`，设置 `QWEN_HOME=~/.qwen`，或在首次运行前创建 `~/.qwen`。带 `--source` 参数的独立安装脚本会写入 `~/.qwen/source.json`，因此也会产生后一种效果。
- 自定义的 `XDG_CONFIG_HOME` 只在设置了它的地方生效。没有设置它的启动环境（例如桌面启动器、systemd 用户服务或 cron）会解析到 `~/.config/qwen`，在没有 `~/.qwen` 时把它当作另一个独立的安装。标记规则只保护 `~/.qwen`。请把它设置在所有启动环境都会读取的位置，例如 systemd 的 `environment.d` 文件或 `/etc/environment`，而不只是 shell 配置文件。
- 指向不存在目标的 `~/.qwen` 符号链接会被视为不存在，与 `existsSync` 的结果一致。它存在期间不会写入标记，因此一旦目标恢复（例如此前尚未挂载的卷），`~/.qwen` 会重新被使用。
- 在 Linux 上，未设置 `QWEN_HOME` 时，每次解析默认目录都需要一到两次 `existsSync` 调用，在 macOS 上两次约 3 µs。结果不做缓存，因为主目录 `.env` 可能在第一次解析之后才设置 `QWEN_HOME`，而 VS Code 插件也是有意每次重新探测。
- 伪造主目录或在 mock `node:fs` 时未提供 `existsSync` 的测试，现在会固定 `QWEN_HOME`，因为 Linux CI 使用空的 `HOME` 运行。

## 超出范围

- 自动迁移 `~/.qwen`。
- 把配置、数据和状态拆分到不同的 XDG 目录，即 #1210 的另一半。
- 仍字面写着 `~/.qwen` 的提示词、设置说明和文档，这在使用 `QWEN_HOME` 时已是如此。其中包括生成已发布 VS Code schema 的 `settingsSchema.ts` 描述，以及九种语言中的 `Saved in at ~/.qwen/settings.json` 字符串；修复它们需要插入解析后的路径并迁移这些键，见 #15628。
- Live 发现的约定位置，它仍使用 `~/.qwen`。
- 仓库自身的开发脚本（沙箱命令查找、遥测及其主目录 `.env` 预读），它们仍读取 `~/.qwen`。在 Linux 新安装上它们看不到 `~/.config/qwen`：只在那里配置的沙箱不会被构建和启动脚本识别，`npm run telemetry` 也会从 `~/.qwen` 读取设置和输出。

## 验收标准

- 在 Linux 上使用空主目录时，首次运行会创建带标记的 `~/.config/qwen`，且不会出现 `~/.qwen`，无论它是交互式 CLI、子命令、`qwen serve` 还是沙箱运行；在 bare 模式下关闭使用统计时也是如此。
- 只有 `~/.qwen` 时，继续使用它。
- 同时存在 `~/.qwen` 和不含标记的 `~/.config/qwen` 时，使用 `~/.qwen`，包括在某次运行把 `QWEN_HOME` 指向 `~/.config/qwen` 之后。
- 同时存在 `~/.qwen` 和包含标记的 `~/.config/qwen` 时，使用 XDG 目录。这也包括在 XDG 目录首次运行之后又被重新创建的 `~/.qwen`。
- 绝对路径的 `XDG_CONFIG_HOME` 会被采用，相对路径会被忽略，来自 `.env` 文件的值会被忽略，`QWEN_HOME` 优先于一切。XDG 安装上遗留的 `~/.qwen/.env` 中的 `QWEN_HOME` 会被忽略。
- macOS 和 Windows 即使存在 `~/.config/qwen` 也使用 `~/.qwen`。
- “设计决策”中列出的产品内各独立解析逻辑结果一致，且无论全局目录在哪个位置，Auto 模式都会保护其中的 settings、hooks 和 skills；正在使用 `~/.qwen` 时，还会保护 XDG 目录及其标记。
