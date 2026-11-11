/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// brand-env.js 由 Node / Bun 直接加载，不参与 tsc 编译程序；
// 这里补一份声明，让 bun-build-config.ts 等调用方拿到真实类型。

/**
 * 将共享品牌字段展开为构建期的 `process.env.XXX` → JSON 空字符串字面量，
 * 使构建产物使用 Core 中的 Qwen Code 默认值。
 */
export function qwenBrandDefines(): Record<string, string>;
