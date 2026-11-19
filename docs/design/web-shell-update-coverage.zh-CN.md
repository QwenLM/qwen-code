# Web Shell 更新覆盖范围

[English](web-shell-update-coverage.md) | [简体中文](web-shell-update-coverage.zh-CN.md)

本增量扩展 [Web Shell 更新](web-shell-update.zh-CN.md)。其中定义的路由形态、
激活顺序与重启语义保持不变。

## 问题与范围

一键更新（后台准备加显式重启）目前只提供给独立安装，以及全局前缀可写的
npm 全局安装。由此产生两个缺口：

1. 受管理暂存机制本身与包管理器无关，路由却把它限制在
   `packageManager === npm` 且前缀可写。被识别为 pnpm、yarn、bun 的全局安装，
   以及全局前缀需要 sudo 的 npm 安装，都被排除在外——而暂存与激活根本不写
   全局前缀：暂存版本用 npm 装入 Qwen 主目录下用户自己的隔离前缀，共享的
   `cli-entry.js` 启动器（无论用哪个包管理器安装，发布包中的该文件完全相同）
   在下次启动时解析 `active.json` 指针。
2. 有更新但无法一键安装（`canInstall: false`）时，API 已返回手动
   `instructions`，Web Shell 却什么都不渲染：更新控件只在 `ready` 状态出现。
   Homebrew、npx、本地安装的用户只看到停留在旧版的版本号，没有任何指引。
   （Windows 与开发模式 daemon 报告的是 `unavailable` 而非 `available`，
   改动前后都保持无展示。）

本增量关闭这两个缺口。不新增 Windows 进程替换、嵌入式宿主重启或任何新路由。

## 设计

### 服务端：放宽受管理暂存的准入

安装被识别为全局且包管理器为 npm、pnpm、yarn、bun 之一时，更新控制器即提供
受管理暂存。可写前缀条件（存在 `updateCommand`）被移除：暂存用隔离 npm 前缀
装入用户自己的更新根目录，从不写全局前缀，因此 root 所属的前缀不构成障碍。
Homebrew 保持手动；其 formula 拥有安装的生命周期。

身份闸门不变，且仍是真正的安全边界：`QWEN_CODE_CLI` 加
`QWEN_CODE_MANAGED_NPM_PIN` 必须解析到同一个 `cli-entry.js`，其相邻清单必须是
已发布的 `@qwen-code/qwen-code` 包。以其他方式启动的安装（开发树、嵌入式宿主、
重打包二进制）保持 `canInstall: false`。

暂存、激活、锁、冒烟测试与清理原样复用 `managed-npm-update.ts`。任何包管理器
的显式安装仍会改变基础清单或启动器 ctime，从而取代受管理指针，与今天一致。

### 客户端：用手动指引替代静默

状态为 `available`、`canInstall: false` 且 `instructions` 非空时，更新控件渲染
同一个版本号旁的按钮（侧栏折叠时仅图标）。点击打开弹层而非重启：目标版本、
一行「当前安装方式无法在 Web Shell 中更新」的说明，以及等宽字体块中的指引
命令。弹层使用共享 Popover 原语，其 portal 挂到 Web Shell portal 根。此状态
下按钮绝不调用准备或重启。

其余状态行为不变：检查与准备保持安静、仅在 `ready` 出现按钮、显式重启容忍
短暂断线并返回原地址。两种语言均新增文案。

该入口覆盖检查返回 `available` 更新并附手动指引的安装，如 Homebrew、npx 与
本地安装。Windows daemon 没有重启回调，开发模式的检查被跳过，两者都报告
`unavailable` 并有意保持无展示；本增量不改变这些排除。

rail 布局下手动弹层从「更多」菜单内打开。其焦点与指针交互与既有的本地文件、
桌面中继面板一样，被豁免于「更多」弹层的外部交互关闭，因此用户阅读或选中
指引时两层都保持打开。

## 归属与影响范围

两处改动都保持 daemon 进程全局，沿用现有身份认证、主监听器与操作者设置闸门。
SDK 类型不变：`instructions` 已是 `DaemonUpdateStatus` 的字段。消费者是
daemon 更新路由与 Web Shell 侧栏；协议参考文档同步更新放宽后的准入与手动
指引入口。

## 验证与验收

单元测试覆盖放宽后的准入（pnpm/yarn/bun 全局与 sudo-npm 安装在启动器印记
有效时提供 `canInstall: true`；Homebrew 与非全局安装保持手动指引；缺失或
外来启动器印记仍拒绝），以及客户端入口（仅有指引时出现按钮、打开弹层、
绝不准备或重启、折叠与中文形态）。浏览器回归在既有一键场景之外新增手动
指引场景。

验收：使用发布启动器的全局 pnpm/yarn/bun 或 root 所属的 npm 安装，获得与可写
npm 安装相同的一键流程；检查返回可用更新并附手动指引的安装，在版本号旁展示
这些步骤而非空无一物，且 rail 布局下阅读或选中指引时「更多」菜单与手动弹层
都保持打开；没有指引的安装与所有非 `available` 状态——包括 Windows 与
开发模式 daemon——的渲染与之前完全一致。

## 待决问题

无。
