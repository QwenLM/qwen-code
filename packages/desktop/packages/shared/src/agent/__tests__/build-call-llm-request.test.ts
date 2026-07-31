/**
 * Tests for buildCallLlmRequest() — the shared pre-execution pipeline
 * used by backend PreToolUse adapters.
 *
 * Tests cover input validation, attachment processing, schema injection,
 * and the validateModel callback hook.
 */
import { describe, it, expect } from 'bun:test';
import { buildCallLlmRequest } from '../llm-tool.ts';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';

// ============================================================
// Test fixtures
// ============================================================

const TMP_DIR = join(import.meta.dir, '__tmp_build_call_llm__');

function setupFixtures() {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, 'test.ts'), 'const x = 1;\nconst y = 2;\n');
  writeFileSync(join(TMP_DIR, 'empty.ts'), '');
  writeFileSync(join(TMP_DIR, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG header
}

function cleanupFixtures() {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

// ============================================================
// Tests
// ============================================================

describe('buildCallLlmRequest()', () => {
  // Setup/teardown
  setupFixtures();
  // Note: cleanup at end of file via process.on

  // --- Validation ---

  it('throws on empty prompt', async () => {
    await expect(
      buildCallLlmRequest({ prompt: '' }, { backendName: 'Test' })
    ).rejects.toThrow('Prompt is required');
  });

  it('throws on whitespace-only prompt', async () => {
    await expect(
      buildCallLlmRequest({ prompt: '   ' }, { backendName: 'Test' })
    ).rejects.toThrow('Prompt is required');
  });

  it('throws on missing prompt', async () => {
    await expect(
      buildCallLlmRequest({} as Record<string, unknown>, { backendName: 'Test' })
    ).rejects.toThrow('Prompt is required');
  });

  // --- Basic request ---

  it('builds request from prompt-only input', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'Summarize this' },
      { backendName: 'Test' }
    );
    expect(result.prompt).toBe('Summarize this');
    expect(result.systemPrompt).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('passes through systemPrompt', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'test', systemPrompt: 'Be concise' },
      { backendName: 'Test' }
    );
    expect(result.systemPrompt).toContain('Be concise');
  });

  it('passes through maxTokens and temperature', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'test', maxTokens: 1000, temperature: 0.5 },
      { backendName: 'Test' }
    );
    expect(result.maxTokens).toBe(1000);
    expect(result.temperature).toBe(0.5);
  });

  // --- Attachments ---

  it('processes text file attachments', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'Summarize', attachments: [join(TMP_DIR, 'test.ts')] },
      { backendName: 'Test' }
    );
    expect(result.prompt).toContain('<file path="test.ts">');
    expect(result.prompt).toContain('const x = 1;');
    expect(result.prompt).toContain('Summarize');
  });

  it('rejects image attachments', async () => {
    await expect(
      buildCallLlmRequest(
        { prompt: 'test', attachments: [join(TMP_DIR, 'image.png')] },
        { backendName: 'Codex' }
      )
    ).rejects.toThrow('Image attachments are not supported in Codex mode');
  });

  it('rejects missing file attachments', async () => {
    await expect(
      buildCallLlmRequest(
        { prompt: 'test', attachments: ['/nonexistent/file.ts'] },
        { backendName: 'Test' }
      )
    ).rejects.toThrow('File not found');
  });

  // --- Schema injection ---

  it('injects outputFormat schema into systemPrompt', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'test', outputFormat: 'summary' },
      { backendName: 'Test' }
    );
    expect(result.systemPrompt).toContain('JSON');
    expect(result.systemPrompt).toContain('summary');
    expect(result.systemPrompt).toContain('key_points');
  });

  it('injects custom outputSchema into systemPrompt', async () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    const result = await buildCallLlmRequest(
      { prompt: 'test', outputSchema: schema },
      { backendName: 'Test' }
    );
    expect(result.systemPrompt).toContain('"name"');
    expect(result.systemPrompt).toContain('JSON');
  });

  it('appends schema to existing systemPrompt', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'test', systemPrompt: 'Custom instructions', outputFormat: 'classification' },
      { backendName: 'Test' }
    );
    expect(result.systemPrompt).toContain('Custom instructions');
    expect(result.systemPrompt).toContain('category');
  });

  it('includes outputSchema in returned request from outputFormat', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'test', outputFormat: 'summary' },
      { backendName: 'Test' }
    );
    expect(result.outputSchema).toBeDefined();
    expect((result.outputSchema as Record<string, unknown>).type).toBe('object');
  });

  it('includes custom outputSchema in returned request', async () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    const result = await buildCallLlmRequest(
      { prompt: 'test', outputSchema: schema },
      { backendName: 'Test' }
    );
    expect(result.outputSchema).toEqual(schema);
  });

  it('does not include outputSchema when no schema specified', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'test' },
      { backendName: 'Test' }
    );
    expect(result.outputSchema).toBeUndefined();
  });

  // --- validateModel callback ---

  it('calls validateModel with resolved model ID', async () => {
    let receivedModel = '';
    await buildCallLlmRequest(
      { prompt: 'test', model: 'some-model-id' },
      {
        backendName: 'Test',
        validateModel: (modelId) => {
          receivedModel = modelId;
          return modelId;
        },
      }
    );
    expect(receivedModel).toBe('some-model-id');
  });

  it('clears model when validateModel returns undefined', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'test', model: 'some-model-id' },
      {
        backendName: 'Test',
        validateModel: () => undefined,
      }
    );
    expect(result.model).toBeUndefined();
  });

  it('uses corrected model from validateModel', async () => {
    const result = await buildCallLlmRequest(
      { prompt: 'test', model: 'some-model-id' },
      {
        backendName: 'Test',
        validateModel: () => 'corrected-model',
      }
    );
    expect(result.model).toBe('corrected-model');
  });
});

// Cleanup
process.on('exit', () => {
  try { cleanupFixtures(); } catch {}
});
