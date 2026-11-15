# `/pkgdiet` 依赖防护技能设计文档

[English](./2026-09-23-pkgdiet-skill.md) | [中文版](./2026-09-23-pkgdiet-skill.zh-CN.md)

状态：已在 PR #12572 中实现。
关联文件：`packages/core/src/skills/bundled/pkgdiet/SKILL.md`，`packages/core/src/skills/bundled/pkgdiet/SKILL.test.ts`。

## 1. 目标与背景

自主 AI 编程智能体在工程搭建与开发中经常安装外部依赖（如 `npm install`、`pnpm add`、`npx`）。缺乏实时检查时，智能体面临以下风险：

- 包名幻觉攻击（安装攻击者抢注的同名或拼写错误恶意包）。
- 依赖体积膨胀与已废弃（deprecated）包的引入。
- 软件供应链安全隐患。

`/pkgdiet` 技能通过集成 PkgDiet 模型上下文协议（MCP）服务，在依赖代码被拉取或执行之前提供可交互、用户授权的依赖安全、废弃状态及体积评估防护。

## 2. 设计决策与边界

### 2.1 触发与智能体控制

- `user-invocable: true`，`disable-model-invocation: true`：模型绝不自主触发该技能，仅当用户显式输入 `/pkgdiet` 时方可激活。
- `allowedTools: undefined`：无预先授权工具。所有操作（包括注册服务与包安装）均须通过显式用户确认。
- **会话级约束**：技能防护指引仅在显式调用 `/pkgdiet` 的交互会话内有效，不限制后台子智能体、钩子、工作流脚本或外部终端命令。

### 2.2 注册与存储范围

- **用户作用域注册**：通过 `"${QWEN_CODE_CLI:-qwen}" mcp add --scope user pkgdiet npx -y pkgdiet@2.0.0 mcp` 注册至用户全局作用域，确保跨项目可用且不污染单仓库配置。
- **进程与环境模型**：MCP 服务作为会话同级的本地 stdio 子进程运行，继承会话环境变量（`sanitizeChildEnv` 保留第三方开发凭据）。该行为在技能声明与用户确认弹窗中均作明确披露。
- **运行时解析**：`npx -y pkgdiet@2.0.0 mcp` 在运行时动态从 npm 解析 2.x 依赖树。

### 2.3 配置优先级与身份安全

- **全字段身份比对**：为防范恶意仓库通过声明带自定义 `env`（如 `NODE_OPTIONS` 预加载脚本）或 `cwd` 的 `pkgdiet` 拦截评审，技能直接读取配置文件（`~/.qwen/settings.json`）并完整比对：`command: npx`、`args: ["-y", "pkgdiet@2.0.0", "mcp"]`，且不得包含其它扩展字段（`env`、`cwd`、`headers`、`url` 等）。
- **不受信的作用域隔离**：任何来源于项目或工作区作用域（`.mcp.json`、`.qwen/settings.json`）的 `pkgdiet` 条目均视为不受信。技能立刻终止并拒绝建议 `mcp approve`，告知用户必须从项目文件中手动删除。
- **评估器源地址完整性**：引导阶段核验当前 npm 活跃源是否为 `https://registry.npmjs.org/`。若检测到重定向（通过 `.npmrc`、`npm_config_registry`），技能中止注册；重定向被归类为身份不匹配（identity mismatch）而非可接受的残留风险。
- **完整配置还原**：若 `~/.qwen/settings.json` 中已存在旧的用户级配置，其完整配置对象在写入前被记录；当注册命令退出码非零或连通性校验未通过时，完整还原该对象。
- **沙箱快路径优先**：在沙箱校验前先进行连通性与配置检查，允许挂载了 `~/.qwen` 的容器化沙箱会话直接复用已有的守卫服务，免去宿主机重复注册流程。

### 2.4 判定契约与运行模式

- **未评估包安全闭门（Fail-Closed）**：若 `check_dependency` 返回 `ALLOW` 但附带未评估原因（如网络超时、私有 `.npmrc` 映射或降级模式），技能立刻终止并提示用户决策，绝不放行未经筛查的依赖。
- **项目策略与缓存门禁**：在首次检查前，技能排查仓库中的 `.pkgdietrc.json`、`pkgdiet.config.json`、`package.json#pkgdiet` 与 `.pkgdiet-cache.json`。若存在策略规则，将规则明确展示给用户并作为仓库声明判定处理；拒绝信任仓库内提交的 `.pkgdiet-cache.json`。
- **源地址对齐与本地解析识别**：判定仅对 `https://registry.npmjs.org` 的 latest 版本有效。若通过 `--registry`、项目 `.npmrc`、用户 `~/.npmrc`、`npm_config_registry`、`.yarnrc.yml` (`npmRegistryServer`)、`.yarnrc`、`bunfig.toml` 或 lockfile 重定向，或者执行命令解析为项目已存在的本地二进制文件（`node_modules/.bin`、`devDependencies`、scripts），判定视为不适用，技能不执行命令。
- **版本作用域**：判定仅适用于最新包名级别，不同版本或范围不复用缓存。
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
