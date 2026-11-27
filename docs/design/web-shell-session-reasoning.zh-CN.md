# Web Shell 任务级思考

[English](web-shell-session-reasoning.md) | [简体中文](web-shell-session-reasoning.zh-CN.md)

## 行为

在记录历史的本地工作区任务中，聊天思考控件和 `/effort` 应用同一个任务级选择。
选择 `high` 会打开思考并使用高强度。切换模型和重新打开任务时保留该选择。
新建任务继续使用已配置的默认值。

## 协议与持久化

daemon 声明 `session_reasoning_persistence` 能力，原生 Web Shell 在工作区任务中使用它。
配置请求可发送 `persistToSession: true`，消息请求可通过
`_meta["qwenCode/persistSessionReasoning"]: true` 将其中的 effort 命令限定到任务。
两个请求经同一 ACP 配置处理入口，校验模型能力并要求写入历史记录。
daemon 会向调用方返回写入失败。现有 `persist` 选项继续供客户端写入共享设置。

选择保存在现有的任务模型记录里，随任务一起恢复。功能上线前创建的任务可以在重新打开后
保存第一次选择。其他模型不支持所选档位时，保留记录供支持的模型使用。
独立终端命令和嵌入式客户端沿用各自原有行为，客户端可以显式接入。

## 验证

思考关闭时分别通过两个入口设置 `high`，检查配置、下一次实际模型请求和 daemon
重启后的任务。用功能上线前创建的任务重复验证，比较设置文件和下一项新任务
实际使用的思考配置。覆盖不支持档位的模型和历史记录写入失败。
