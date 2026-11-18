# 已安装 OpenTUI 分发验收

[English](opentui-installed-distribution-acceptance.md) | [简体中文](opentui-installed-distribution-acceptance.zh-CN.md)

## 状态与问题

**实现候选，2026-10-26。本机开发验证已完成；随后新增的 CI 接线及最终交付候选仍待验证。** 本文是一批完整安装分发验收方案，基于 main `18e1b2a991d819dba8e4d646eb2d54187269a775`，不把历史 PASS 用作当前候选证据。承接 [POSIX npm 分发设计](2026-10-21-opentui-npm-distribution.zh-CN.md)与[迁移交付计划](2026-10-20-opentui-migration-delivery.zh-CN.md)。

本批之前，永久安装套件在 Darwin arm64 或 GNU Linux x64 上，使用真实 Node 26.4.0 验证全新 local-prefix `npm install --ignore-scripts`。它审计真实 npm tarball、私有 Bun/native 加载、六项拒绝控制、读屏回退，以及真实 npm 子进程查询合成 registry。原有场景未覆盖 global bin、真实 npx、另两个声明的 POSIX 目标、Node 22 或已发布版本的更新激活。新套件增加两个固定 Node 工具链下的真实 global/npx；公开 registry 与已发布升级仍分别留证。构建、源码或 fixture 通过不能填补这些缺口。

classic 与 preview 安装器是不同路线。变更前两个 preview 脚本均先删除现有 preview 目标，再解压，截断归档导致旧入口和数据删除已复现为 FAIL。修复仅用于 staging 或替换失败时保留已有 preview 安装；本机 POSIX 回归已执行，Windows 实跑仍待完成，不新增包管理器，也不把 preview 改成正式默认支持。

## 目标与边界

保持 OpenTUI 0.5.10 与 shipping Bun 1.4.4。保持 Node 作为 npm launcher 和包管理解释器、既有监督交接、默认 Ink、读屏回退与更新器所有权。不引入 runtime selector、全局 Bun 要求、启动下载、新发布包族、通用测试框架、Windows npm 私有 Bun 或 musl 支持。

将永久真实布局验收、有边界的 preview 失败保护修复、双向链接的测试计划及精确源码/产物凭据作为一个完整审查批次。每个交付 PR 对实际 base 的新增加删除不超过 6000 行。不删唯一断言，也不把每个平台或场景拆成独立 PR 来凑上限。

## 路线与适用性

| 路线                                                       | 声明行为                                                 | 所需验收                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Darwin arm64/x64、GNU Linux arm64/x64 的 npm global 与 npx | 显式交互 OpenTUI 使用安装自带的私有 Bun；npm 保持原 Node | 真实 bin/cache 入口、native/parser 与进程所有权、回退/拒绝及更新所有权 |
| 四个 POSIX 目标和 win-x64 的 classic standalone            | 打包 Node/Ink 保持兼容路线                               | 实际安装与生命周期、归档/runtime 完整性、strict OpenTUI 拒绝及更新保护 |
| 五个目标的 Bun standalone preview                          | 携带 Bun/native 资产的 gated preview 归档                | 平台资格与发布范围裁决；现有设计仍排除 Windows Bun PTY                 |
| Windows npm、Linux musl 与其他不支持 CPU                   | 不执行 npm 私有 Bun 交接                                 | 普通 Node/Ink 兼容与 strict 明确拒绝，不暗中新增正向 OpenTUI 支持      |

原有 180 条计划义务完整保留：117 格涉及已声明路线，45 格涉及有条件 preview，18 格涉及 Windows npm 兼容/拒绝。这只是适用性提案，不是 PASS、政策豁免或删除用户合同。root/维护者裁决模糊预期后才能修改正式矩阵。不支持的笛卡尔积不转成新增实现义务。

## 验收工具与工具链设计

复用当前 installed 套件、进程观察器与 `InteractiveSession`。只将真正重复的 pack/inventory、工具链、安装 receipt 与自有进程管理提取为一个 installed fixture，供既有套件及新分发/更新用例共同使用。场景断言保持明确，保留零重试、串行、有限预算及原失败。

使用固定真实 Node 22.23.2 和 Node 26.4.0，各自配属其工具链的 npm。记录可执行路径、版本、hash 和 mode。构建所用 Node 24 不等于 Node 22 产品验证。四个原生 POSIX runner、两个调用 Node 版本、两个安装布局及启用/禁用安装脚本构成 32 个真实布局/工具链/生命周期上下文；缺 runner 就记 NOT_RUN，不静默 skip。Linux runner 必须证明 glibc 可用。共享产物仅在源码或输入变化时重建，不为每条断言重建。

global 使用真实 npm global 安装到自有 prefix。通过该 npm 查询全局包根，不假设 local-prefix 的 `node_modules` 布局；以受控 PATH 调用已安装 bin，并验证 realpath 和实际 Node 进程。npx 使用该工具链的真实 `npm exec`/npx，在空工作区和自有 `HOME/.npm` cache 中调用精确 tarball。记录选中的 `_npx` 安装及其产物身份，不能取搜索到的第一个目录。不能用 local 安装伪造 cache 树。

当前 npx 分类器识别 `/.npm/_npx` 和 `/npm/_npx`。其他形状的自定义 cache 必须先重现，再宣称缺陷或修改生产行为。保留该风险，不注入虚假安装身份让测试通过。

## Canonical CI 产物与开发证据

既有 GNU Linux x64 安装 job 保持为单一打包生产者。原九个场景的断言和 receipt 不变；同样的 tarball 审计成功后，额外导出发布文件 inventory 与源码 receipt。只有生产者成功才上传这些文件与 tarball。四个原生目标下载相同字节。小型 binder 对照原件检查 tarball/inventory 的 hash、字节数及实际 checkout commit/diff，再只在新 receipt 中重绑两个本地路径。不改 canonical 原件，不运行包管理器。每个 host 用固定 Node 22.23.2/26.4.0 串行执行两条完整十二案，输出独立，bound artifact 相同。第一腿失败则第二腿为 NOT_RUN；不忽略或重试失败及未处理错误。

Hosted 标签为 `ubuntu-24.04`、`ubuntu-24.04-arm`、`macos-15` 和 `macos-15-intel`，显式断言实际 platform/CPU 与 Linux glibc。[官方 runner 清单](https://github.com/actions/runner-images/blob/6d35e16176367288d91febefafbd221cb2da6ca1/README.md)中存在标签，不证明仓库有调度权限或原生执行成功。Canonical 和每个 host 的证据 artifact 名包含 run 与 attempt 身份。Windows 安装器失败出口包含两份完整安装文件，允许 warning 的广泛 scripts 套件不能吞掉 preview 失败。既有 merge queue/schedule/dispatch 信任策略不变，普通 PR 不自动构成 Windows 证据。八个通用 preview 场景可在该平台执行，三个 POSIX 专属场景仍明确跳过。

本轮 CI 接线前，在 Darwin arm64 上以 main `18e1b2a991d819dba8e4d646eb2d54187269a775` 加未提交分发改动，build、包含 integration 的 typecheck、lint 与 bundle 均通过。两份安装器整文件得到 148P、11 项原平台跳过。一次审计 tarball 含 1,375 个发布文件；原安装九案与两个真实 Node 各自新增十二案均通过，共 33 个产品场景、无失败或跳过。每条新增十二案执行期间，source/runtime/controller 和完整产物守卫不变，无超时、强制清理或自有进程残留。这些仅是精确接线前候选的开发证据，不证明后续接线、未来 commit、其他平台或已发布升级通过。最终交付须绑定自己的精确源码与产物证据。原截断归档删除 FAIL 与不变 oracle 的修复 PASS 分别保留。

## 产品与失败合同

正向用例必须具备 TTY、strict OpenTUI、真实安装自带 Bun/native 映射、parser/高亮输出、已关闭的模型请求及无自有进程存活的自然退出。仅 `--version`、源码 bundle 或 wrapper 日志不够。npm 操作保持原 Node 身份，观察全部子进程启动和退出。

验证普通安装与 `--ignore-scripts`、无全局 Bun、诱饵 Bun、真实 `--omit=optional` 安装、Bun 缺失/不可执行、native/grammar 资产缺失、禁止 relaunch 与继承 runtime flags。strict 失败和 nonstrict 可用 Ink 回退是独立断言。读屏、headless/protocol/help/version 保持既有行为。只读行为必须使用真实受限权限，不能在不受限身份下 chmod 后冒充。

冻结源码、tarball、工具链和初始安装 inventory。更新用例仅允许声明的 staging/version/pointer 路径变化，不能整体关闭不可变守卫。记录进程出生身份，避免 PID 重用被误判为自有残留。强制清理属于失败证据，不是自然退出验收。

## 更新、认证与 preview 保护

测试真实已发布源版本安装、产品更新入口、staging/activation 及从原 global launcher 再次进入。核对 base version/ctime 与 launcher 身份、选定 version 目录/pointer、真实新可执行文件/资产、用户数据保留及旧活动会话隔离。直接运行新 payload 不证明激活。下载、认证、版本不符、CLI 不完整或 smoke 失败后，原可用安装和 active pointer 必须仍可使用，仅清理自有 staging。

npx 当前声明不适用更新。其验收是显式旧/新版本 cache 调用及失败候选隔离，不修改 global 或无关 cache。不能为测试方便给 npx 新增受管自更新。失败更新保留旧版与用户显式降级是不同合同，不豁免或替换既有 keep-highest 激活规则；降级/回滚政策需要维护者裁决。

用户已明确只使用公开 `https://registry.npmjs.org/`：真实匿名 metadata、下载、安装及适用的更新构成最终 registry 路线。保留原 Node/npm 配置及配置传递回归；不需要也未授权私有 registry、新凭证或发布权限。本地 registry 可提供确定性的候选/失败及合成配置用例，但须保留合成属性。真实旧 release 加合成候选 endpoint，不等于公开 registry 的 released-to-released 升级证明。不发布候选、不改 dist-tag，也不伪造版本以宣称这项证据。

preview 脚本解压到自有同级 staging 目录，触碰活动目标前校验预期 target 的 launcher/runtime/package 结构，staging 成功后才替换。解压、验证或激活失败均保留或恢复旧 preview，classic 安装与 PATH 不变。POSIX 与 PowerShell 行为一致，不引入新更新器、锁服务或持久 runtime cache。保留已文档化的本地 `--archive` checksum bypass，并明确该输入未验证，不能悄悄视作可信 release 来源。归档信任、路径/link 处理与替换清理必须补回归，再定稿实现。

## Release 来源与证据

2026-10-26 读取的 GitHub 元数据显示 CLI stable [v0.26.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.26.1) 于 2026-10-24 发布，含五个 classic 归档、五个 preview 归档和 `SHA256SUMS`；[v0.26.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.26.0) 是另一已发布源版本候选。这份 GitHub 清单只是元数据：release 资产的下载、hash 和实际可执行性仍为 NOT_RUN。GitHub `releases/latest` 当前指向 SDK release，不能用通用 latest endpoint 选择 CLI 基线。

本 checkout 也声明版本 0.26.1，同版本候选字节不等于已发布包。公开 npm 对 0.26.0 与 0.26.1 的匿名 metadata 读取已通过：公开 0.26.0 没有私有 Bun optional 依赖，公开 0.26.1 的四个 POSIX Bun 包固定为 1.3.14，与当前源码候选的 1.4.4 不同。显式选择源 release、候选源码/版本及允许的 endpoint；现有公开 release 的下载、完整性和更新激活仍需受控执行验证，验收不包含任何发布操作。真实 release、未发布候选、本地 fixture、真实公开 registry 访问及跨平台证据分别记录。

每个 attempt 记录 source commit/tree、产物 hash 与文件审计、target/libc、调用 Node/npm 和私有 Bun/native 身份、实际入口/cache、安装 flags、输出/断言、精确退出/清理及不可变前后 map。按原范围保留 FAIL、SKIP、NOT_RUN，不拼接不同候选的成功行作为最终验收。

## 验证与验收条件

1. 冻结最终源码与打包输入，审计一个真实 npm pack 和对应 target 归档，执行前对齐英中设计与 E2E 计划。
2. 按项目流程先跑既有永久用例及全局 CLI baseline，记录精确版本及不可用基线；baseline 不转成候选通过。
3. 运行受影响 build/typecheck 和聚焦测试，再在声明的原生 runner 与固定 Node 工具链上执行真实 global/npx 上下文。保留既有九案范围，新增证据而不重命名旧结果。
4. 执行真实更新激活/失败保护、npx cache 转换、认证边界及两个 preview 脚本失败路径。Windows classic 与 gated preview、其 PTY 限制分别核定。
5. 完整最终 diff 与证据经过连续两次干净审计后统一送审。缺 runner、release 或认证证据明确保持开放，验收工具合并不等于整体迁移完成。

全部 180 条义务及人工 IME、剪贴板/设备、无障碍与终端生命周期合同继续跟踪。默认 runtime/renderer、发布 rollout 和 Ink 移除仍需独立验收门槛与维护者批准，本批不改变这些政策。

## 待裁决事项

- 其余原生 POSIX 与 Windows runner 的实际调度和执行；本机 Node 22.23.2/26.4.0 证据不能关闭这些格。公开匿名 registry 的用户选择已解决。
- 精确源 release 包/归档及候选 endpoint/版本，现有公开 release 的下载、完整性和激活仍待验证。
- preview 范围与 Windows PTY 预期，不从存在归档推导完整 preview 对齐。
- npx 自定义 cache 分类重现与显式降级/回滚政策。
- 最终安装产品与合成 fixture 的边界，以及仍未关闭的平台、人工和默认门槛。
