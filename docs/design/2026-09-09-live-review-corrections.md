# Live review corrections

## Scope

Address confirmed PR #11369 review defects on `3f0a30c2bf`, retaining the three
maintainer main merges. The review is partial: addressing its findings does not
certify unrelated parts of this feature PR. Isolated regression evidence must
precede fixes; builds and affected-package verification follow them.

## Decisions

- Keep v9 camera readiness strict and update stale CLI hello fixtures. Camera
  is requested functionality: packaging requires its nonempty usage description
  and exactly the four existing entitlements, rejecting all other permissions.
- Cache shutdown authority by authenticated daemon identity, not WebSocket
  lifetime. Identity/credential changes revoke it; failed Quit stays pinned to
  the original target. Shared-daemon retries still send a real stop frame.
- Keep the failed-Quit UI and stopped media, with a truthful connection state.
  Only a matching shutdown receipt or signal-zero ESRCH for the authenticated
  PID proves shutdown. HTTP/network failures or ambiguous process probes do not.
  Preserve the failure cause but log only non-sensitive classifications.
- Full readiness recovery dominates visual-only recovery. Visual changes cannot
  cancel microphone/audio/shortcut updates. Rejected mode sends report failure
  without optimistically changing the acknowledged mode.
- Clear output bookkeeping at both stop boundaries. Replay buffered submission
  residue without inventing job ownership or reopening resolved permissions.
  Ignore a late tool result only after that exact response failed nonfatally
  and while its Realtime connection remains usable.
- Pair Host output clears with injector state and retry deferred Proactive
  repair once every response authority has settled. Preserve FIFO, direct-user
  adjacency and tool-authority boundaries.
- Reset monitor recycle state at its authoritative ready event. Keep the entire
  SFT prompt and non-executable Func_call behavior; distinguish it from wait in
  content-free diagnostics. Retain nominal warm-up and add continuous observed
  time for slow successful capture; expired evidence resets that interval.
- Advertise exact adjacent-update/cancel restrictions. Map only known argument
  errors to actionable model receipts. Reuse PCM/instruction-size constants,
  classify oversized initial instructions as configuration errors, and remove
  an image-drop reason with no producer.

## Deferred maintenance

Keep post-call harness observation: the backend treats some typed 404/session
not-found errors as recoverable during runtime replacement, so an arbitrary
retry cap is unsafe. Current visual prompts, JPEG validation, wire enums and
tool schema/allowlist copies show no drift. Broad unification stays separate
maintenance; the review report records the parity evidence.

## 中文说明

### 范围

基于 `3f0a30c2bf` 修复 PR #11369 已确认的问题，保留维护者三次合入 main 的历史。
原审查只覆盖部分内容，处理这些意见不等于为整个功能 PR 作完整认证。先用隔离回归
复现，再修复，并完成构建和受影响包的验证。

### 决策

- 保留严格的 v9 摄像头就绪校验，更新过期 CLI hello 测试替身。摄像头是已要求的
  功能；打包检查要求非空用途说明和现有四项权限，拒绝所有额外权限。
- 退出权限按已认证 daemon 身份缓存，而非按 WebSocket 存活期。身份或凭据改变时
  撤销；失败重试固定原目标。共享 daemon 的重试仍必须真正发送 stop 帧。
- 退出失败时保留错误与重试界面，媒体保持停止，连接状态不能误报 ready。
  只有匹配回执或对已认证 PID 的零信号探测得到 ESRCH，才能证明已退出；网络、HTTP
  失败和不明确的进程探测都不是证明。保留失败原因，日志只记录不敏感的分类。
- 完整就绪恢复优先于纯视觉恢复；视觉变化不能取消麦克风、音频或快捷键更新。
  模式发送失败应提示，不提前改变已确认的模式。
- 两种停止终态都清理播放状态；重放提交残留事件，但不猜测任务归属、不复活已处理
  的授权。只有同一响应已发生非致命失败、连接仍可用时，才忽略迟到工具结果。
- Host 清空音频时同步 injector；所有响应类型都结束后重试延后的 Proactive 修复，
  同时保持 FIFO、直接用户相邻引用与工具权限边界。
- monitor 回收状态只在权威 ready 事件中重置。完整保留 SFT prompt 和 Func_call
  不执行语义，仅在不含内容的诊断中区分它与 wait。保留正常帧率暖启动，并允许慢速
  成功采集按连续观测时间满足门槛；证据过期后重置计时。
- 工具描述明确相邻更新／取消限制；模型回执仅映射已知参数错误。复用 PCM 和指令
  长度常量，初始指令过长归为配置错误，删除没有生产者的丢帧原因类型。

### 延期维护

保持通话结束后的后台观察：后端在运行时替换期间把部分带类型的 404／session-not-found
视为可恢复错误，不能据此加入任意重试上限。视觉提示词、JPEG 校验、线上枚举及工具
schema／白名单副本当前未发现漂移；大范围统一留作独立维护，一致性证据记录在审查报告中。
