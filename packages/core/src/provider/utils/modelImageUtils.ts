/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelImageBlock } from '../modelStreamRequest.js';
import {
  isSupportedImageMediaType,
  normalizeImageMediaType,
  unsupportedImagePlaceholder,
  type SupportedImageMediaType,
} from '../../utils/supportedImageTypes.js';

/** 图片块的发送形态：可发送的 base64 / URL 源，或降级后的占位文本。 */
export type ModelImageProjection =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'base64';
      readonly mediaType: SupportedImageMediaType;
      readonly data: string;
    }
  | { readonly type: 'url'; readonly url: string };

/** 非视觉模型发送时的占位文本；历史里的图片块保持不变。 */
const NON_VISION_IMAGE_PLACEHOLDER =
  '[Image omitted: the current model does not support image input. ' +
  'Ask the user to switch to a vision-capable model if the image content is needed.]';

/**
 * 图片块的协议无关判定，供各协议工厂共用：媒体类型校验、视觉能力降级与
 * data URL 拆解只在这里做一次，各协议只负责把结果写成自己的 wire 形状。
 */
export class ModelImageUtils {
  /**
   * 不支持的媒体类型（含 SVG）与非视觉模型降级为占位文本；data URL 拆回
   * base64 源；无有效数据的源返回 undefined，由调用方跳过。
   */
  static resolve(
    source: ModelImageBlock['source'],
    supportsVision: boolean,
  ): ModelImageProjection | undefined {
    const resolved = ModelImageUtils.resolveSource(source);
    if (!resolved || resolved.type === 'text' || supportsVision) {
      return resolved;
    }
    return { type: 'text', text: NON_VISION_IMAGE_PLACEHOLDER };
  }

  /** OpenAI 两协议只收 URL 形态，base64 源拼成 data URL。 */
  static toUrl(
    image: Exclude<ModelImageProjection, { type: 'text' }>,
  ): string {
    return image.type === 'base64'
      ? `data:${image.mediaType};base64,${image.data}`
      : image.url;
  }

  private static resolveSource(
    source: ModelImageBlock['source'],
  ): ModelImageProjection | undefined {
    if (source.type === 'base64') {
      return ModelImageUtils.resolveBase64(source.mediaType, source.data);
    }
    if (!source.url) return undefined;
    const dataUrl = /^data:([^;,]+);base64,(.*)$/isu.exec(source.url);
    if (dataUrl) {
      return ModelImageUtils.resolveBase64(dataUrl[1], dataUrl[2]);
    }
    return ModelImageUtils.isSvgUrl(source.url)
      ? { type: 'text', text: unsupportedImagePlaceholder('image/svg+xml') }
      : { type: 'url', url: source.url };
  }

  private static resolveBase64(
    mediaType: string,
    data: string,
  ): ModelImageProjection | undefined {
    if (!mediaType || !data) return undefined;
    if (!isSupportedImageMediaType(mediaType)) {
      return { type: 'text', text: unsupportedImagePlaceholder(mediaType) };
    }
    return {
      type: 'base64',
      mediaType: normalizeImageMediaType(mediaType) as SupportedImageMediaType,
      data,
    };
  }

  private static isSvgUrl(url: string): boolean {
    try {
      return new URL(url).pathname.toLowerCase().endsWith('.svg');
    } catch {
      return url.toLowerCase().split(/[?#]/u, 1)[0].endsWith('.svg');
    }
  }
}
