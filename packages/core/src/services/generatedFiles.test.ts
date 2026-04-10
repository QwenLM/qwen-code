/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isGeneratedFile } from './generatedFiles.js';

describe('isGeneratedFile', () => {
  it('should exclude lock files', () => {
    expect(isGeneratedFile('package-lock.json')).toBe(true);
    expect(isGeneratedFile('yarn.lock')).toBe(true);
    expect(isGeneratedFile('pnpm-lock.yaml')).toBe(true);
    expect(isGeneratedFile('Cargo.lock')).toBe(true);
  });

  it('should exclude minified files', () => {
    expect(isGeneratedFile('app.min.js')).toBe(true);
    expect(isGeneratedFile('styles.min.css')).toBe(true);
    expect(isGeneratedFile('lib-min.js')).toBe(true);
  });

  it('should exclude files in dist/build directories', () => {
    expect(isGeneratedFile('dist/bundle.js')).toBe(true);
    expect(isGeneratedFile('build/output.js')).toBe(true);
    expect(isGeneratedFile('src/.next/cache.js')).toBe(true);
  });

  it('should exclude TypeScript declaration files', () => {
    expect(isGeneratedFile('types/index.d.ts')).toBe(true);
  });

  it('should exclude generated code files', () => {
    expect(isGeneratedFile('api.generated.ts')).toBe(true);
    expect(isGeneratedFile('schema.pb.go')).toBe(true);
    expect(isGeneratedFile('service.grpc.ts')).toBe(true);
  });

  it('should exclude vendor directories', () => {
    expect(isGeneratedFile('vendor/lib/utils.js')).toBe(true);
    expect(isGeneratedFile('node_modules/pkg/index.js')).toBe(true);
  });

  it('should NOT exclude normal source files', () => {
    expect(isGeneratedFile('src/main.ts')).toBe(false);
    expect(isGeneratedFile('lib/utils.js')).toBe(false);
    expect(isGeneratedFile('README.md')).toBe(false);
    expect(isGeneratedFile('package.json')).toBe(false);
    expect(isGeneratedFile('src/components/Button.tsx')).toBe(false);
  });
});
