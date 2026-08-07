# tui-poc-lab — qwen-code TUI on OpenTUI (POC)

验证目标：用 OpenTUI 渲染器替换 qwen-code 的 ink 渲染层，解决
**Warp / Tabby / Windows PowerShell 下的闪屏**，并把**鼠标交互做成一等公民**。

> 分支：`feat/opentui-tui`（worktree：`qwen-code-opentui`）。本目录是独立实验区，
> 不在 npm workspaces 内（避免污染主仓 lockfile）；验证通过后再并入 `packages/`。

## 运行

```bash
cd tui-poc-lab
bun install
bun src/main.tsx        # OpenTUI POC（主要验证对象）
bun src-ink/ink-demo.tsx # ink 对照组（复现 qwen-code 现有写入模式）
```

## 体验验证清单

| 验证点 | 操作 | 期望 |
|---|---|---|
| **闪屏（核心）** | 两个 demo 分别在 Warp、Tabby、PowerShell、iTerm2 里跑，观察流式输出期间画面 | opentui 侧无闪烁；ink 侧复现现有闪烁 |
| 鼠标选择+复制 | 拖拽选中任意文本后松开 | 自动进剪贴板，底部 toast 提示（对齐原生终端习惯） |
| 点击展开/收起 | 点击工具卡 / Thinking 行 | 展开输出；再点收起；hover 有高亮 |
| 滚轮滚动 | 滚轮上下 | scrollbox 贴底流式跟随，向上滚可回看历史 |
| 流式渲染 | 观察 markdown（代码块/表格/列表）流式生成 | 增量渲染、无整屏跳动 |
| 中断 | Esc | 停止流式 |

## 已验证的技术事实（本机实测）

1. **node:ffi 在 Node 24.15.0 不存在**（`No such built-in module: node:ffi`）；
   opentui 官方仅在 Node v26.4.0 + `--experimental-ffi` + Linux 上验证过 Node 路径。
   → **POC 运行时用 bun（1.3.13，opentui 一等支持）**；正式迁移的分发建议照 opencode
   走 **bun compile 单二进制**（用户机器无需 node/bun），彻底绕开 node:ffi 版本问题。
2. **zig 原生核无需自己编译**：npm 的 `@opentui/core` 通过 8 个平台 optionalDependencies
   直接分发预编译 `libopentui.{dylib,so,dll}`（本机已验证 darwin-arm64 安装即用）。
3. opentui 写入模式 = 行级 memcmp 快路径 + cell 级 diff + run 合并，**无任何 erase 序列**，
   帧字节 ~70B 级（ink 标准 ~4.2KB、ink incremental ~0.3KB）；DEC 2026 每帧包裹。
   详见 `tui-research` 仓库 `reports/warp-flicker-mechanism.md`。
4. **本机 PTY 实测（POC 完整会话 vs ink demo 6 秒）**：
   - POC：`ESC[2K` erase 序列 **0 次**，DEC 2026 同步帧 253 次，CUP 覆盖写 3640 次；
   - ink：6 秒内 `ESC[2K` **749 次**（每帧先擦后写）。
   → 结构性差异与理论分析完全一致；剩下的问题是 Warp/Tabby/PowerShell 真机肉眼验证。

## 已知退化（按用户确认接受）

- mermaid 不渲染（qwen-code 现支持，迁移后按普通代码块处理，后续再补）
- 显示逻辑以本 POC / opencode 为准，不 1:1 复刻 ink 版

## 目录

```
src/main.tsx          入口（renderer 配置）
src/app.tsx           聊天界面（scrollbox 视口 + 流式 markdown + 鼠标交互）
src/stream-script.ts  脚本化流式事件源（与 ink demo 共用同一内容）
src/clipboard.ts      OSC 52 + pbcopy/xclip/clip 复制
src-ink/ink-demo.tsx  ink 对照组
```
