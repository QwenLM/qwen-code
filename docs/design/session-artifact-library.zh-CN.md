# 持久化会话产物管理

[English](session-artifact-library.md) | [简体中文](session-artifact-library.zh-CN.md)

## 问题与范围

DAC 需要实例内统一产物专区，覆盖运行中、未加载及已归档的会话。现有产物路由要求会话已经加载，写入还要求绑定的客户端。为了浏览产物而加载全部历史对话会额外创建 agent 并改变运行状态。

## 设计

新增持久化工作目录作用域的 `GET /workspaces/:workspace/session/:id/artifact-library` 和 `DELETE /workspaces/:workspace/session/:id/artifact-library/:artifactId`，仅在产物持久化可用时发布 `session_artifact_library`。既有运行中会话和客户端所有权接口合同不变。管理删除接口经过现有 strict mutation guard 和显式解析的可信工作目录，代表工作目录所有者移除登记，包括客户端创建的产物，不伪造客户端身份。接口不发提示词、不 attach、不取消归档、不删除 workspace 文件。

运行中产物从所属 runtime bridge 读取。冷会话与归档会话通过 SessionService 读取，核验存储身份、项目归属、完整记录及当前对话分支。首次 prompt 前登记产物的会话可能只有产物事件与标题/来源元数据，没有对话主链，仍应正常读取。持久化记录复用既有产物校验和公开字段投影，禁止读取过程中写 snapshot 引用或启动 agent。单份 transcript 上限 64 MiB，损坏或不可用必须显式报告。

删除时持有 session archive coordinator 排他锁，避免 load/archive/delete 竞态。运行中删除经独立的所有者管理 bridge 方法，复用 store 队列、持久化与事件。冷会话删除获取 daemon writer lease（归档存储使用既有 maintenance lease），重新核对文件身份后追加原生 artifact event，记录 explicit tombstone 和原 marker。父节点取重建后的当前对话尾部，不能使用可能为来源快照等旁路元数据的物理尾记录，否则产物恢复会漏掉删除事件。失败时登记仍可见。managed execution transcript 保留自己的权威链路，拒绝 legacy 写入。产物不存在时幂等成功；会话不存在或存储冲突时报错。不重写 transcript，不另建元数据权威。

## 影响组件

- `packages/core/src/services/sessionService.ts`：有界快照读取与受保护的冷会话 tombstone。
- `packages/acp-bridge/src/sessionArtifacts.ts`、`session-control-plane.ts`、`bridgeTypes.ts`：只读投影与显式 workspace owner 删除。
- `packages/cli/src/serve/server/session-artifact-library.ts`、routes 与 capabilities：runtime 归属、锁、生命周期和能力协商。
- DAC 使用现有带认证的 daemon facade 调用；视图/置顶偏好及可选磁盘文件删除由产品 UI 管理。

## 验证与验收

覆盖 live/cold/archived 读取、删除后重载不复现、归档与历史不变、不 attach/spawn、owner/client 边界、workspace 错配、损坏、并发 writer 拒绝和幂等性。执行受影响 package 测试、build、typecheck、bundle。临时 daemon HTTP 测试对比全局基线和本地 bundle，无模型调用、不使用真实用户会话。计划与结果位于 `.qwen/e2e-tests/session-artifact-library.md`。

## 风险与待确认事项

旧 daemon 不声明此能力，客户端必须显示升级状态，不能静默只返回 live 产物。超大或损坏 transcript 显示明确的部分失败。managed execution 登记写入不属于 legacy 持久化权限。

既有 session loader 对从未记录对话轮次、仅由 API 登记产物的会话，可能在恢复后丢失运行中产物视图；未修改的全局 CLI 已复现。新管理接口支持这类记录的冷读取和持久化删除，但本次不替换原有空对话加载链路。对需求中“对话生成产物”的恢复验收，通过正常 ChatRecordingService API 录入已完成轮次。此协议暂无待确认的产品决策。

## 归属与失败语义

两条路由在分派前解析全局 live 归属，拒绝归属歧义、不可用或由其他 runtime 持有的会话。内部 runtime 的活动屏障包围 shared/read 或 exclusive/remove 归档屏障。冷投影保留时间戳，对旧 pinned retention 降级并告警，使用 metadata-only 恢复状态，不误报持久化不可用。live 上限保持 200，冷读取不裁剪登记。

单产物兼容告警随部分读取返回，并允许移除已知登记；无法识别的版本、被截断的 journal 及过期序号告警拒绝写入。不完整记录或对话链返回 `session_transcript_corrupt`，并发物理变更仍使用 writer conflict 错误。空记录或其他工作目录的记录视为不存在；其他存储身份错误视为冲突。managed 写入拒绝消息明确描述产物操作。

冷会话无操作移除不返回虚假的 changes。tombstone 成功后，以 best-effort 方式释放未再使用的受管网页快照引用，并保留 workspace 文件。改名父节点跳过旁路记录，即使大型产物快照将对话尾部挤出首次读取窗口也不截断历史。live 持久化失败保留现有 HTTP 200 warning 结果，调用方必须检查结果后再从视图移除条目。
