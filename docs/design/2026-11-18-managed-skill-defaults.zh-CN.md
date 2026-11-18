# Managed Workspace 的默认 Skill

[English](2026-11-18-managed-skill-defaults.md) | [简体中文](2026-11-18-managed-skill-defaults.zh-CN.md)

宿主可在已有扩展源上实现 `ManagedSkillCatalogSource`。一次目录查询返回可信租户、Actor 和 Workspace 有权使用的精确 Skill 引用、编译目标、展示信息及默认安装标记。多个提供方按稳定顺序返回。发现目录不会发布包。

创建 Workspace Session 时，如果调用方未提供任何静态 Skill 且省略扩展 pin，MAS 通过现有的授权导入流程导入默认项，再一起准入其不可变 pin。默认项只面向具备扩展能力的创建：在调用提供方之前，创建先解析 Session 的 tool profile，要求已协商的 Shell 或 MCP lifecycle、已启用且具备自助准备能力的扩展，以及有权向非外部 Workspace 导入的 Actor。任一能力缺失时——例如 workspace shell 关闭时的默认 FILES profile——创建跳过发现并沿用原有行为，而不是先导入随后会被后续门禁拒绝的包。显式 pin 列表决定本次选择，包括空列表。已准入的默认项显式绑定解析出的 Workspace 并锁其行；未准入任何默认项的省略选择保留[锁清单](2026-11-12-managed-agent-lock-inventory.zh-CN.md)记录的默认 tenant scan 锁序，与默认切换的并发行为不变。省略静态 Skill 与传空列表保留原有幂等语义。已准入请求在调用提供方之前重放。创建会话时缓存的精确包版本可供其他有权用户复用。只有显式发布会更新 Workspace 目录的最新项。默认项导入失败会阻止会话准入。没有目录提供方的宿主沿用已有创建行为。

编译器从实际执行的归档生成独立 Skill 元数据。MAS 按包版本保存元数据，从会话初始 pin 投影带命名空间的名称和描述。准入时按 Hosted 的 UTF-8 字节限制校验编译元数据，并与已固定的 AgentDefinition 一起检查名称冲突。准备阶段展开扩展路径后，要求正文包含非空白内容且不超过 512 KiB，并记录独立条目序列化后的 UTF-8 字节数。创建时在写入 Session 之前校验合并目录的 256 项和 2 MiB 上限。只有在容纳所有已选 Skill 后仍有足够容量时，服务端才会添加可选的 loop Skill。首次安装准备期间继续展示初始选择。配置 bundle 生效后，可见目录以实际安装的贡献为准。Bundle 中的 command 不是 Skill：Session Skill 目录只列出 skill 类贡献，256 项上限也不把 command 计入。对用户隐藏的技能保持隐藏。模型通过已有初装流程从固定包读取指令与素材。撤销来源影响新准入，已创建会话的快照和请求重放仍然可用。

验收覆盖按上下文发现、显式选择、能力门控（FILES profile 或关闭自助服务时跳过发现，不写入包和导入回执）、空默认项保留省略选择、command 贡献不进入 Session Skill 目录、变更版本和撤销前后的新建及重放、初始化前后的目录可见性，以及无提供方行为。Managed V1 开发库记录独立 Skill 的元数据和包版本是否已显式发布到 Workspace 目录。已有开发库应按模块基线策略重建。
