/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectErrorCodes } from '../utils/errors.js';
import { getErrorStatus } from '../utils/httpErrors.js';
import { readExplicitNetworkFailurePhase } from '../client/utils/networkUtils.js';

const STREAM_READ_TIMEOUT_CODES = ['UND_ERR_BODY_TIMEOUT'];
const CONNECTION_CLOSED_CODES = ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'];
const RESUMABLE_STREAM_CODES = [
  ...CONNECTION_CLOSED_CODES,
  ...STREAM_READ_TIMEOUT_CODES,
];

/** 沿 cause 链读 inference 的语义分类；链上第一处分类生效。 */
function readInferenceErrorKind(error: unknown): string | undefined {
  const seen = new Set<object>();
  let candidate = error;
  while (candidate && typeof candidate === 'object' && !seen.has(candidate)) {
    seen.add(candidate);
    const kind = (candidate as { kind?: unknown }).kind;
    if (typeof kind === 'string') return kind;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Only receiving-phase transport failures may resume with settled tool results. */
export function isResumableStreamFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let candidate = error;
  let resumable = false;
  while (candidate && typeof candidate === 'object' && !seen.has(candidate)) {
    seen.add(candidate);
    const value = candidate as {
      code?: unknown;
      phase?: unknown;
      status?: number;
      httpStatus?: number;
      kind?: unknown;
      cause?: unknown;
    };
    // Provider codes may look like socket codes (even without an HTTP status).
    // Explicit failures anywhere in the cause chain outrank those heuristics.
    if ((value.httpStatus ?? 0) >= 400 || (value.status ?? 0) >= 400)
      return false;
    // 已按语义分类的推理失败不是本地接收中断；network 分类仍可能源于底层连接
    // 中断，交给下面的 code 判定，避免把请求阶段的连接失败当成可续跑。
    if (value.kind !== undefined && value.kind !== 'network') return false;
    if (
      value.phase === 'stream_idle' ||
      RESUMABLE_STREAM_CODES.includes(String(value.code))
    )
      resumable = true;
    candidate = value.cause;
  }
  return resumable;
}

/** Short, redacted cause for the model-facing interruption reminder. */
export function describeStreamInterruption(error: unknown): string {
  const codes = new Set(collectErrorCodes(error));
  if (
    STREAM_READ_TIMEOUT_CODES.some((code) => codes.has(code)) ||
    readExplicitNetworkFailurePhase(error) === 'stream_idle'
  )
    return 'the response read timed out';
  if (CONNECTION_CLOSED_CODES.some((code) => codes.has(code)))
    return 'the upstream connection was closed';
  const kind = readInferenceErrorKind(error);
  if (kind === 'server')
    return 'the upstream service was temporarily unavailable';
  if (kind === 'rate_limited')
    return 'the upstream service was temporarily rate limited';
  const status = getErrorStatus(error);
  if (status === 429)
    return 'the upstream service was temporarily rate limited';
  if (status !== undefined && status >= 500)
    return 'the upstream service was temporarily unavailable';
  return 'a transient request failure occurred';
}
