// Test 1 — do `tools`, `tool_calls`, and assistant+tool history pass through
// the batch body untouched? Answers plan §6 question 1.
//   node docs/verification/batch-api/01-tools.mjs
import {
  client,
  line,
  writeJsonl,
  submit,
  waitFor,
  collect,
  save,
  cleanup,
  bodyOf,
  MODEL,
} from './lib.mjs';

const oa = client();
const system = {
  role: 'system',
  content: 'You are a terse assistant. Use tools when they apply.',
};
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Get the current local time in a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];
const common = { model: MODEL, enable_thinking: false, temperature: 0 };

const lines = [
  // L1: should come back with finish_reason=tool_calls
  line('L1-call', {
    ...common,
    tools,
    tool_choice: 'auto',
    messages: [system, { role: 'user', content: '北京现在几点？' }],
  }),
  // L2: prior assistant tool_call + tool result in history; should answer using 10:30
  line('L2-history', {
    ...common,
    tools,
    messages: [
      system,
      { role: 'user', content: '北京现在几点？' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_time', arguments: '{"city":"北京"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"time":"10:30"}' },
    ],
  }),
  // L3: control, no tools
  line('L3-plain', {
    ...common,
    messages: [system, { role: 'user', content: 'Say hello in one word.' }],
  }),
];

const submitted = await submit(oa, writeJsonl('01-tools.jsonl', lines));
const batch = await waitFor(oa, submitted.id);
const { err, byId } = await collect(oa, batch);

const m = (id) => bodyOf(byId[id])?.choices?.[0];
const l1 = m('L1-call'),
  l2 = m('L2-history'),
  l3 = m('L3-plain');
const verdict = {
  status: batch.status,
  request_counts: batch.request_counts,
  L1_finish_reason: l1?.finish_reason ?? null,
  L1_tool_name: l1?.message?.tool_calls?.[0]?.function?.name ?? null,
  L1_pass:
    l1?.finish_reason === 'tool_calls' &&
    l1?.message?.tool_calls?.[0]?.function?.name === 'get_time',
  L2_content: l2?.message?.content ?? null,
  L2_pass:
    typeof l2?.message?.content === 'string' &&
    l2.message.content.includes('10:30'),
  L3_content: l3?.message?.content ?? null,
  L3_pass: Boolean(l3?.message?.content),
  errors: err.map((e) => ({
    custom_id: e.custom_id,
    error: e.error ?? e.response?.body?.error ?? null,
  })),
};
verdict.pass =
  verdict.L1_pass && verdict.L2_pass && verdict.L3_pass && err.length === 0;
save('01-tools.result.json', { verdict, batch, raw: byId });
await cleanup(oa, batch);
console.log(verdict.pass ? 'PASS' : 'FAIL', JSON.stringify(verdict, null, 2));
