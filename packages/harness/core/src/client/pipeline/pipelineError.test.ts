/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { PipelineError } from './pipelineError.js';
import { ValveError } from './valve/valveError.js';

const errorTypes = [
  {
    name: 'PipelineError',
    ErrorType: PipelineError,
    context: { pipelineName: 'outbound' },
    createError: (message: string, options?: ErrorOptions) =>
      new PipelineError(message, { pipelineName: 'outbound', ...options }),
  },
  {
    name: 'ValveError',
    ErrorType: ValveError,
    context: { valveName: 'wasm', step: 'sign' },
    createError: (message: string, options?: ErrorOptions) =>
      new ValveError(message, { valveName: 'wasm', step: 'sign', ...options }),
  },
];

describe.each(errorTypes)('$name', ({ name, ErrorType, context, createError }) => {
  it('保留异常类型、名称、消息和堆栈', () => {
    const error = createError('执行失败');

    expect(error).toBeInstanceOf(ErrorType);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.message).toBe('执行失败');
    expect(error.stack).toContain(`${name}: 执行失败`);
    expect(error.cause).toBeUndefined();
  });

  it('保留失败位置字段', () => {
    const error = createError('执行失败');

    expect(error).toMatchObject(context);
  });

  it.each([new Error('底层异常'), '取消原因', null, undefined])(
    '保留原始 cause：%s',
    (cause) => {
      const error = createError('执行失败', { cause });

      expect(error.cause).toBe(cause);
    },
  );
});

describe('异常原因链', () => {
  it('保留各层位置和原始异常，不复制或改写底层异常', () => {
    const original = Object.assign(new Error('签名失败'), {
      code: 'SIGN_FAILED',
    });
    const originalStack = original.stack;
    const valve = new ValveError('签名失败', {
      valveName: 'wasm',
      step: 'sign',
      cause: original,
    });
    const pipeline = new PipelineError('出站管线失败', {
      pipelineName: 'outbound',
      cause: valve,
    });

    expect(pipeline.pipelineName).toBe('outbound');
    expect(pipeline.cause).toBe(valve);
    expect(valve.valveName).toBe('wasm');
    expect(valve.step).toBe('sign');
    expect(valve.cause).toBe(original);
    expect(original.code).toBe('SIGN_FAILED');
    expect(original.stack).toBe(originalStack);
  });
});
