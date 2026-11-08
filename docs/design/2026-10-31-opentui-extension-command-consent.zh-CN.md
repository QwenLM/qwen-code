# OpenTUI 直接扩展安装确认

[English](2026-10-31-opentui-extension-command-consent.md) | [简体中文](2026-10-31-opentui-extension-command-consent.zh-CN.md)

## 问题与范围

普通审批模式下的公开直接安装复现表明，原生界面未询问即提交安装。同候选 Ink 和已安装 Ink 均显示确认、接受 No，并保持空的权限记录与产物状态；两项完整对照随后因取消消息换行的观察器失败，因此不记为完整通过。原生 Source 获取流程自行传入明确的确认回调，属于另一条路径。

## 所有权与实现

原生 shell 为当前 Config 的扩展管理器注册已有确认格式化器，通过已有动作确认队列展示请求。effect 内的 AbortController 同时拥有等待与已显示的请求。effect 仅依赖 Config 和稳定的确认桥，因此普通重渲染保留待确认请求。Config 替换和卸载中止所有者；捕获的旧回调会拒绝，不会批准或打开另一对话框。清理不恢复无操作回调，也不覆盖后继注册。每项请求保留队列独立的 Yes/No 结算。

本改动只涉及 CLI，不改变 Core API、审批模式、provider/headless 行为或安装事务边界。取消无法撤销 Core 已完成的提交。全局 marketplace 选择与扩展设置回调仍是独立、未验证的能力；Source 获取明确传入的回调继续生效。

## 验证与验收

受控修复前原生安装未确认即提交。最初 Ink 对照显示确认、接受 No，并保持权限/产物为空；完整观察器因取消文本换行失败，原失败保留。首轮原生修正另因在 box 内直接挂载字符串而失败。这些记录保存在调查文件中。当前回调使用清理后的原生文本，shell 回归通过原生到 DOM 的测试 adapter 检查实际元素。

修正后的公开拒绝 case 在 precommit e7fe 加本补丁的 bundle 上，分别通过 strict Bun+OpenTUI、Node+Ink 和 Bun+Ink。另一次全局已安装 Ink 基线也通过，其 source 身份未知。四次执行均展示确认、接受单次 No，保持初始化权限记录与整个产物快照精确不变，模型请求0，并以 exit0/signal0 自然退出。就绪观察使用各 renderer 现有确认界面，不为原生产品添加仅 Ink 才有的问题句。这些结果只覆盖拒绝，不代表随后同意安装或 hook 执行。

本 precommit 补丁已通过正常 build 和 bundle；实际测试入口为 `9a16c6a746510853c9640b5368547e5f1e3dbbb07d5bb5bf6e602e4f6b028e54`。完整 typecheck 已通过。仅测试的拒绝断言修正后，最新三个整文件261P，覆盖格式化/原生文本确认、Yes/No 结算、FIFO、普通重渲染、Config 替换、旧处理器、迟到答复及卸载。完整 lint 与原生布局验证也已通过。不声明新增已提交/安装产物、其他平台、hook 生命周期或整体迁移资格。
