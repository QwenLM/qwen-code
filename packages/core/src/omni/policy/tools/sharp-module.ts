/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal slice of the sharp module the omni policy tools use, shared by
 * `omni_downsample_image` and `omni_convert_image`.
 */
export type SharpModule = (input: string, options?: object) => SharpPipeline;

export interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(options: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: boolean;
  }): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  png(): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  toFile(
    outputPath: string,
  ): Promise<{ width: number; height: number; size: number }>;
}

/**
 * Load sharp lazily (decision D9: soft dependency, mirroring the
 * image-view.ts convention). A load failure is an EXECUTION failure of
 * the calling invocation — onFailure semantics take over — never a
 * startup gate.
 */
export async function loadSharp(): Promise<SharpModule> {
  // sharp is a CJS `export =` module, so the callable is on `.default`
  // at runtime even though NodeNext types collapse that namespace away.
  return ((await import('sharp')) as unknown as { default: SharpModule })
    .default;
}
