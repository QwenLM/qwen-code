# 本地文件（Local Files）易用性改进

[English](2026-11-14-local-files-usability.md) | [简体中文](2026-11-14-local-files-usability.zh-CN.md)

> 状态：本次变更已实现。建立在
> [客户端文件系统桥设计](2026-09-03-client-filesystem-bridge.md)之上；
> 不改变该设计的安全模型、工具面或降级矩阵。

## 1. 问题

Web Shell 侧边栏的**本地文件**入口（客户端文件系统桥）功能可用，但若干日常交互比应有的更费力：

1. **连接状态几乎不可见。** 触发器是一个 16px 图标，唯一的状态信号是一个 1.5px 圆点，且只在已连接或忙碌时显示。`failed` 的桥**完全没有圆点**，tooltip 无论状态如何都是固定的「本地文件」。
2. **更换授权目录要两步。** 已连接时面板只有「断开」；用户必须先断开、再连接并重新选择。`connect()` 在存储句柄是同一条目时还会短路，因此单纯再调一次无法打开选择器。
3. **需要重新授权的授权只能被动发现。** 刷新后，权限回落到 `prompt` 的存储句柄会把桥停在 `needs-gesture`。Popover 之外没有任何东西报告这一点，用户可能误以为 agent 仍能访问文件，实际已不能。
4. **面板不说明绑定的是哪个会话。** 桥是严格会话作用域的，但面板只显示目录名与工具数。桥设计的生命周期一节承诺「已连接（绑定会话 X，根目录 Y）」；会话这一半缺失。`needs-session` 态同样只让用户先创建会话，却不提供该动作。
5. **若干阻断文案只解释原因、不给修复动作。** `unsupported-daemon` 让用户设环境变量并重启；`insecure-context` 建议 SSH 隧道却不给命令；`workspace-ineligible` 用内部术语（「不受信任或 live 工作区」）且无下一步；带存储授权的 `failed` 桥按钮仍标「连接目录…」而非「重试」。

## 2. 现状（已在父提交核实）

- `packages/web-shell/client/components/LocalFilesControl.tsx` 导出 prop 驱动、无 hook 的 `LocalFilesPanel`，以及 daemon 侧 `LocalFilesControl`（popover 触发器 + 桥接线）。
- `packages/web-shell/client/components/ManagedLocalFilesControl.tsx` 是 Managed 模式入口；复用 `LocalFilesPanel` 并渲染自己的触发器。
- `packages/web-shell/client/local-files/useLocalFilesBridge.ts`（daemon）与 `useManagedLocalFilesBridge.ts`（Managed）持有授权生命周期。两者的 `connect()` 都复用存储句柄，只要存在授权就绝不重新打开选择器。
- `packages/web-shell/client/components/ToastHost.tsx` 提供 `requestToast(tone, message)`，是全应用使用的窗口事件 toast。
- 会话标题可取 `useConnection().displayName`（daemon）与 `currentSummary.title`（Managed 页）。创建会话为 `useActions().newSession()`（daemon-react-sdk）。
- 面板的降级矩阵与可供性由 `LocalFilesPanel.test.tsx` 钉住；控制接线由 `LocalFilesControl.test.tsx` 与 `sidebar/WebShellSidebar.local-files-footer.test.tsx`；Managed 浏览器路径由 `client/e2e/managed-local-files.spec.ts`。

## 3. 目标与非目标

目标：让桥状态一目了然、缩短更换目录与重新授权路径、点名绑定会话、把阻断文案变成具体动作——且不触碰桥的安全模型。

非目标（与桥设计一致）：

- 不接管其他标签页持有的桥（`held-elsewhere` 保留只读说明）。
- 不新增工具、不加删除工具、不做只读模式切换。
- 不改变会话作用域、信任门禁或工作区路由解析器。
- 不支持 Firefox/Safari；能力探针及其阻断项保留。

## 4. 提议的变更

### 4.1 触发器状态可见性（两个控制）

一个共享 helper 把 `LocalFilesStatus` 映射为圆点颜色与 tooltip：

| 阶段                                          | 圆点                        |
| --------------------------------------------- | --------------------------- |
| `connected`                                   | `bg-primary`                |
| `held-elsewhere`、`connecting`、`registering` | `bg-muted-foreground`       |
| `reconnecting`、`needs-gesture`               | `bg-[var(--warning-color)]` |
| `failed`                                      | `bg-destructive`            |
| 其他                                          | 无                          |

`held-elsewhere` 刻意用 muted 而非 primary：桥虽在运行但由另一个标签页持有，本标签页不能把圆点读作「我这里有一个可用的桥」——这保留了改动前触发器所做的区分。警告圆点使用随主题变化的 `--warning-color` token（在 `App.module.css` 按主题定义：暗色 `#ecc94b`、亮色 `#9a6a00`），应用其余部分的警告已在用它；`amber-500` 之类的裸调色板颜色无法适应亮色主题。

tooltip 变为 `本地文件 — <状态>`，在有目录名时追加 `（<rootName>）`，取代固定标签；瞬态的 `workspace-resolving` 阻断读作「解析中…」，而非永久不可用文案。同一字符串还经 `aria-describedby` 指向一个视觉隐藏 span 暴露给读屏器。`aria-label` 保持基础标签，使既有入口断言与读屏命名稳定。

### 4.2 已连接时更换目录

- `LocalFilesPanel` 新增可选 `onChangeDirectory` prop；当阶段为 `connected` 且该 prop 存在时，在「断开」旁渲染「更换目录…」按钮。`held-elsewhere` 刻意不提供：存储记录跨标签页共享，在对端持有桥时重新选择会覆盖对端的授权。
- 两个 hook 的 `connect()` 接受 `options?: { forcePicker?: boolean }`。带 `forcePicker` 时跳过存储句柄复用分支，直接打开原生选择器，选中的句柄覆盖旧记录保存。daemon hook 随后经既有 `startBridge(handle, { force: true })` 路径重建桥；Managed hook 没有 `startBridge`——它在保存后经 `bridge.connect()` 重跑注册。两者所有既有的 generation/in-flight 守卫原样适用。
- `forcePicker` 下的选择器结果保持运行中桥的真实性：
  - 取消 → 不写状态、无返回值（旧桥继续运行，handler 保持静默）；
  - 失败/不可用 → 保留连接前状态而非写 `failed`，因为旧桥仍连接，写 `failed` 既误报状态，又会让后续重试卡在同条目短路上。hook 返回 `repick-failed` 结果，控制将其呈现为错误 toast，使这次点击不静默；
  - 重选已绑定的条目（经 `isSameEntry` 判同一性，而非 basename）保留运行中的桥，不拆掉重建。两个 hook 都短路；Managed hook 在保存之前就返回，因此重复确认已绑定目录绝不会重新注册绑定。
- 强制路径上保存软失败（配额/驱逐）在**两个** hook 中都按重选失败处理：整笔变更被拒绝，活桥继续服务旧目录，记录继续持有旧目录，handler 弹出错误 toast。若内存中服务新目录而记录仍是旧目录，刷新会静默回绑用户刻意换走的目录。
- 瞬态 resolving 抖动期间，daemon hook 寄存一个强制重建义务而非在抖动中重建；rebind effect 在判定落定后消费它。该义务是必需的：rebind 的保桥豁免只比较 basename，分不清同名新目录与旧目录。

### 4.3 重新授权提示

当 daemon 控制的状态转入 `needs-gesture`（从任何其他阶段，包括刷新后挂载时），触发一次 `requestToast('warning', …)`，点名目录并指向本地文件入口。用一个 ref 按转移去重，使重渲染不会重复 toast。持久可供性仍是警告色触发器圆点加面板的「重新连接」按钮；toast 只解决「从未打开 popover」的缺口。Managed hook 目前没有 `needs-gesture` 阶段，故此提示仅 daemon。

### 4.4 绑定会话与创建会话

- `LocalFilesPanel` 新增可选 `sessionName` prop；已连接且有名时，在目录行旁渲染「会话：<name>」行。
- `LocalFilesPanel` 新增可选 `onNewSession` prop；在 `needs-session` 且该 prop 存在时渲染「新建会话」按钮。
- daemon 控制传 `sessionName = displayName` 与 `onNewSession = () => actions.newSession()`（经 `useActions()`）；`newSession` 经通知系统自行报告失败，控制只挂一个空 catch 以避免未处理的 rejection。Managed 控制传 `sessionName = currentSummary.title`（当标题就是会话 id 时省略），不传 `onNewSession`——Managed 的会话创建属于页面，而非此控制。

### 4.5 可执行的阻断文案

- `unsupported-daemon`：「复制启动命令」按钮复制 `QWEN_SERVE_CLIENT_MCP_OVER_WS=1 qwen serve`。
- `insecure-context`：先于 `unsupported-browser` 诊断——安全上下文是 picker 的前提，因此在本阻断所针对的纯 http 非回环部署上 picker 必然缺失，先诊断它会把隧道指引藏在「请用 Chrome」后面。当控制能推导出绝对 daemon URL 时，「复制 SSH 隧道命令」按钮复制 `ssh -L <localPort>:localhost:<remotePort> <hostname>`——远端端口取自 URL（缺省按协议），特权远端端口（<1024）本地映射为 `remotePort + 8000`，使隧道无需特权本地绑定。host 走白名单（`[A-Za-z0-9._:-]`、禁止前导 `-`、保留 IPv6 的 `:`），因为命令要粘贴进 shell，而 WHATWG URL 解析器会保留 host 中的 shell 元字符；不安全的 host 不产生命令。解释文案点名要打开的**本地**绑定（`http://localhost:<localPort>`）——命令中唯一的 `localhost` 是远端。
- `workspace-ineligible`：文案改写为给出下一步——在受信任的普通工作区会话中使用——而非只点名内部条件。
- 带有名授权的 `failed`：连接按钮标「重试」；无授权时仍标「连接目录…」。两者都调用同一 `onConnect`。

复制按钮是 prop 驱动的：面板接收 `onCopyCommand(command)` 与可选 `tunnelCommand`，保持无 hook。控制经共享的 `writeClipboardText` helper 复制（异步 Clipboard API，非安全上下文回退 `execCommand('copy')`），并经 `requestToast` 报告成功/失败。daemon 启动命令是模块常量；Managed 控制不传复制可供性（其阻断是浏览器级的，且其 base URL 是相对 API 路径）。

### 4.6 managed-only 外壳中的 toast 通道

`requestToast` 是窗口 `CustomEvent`，daemon 宿主外壳中唯一的监听器在 App。managed-only 启动路径（`ManagedStandaloneApp` → `ManagedAgentWebShell`）现在挂载 `WindowToastHost`——一个自包含宿主，与 App 监听器同一契约：非空 message 校验、tone+message 去重、上限栈、按截止时间自动消失。没有它，「更换目录」失败 toast 会派发进一个没有监听器的文档而被静默丢弃。toast 栈常量放在 `ToastHost.tsx` 并与 App 共享，使两个宿主不会漂移。

## 5. 设计决策与理由

- **面板保持 prop 驱动、无 hook。** 每个新可供性都是可选 prop，使既有降级矩阵测试保持形状，新可供性无需 daemon provider 即可测试。
- **`forcePicker` 是可选参数，不是新方法。** 它复用整条既有选择/保存/重建路径及其竞态守卫。缺省（无参数）流程不变，只有一处共享修复：瞬态 `workspace-resolving` 抖动不再在 connect 入口守卫处扣留一个运行中、路由正确的桥（与 rebind effect 既有的豁免一致），因此普通连接与更换目录都能扛过抖动。
- **`needs-gesture` 用 toast 而非聊天区 banner。** banner 需要把桥状态从常驻挂载的侧边栏控制提升到会话视图，改变 hook 的挂载/恢复生命周期。既有 toast 机制以零新接线交付主动提示；警告色圆点在 toast 消失后仍保持状态可发现。
- **`held-elsewhere` 下不提供更换目录。** IndexedDB 记录按源共享；从非 owner 标签页重新选择会悄悄替换 owner 的授权。
- **`aria-label` 不变。** 状态放在 tooltip 与面板；入口的可访问名称对既有消费者与测试保持稳定。

## 6. 涉及文件

- `packages/web-shell/client/components/LocalFilesControl.tsx` — 面板 props、触发器 helper、daemon 接线（toast、复制、会话、更换目录）。
- `packages/web-shell/client/components/ManagedLocalFilesControl.tsx` — 触发器 helper、会话名、更换目录接线。
- `packages/web-shell/client/local-files/useLocalFilesBridge.ts` — `connect({ forcePicker })`。
- `packages/web-shell/client/local-files/useManagedLocalFilesBridge.ts` — `connect({ forcePicker })`。
- `packages/web-shell/client/components/managed/ManagedSessionsPage.tsx` — 向 Managed 控制传入会话标题，当标题就是会话 id 时抑制。
- `packages/web-shell/client/local-files/capabilities.ts` — insecure-context 先于 unsupported-browser 诊断。
- `packages/web-shell/client/components/ToastHost.tsx` — `WindowToastHost` 与共享 toast 栈常量。
- `packages/web-shell/client/ManagedAgentWebShell.tsx` — 挂载 toast 宿主。
- `packages/web-shell/client/App.tsx` — 消费共享 toast 常量。
- `packages/web-shell/client/i18n.tsx` — 新增 EN/ZH 键（两种语言）；insecure-context 指引为带本地端口的函数值。
- 测试：`LocalFilesPanel.test.tsx`、`LocalFilesControl.test.tsx`、`ManagedLocalFilesControl.test.tsx`、`ManagedSessionsPage.test.tsx`、`ManagedAgentWebShell.test.tsx`、`ToastHost.test.tsx`、`capabilities.test.ts`、`i18n.test.ts`、hook 测试、`client/e2e/managed-local-files.spec.ts`，以及 `client/e2e/web-shell.local-files-toast.spec.ts`。

## 7. 约束与风险

- 桥 hook 对竞态敏感（generation 计数、in-flight 闩、revoke 仲裁）。`forcePicker` 只跳过存储句柄复用；不得绕过任何守卫。hook 测试钉住带运行中桥时的取消/失败行为。
- 新 i18n 键必须同时落在 EN 与 ZH；面板的中文渲染矩阵扩展以覆盖每个新字符串。
- toast 从常驻挂载的控制触发；去重 ref 必须防止在无关重渲染时重复触发。
- 复制依赖 `writeClipboardText`：非安全上下文没有异步 Clipboard API，`execCommand('copy')` 回退在点击的用户激活内运行。若安全上下文的权限弹窗在拒绝前耗尽了该激活，回退仍可能失败；控制此时经 toast 报告失败，而非声称成功。

## 8. 验证计划

- 单元：扩展 `LocalFilesPanel.test.tsx`（按阶段的新可供性、两种语言）、控制接线测试（toast 去重、复制命令、会话名、更换目录），以及 `forcePicker` 的 hook 测试（重选、取消保留桥、失败保留状态）。重建用例经新 socket 上的真实 `list_directory` 工具调用探测实际服务的目录（同名 handle 使按名断言失明）；两个 hook 的测试都读取 `repick-failed` 返回契约，取消的姊妹用例断言静默；探针优先级、恶意 host 白名单、本地端口文案、managed toast 宿主、改写阻断文案的 zh≠en 对照各有专用用例。每个新守卫都经变异验证并字节级还原。
- `npm run build && npm run typecheck`，外加从 `packages/web-shell` 跑聚焦 vitest 套件。
- E2E：扩展 `managed-local-files.spec.ts`，在真实浏览器中断言已连接态的更换目录可供性与会话名；并新增 `web-shell.local-files-toast.spec.ts`，恢复一个权限为 `prompt` 的持久化授权（在 IndexedDB 层拦截），断言一次性警告 toast 在不打开 popover 的情况下到达真实 toast 宿主。非安全上下文的剪贴板回退还在非回环源上实跑（`execCommand('copy')` 携带推导出的隧道命令）。命令类功能所用的 CLI 级 dry-run 不适用于纯浏览器 UI；基线是既有单元 + E2E 套件。

## 9. 验收标准

- 失败的桥显示红点；需重新授权的授权显示警告色点与一次性警告 toast；tooltip 点名状态与目录。
- 已连接面板提供「更换目录…」，直接打开选择器并在新授权上重建桥；取消则旧桥继续运行。
- 已连接面板点名绑定会话；`needs-session` 提供「新建会话」（daemon）。
- `unsupported-daemon` 与 `insecure-context` 提供具体命令的一键复制；`workspace-ineligible` 给出下一步；带授权的失败桥提供「重试」。
- 所有既有降级矩阵、接线、footer 与 Managed E2E 断言仍通过；无安全模型变更。

## 10. 未决问题

- Managed hook 是否应增加 `needs-gesture` 阶段（其恢复目前会悄悄丢弃 `prompt` 授权）。此处不在范围内；在该缺口解决前，提示仅 daemon。
