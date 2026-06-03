import { describe, it, expect } from 'vitest';
import { stripExportMeta, createWorkflowSandbox } from './workflow-sandbox.js';

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

describe('createWorkflowSandbox', () => {
  it('exposes args verbatim', async () => {
    const sandbox = createWorkflowSandbox({
      args: { question: 'why?' },
      startTime: 1000,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return args.question`);
    expect(result).toBe('why?');
  });

  it('Date.now() returns startTime fixed value', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      startTime: 42,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return Date.now()`);
    expect(result).toBe(42);
  });

  it('Math.random() throws inside sandbox', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      startTime: 1,
      dispatch: async () => 'ignored',
    });
    await expect(sandbox.run(`return Math.random()`)).rejects.toThrow(
      /Math\.random/,
    );
  });

  it('return statement at top level captures the script result', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      startTime: 1,
      dispatch: async () => 'ignored',
    });
    const result = await sandbox.run(`return 1 + 2`);
    expect(result).toBe(3);
  });
});
