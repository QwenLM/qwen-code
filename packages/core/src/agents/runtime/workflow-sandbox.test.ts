import { describe, it, expect } from 'vitest';
import { stripExportMeta } from './workflow-sandbox.js';

describe('stripExportMeta', () => {
  it('returns input unchanged when no export meta present', () => {
    const src = `phase("plan")\nreturn 1`;
    expect(stripExportMeta(src)).toBe(src);
  });

  it('strips a simple export const meta declaration', () => {
    const src = `export const meta = { name: 'x', description: 'y' }\nphase("plan")\nreturn 1`;
    expect(stripExportMeta(src)).toBe(`phase("plan")\nreturn 1`);
  });

  it('strips a multi-line export const meta with nested braces', () => {
    const src = `export const meta = {
  name: 'x',
  phases: [{ title: 'a' }, { title: 'b' }],
}
phase("plan")
return 1`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")\nreturn 1`);
  });

  it('strips an export meta followed by a trailing semicolon', () => {
    const src = `export const meta = { name: 'x' };\nphase("plan")`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")`);
  });

  it('does not strip a const meta without export keyword', () => {
    const src = `const meta = { name: 'x' }\nreturn meta`;
    expect(stripExportMeta(src)).toBe(src);
  });

  it('handles string literals containing closing brace characters', () => {
    const src = `export const meta = { name: 'x', description: 'hello }' }
phase("plan")
return 1`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")\nreturn 1`);
  });

  it('handles string literals containing opening brace characters', () => {
    const src = `export const meta = { name: 'x', description: 'hello { world' }
phase("plan")
return 1`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")\nreturn 1`);
  });

  it('handles escaped quote characters inside string literals', () => {
    const src = `export const meta = { name: 'x', description: 'it\\'s fine }' }
phase("plan")`;
    expect(stripExportMeta(src).trim()).toBe(`phase("plan")`);
  });
});
