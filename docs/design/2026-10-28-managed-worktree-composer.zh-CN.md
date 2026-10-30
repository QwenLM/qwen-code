# 输入框中的 Managed worktree 控件

[English](2026-10-28-managed-worktree-composer.md) | [简体中文](2026-10-28-managed-worktree-composer.zh-CN.md)

## 问题与范围

Managed 整行“会话文件”表单已复用 Local 的布局及稳定 Git 按钮样式，移至输入框下方的工作区旁。按钮显示实际当前 Git 分支，例如 main。用户要求像 daemon 一样简单选择 worktree：选择“Worktree 隔离”后，发送首条消息时创建独立 checkout，不填写起始 ref 表单。

## 分支契约与权限归属

为 WebShell worktree 选项新增可选可空 currentBranch，公开选项新增 current_branch。沿用已验证的仓库路径和原生 Git runner，读取所选源 checkout 的符号分支：有名分支返回真实名称，游离 checkout 返回 HEAD，无法安全检查时返回 null。该观察独立于所选 baseRef/baseCommit；在验证 worktree 起点前读取，避免无效起点或未产生提交的分支抹掉源分支。保留 actor 授权、存储 guard、部署开关及私有/不安全布局拒绝。不新增普通 daemon Git API、schema migration、写入或模型请求。

## 输入框行为

为所选 workspace/cwd 请求 Managed 选项，不发送 baseRef；即使不支持 worktree，当前模式也保持可用。按 workspace/cwd 绑定分支观察，中止旧选择的请求，刷新同一来源时保留匹配分支。切换模式或打开弹层时重新检查 worktree 支持情况。当前模式按钮显示观察到的分支；信息未知时使用通用文件控件，不猜测分支，也不把工作方式作为分支名。worktree 意图复用 daemon 的“Worktree 隔离”标签和紫色提示。

弹层复用 daemon 的 Git 模式/当前分支/Worktree 隔离标签、首条消息说明及稳定样式。只保留当前/worktree 选择和保留目录管理入口，两种选择均立即收起。worktree 意图提供同样的清除按钮，恢复当前分支。移除该选择中的起始 ref、提交和文件选择表单。新的隔离请求发送 worktree: {}，由已有服务在受理时解析当前 HEAD 并分配分支和目录。单纯选择不创建会话，也不请求模型。公开 API 保留已有显式起始 ref 能力。

关闭后仍可见检查状态和错误。繁忙、加载及待确认状态冻结编辑和清除按钮，不支持 worktree 时仍能切回当前模式。包括此次简化前指定起始 ref 的已有待确认请求，均按原存储载荷和幂等键重试。目标 worktree 就绪前不开放文件引用。受控打开状态继续设置输入框的 dialogOpen 和 disabled 保护焦点。共享 hook、daemon 行为、后端生命周期、授权和存储 guard 保持不变。

## 简化验收

验证选择 Worktree 后弹层收起、按钮变化、首条消息前没有创建，发送时携带 worktree: {} 和原输入。验证清除/当前模式、不可用时错误可见且不降级、管理入口、冻结重试（含旧显式起点）及工作区切换的旧分支响应拒绝。执行专项创建器和 Local 弹层测试、仓库 build/typecheck/bundle，并用构建前端配合已有后端在 Chrome 验证。此次仅修改前端，不新增 Java 打包/启动或重复 Java 测试；保留已有共享验证预算和后端证据。

## 会话信息位置

在首页聊天中，将已就绪 worktree 的状态、分支和起始提交放入现有会话详情卡，与目录/状态/ID 元数据一起展示。共享详情卡增加可选的纯展示内容插槽，由 Managed 导航行传入已有 worktree 状态渲染器。准备/删除中和受阻/失败状态仍在聊天上方简要提示，不展示分支和起始提交；已就绪时不再常驻 worktree 区块。独立 Managed 页面使用普通导航，没有详情卡，因此保留完整显示；worktree 管理器也保留完整信息。不新增 API 请求、状态流转或模型调用。验证卡片信息/ID 复制/portal、首页就绪与错误、独立页及管理器行为，再在 Chrome 检查已有就绪会话。

此信息位置调整通过受影响页面、导航行、worktree 管理器及共享详情卡测试中的 183 个独立用例，仓库 build/typecheck/bundle 及专项 lint/格式检查通过。Chrome 验证了用户已有的就绪会话：聊天上方没有就绪区块，详情卡包含完整状态/分支/起始提交。前端预览的深层链接 HTML 标记另在本地验证工具中修正，未重启后端或发起新模型轮次。完整 CI 及其他平台仍未验证。

## 验证与状态

此前布局增量通过仓库 build/typecheck/bundle、263 个输入框用例、18 个 Local 弹层用例及专项创建器用例，证据保留于本地 E2E 计划。已定位并修正 Node26.12.1 的 Storage.prototype 测试夹具不匹配。真实 Chrome 验证了布局、起始 ref 编辑、非 Git 切回及管理入口；这些结果没有证明真实分支标签，本次修正补齐此项。

基线确认原项目的原生 Git 返回 main，但已有选项响应没有 currentBranch。本次修正通过 29 个 Java 测试，覆盖原生 Git 分支与起点独立、嵌套路径、checkout 变化、游离及未提交分支、安全拒绝、camel/snake 响应投影、ManagedAgentApiContractTest 和 SurfaceRegistryGateTest。Checkstyle、打包及 WebShell 类型重新生成通过。287 个专项创建器/client/provider 测试全部通过，仓库 build、typecheck、bundle 及专项 ESLint 通过。

简化前，全新本机 runtime 返回 currentBranch=main，与原生 Git 一致。真实 Chrome 在 Managed 工作区旁显示 main，弹层内保留“当前目录/main”和“独立 worktree”。没有重启已有服务，项目内容和父目录标记保留。包含此前保留工作和新实例启动的 Java 相关验证共使用 186.33 秒，未超过共享 600 秒预算。未发送模型提示。这些是本地 macOS 证据，完整 CI 及其他平台仍未验证。

简化后的前端在适用的多次运行中通过全部 145 个创建器用例及 18 个 Local 弹层用例，仓库 build/typecheck/bundle 和专项格式/lint 检查通过。一次并发 SDK 构建导致的测试收集失败和两个新夹具不匹配已在验证配置中修正，受影响用例通过，无需修改生产行为。真实 Chrome 使用构建前端和已有后端，验证了简洁的两项选择、自动收起、紫色 Worktree 按钮、恢复 main 及保留目录管理。该浏览器检查未发送模型提示或修改 worktree；首条消息载荷和旧请求重试由 provider 测试验证。此次增量未修改后端文件或增加 Java 验证预算。
