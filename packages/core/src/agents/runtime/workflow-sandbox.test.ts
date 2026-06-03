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

describe('createWorkflowSandbox primitives', () => {
  it('phase() pushes titles in script order', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      startTime: 1,
      dispatch: async () => 'ignored',
    });
    await sandbox.run(`phase("plan"); phase("build"); return 0`);
    expect(sandbox.getPhases()).toEqual(['plan', 'build']);
  });

  it('log() accumulates string and non-string arguments', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      startTime: 1,
      dispatch: async () => 'ignored',
    });
    await sandbox.run(`log("hi"); log(42); return 0`);
    expect(sandbox.getLogs()).toEqual(['hi', '42']);
  });

  it('agent() invokes dispatch and resolves with its return value', async () => {
    const seen: Array<{ prompt: string; label?: string }> = [];
    const sandbox = createWorkflowSandbox({
      args: undefined,
      startTime: 1,
      dispatch: async (prompt, opts) => {
        seen.push({ prompt, label: opts.label });
        return `echo: ${prompt}`;
      },
    });
    const result = await sandbox.run(
      `const a = await agent("write hello", { label: "h1" });
       return a;`,
    );
    expect(result).toBe('echo: write hello');
    expect(seen).toEqual([{ prompt: 'write hello', label: 'h1' }]);
  });

  it('agent() runs sequentially when called multiple times', async () => {
    const order: number[] = [];
    let counter = 0;
    const sandbox = createWorkflowSandbox({
      args: undefined,
      startTime: 1,
      dispatch: async () => {
        const myOrder = ++counter;
        await new Promise((r) => setTimeout(r, 5));
        order.push(myOrder);
        return String(myOrder);
      },
    });
    const result = await sandbox.run(`
      const a = await agent("first");
      const b = await agent("second");
      return [a, b];
    `);
    expect(result).toEqual(['1', '2']);
    expect(order).toEqual([1, 2]);
  });

  it('full P1 acceptance script: phase + agent returns expected value', async () => {
    const sandbox = createWorkflowSandbox({
      args: undefined,
      startTime: 1,
      dispatch: async (prompt) => `agent-response:${prompt}`,
    });
    const result = await sandbox.run(`
      phase("plan");
      const out = await agent("write a hello", { label: "h1" });
      return out;
    `);
    expect(result).toBe('agent-response:write a hello');
    expect(sandbox.getPhases()).toEqual(['plan']);
  });
});
