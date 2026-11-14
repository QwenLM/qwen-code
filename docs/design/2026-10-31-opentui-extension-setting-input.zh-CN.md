# OpenTUI 直接扩展设置输入

[English](2026-10-31-opentui-extension-setting-input.md) | [简体中文](2026-10-31-opentui-extension-setting-input.zh-CN.md)

## 问题与范围

直接安装确认修复并不拥有后续必填设置输入。当前原生复现中，非敏感值已写入安装后的 .env，但相同输入也进入了 composer，随后公开 quit 未能自然退出。全局 Ink 与两个候选 Ink 配置完成了相同 fixture。这是输入所有权缺陷，不代表保存失败或 Core 策略错误。

## 设计

在当前 Config 拥有的确认回调旁注册设置回调。导出并复用已有 Source 扩展设置组件，不改变其输入、密码、编辑或结算行为。设置请求进入 shell 已有 FIFO 模态队列，活动设置期间 composer 保持卸载。每个请求拥有独立的值/取消 promise 和所有者。普通重渲染保留请求；Config 替换、卸载、Escape 与捕获的旧回调拒绝。迟到提交不能结算后继请求。清理不恢复无操作回调，也不覆盖后继注册。Source 获取明确传入的回调继续优先于管理器全局回调。

保持 Core API、安装事务、审批模式、marketplace 选择、provider 与 headless CLI 不变。取消无法回滚 Core 已提交的操作。设置组件仍按已有合同处理敏感值；公开复现只使用非敏感的自有标签，不声明设备或秘密存储验证。

## 验证

原公开原生运行虽持久化精确的非敏感值，输入也进入 composer，quit 未自然退出。该完整失败与 Ink 对照继续保留。实现已通过正常完整 build、typecheck、lint、bundle、原生布局检查，以及五个 CLI 整文件298P。Shell 回归覆盖精确输入值、取消、确认/设置 FIFO、连续独立设置、普通重渲染、配置替换、旧回调及卸载；已有真实 Source 组件测试也包含在内。

两个公开 case 已在基于 b74f34b9（ec0e 的仅测试后继）的 precommit 设置桥上，分别通过 strict Bun+OpenTUI、Node+Ink 与 Bun+Ink，实际入口为 `7fd97e9ee34f8461a8e828d8439fab34661fff0a47790e2dca27ee878bbd3852`。另一个 source 身份未知的全局已安装 Ink 基线也通过两项：共八次执行、两个唯一 case、12次明确 exit0/signal0 自然退出、模型请求0、清理错误0。保存保持精确原生 manifest、本地源和 .env，输入未提交到 composer，随后自然退出。冷启动保持完整权限/产物/raw 快照和精确 .env，公开文本列出该扩展并再次自然退出；这里只证明文本列表可见，不是管理对话框导航。在另一个全新工作区，设置输入单次 Escape 后确认取消，完整初始化快照不变且正常自然退出。

独立保存结果审查已核同上述限定结果，只读 publisher 保持不变。继承仅测试的 manager 夹具修正后，该设置桥工作树的额外真实 shell voice 整文件24P，录音、设备与传输均为 mock。这24项与上述298项受影响测试分列。未声明真实音频/设备权限、敏感值/keychain、其他设置 scope、完整生成依赖闭包、安装态/最终 main 产物或 Core hook 生命周期资格。整体迁移与其他回调缺口仍开放。
