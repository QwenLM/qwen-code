# 扩展 watcher 复用：设计补充

[English](2026-11-15-opentui-extension-watcher-reuse.md)

组合检查点：这些已审修改现已迁入基于实际 main 检查点 `dab5253c` 的独立 Source 组合候选，不包含 SkillReview PR 的未合并增量。下文 `b6ec` / `7220` 结果属于原双工作树候选；在准备时，该组合尚未 build 或运行产品，未继承其通过资格。

历史检查点：本文最初为 Proposed、ignored 草稿，当时尚未取得实现或产品资格。当前已有最小实现候选；以下合同与限制继续适用，最新实际结果见下节。

## 证据与范围

批量刷新产物 `2a86` 完整通过 Node+Ink Source 场景，两种 Bun 模式失败。后续 watcher 诊断产物 `d52c` 通过 124 项单元测试，但 Native Source 实际运行仍在 B 同意边界失败。两者是不同候选与结果。

保存的诊断包含 25 条记录。同一 PID 46144、generation 5 中，`main-close-call-before` 为 19529493875，`main-close-call-returned` 为 25896133584，两条 before/returned 关闭边界记录相隔 6.366639709 秒。before 时间戳取于日志序列化/append 之前，因此区间包含该诊断工作及 close 调用/catch 注册；诊断开销未独立分离。这不证明关闭 Promise 已完成、不识别唯一底层锁持有者，也不证明它是完整 Source 失败的唯一原因。generation 9 在保存窗口内缺匹配返回，不能仅凭相邻顺序归为业务或清理。

本实现候选仅处理 CLI watcher 生命周期，必须保留 Core store 策略、安装/同意顺序、link 扩展行为与刷新分类。不把轮询开关、延长超时、重试、Core API 或诊断日志加入交付设计。

## 当前验证检查点

当前已观察检查点：生产候选仍为产物 `b6ec1bb9…`（12 文件 tree `4dd28184…`），正常验证记录 148 项测试通过。独立验收 harness tree `7220217e…` 的 14 项 helper 合同测试以及 build、typecheck、针对性零警告 lint、格式检查通过；两者范围分离，不是 162 项应用测试。更强的 Sources 列表准入 predicate 和生命周期观测只改变 harness，不改变该生产产物、输入或预算。

| 当前已观察 profile | 完整公开 Source 整案 | 公开自然退出           | 模型 HTTP |
| ------------------ | -------------------- | ---------------------- | --------- |
| Strict Bun/OpenTUI | 1 PASS               | 2 次 exit 0 / signal 0 | 0         |
| Bun/Ink            | 1 PASS               | 2 次 exit 0 / signal 0 | 0         |
| Node/Ink           | 1 PASS               | 2 次 exit 0 / signal 0 | 0         |

这三次执行达到 A 批准/B 拒绝、partial 状态与选择清空、明确仅重选 B/重新同意、精确持久 metadata/commands 及热冷补全，并保留 publisher 保护。Git/catalog 流量独立于模型 HTTP，且不为零。覆盖仅限 command-only HTTP catalog→Git fixture，不包含本地目录 publisher 或 hook-sensitive Source 路线。此前 `2a86` 失败以及同一 `b6ec` 的 Native 冷启动超时、Bun/Ink Sources 详情准入失败均保持原记录；新通过不证明这些失败已修复，也不解释其原因。已安装 global Ink 的冷退出失败也仍未关闭。

Bun/Ink 冷启动的 observer spawn-marker→ready 区间为 27.177843 秒，接近未改的本地 30 秒 ready 窗口。该时钟属于 harness observer 进程，spawn marker 在 PTY 创建后发出，因此不是完整进程初始化时长或精确 deadline 余量。同步 raw-output/lifecycle 文件写入可能扰动调度。每 profile 单次通过不证明启动失败频率、稳定性、性能改善或无观测 I/O 的结果。Config 修改仍需 Tier 2 维护者审查；跨平台/native 事件稳定性、最终 main 验收及整体迁移完成均未取得资格。

## 现有所有权与调用方

一个 watcher 实例捕获所选 Config 与刷新状态。`llm.tsx` 创建并启动它、注册会重启它的扩展状态通知，并在清理时停止它。mutation 抑制结束调用 `restartAfterMutation`；扩展目录缺失时的 bootstrap 也请求重启。以上路径必须共享同一生命周期授权。其他 settings/LSP watcher 不属于本次修改。

## 候选合同

- 主 chokidar watcher 仅监测 extension/link 根。Chokidar 4 即使接收 state 父目录，也会创建子 handle 并可能在原子替换时重新绑定；只把根字符串改成父目录不能消除该生命周期成本。
- 另用公开 `fs.watch` 监测稳定 state 父目录。精确过滤 state basename；filename 为 null 时保守重读当前 state generation。`state.json` 原子替换不改变父目录身份，不应重建健康 extension/link watcher。忽略无关兄弟文件。
- state 父目录缺失时，监测最近现存祖先，目录逐步创建后向目标父目录重新布防。父目录替换、watcher 错误或 stop 撤销旧回调；不得回退到其他 Config/store。独立保留现有扩展目录缺失 bootstrap。
- 仅在主 watcher 已 ready、健康、manager 匹配且每个 extension/link 根真实目录身份（device、inode、type）匹配时复用。路径字符串相同不足以证明。复用时重新计算元数据与 stale 文件引用，不递增现有有效回调的 generation。
- 真实 root/link/parent 身份变化、watcher 不健康或 manager 替换，应进行对应重建。保留 `followSymlinks: false` 与现有配置 link-source 解释，不扩大文件系统所有权。
- 同 manager 下的重建必须保留活跃 mutation suppression ID 及其完成授权。仅为重建就释放它们可能漏掉或重排最终通知。显式 stop 或 manager 替换才释放旧 manager 的 listener/抑制，且防止旧回调复活。
- `stopWatching` 撤销 main/state/bootstrap 回调、释放 listener/poller，并对全部自有 watcher 各关闭一次。不引入新开关、轮询覆盖、Core API 或通用 handoff 框架。实现以当前 literal 目录的 lstat/realpath/device/inode/mode 和 ready/health 状态决定复用；symlink 或未知身份仍附着监测，但不复用旧 handle。

首个可读数值 state 快照仅建立 baseline，不触发刷新，无论 generation 是 0、1 或其他合法数值。重新布防前捕获是否已有 baseline：重启 poll 刚建立首快照时，不应立即再强制通知。若先前已有 baseline，父目录替换仍需强制走原 state-event 分类；删除或不可读快照保留保守通知路径。现有抑制与刷新状态去重不变。

## 接受前验证

保留现有分类、抑制、bootstrap 和清理测试。将规定无条件重启的测试改为证明健康同根复用且元数据刷新的行为测试，不删除其实际通知断言。补充 state 原子替换不重启主 watcher、忽略兄弟文件/null filename、父目录缺失时祖先重新布防、物理 root/parent 替换、link 根新增/移除或改目标、ready 前/出错回退、同 manager 活跃抑制保留、manager 替换、stop/restart 和旧回调的针对性用例。mock chokidar 的测试证明生命周期调用，不证明 native FSEvents 性能。

验收要求完成正常 build/type/相关 whole 测试/lint/format/bundle，再用同一产物运行完整 Source 场景的 Native、Bun+Ink、Node+Ink，业务断言和预算不变；已执行检查点见上节。保留之前失败。保存的 6.3666 秒区间支持调查可避免的生命周期成本，不是吞吐基准，也不能替代完整产品场景。

## 待决事项

当前实现包含 literal 目录身份、ready/health、祖先重新布防、同 manager 抑制保留与 first-baseline 保护；其平台行为与复杂度仍需独立审查和维护者裁决。如果保持语义需要不成比例的生命周期机制，应拒绝该设计，选择更小且经验证的方案。整体迁移、平台批准和默认 renderer 切换不属于本增量。
