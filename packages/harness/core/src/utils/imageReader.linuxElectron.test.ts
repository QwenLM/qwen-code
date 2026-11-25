/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PhotonImage } from '@silvia-odwyer/photon-node';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const portable = vi.hoisted(() => ({ unavailable: false, loads: vi.fn() }));
vi.mock('node:module', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:module')>();
  return {
    ...original,
    createRequire: (url: string | URL) => {
      const realRequire = original.createRequire(url);
      return (request: string) => {
        if (request === '@silvia-odwyer/photon-node') {
          portable.loads();
          if (portable.unavailable) throw new Error('Photon unavailable');
        }
        return realRequire(request);
      };
    },
  };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
)!;
const electronDescriptor = Object.getOwnPropertyDescriptor(
  process.versions,
  'electron',
);
const sharpLoads = vi.fn();

function setHost(platform: string, electron?: string) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(process.versions, 'electron', {
    configurable: true,
    value: electron,
  });
}

function createPng(width = 11, height = 11): Buffer {
  const image = new PhotonImage(
    new Uint8Array(width * height * 4).fill(128),
    width,
    height,
  );
  try {
    return Buffer.from(image.get_bytes());
  } finally {
    image.free();
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  portable.unavailable = false;
  // 在 import 边界断言，确保生产链路连原生模块加载都不会触发。
  // 测试用原生模块预先在真实宿主加载，避免模拟平台时解析错误的二进制。
  vi.doMock('sharp', () => {
    sharpLoads();
    return { default: sharp };
  });
  setHost('linux', '43.1.1');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  if (electronDescriptor)
    Object.defineProperty(process.versions, 'electron', electronDescriptor);
  else delete process.versions['electron'];
  vi.doUnmock('sharp');
});

describe('Linux Electron 的图片处理隔离', () => {
  it('附件图片通过 WASM 缩放，始终不加载 sharp', async () => {
    const { maybeResizeAndDownsampleImageBuffer } = await import(
      './imageReader.js'
    );
    const input = createPng(2100, 42);
    const result = await maybeResizeAndDownsampleImageBuffer(
      input,
      input.length,
      'png',
    );
    const decoded = PhotonImage.new_from_byteslice(result.buffer);
    try {
      expect(decoded.get_width()).toBe(2000);
      expect(decoded.get_height()).toBe(40);
    } finally {
      decoded.free();
    }
    expect(portable.loads).toHaveBeenCalled();
    expect(sharpLoads).not.toHaveBeenCalled();
  });

  it('BMP 转换和 token 压缩也不会绕回原生处理器', async () => {
    const { processImageBufferWithTokenBudget } = await import(
      './imageReader.js'
    );
    const bmp = Buffer.alloc(54 + 11 * 11 * 4);
    bmp.write('BM');
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(11, 18);
    bmp.writeInt32LE(11, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(32, 28);
    bmp.writeUInt32LE(bmp.length - 54, 34);
    bmp.fill(128, 54);
    const result = await processImageBufferWithTokenBudget(bmp, {
      maxTokens: 100,
    });
    expect(result.mediaType).toBe('image/png');
    const decoded = PhotonImage.new_from_byteslice(
      Buffer.from(result.base64, 'base64'),
    );
    try {
      expect(decoded.get_width()).toBe(11);
    } finally {
      decoded.free();
    }
    // 极低预算触发现有的最终 JPEG 压缩路径，也不能回退加载 sharp。
    const compressed = await processImageBufferWithTokenBudget(createPng(), {
      maxTokens: 1,
    });
    expect(compressed.mediaType).toBe('image/jpeg');
    expect(sharpLoads).not.toHaveBeenCalled();
  });

  it('Photon 不可用时仅允许受限透传，不尝试 sharp', async () => {
    portable.unavailable = true;
    const { maybeResizeAndDownsampleImageBuffer } = await import(
      './imageReader.js'
    );
    const input = createPng();
    const result = await maybeResizeAndDownsampleImageBuffer(
      input,
      input.length,
      'png',
    );
    expect(result.buffer).toEqual(input);
    const oversized = createPng(2100, 42);
    await expect(
      maybeResizeAndDownsampleImageBuffer(oversized, oversized.length, 'png'),
    ).rejects.toThrow();
    expect(sharpLoads).not.toHaveBeenCalled();
  });

  it('损坏图片仍然拒绝，不因选择 WASM 放宽校验', async () => {
    const { maybeResizeAndDownsampleImageBuffer } = await import(
      './imageReader.js'
    );
    const truncated = createPng().subarray(0, -12);
    await expect(
      maybeResizeAndDownsampleImageBuffer(truncated, truncated.length, 'png'),
    ).rejects.toThrow(/missing IEND/);
    expect(sharpLoads).not.toHaveBeenCalled();
  });
});

describe('其他宿主保留 sharp 优先策略', () => {
  it.each([
    ['linux', undefined],
    ['darwin', undefined],
    ['win32', undefined],
    ['darwin', '43.1.1'],
    ['win32', '43.1.1'],
  ])('%s / Electron=%s 不切换到 Photon', async (platform, electron) => {
    setHost(platform!, electron);
    const { maybeResizeAndDownsampleImageBuffer } = await import(
      './imageReader.js'
    );
    const input = createPng();
    const result = await maybeResizeAndDownsampleImageBuffer(
      input,
      input.length,
      'png',
    );
    expect(result.buffer).toEqual(input);
    expect(sharpLoads).toHaveBeenCalled();
    expect(portable.loads).not.toHaveBeenCalled();
  });
});
