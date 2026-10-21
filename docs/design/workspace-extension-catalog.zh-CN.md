# 工作区扩展投影仅加载清单

[English](workspace-extension-catalog.md) | [简体中文](workspace-extension-catalog.zh-CN.md)

## 问题与范围

`GET /workspaces/:workspace/extensions` 只返回身份和激活字段，却加载所有扩展
子资源。管理页还会请求完整扩展状态，造成重复工作。

## 决策

调用 `refreshCatalogSnapshot()`，使用它返回的扩展列表及同一份 snapshot 组装
响应。复用 #12153 引入的清单加载器，不改变响应结构或核心加载行为。

此路由属于 selected-runtime 作用域。保留 runtime 解析、工作区 cwd、信任处理、
读取后的 generation guard，以及 desired/applied generation。激活状态必须从
同一份返回的 snapshot 解析；不得回退到主 runtime 或另行读取激活状态。

## 约束与验证

保留继承和显式工作区激活、链接安装身份及错误传播语义。完整状态和 Skill 状态
路由保持现状。不引入缓存，不改变锁行为或写操作。

路由测试必须断言调用清单加载器，并且不调用完整刷新或读取完整扩展缓存。
真实文件系统 fixture 验证链接与普通条目、选中工作区的覆盖状态及 generation。
现有协调测试继续覆盖 generation 回退和操作乱序。运行相关路由测试、构建和类型检查。

## 后续工作

请求合并、详情加载及缓存失效属于独立工作。没有端点基准数据时不承诺提速百分比。
