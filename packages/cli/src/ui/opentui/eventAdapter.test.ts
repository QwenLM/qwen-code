/**
 * Unit tests for the real-event → neutral-model adapter (P1d seam).
 * Run: node --experimental-strip-types packages/cli/src/ui/opentui/eventAdapter.test.ts
 */
import assert from 'node:assert/strict';
import { createEventMapper } from './eventAdapter.ts';

type AnyEv = Parameters<ReturnType<typeof createEventMapper>>[0];

// content -> text delta
{
  const map = createEventMapper();
  const out = map({ type: 'content', value: 'hello' } as unknown as AnyEv);
  assert.deepEqual(out, [{ type: 'text', delta: 'hello' }]);
}

// thought then content emits thinking-end before first text
{
  const map = createEventMapper();
  const t = map({ type: 'thought', value: { description: 'planning' } } as unknown as AnyEv);
  assert.deepEqual(t, [{ type: 'thinking', delta: 'planning' }]);
  const c = map({ type: 'content', value: 'answer' } as unknown as AnyEv);
  assert.deepEqual(c, [{ type: 'thinking-end' }, { type: 'text', delta: 'answer' }]);
}

// tool request/response
{
  const map = createEventMapper();
  const s = map({ type: 'tool_call_request', value: { callId: 'c1', name: 'shell' } } as unknown as AnyEv);
  assert.equal(s[0].type, 'tool-start');
  const e = map({ type: 'tool_call_response', value: { callId: 'c1', error: undefined } } as unknown as AnyEv);
  assert.deepEqual(e, [{ type: 'tool-end', id: 'c1', success: true, summary: 'ok' }]);
}

// finished -> done
{
  const map = createEventMapper();
  const d = map({ type: 'finished', value: {} } as unknown as AnyEv);
  assert.deepEqual(d, [{ type: 'done' }]);
}

console.log('eventAdapter.test: all assertions passed');
