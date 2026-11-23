import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveResidentToolEvidence } from './resident-tool-evidence.mjs';

const run = 'unit_synthetic_owned_run';
function transcript(which) {
  const names =
    which === 'first'
      ? ['write_file', 'edit', 'read_file']
      : ['read_file', 'edit', 'read_file'];
  return [
    { role: 'system', content: 'MUST_NOT_ENTER_EVIDENCE' },
    {
      role: 'user',
      content: `K2_RESIDENT_ACK_${which.toUpperCase()}:${run}`,
    },
    ...names.flatMap((name, index) => {
      const id = `ack-${which}-${index}`;
      const args =
        name === 'write_file'
          ? { file_path: 'proof.txt', content: `before:${run}` }
          : name === 'edit'
            ? {
                file_path: 'proof.txt',
                old_string: `${which === 'first' ? 'before' : 'first'}:${run}`,
                new_string: `${which}:${run}`,
              }
            : { file_path: 'proof.txt' };
      return [
        {
          role: 'assistant',
          tool_calls: [
            {
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: id,
          content: [
            {
              type: 'text',
              text:
                name === 'read_file'
                  ? `${index === 0 ? 'first' : which}:${run}`
                  : 'synthetic unit-test write/edit reply',
            },
          ],
        },
      ];
    }),
  ];
}

test('captures the observed pairs without system or user content', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'resident-evidence-'));
  t.after(() => rmSync(directory, { recursive: true }));
  for (const which of ['first', 'second']) {
    const messages = transcript(which);
    const digest = saveResidentToolEvidence(directory, run, which, messages);
    assert.equal(
      saveResidentToolEvidence(directory, run, which, messages),
      digest,
    );
    const raw = readFileSync(join(directory, `${which}-tools.json`), 'utf8');
    const saved = JSON.parse(raw);
    assert.deepEqual(
      saved.records,
      [0, 1, 2].map((index) => ({
        call: messages[2 + index * 2].tool_calls[0],
        result: messages[3 + index * 2],
      })),
    );
    assert.equal(raw.includes('MUST_NOT_ENTER_EVIDENCE'), false);
  }
});

test('rejects wrong identity, path, result shape and inexact read bytes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'resident-evidence-'));
  t.after(() => rmSync(directory, { recursive: true }));
  for (const change of [
    (messages) => (messages[3].tool_call_id = 'foreign'),
    (messages) =>
      (messages[2].tool_calls[0].function.arguments =
        '{"file_path":"other.txt","content":"private"}'),
    (messages) => (messages[3].is_error = true),
    (messages) => (messages[7].content[0].text += '\n'),
    (messages) => (messages[3].content[0].text = 'x'.repeat(8193)),
    (messages) => messages.splice(3, 1),
  ]) {
    const messages = transcript('first');
    change(messages);
    assert.throws(() =>
      saveResidentToolEvidence(directory, run, 'first', messages),
    );
  }
  assert.throws(() => readFileSync(join(directory, 'first-tools.json')));
});

test('refuses altered retries and does not follow existing symlinks', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'resident-evidence-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const messages = transcript('first');
  saveResidentToolEvidence(directory, run, 'first', messages);
  messages[3].content[0].text = 'different reply';
  assert.throws(() =>
    saveResidentToolEvidence(directory, run, 'first', messages),
  );
  symlinkSync('first-tools.json', join(directory, 'second-tools.json'));
  assert.throws(() =>
    saveResidentToolEvidence(directory, run, 'second', transcript('second')),
  );
});
