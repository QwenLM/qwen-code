# 插件 Hook 根路径重定位

[English](2026-11-17-plugin-hook-root-relocation.md) | [简体中文](2026-11-17-plugin-hook-root-relocation.zh-CN.md)

## 状态与问题

已实现，并在 Darwin arm64 的 Node 24 与 Ink 上完成本地验证。验收前必须经过 Core Tier 2 维护者审查，本改动不代表已具备发布条件。

文件形式的插件 Hook 此前会将 `${CLAUDE_PLUGIN_ROOT}` 展开为临时转换目录。安装完成并移除该目录后，持久化命令仍指向临时位置，尽管已安装脚本确实存在。真实公开安装记录了 SessionEnd 子进程在已删除临时路径上的 `MODULE_NOT_FOUND`，定向回归也复现了过早展开。较大的公开整案另有无关 UI 失败，不能算作整案通过。

真实全局 `qwen` 0.22.0 基线完成了两次自然退出且没有模型请求，但没有得到合格的冷启动 Shell receipt，也未观察到具体 Hook 错误。该结果仍为不具备资格，既不能否定，也不能独立复现较新版本的安装失败。

## 契约

在文件 Hook 命令和转换后的 manifest 中保留 `${CLAUDE_PLUGIN_ROOT}`，直到安装加载时按有效扩展根目录展开，与 inline Hook 一致。转换器现在直接保存解析后的 Hook 数据。不改变任意字面绝对命令、inline Hook、matcher、选项或资源内容与权限。现有守卫继续拒绝绝对 Hook 文件声明、路径穿越和符号链接逃逸。

## 兼容性与回归

共享 builder 服务于 Claude marketplace 插件、独立插件及 Qoder 转换。产物通过兼容扩展转换进入扩展安装/更新准备和 GitHub 更新检查。已安装扩展管理器按有效扩展路径展开 Hook 变量，随后 Hook registry 消费已激活扩展的 Hook，Hook runner 执行命令。Mod 夹具也消费转换后的资源。公开定义模块导出可能存在未知的外部消费者，因此展开时机的变化必须由维护者裁决。

升级不会修复由修复前版本安装的扩展：加载只解析并替换持久化 manifest 中的变量，其中已不存在可供匹配的 `${CLAUDE_PLUGIN_ROOT}` token，启动时也不会重新转换已安装的扩展。由于加载永远不会重写已持久化的绝对命令，这类安装需要执行一次更新（`qwen extensions update <name>`）或重新安装。

更新后的文件 Hook 回归要求字面 token、完全一致的序列化 Hook 对象，以及在转换产物复制到已安装根目录并删除转换目录后，加载得到的命令仍能读取已安装脚本。两个 Mod 资源分支通过现有 helper 显式展开后继续断言原有内容。安全拒绝覆盖保留。不新增加载器、Hook API、路径改写策略或执行开关。

## 验证与验收

执行定向 RED/GREEN 和受影响的 converter、Qoder、variables、extension-manager 与 Hook 加载契约，随后执行构建、类型检查、lint 和格式检查。把公开冷启动用例绑定到新产物：不可变 Git publisher、真实已安装脚本、合格的 Shell 可执行文件/PID/birth/argv/cwd 见证、零模型请求、原预算和两次自然退出。observer 失败与缺失 receipt 必须和具体子进程错误区分。

验收要求加载前保留 token、在已安装根目录展开，并在临时克隆删除后真实执行，同时保留 inline/Mod 行为和安全拒绝。公开 A-only Git 安装现已通过：热、冷两次退出均为自然退出，各产生一份合格的 Bash receipt，命令在临时克隆清理后指向已安装脚本。构建、类型检查、受影响单元契约、lint 和格式检查均通过。Native 信号、其他 Hook 事件、全部 Source 流程、平台及长期稳定性不在本结果范围内。
