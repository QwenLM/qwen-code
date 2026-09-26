# models.dev 模型目录交付计划

状态：实现与本地验证完成，远程检查跟随 PR #11959 的最终提交。原纯设计 PR #9851 已被[双语设计文档](../design/2026-08-23-models-dev-registry.md)替代并关闭。

## 最终范围

内置裁剪目录、后台刷新、ETag 与 24 小时缓存、镜像及关闭开关、上下文/输出/模态查询与正则回退。不引入 effort 元数据迁移、provider-aware 解析、跨进程锁或定时服务。

- 所有归一化候选都参与冲突检查，有分歧就回退，包括带日期和 provider 前缀的条目。
- 拒绝非正安全整数 token 上限及非布尔模态。
- 纠正 Sonnet 4.5 已退役的 1M beta 数据，保留 200,000 默认上限。
- qwen3.8-max 的 PDF 不自动从目录启用；内置和刷新数据均受此约束。用户可针对验证过的 endpoint 显式设置 `generationConfig.modalities.pdf`。
- 移除未发布的 `model.customCatalog` 及其进程全局叠加状态，避免首轮不生效和跨 Config 串用。私有/离线模型继续使用现有 `modelProviders`，不读取自定义目录缓存。

## 验收

真实 Config 验证覆盖 settings 和 modelProviders 两条路径：第一个会话首次初始化及认证后即得到显式 context=12,345、pdf=true；第二个会话使用默认 context=1,000,000、pdf 未启用，且不改变第一个会话。目录开关和真实缓存节流保持正常。

定向测试、build、typecheck、lint、两轮复核及远程 CI 结果记录在[验证记录](../verification/models-dev-catalog/README.md)和 PR 评论。已知不可靠的默认行为通过收窄范围移除，不以缺少凭证的 live 测试冒充通过。

## 后续边界

自定义目录如需恢复，应从会话作用域模型解析设计入手，不重新引入全局 source。自动启用 Qwen PDF 需要 provider/协议作用域能力解析和真实识别验证。两者均不属于本 PR 的交付承诺。
