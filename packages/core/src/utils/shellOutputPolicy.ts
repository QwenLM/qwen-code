/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Maximum foreground shell output kept inline. */
export const SHELL_INLINE_OUTPUT_MAX_BYTES = 30_000;
/** Maximum persisted-output preview length in UTF-16 code units. */
export const SHELL_PERSISTED_PREVIEW_CHARS = 2_000;
/** Maximum number of bytes retained in a persisted shell output artifact. */
export const SHELL_PERSISTED_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** Delay before elapsed time and foreground backgrounding hints are shown. */
export const SHELL_PROGRESS_THRESHOLD_MS = 2_000;
/** 实时通知与最终日志尾部预览共用的 UTF-8 字节上限。 */
export const SHELL_OUTPUT_PREVIEW_MAX_BYTES = 4096;
