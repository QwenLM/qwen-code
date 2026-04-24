# `PR-4` 实操清单：终端协议层残余闪烁收尾

> 本文档把 [10-issue-oriented-flicker-plan.md](./10-issue-oriented-flicker-plan.md) 里的 `PR-4` 落成可以直接照着做的执行清单。`PR-4` 只有在 `PR-1` ~ `PR-3` 的应用层问题收敛后才应默认推进。

## 1. 目标

`PR-4` 只处理特定终端中仍能看到的帧撕裂和中间帧：

1. 支持 synchronized output 的终端中，单帧更新尽量原子显示。
2. 不支持或未知终端自动 fallback。
3. stdout monkeypatch 顺序与 `terminalRedrawOptimizer` 不冲突。

## 2. 前置条件

进入实现前必须满足：

- `PR-1` 已提供 stdout write / clear / erase optimization counters。
- `PR-2` 已降低大输出 layout 风暴。
- `PR-3` 已处理窄屏 shell 重复输出，不再靠协议层遮掩 serializer 问题。
- 已明确支持矩阵：WezTerm、kitty、iTerm2、JetBrains、tmux、SSH 至少分清 allowlist / denylist / unknown。

## 3. 非目标

- 主屏语义改造
- shell serializer 修复
- 大输出和 detail panel 重构
- Markdown parser / token cache
- 修改 screen reader 输出路径

## 4. 文件边界

预计会修改：

- `packages/cli/src/ui/utils/terminalRedrawOptimizer.ts`
- `packages/cli/src/ui/utils/synchronizedOutput.ts`
- `packages/cli/src/gemini.tsx`
- 对应单测

可能波及：

- terminal detection / env probe 工具
- startup config / settings schema 中的实验开关

## 5. 建议实现顺序

### Step 1：runtime probe 和 allowlist

- 默认关闭未知终端。
- 明确支持 WezTerm / kitty / iTerm2 等已知路径。
- JetBrains terminal 只作为显式验证样本，不在没有 probe 证据时默认开启。
- tmux / SSH 默认保守，除非能证明 passthrough 正确。

### Step 2：frame wrapper 与 optimizer 合并

不要出现双层互相抢写的 monkeypatch：

- `terminalRedrawOptimizer` 负责 eraseLines 优化和 counters。
- synchronized output wrapper 负责在单次 render write 周围包 BSU/ESU。
- callback、Buffer、string encoding 语义必须保持 Node `stdout.write` 兼容。

### Step 3：灰度开关与回滚

- 增加环境变量关闭路径。
- 出现异常终端时能单独回退 synchronized output，不影响 `PR-1` 的 eraseLines optimizer。
- counters 中记录 BSU/ESU 是否平衡。

## 6. 测试清单

单测：

```bash
cd packages/cli
npx vitest run src/ui/utils/terminalRedrawOptimizer.test.ts
npx vitest run src/ui/utils/synchronizedOutput.test.ts
```

手工验证矩阵：

- WezTerm
- kitty
- iTerm2
- JetBrains terminal
- tmux
- SSH
- screen reader mode

## 7. Done 定义

- 支持终端中的残余帧撕裂明显减少。
- 未支持终端不会退化。
- BSU/ESU 平衡可观测。
- 可以通过单一开关回退 synchronized output。
- screen reader 路径不安装协议层 wrapper。

## 8. Review 重点

- 是否在应用层问题未收敛时过早开启协议层默认值。
- 是否破坏 stdout.write 的返回值、callback 或 encoding 语义。
- 是否和 `terminalRedrawOptimizer` 的安装 / restore 顺序冲突。
- 是否把 JetBrains / tmux 这类复杂环境写成无条件支持。

