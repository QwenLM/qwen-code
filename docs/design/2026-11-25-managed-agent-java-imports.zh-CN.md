# Managed Agent Server Java import 清理

[English](2026-11-25-managed-agent-java-imports.md) | [简体中文](2026-11-25-managed-agent-java-imports.zh-CN.md)

## 范围

注解、方法签名和表达式中的全限定类型名会增加 Managed Agent Server 生产代码的阅读成本。
本次清理覆盖 `packages/managed-agent-server/*/src/main/java` 下的 Java 文件。

## 方案

在短类名仍能解析到原类型时，使用短类名。Java 需要时添加显式 import。对于当前包和
`java.lang` 中的类型，使用隐式导入。短类名会解析到其他类时，保留全限定名。
Harness SDK 适配器中的 SDK 和服务端契约都定义了 `HarnessRuntimeRecovery`，
因此 SDK 参数保留全限定名。

通过 Java 编译器识别源码中的类型引用。包声明、注释和字符串字面量保持原样，
其中包括 Spring 扫描目标和反射所需的类名。

## 验证

使用 JDK 21 在清理前后编译 Maven reactor 的生产模块，并用 `-g:none` 关闭调试信息。
逐字节比较编译后的类文件，确认编译器解析的类、方法和注解一致。
运行两套 Checkstyle 配置，并执行覆盖模块边界、Spring 装配、API 契约、
持久化及 Runtime Broker 的相关测试。
