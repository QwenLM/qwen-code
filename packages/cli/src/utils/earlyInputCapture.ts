/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Early Input Capture - 在 REPL 初始化期间捕获用户输入
 *
 * 原理：在 CLI 入口处最早启动 raw mode 监听 stdin，REPL 就绪后注入缓冲内容。
 * 解决启动期间用户输入丢失的问题。
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('EARLY_INPUT');

/** 最大缓冲区大小 (64KB) */
const MAX_BUFFER_SIZE = 64 * 1024;

/**
 * 输入缓冲区
 */
interface InputBuffer {
  /** 原始字节数据 */
  rawBytes: Buffer;
  /** 是否已完成捕获 */
  captured: boolean;
}

let inputBuffer: InputBuffer = {
  rawBytes: Buffer.alloc(0),
  captured: false,
};

let captureHandler: ((data: Buffer) => void) | null = null;
let isCapturing = false;

/**
 * 检查是否为终端响应序列
 * 终端响应通常以特定的前缀开头
 *
 * 注意：用户输入的功能键序列应该保留：
 * - ESC [ A/B/C/D - 方向键
 * - ESC O P/Q/R/S - F1-F4 (SS3 序列)
 * - ESC [ 1;5A - Ctrl+上箭头等修饰键
 */
function isTerminalResponse(data: Buffer, startIdx: number): boolean {
  if (startIdx >= data.length || data[startIdx] !== 0x1b) {
    return false;
  }

  const nextIdx = startIdx + 1;
  if (nextIdx >= data.length) {
    return false;
  }

  const nextByte = data[nextIdx];

  // 检查 ESC 后面直接跟的特殊字符
  // P = 0x50 (DCS), _ = 0x5F (APC), ^ = 0x5E (PM), ] = 0x5D (OSC)
  // 注意：O = 0x4F 是 SS3 序列，用于功能键，应该保留
  if (
    nextByte === 0x50 || // P (DCS)
    nextByte === 0x5f || // _ (APC)
    nextByte === 0x5e || // ^ (PM)
    nextByte === 0x5d // ] (OSC)
  ) {
    return true;
  }

  // 检查 CSI 序列中的终端响应
  // ESC [ ? ... (DEC private mode response)
  // ESC [ > ... (DA2 response)
  if (nextByte === 0x5b) {
    // CSI 序列，检查第三个字符
    const thirdIdx = startIdx + 2;
    if (thirdIdx < data.length) {
      const thirdByte = data[thirdIdx];
      if (thirdByte === 0x3f || thirdByte === 0x3e) {
        // ESC [ ? 或 ESC [ > - 这是终端响应
        return true;
      }
    }
  }

  return false;
}

/**
 * 跳过终端响应序列
 * 返回跳过后的索引位置
 */
function skipTerminalResponse(data: Buffer, startIdx: number): number {
  if (startIdx >= data.length || data[startIdx] !== 0x1b) {
    return startIdx + 1;
  }

  const nextIdx = startIdx + 1;
  if (nextIdx >= data.length) {
    return nextIdx;
  }

  const nextByte = data[nextIdx];

  // OSC 序列: ESC ] ... BEL 或 ESC ] ... ST
  if (nextByte === 0x5d) {
    let i = startIdx + 2;
    while (i < data.length) {
      // BEL (0x07) 或 ST (ESC \)
      if (data[i] === 0x07) {
        return i + 1;
      }
      if (data[i] === 0x1b && i + 1 < data.length && data[i + 1] === 0x5c) {
        return i + 2;
      }
      i++;
    }
    return data.length;
  }

  // DCS/APC/PM 序列: ESC P/_/^ ... ST
  if (nextByte === 0x50 || nextByte === 0x5f || nextByte === 0x5e) {
    let i = startIdx + 2;
    while (i < data.length) {
      // ST (ESC \)
      if (data[i] === 0x1b && i + 1 < data.length && data[i + 1] === 0x5c) {
        return i + 2;
      }
      i++;
    }
    return data.length;
  }

  // CSI 序列: ESC [ ... (0x40-0x7E 结束)
  if (nextByte === 0x5b) {
    let i = startIdx + 2;
    while (i < data.length) {
      const byte = data[i];
      // CSI 序列以 0x40-0x7E 结束
      if (byte >= 0x40 && byte <= 0x7e) {
        return i + 1;
      }
      i++;
    }
    return data.length;
  }

  return startIdx + 1;
}

/**
 * 过滤终端响应序列（如 Kitty 协议响应、设备属性响应等）
 * 保留用户输入（包括方向键等功能键）
 */
function filterTerminalResponses(data: Buffer): Buffer {
  const result: number[] = [];
  let i = 0;

  while (i < data.length) {
    // 检测 ESC 序列
    if (data[i] === 0x1b) {
      // 检查是否为终端响应（需要过滤掉）
      if (isTerminalResponse(data, i)) {
        // 跳过终端响应序列
        i = skipTerminalResponse(data, i);
        continue;
      }
      // 用户输入的功能键（如方向键 ESC [A），保留
    }
    // 保留当前字节
    result.push(data[i]);
    i++;
  }

  return Buffer.from(result);
}

/**
 * 开始早期输入捕获
 * 在 gemini.tsx 设置 raw mode 之后立即调用
 */
export function startEarlyInputCapture(): void {
  if (isCapturing || !process.stdin.isTTY) {
    return;
  }

  // 检查是否禁用
  if (process.env['QWEN_CODE_DISABLE_EARLY_CAPTURE'] === '1') {
    debugLogger.debug('Early input capture disabled by environment variable');
    return;
  }

  isCapturing = true;
  inputBuffer = {
    rawBytes: Buffer.alloc(0),
    captured: false,
  };

  debugLogger.debug('Starting early input capture');

  captureHandler = (data: Buffer) => {
    if (inputBuffer.captured) {
      return;
    }

    // 检查缓冲区大小限制
    if (inputBuffer.rawBytes.length >= MAX_BUFFER_SIZE) {
      debugLogger.debug('Buffer size limit reached, stopping capture');
      return;
    }

    // 过滤掉终端响应序列（如 Kitty 协议响应）
    const filtered = filterTerminalResponses(data);
    if (filtered.length > 0) {
      // 限制缓冲区大小
      const newLength = inputBuffer.rawBytes.length + filtered.length;
      if (newLength > MAX_BUFFER_SIZE) {
        const truncated = filtered.subarray(
          0,
          MAX_BUFFER_SIZE - inputBuffer.rawBytes.length,
        );
        inputBuffer.rawBytes = Buffer.concat([inputBuffer.rawBytes, truncated]);
        debugLogger.debug(`Buffer truncated at ${MAX_BUFFER_SIZE} bytes`);
      } else {
        inputBuffer.rawBytes = Buffer.concat([inputBuffer.rawBytes, filtered]);
        debugLogger.debug(
          `Captured ${filtered.length} bytes (total: ${inputBuffer.rawBytes.length})`,
        );
      }
    }
  };

  process.stdin.on('data', captureHandler);
}

/**
 * 停止早期输入捕获
 * 在 KeypressProvider 挂载前调用
 */
export function stopEarlyInputCapture(): void {
  if (!isCapturing || !captureHandler) {
    return;
  }

  process.stdin.removeListener('data', captureHandler);
  captureHandler = null;
  isCapturing = false;
  inputBuffer.captured = true;

  debugLogger.debug(
    `Stopped early input capture: ${inputBuffer.rawBytes.length} bytes`,
  );
}

/**
 * 获取并清除捕获的输入
 * 供 KeypressContext 使用
 */
export function getAndClearCapturedInput(): Buffer {
  const buffer = Buffer.from(inputBuffer.rawBytes);
  inputBuffer = {
    rawBytes: Buffer.alloc(0),
    captured: false,
  };
  return buffer;
}

/**
 * 检查是否有捕获的输入
 */
export function hasCapturedInput(): boolean {
  return inputBuffer.rawBytes.length > 0;
}

/**
 * 重置捕获状态（仅用于测试）
 */
export function resetCaptureState(): void {
  if (captureHandler) {
    process.stdin.removeListener('data', captureHandler);
    captureHandler = null;
  }
  isCapturing = false;
  inputBuffer = {
    rawBytes: Buffer.alloc(0),
    captured: false,
  };
}
