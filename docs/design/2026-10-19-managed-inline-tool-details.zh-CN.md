# 展开时读取 Managed 工具详情

[English](2026-10-19-managed-inline-tool-details.md) | [简体中文](2026-10-19-managed-inline-tool-details.zh-CN.md)

## 问题与范围

Managed 生命周期事件携带名称与状态，已保存的工具参数、输出和错误仍保存在私有已提交历史中。因此，失败的 ReadFile 卡片展开后没有诊断，成功的 Shell 卡片显示输出不可用。此前耗时还会导致空的执行详情区域出现。

ReadFile 和 Shell 详情应仅在用户展开已结束的卡片时加载。为显示结果而提前处理每次调用，不应回扫在先历史或把私有文本复制到生命周期事件。本次保持工具执行、路径校验、Runtime 选择，以及独立的 O3 Artifact 发布和下载策略不变。

## 读取策略与归属

契约版本 `1.67.0` 新增 `POST /api/agent/web-shell/v1/tool-details/get`，复用已有 Session/Item 请求结构。这是以持久化 Workspace 为作用域的读取：要求可信 actor、当前 Session 可见性及 Workspace 读取授权，并在返回前重新校验。响应使用 `Cache-Control: private, no-store`。路由不启动 Harness、不获取 Runtime、不执行命令，也不回退到其他 Workspace。

读取默认启用。管理员可通过 `qwen.managed-agent.harness.tool-details-enabled=false` 或 `QWEN_MANAGED_AGENT_TOOL_DETAILS_ENABLED=false` 关闭。所有获准读取 Session/Workspace 的用户均可读取这些有界工具详情。Artifact 发布与原始下载权限保持独立，不需要额外发布开关或对象存储。保存的文本可能包含敏感内容，不会自动脱敏。

关闭配置会拒绝新的详情请求，不删除先前发布的内联历史，也不改变已批准的 O3 预览。既有内联数据继续按原方式渲染。新的生命周期事件不携带详情文本或参数，服务端也不回填公共事件。

## 保留历史与边界

从持久化 Item 和 Turn 解析原始 prompt、工具名及 call ID。仅支持 `read_file` 和 `run_shell_command`，在已提交 assistant/result 消息中精确匹配 Session、Workspace、prompt、call ID 和名称。没有执行回执的参数校验错误也可读取。同时保留已保存的输出与错误文本，并区分文本缺失和显式记录的空字符串。

新的 Item/事件保存生命周期来源序号；既有 Item 可从保留的公共事件来源键解析。使用 Item/事件中较新的序号，从对应工具的 journal 事务开始读取，后续 Turn 不会把旧结果挤出扫描窗口。后到的结果提交即使没有改变状态，也会使已展开卡片的读取失效。没有保留的指针时，从 journal 头开始有界搜索。历史缺失或已被裁剪时继续显示不可用。

每次查询最多扫描 512 个 journal 事务，journal/消息总读取量最多 8 MiB。超过预算的 journal 行在传输字节前拒绝。校验 journal 摘要和每个已提交资源引用，支持普通与分块消息。这是仅在展开时进行的有界查询，不是常数时间索引，也不重建已移除的数据。

仅返回标量显示参数：ReadFile 的 `file_path`、`path`、`offset`、`limit`，以及 Shell 的 `command`、`directory`、`timeout`。过滤未知字段及类型错误的标量。超过 4 KiB 的参数不返回，不把原本完整的输出误标为截断。保存的文本限制为 8 KiB、200 行，标识本地及上游输出截断。媒体、私有捕获引用及原始 stdout/stderr 下载不属于此路由。

## 客户端行为

Managed 会话向 ReadFile/Shell 卡片提供详情加载器。关闭的卡片不发出详情请求。已展开且缺少输入或输出的已结束卡片显示加载状态，读取自己的 Session/Item，随后复用已有渲染器。已有输入和输出时无需额外请求。缺失输出显示不可用提示，已记录的空输出显示不同的空提示。

关闭卡片或切换 provider、Session、工具身份会中止进行中的读取。展示前核对响应身份和生命周期版本，避免晚到的响应暴露另一 Session 的内容。即使结束回执先到，新的完成来源序号也会重读详情。Shell 执行详情仅在有实际字段行时渲染，耗时继续显示在状态栏。

## 验证与验收

- 展开之前不发生详情 HTTP 请求、为获取参数而回扫在先历史，或内联发布详情。
- 展开已保存的失败 ReadFile 和完成 Shell 卡片可显示各自的诊断、命令和输出；刷新后重开无需执行工具。
- 保留的旧结果无需公共回填即可读取；空、缺失及截断结果保持可区分。
- 其他 tenant、缺失 actor、已撤销 Workspace 授权、正在删除的 Session、关闭读取及不支持的工具均不返回私有详情。
- 精确匹配、数据损坏、分块资源、字节上限、参数白名单、晚到结果，以及客户端取消和过期请求均有定向覆盖。
- 运行根目录 build/typecheck/bundle、受影响生产者/reducer/组件和浏览器检查、API/路由契约测试、Maven 验证，以及可销毁的 MySQL 8.4 集成检查。不向用户正在运行的 Session 发送提示，也不修改其数据库。

## 限制

私有已提交结果仍按原方式保留；本次延迟的是显示读取，而非持久化。首次展开多一次 HTTP 往返。超过固定读取预算的深层或大型历史仍不可用。实时输出、分离任务 artifact、媒体、原始捕获遍历、新索引，以及已裁剪历史重建不属于本次修复。
