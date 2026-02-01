# 设计概览

> 本文档概述目标、范围与非目标，作为设计文档的入口。

## 目标

- 统一 Chrome 扩展与 MCP Native Server 的设计口径。
- 明确协议、数据流、工具能力与安全边界。
- 为实现、测试与发布提供稳定的设计依据。

## 范围

- Chrome MV3 扩展（UI/Service Worker/Content Script）
- MCP Native Server（工具注册、Native Messaging、MCP stdio）
- 与 Qwen CLI 的集成方式

## 非目标

- 不包含具体实现细节与代码变更（由后续实现文档/PR 追踪）。

## 相关文档

- [03-architecture.md](03-architecture.md)
- [05-protocols.md](05-protocols.md)
- [08-tools-catalog.md](08-tools-catalog.md)
