# Skills 配置目录的自动发现

[English](skills-config-automatic-discovery.md) | [简体中文](skills-config-automatic-discovery.zh-CN.md)

## 问题与范围

Issue #15645：daemon 预热独立配置目录后，外部工具创建的合法项目 `SKILL.md`
能被 runtime 发现，管理端却看不到。provider 长期保留 `SkillManager`，只有配置
变更才使其失效。每次读取都会重新加载设置，但不会重新发现目录。

修复覆盖 `/workspace/config/skills`（legacy-primary）和
`/workspaces/:workspace/config/skills`（persisted-workspace）。管理目录仍独立于
child 和 session。向已有 session 应用变更、runtime 回退策略、扩展激活以及 core
发现语义不在本次范围内。

## 设计

只有 server 的两个配置 provider 启用 `autoDiscover`，其他调用方保留原有行为。
冷读取共享一次发现；热读取将保留的 manager 与重新加载的设置组合，不等待后台
文件系统工作。

受信任且非 safe 的目录使用 chokidar 订阅 project/user 目录，复用 runtime 的
`watcherIgnored` 和 `WATCHER_MAX_DEPTH` 策略。provider 内按目录共享订阅，多个
workspace 共用的 user 目录也只监听一次。事件经 150 ms 防抖后启动后台发现，
无需 GET；扫描期间到达的事件会合并为后续一次观察。

读取还会触发后台核对，从任务开始计时，最多每秒启动一次。该路径发现启动后
才创建的目录，覆盖丢失事件、watcher 失败，并在不持久监听不受信任 workspace
的前提下刷新 inert untrusted 目录。1 秒是启动节流，不是保证可见的期限。
没有被监听到变更的空闲目录，要在后续读取及一次成功扫描后才收敛。

每次后台观察都使用全新的临时 manager map。完整成功的结果原子替换保留的
manager。拒绝或不完整的发现（包括 `hasDiscoveryErrors()`）保留上一份目录。
每次热 GET 仍重新读取设置，启用/禁用变更不必等待发现窗口。首次发现保留既有
响应语义。

后台任务在 5 秒后释放共享槽，避免慢文件系统永久阻止重试；这不会取消底层
I/O。只要 workspace 代际仍有效，且没有更新的成功观察已发布，迟到的成功结果
仍可发布。发布顺序由启动序号决定，与完成时间和系统时钟无关；完成只清理自己
占用的槽。冷读取等待真实发现，不采用这个超时。

## 信任与生命周期

safe 目录保持仅 bundled。有效 safe-mode 变化时，在回答后续读取前丢弃原 manager
及订阅。inert untrusted 目录按已有策略读取清单，但不会加载 workspace 设置或
扩展，也不创建持久 watcher。watcher 不创建任何目录。

显式失效推进既有 epoch，删除 manager 和活跃的读取/刷新槽，取消防抖计时器，
移除该 workspace 的 watcher 订阅。workspace 删除复用此路径。已分离的扫描
之后不能再安装 manager 或 watcher；其他 workspace 的订阅继续保留。

provider 关闭先禁止新工作，再使所有 workspace 失效，包括仍在途的冷读取，
并关闭其拥有的 watcher。server 为外部传入和本地创建的 lifecycle 都注册该
清理，不改变其他 daemon 资源的所有权。一次性的 `snapshot()` 路径执行全新
发现，不启动 watcher 或后台任务。

## 取舍与归属

本实现替代 #15703，参考 2SinceJuly 的 watcher 方案、失败案例和回归场景。
core `SkillManager` 保持不变。后台全新构建扫描所有已启用层级，包括 bundled
和扩展元数据，避免在 core 中引入部分缓存发布。这增加了每次刷新的工作量，
由共享槽及启动节流限制；热读取仍使用缓存。挂起的操作系统 I/O 无法强制取消，
可能超出超时时间继续存在，但不能覆盖更新的成功观察。

本次不扩展 provider 既有的 `skills.directories` 缺失。因此不宣称所有 runtime
来源都已对齐，也不承诺已有 session 会自动采用新发现的 Skill。

## 验证与验收

- 独立复现基线的预热目录缺陷；先尝试全局 CLI，单独记录版本/API 限制。
- 使用构建后的 daemon，在无 child/session 时通过两条配置路由验证外部新增、
  编辑、删除及重新创建，并确认 workspace 隔离与并发读取。
- 验证无读取时的 watcher 发现、缺失目录的后台核对、连续刷新窗口、失败或
  不完整扫描，以及慢刷新恢复。
- 验证冷发现和后台工作期间的失效与关闭、迟到结果顺序、共享订阅和完整清理。
- 跨刷新周期保留每次读取设置、显式失效、snapshot 新鲜度、safe 模式仅 bundled
  及 inert untrusted 行为。
- 执行 build、bundle、typecheck 和针对性测试；完成两轮干净的全 diff 自审，
  并取得独立审阅。

验收依赖实测行为和检查记录。创建 PR 或 CI 通过不等于已部署或合并。
