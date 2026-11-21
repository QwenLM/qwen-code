# `/pkgdiet` 依赖防护技能设计文档

[English](./2026-09-23-pkgdiet-skill.md) | [中文版](./2026-09-23-pkgdiet-skill.zh-CN.md)

状态：已在 PR #12572 中实现。
关联文件：`packages/core/src/skills/bundled/pkgdiet/SKILL.md`，`packages/core/src/skills/bundled/pkgdiet/SKILL.test.ts`。

## 1. 目标与背景

自主 AI 编程智能体在工程搭建与开发中经常安装外部依赖（如 `npm install`、`pnpm add`、`npx`）。缺乏实时检查时，智能体面临以下风险：

- 包名幻觉攻击（安装攻击者抢注的同名或拼写错误恶意包）。
- 依赖体积膨胀与已废弃（deprecated）包的引入。
- 软件供应链安全隐患。

`/pkgdiet` 技能通过集成 PkgDiet 模型上下文协议（MCP）服务，在 npm 依赖代码被拉取或执行之前提供可交互、用户授权的依赖安全、废弃状态及体积评估防护。

## 2. 设计决策与边界

### 2.1 触发与智能体控制

- `user-invocable: true`，`disable-model-invocation: true`：模型绝不自主触发该技能，仅当用户显式输入 `/pkgdiet` 时方可激活。
- `allowedTools: undefined`：无预先授权工具。所有操作（包括注册服务与包安装）均须通过显式用户确认。
- **会话级与生态边界**：技能防护指引仅在显式调用 `/pkgdiet` 的交互会话内有效，不限制后台子智能体、钩子、工作流脚本或外部终端命令。仅防护 npm 生态管理器（`npm`、`pnpm`、`yarn`、`bun`）。

### 2.2 注册与存储范围

- **用户作用域注册**：通过 `"${QWEN_CODE_CLI:-qwen}" mcp add --scope user pkgdiet npx -y pkgdiet@2.0.0 mcp` 注册至用户全局作用域（`$QWEN_HOME/settings.json` 或 `~/.qwen/settings.json`），并在配置文件中显式将 `mcpServers.pkgdiet.cwd` 设置为工作区外的独立目录（如 `$QWEN_HOME` 或用户主目录），防止受仓库本地 `.npmrc` 或 `node_modules` 干扰。
- **进程与环境模型**：MCP 服务作为会话同级的本地 stdio 子进程运行，继承会话环境变量（`sanitizeChildEnv` 保留第三方开发凭据）。该行为在技能声明与用户确认弹窗中均作明确披露。
- **运行时解析**：`npx -y pkgdiet@2.0.0 mcp` 在运行时动态从 npm 解析 2.x 依赖树。

### 2.3 配置优先级与身份安全

- **会话策略过滤前置校验**：引导阶段排查 `mcp.allowed` 与 `mcp.excluded`，确认 `pkgdiet` 未被全局配置策略禁用后再行注册。
- **白名单身份校验**：用户级配置按白名单比对：仅允许包含 `command`、`args` 与工作区外的独立 `cwd`，且命令与参数严格匹配 `npx` 及 `["-y", "pkgdiet@2.0.0", "mcp"]`。任何多余字段（`env`、`headers`、`trust`、`timeout` 等）均视为不匹配并拒绝执行。
- **不受信的作用域隔离**：任何来源于项目或工作区作用域（`.mcp.json`、`.qwen/settings.json`）的 `pkgdiet` 条目均视为不受信。技能立刻终止并拒绝批准（halts immediately and refuses approval）。工作区条目可通过 `"${QWEN_CODE_CLI:-qwen}" mcp remove --scope project pkgdiet` 移除；`.mcp.json` 条目须手动编辑对应文件。
- **配置作用域限制**：白名单校验仅作用于用户作用域（user scope）条目（`$QWEN_HOME/settings.json` 或 `~/.qwen/settings.json`）。SystemDefaults（`system-defaults.json` 或 `QWEN_CODE_SYSTEM_DEFAULTS_PATH`）、系统作用域（Linux `/etc/qwen-code/settings.json`、macOS `/Library/Application Support/QwenCode/settings.json`、Windows `C:\ProgramData\qwen-code\settings.json` 或 `QWEN_CODE_SYSTEM_SETTINGS_PATH`）、CLI 标志（`--mcp-config`）、扩展提供以及 ACP/IDE 会话注入的 MCP 服务均不在本技能的可检查与校验范围内。若服务处于活跃状态但无法在三个可读作用域（用户、工作区、项目）中找到配置条目，服务的来源无法确认，技能立刻终止并不将其作为守卫服务。
- **评估器源地址完整性**：引导阶段在评估器非工作区工作目录（如 `(cd "<cwd>" && npm config get registry)`）执行 `npm config get registry`。若 npm 执行失败或退出码非零，终止注册。输出通过去除末尾斜杠归一化后必须严格等于 `https://registry.npmjs.org`。重定向源被视为身份不匹配（identity mismatch）并终止注册。
- **配置还原保证**：若 `$QWEN_HOME/settings.json`（或 `~/.qwen/settings.json`）中已存在旧的用户级配置，其完整配置对象在写入前被记录；若注册命令退出码非零，完整还原该对象；若连通性重试超时，保留配置并引导用户重启。
- **有限重试探测**：连通性检查增加有界重试以容纳冷启动下载。若仍未连通，标记为已注册未运行，通过 `mcp list` 查看连接状态并建议在终端直接执行命令查看 stderr。
- **沙箱快路径优先**：在沙箱校验前先进行连通性与配置检查，允许挂载了用户设置的容器化沙箱会话直接复用已有的守卫服务。

### 2.4 判定契约与运行模式

- **未评估包安全闭门（Fail-Closed）**：若 `check_dependency` 返回 `ALLOW` 但附带未评估原因（如网络超时、私有 `.npmrc` 映射或降级模式），技能立刻终止并提示用户决策，绝不放行未经筛查的依赖。
- **项目策略与智能体直接执行**：在每个项目目录检查前（以及切换工作目录时），技能排查仓库中的 `.pkgdietrc.json`、`pkgdiet.config.json`、`package.json#pkgdiet` 与 `.pkgdiet-cache.json`。策略规则（`allowedPackages`、`blockedPackages`、`minHealthScore`、`securityMode`）明确展示给用户并由智能体直接执行：`blockedPackages` 严格优先于 `allowedPackages`。若包在 `blockedPackages` 中，或在项目的 `securityMode` 下评分低于 `minHealthScore`，无论判定结果如何（regardless of the verdict）一律禁止安装。若包在 `allowedPackages` 且不在 `blockedPackages` 中，视为仓库显式声明。若发现提交的 `.pkgdiet-cache.json`，立刻终止直至其被移除。
- **直接执行与脚手架覆盖**：所有下载并执行包的命令（包括 `npx`、`npm exec`、`yarn dlx`、`pnpm dlx`、`bunx` 以及脚手架 `npm create`、`npm init <pkg>`、`pnpm create`、`yarn create`、`bun create`）均纳入拦截筛查范围。对于脚手架命令，从源拉取并执行的实际包为 `create-<name>`（或 `@scope/create-<name>`）；技能筛查 `create-<name>` 而非裸参数。
- **源地址对齐与本地解析识别**：判定仅对 `https://registry.npmjs.org` 的 latest 版本有效。若通过 `--registry`、项目 `.npmrc`、`~/.npmrc`、`npm_config_registry`、`.yarnrc.yml`、`.yarnrc`、`bunfig.toml` 或 lockfile 重定向，判定视为不适用且不执行安装。若执行命令为不执行网络安装的本地脚本或二进制文件（已在磁盘上的编译工具，或仅调用本地二进制且不从源拉取的运行脚本），视为超出范围并直接正常执行。磁盘上存在同名条目（`node_modules/.bin/<name>`）并不能免除可能拉取远程代码的命令（如 `npm install`/`ci`/`add`、`npx`、`dlx`、`create` 或下载器包装器）的筛查。
- **版本作用域与披露**：判定适用于 latest。若请求固定版本或范围，进入授权步骤并向用户披露该判定覆盖的是 latest。
- **单跳替代建议限制**：调用 `suggest_alternative` 时，替代包仅评审一次（最多单跳），防止递归死循环。
- **运行模式兼容**：直接工具模式下使用 `tool_call`；代码模式（Code Mode）下通过 `exec` 驱动工具函数（`tools.<jsName>`）。

## 3. 卸载与清理

用户可随时通过以下命令移除全局服务注册：

```bash
"${QWEN_CODE_CLI:-qwen}" mcp remove --scope user pkgdiet
```

## 4. 残留风险披露

1. **运行时网络拉取**：首次通过 `npx` 启动时需访问 npm 官方镜像源，网络隔离环境需具备公共 registry 访问权限。
2. **环境变量可读性**：本地 stdio 启动的 MCP 服务会继承当前会话导出的环境变量与 API 凭据。
3. **仓库声明策略**：项目级配置文件（`.pkgdietrc.json`、`pkgdiet.config.json`）在存在时会覆盖默认评估阈值。
