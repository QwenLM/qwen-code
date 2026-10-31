# Windows preview 启动器 fixture 环境

[English](2026-10-30-windows-preview-launch-diagnostic.md) | [简体中文](2026-10-30-windows-preview-launch-diagnostic.zh-CN.md)

## 问题与已观测基线

[原 Windows ECS 场景](https://github.com/QwenLM/qwen-code/actions/runs/41002095690/job/123897020864) 先拒绝故意截断的归档，再通过旧安装树保持不变的比较。随后启动保留的 `qwen.cmd` 时，stdout 为空而非 `OLD_PREVIEW`。这不能证明安装器删了文件。

[hosted Windows 安装前诊断](https://github.com/chiga0/qwen-code/actions/runs/41030003395/job/123977212631) 在 `515b8d67` 上、尚未调用任何安装器时复现了 stdout 为空。PowerShell 包装进程 status 为 0、signal 为 null、error 为 null。fixture 未传 `PATHEXT`，父进程包含 `.CMD`，子进程却仅报告 `.CPL`。Node 为 `v22.23.4`，Windows PowerShell 为 `5.1.20348.5756`。原样 `OLD_PREVIEW` 断言失败。这是真实 RED 观测，不是启动器或安装器合格结论。

后续 [Windows 运行](https://github.com/chiga0/qwen-code/actions/runs/41031170132) 在 `0bbcad` 上继承了父进程实际 `PATHEXT`。raw stdout 已为 `OLD_PREVIEW`，两种启动检查及无 staging 检查均完成，但用例仍失败：两次启动后，受保护的 fixture HOME 下出现了 `AppData/Local/Microsoft/Windows/PowerShell/StartupProfileData-NonInteractive` 和 roaming 目录，`.profile` 保持不变。完整文件结果为 1 失败、3 个声明的 POSIX 跳过；其他用例因 bail 未执行。这仍是 fixture 保护失败，不是完整文件通过。

## 候选改动与范围

在仅 Windows 使用的 fixture 环境中，与 `SystemRoot`、`ComSpec` 一起保留父进程实际的 `PATHEXT`。不编造默认扩展名列表，不放宽 stdout 断言，不修改安装器。第二次 Windows 观测确认该候选恢复了启动器输出，但随后 HOME 保护失败仍未解决。所有早期失败均保留。

保留安装前用例的两种独立启动观测：先运行原 PowerShell 表达式，通过六条 `QWEN_DIAG_` stderr 记录给出原四项 `PATHEXT`、`COMSPEC`、`SYSTEMROOT`、PowerShell 版本，以及真实 `GetFolderPath(LocalApplicationData)` 和 `GetFolderPath(ApplicationData)` 路径；只有它合格后，才执行严格旧安装检查。保存完整进程 error、signal、status、stdout、stderr。要求 trim 后 stdout 为 `OLD_PREVIEW`，每种诊断记录恰好一条（值允许为空），没有额外 stderr。第二个检查要求原生命令退出码，保留安装树断言并确认没有 staging 目录。这两项检查调用**零次安装器**、最多两个启动进程，此外还有下文所述的一次 fixture-readiness 启动，不重试。其他保护用例另行执行真实安装器。

后续 `329ccc` 候选尝试将 `APPDATA`、`LOCALAPPDATA` 指向两个任意 owned 环境路径。真实 known-folder 观测中 LocalApplicationData 为空，ApplicationData 仍位于 HOME 下，因此精确路由断言在安装器执行前失败。保留该失败。移除缺乏依据的环境覆盖、额外目录和路由相等断言；六条 raw 诊断记录仍是观测，不作为重定向合同。

下一候选在每个 Windows fixture 中完成 seed 后、任何归档创建或安装器调用前，只通过原有严格公开旧启动器检查初始化一次。要求输出精确为 `OLD_PREVIEW`、status 为 0、stderr 为空。将完整冷 HOME 图、初始化后 HOME 图以及全部新增条目保存到结构化测试日志。每个原有冷图条目的类型、mode、hash、link target 均须保持。之后才一次冻结包含全部初始化内容的 HOME 作为保护基线。初始化由 fixture 返回的方法承载，在 `withFixture` 现有 `try` 内、测试动作前只调用一次，因此 readiness 或原条目检查失败也会进入原 `finally` 清理 owned 根目录；不捕获或吞掉首个错误。HOME 与 USERPROFILE 仍为同一 owned 目录，不拆分 profile，不排除缓存。后续 `575d` 的真实 Windows 运行仍失败：readiness 仅新增 AppData、Local、Roaming，之后零安装器的两次启动又新增 Microsoft、Windows、PowerShell 目录和 `StartupProfileData-NonInteractive` 文件。保留原 whole-HOME 失败，不再增加 warmup 或等待来追求缓存稳定。

新合同明确为用户数据保护加精确 OS 派生新增域，不再声称整个 HOME 完全相同。冷图与初始化基线中的全部已有条目（包括已存在的同名缓存）仍要求类型、完整 mode、文件 bytes/hash 或 link target 完全相同。只允许两份基线均无的四个精确相对路径新增：`AppData/Local/Microsoft`、其下 `Windows`、其下 `PowerShell` 三个目录及其下 `StartupProfileData-NonInteractive` 常规文件。父链必须为真实目录，不跟随链接；同名目录冒充文件、任何链接、其他新增、修改或删除均拒绝。完整冷图、初始化图、当前图及派生域 before/after 行单独保存到结构化日志。常规文件记录 lstat 类型、完整 mode、bytes、SHA；目录记录类型和完整 mode，没有文件内容 bytes/SHA。

实际零安装器控制说明这些路径可在 host 启动期间出现，不能证明唯一写入者 PID。若安装器也写入同一精确新增域，纯图比较无法区分；本合同不作这一归因。便携合同测试用同一个真实验证 helper，正向验证仅四个精确新增，负向验证 `.profile` 改动、无关新增、冒名目录、缓存链接、父链链接及基线已有缓存变化。所有四次历史失败保持失败。

这表示先建立 profile 已初始化、旧安装可公开启动的初态，再测试安装器保护；不能证明全新 HOME 不会收到 PowerShell host 写入。安装前用例包含 fixture setup 的一次 readiness 启动，再执行原有两种诊断/检查启动，仍为零次安装器且无重试。其他保护用例的每个 Windows fixture 也恰好执行一次 readiness 启动。

现有 `windows-runner-smoke.yml` 保留布尔输入 `preview_launch_diagnostic`，默认 `false`。默认完整 ECS 任务及其预装 Node 路径保持。`true` 模式现在**一次运行完整 preview 安装器测试文件**（12 个安装器/诊断用例加七个便携合同用例），不使用测试名过滤；它不再表示只运行单个零安装器工作流任务。完整文件包含安装前用例及原保护场景，保留各自断言和声明的平台跳过，不运行全仓测试或构建 workspaces。当前文件注册 19 个用例，预期 Windows 执行 16 个并声明三个 POSIX 跳过，仍以实际验证为准。

该聚焦 hosted `windows-2022` 任务使用 Node 22、共享 Windows 环境 action、精确 checkout 验证、冻结且带 `--ignore-scripts` 的依赖安装、零重试、单 worker、15 分钟限制及始终上传的日志。工作流元测试保护用例选择、错误传播及原默认 ECS 路径。五文件改动仅涉及 fixture/诊断测试、工作流、对应元测试和这两份设计文档。

## 验证与限制

通过 `scripts/tests/vitest.config.ts` 运行完整脚本测试及工作流元测试文件，并执行格式和适用的静态检查。macOS 可以验证 POSIX 场景与工作流接线；Windows 专用用例在此跳过不能算 Windows 证据。

审查后，在精确候选分支调用工作流并设置 `preview_launch_diagnostic=true`。记录真实 checkout、runner、Node、PowerShell，检查原始启动记录，报告完整文件实际通过/失败/跳过数量。首个 raw 启动仍须满足原 `OLD_PREVIEW` oracle，之后才运行严格检查；安装器场景仍必须满足安装树保护及 staging 断言。便携 map 测试不能证明 hosted Windows 或安装器行为；下文精确 `b79e4f1` 的 Windows 结果与后续集成 head 的验证分开。

hosted Windows 不是原 ECS 主机。新的完整文件成功只能资格化已记录候选/环境下的 fixture 与保护测试文件，不代表全部 Windows 产品行为通过，也不改变原 ECS 结果。本改动不改变生产默认值、renderer、release 或安装器行为。

## Windows host 启动预算候选与已观测失败

业务候选以 `b8c4` 为父提交，保留完整文件的 true-mode 选择及原无过滤元测试；不包含独立 trace 分支的新诊断用例、过滤器或 wrapper。`b8c4` 的运行 `41043639528` 是 1P、1F、3 个声明跳过、14 个 bail 未达：安装前用例已通过，但原直接 `-File` 截断归档调用在 15 秒超时。原失败保持。

独立 `f7afa` trace 运行 `41046485345` 仅观察成功：相同 4B ZIP、未改生产脚本的不同 wrapper invocation 在 18.7142938 秒取得 status 1、signal null、无 spawn error，trace 到 `ZipFile.OpenRead` 的 Central Directory 损坏异常和 stage/lock 清理路径。它没有逐阶段时间，不能定位原 15 秒耗在哪，也不能把 trace 当原调用通过。

据此为 Windows PowerShell host 调用保留合理启动余量：现有 checked helper 只在 Windows 将 15 秒改为 60 秒；POSIX 仍为 15 秒。九个 Windows 可执行保护用例显式设 120 秒，容纳依序 readiness、归档构造、原直接安装器和旧启动器检查；POSIX 仍继承原 90 秒配置或环境覆盖。独立 raw 安装前观测的 15 秒不变，工作流仍为 15 分钟。这里选择余量是工程预算调整，不是证明原首因或需要时长，更不是增加重试。

生产脚本、4B/错误归档、原 `-File` argv、退出码拒绝、旧安装树、用户条目及精确派生新增域、PATH、兄弟目录和 staging 断言完全不变。下一必须在新精确候选上真实执行完整 19 用例；预期 Windows 16 执行、3 个 POSIX 跳过仍以实际结果为准。若 60 秒仍超时就保留失败，不自动再加时。该候选不声称原 15 秒合同通过或整个迁移完成。

## Owned 模块分析缓存与已记录的 Windows 验证

`feba764` 的[后续 Windows 运行](https://github.com/chiga0/qwen-code/actions/runs/41048926251/job/124039861107) 通过了零安装器的安装前场景。截断归档场景到达语义非零拒绝、旧安装树比较、`OLD_PREVIEW` 重启及无 staging 断言，随后在未改的 HOME 守卫失败：`AppData/Local/Microsoft/Windows/PowerShell/ModuleAnalysisCache` 是预期域外新增常规文件。原初始化条目保持不变。写入者 PID 仍未知，文件名不能证明安装器或 PowerShell 归属。完整文件结果为 1 通过、1 失败、3 个声明的 POSIX 跳过及 14 个 bail 未达。保留原失败和四路径新增域。

[Microsoft 的 Windows PowerShell 5.1 官方文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1?view=powershell-5.1#module-analysis-cache) 明确支持在启动前将 `PSModuleAnalysisCachePath` 设为可写完整文件名，并说明模块导入后可由后台线程写缓存。每个 Windows fixture 使用该受支持控制，指向现有 owned `root/tmp/ModuleAnalysisCache`。不禁用缓存、不使用 `NUL`、不增加 warmup、不改 HOME/USERPROFILE。文档支持候选路由机制，不证明此前文件的写入者。

保留原六条 raw stderr 观测，增加第七条 `MODULE_ANALYSIS_CACHE`，由实际 PowerShell 子进程读取其环境。要求总共恰好七条、每个名称一条，并将新增记录值与计划的 owned 完整路径严格比较；结构化证据也记录配置路径。原字段仍允许空值，但新增路由值不能偏离计划。该受支持路径在 fixture readiness、raw 启动和安装器启动前均已设置。它是正常可写缓存位置，是否生成缓存是可选观测，不通过额外模块导入或 sleep 强制生成。

不将 ModuleAnalysisCache 加入 HOME 白名单；四个精确允许新增域、全部已有条目检查、安装器脚本/参数、timeout 预算、PATH 与 staging 保护均不变。新 Windows 运行必须资格化实际 child 值及原完整 HOME 保护；仅环境见证通过不能证明保护通过。[精确 `b79e4f1` 的 Windows 运行](https://github.com/chiga0/qwen-code/actions/runs/41053808623/job/124056178125) 已通过完整文件：九个 Windows 业务用例、七个便携 map 用例、三个声明的 POSIX 跳过、零失败。实际观测全部七条 child 记录；已有初始化 HOME 条目不变，每个到达用例仅新增四个允许条目，HOME 无 ModuleAnalysisCache。这仅资格化 Node 22.23.4/Windows PowerShell 5.1.20348.5756 下的受控合成包 fixture，不代表 release artifact、真实 Bun ABI/TUI 或完整 Windows 验收。随后合并 main gate `cc6de38` 保持 fixture 字节，但该集成 head 本身尚未运行；仍须对应 workflow/meta 检查与精确 head CI。历史失败保持失败。
