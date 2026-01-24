/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Token calculation result for different content types
 */
export interface TokenCalculationResult {
  /** Total tokens calculated */
  totalTokens: number;
  /** Breakdown by content type */
  breakdown: {
    textTokens: number;
    imageTokens: number;
    audioTokens: number;
    otherTokens: number;
  };
  /** Processing time in milliseconds */
  processingTime: number;
}

/**
 * Image metadata extracted from base64 data
 */
export interface ImageMetadata {
  /** Image width in pixels */
  width: number;
  /** Image height in pixels */
  height: number;
  /** MIME type of the image */
  mimeType: string;
  /** Size of the base64 data in bytes */
  dataSize: number;
}
