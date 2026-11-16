import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const moduleUrl = (path) => pathToFileURL(`${process.cwd()}/${path}`).href;
const { parseManagedSessionEvent, managedSessionEventsDigest } = await import(
  moduleUrl('packages/core/dist/src/managed-runtime/managed-session-records.js')
);
const { describeTransaction } = await import(
  moduleUrl(
    'packages/core/dist/src/managed-runtime/http-managed-session-store.js',
  )
);
const { managedToolDigest } = await import(
  moduleUrl('packages/core/dist/src/tools/managed-tool-protocol.js')
);
const sessionKey = {
  tenantId: 'native-json-tenant',
  workspaceId: 'native-json-workspace',
  sessionId: 'f32ab418-9bf2-4f69-88e6-77ac5512bfb9',
};
const cwd = '/workspace';
const parentUuid = '00000000-0000-4000-8000-000000000001';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (records) =>
  Buffer.from(records.map((record) => JSON.stringify(record) + '\n').join(''));

function produce(name, target) {
  const event = parseManagedSessionEvent({
    v: 1,
    sequence: 1,
    eventId: 'native-json-event',
    sessionKey,
    kind: 'cancel.requested',
    occurredAt: 1700000000000,
    payload: {
      requestId: 'native-json-request',
      target,
      reason: 'digest fixture',
      requestedBy: 'trusted-entry-fixture',
    },
  });
  const marker = {
    transactionId: 'native-json-transaction',
    commandId: 'native-json-command',
    operation: 'requestCancel',
    contentDigest: managedToolDigest(event.payload),
    firstSequence: 1,
    lastSequence: 1,
    eventCount: 1,
    eventsDigest: managedSessionEventsDigest([event]),
    previousCommitDigest: null,
  };
  const record = (uuid, parent, subtype, managedSession) => ({
    uuid,
    parentUuid: parent,
    sessionId: sessionKey.sessionId,
    timestamp: '2023-11-14T22:13:20.000Z',
    type: 'system',
    subtype,
    cwd,
    version: 'native-json-test',
    managedSession,
  });
  const records = [
    record(
      '00000000-0000-4000-8000-000000000002',
      parentUuid,
      'managed_session_event_v1',
      event,
    ),
    record(
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      'managed_session_commit_v1',
      marker,
    ),
  ];
  const bytes = encode(records);
  const metadata = describeTransaction(records, bytes, 1, sessionKey);
  return {
    name,
    recordBytesBase64: bytes.toString('base64'),
    recordDigest: hash(bytes),
    metadata,
  };
}

const fromBits = (bits) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(bits);
  return buffer.readDoubleBE();
};
const boundaries = [
  0,
  -0,
  -1,
  0.125,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  1e-7,
  1e-6,
  1e20,
  1e21,
  9007199254740992,
  1000000000000000100,
  ...[
    '0000000000000002',
    '0000000000000003',
    '000fffffffffffff',
    '0010000000000000',
    '3eb0c6f7a0b5ed8c',
    '3eb0c6f7a0b5ed8d',
    '3eb0c6f7a0b5ed8e',
    '444b1ae4d6e2ef4e',
    '444b1ae4d6e2ef4f',
    '444b1ae4d6e2ef50',
    '43143ff3c1cb0959',
    '43143ff3c1cb095a',
    '43143ff3c1cb095b',
    '4430000000000000',
    '3fd5555555555555',
  ].flatMap((hex) => {
    const value = fromBits(BigInt(`0x${hex}`));
    return [value, -value];
  }),
];
let state = 0x4b325f6e61746976n;
const sampled = [];
while (sampled.length < 256) {
  state = BigInt.asUintN(
    64,
    state * 6364136223846793005n + 1442695040888963407n,
  );
  const value = fromBits(state);
  if (Number.isFinite(value)) sampled.push(value);
}
const strings = {
  10: 'ten',
  2: 'two',
  0: 'zero',
  '01': 'leading',
  4294967295: 'large',
  '\ud800': '\ud800',
  '\udfff': '\udfff',
  '\u{1f600}': '\u{1f600}',
  '\ue000': '\ue000',
  controls: '\u0000\b\f\n\r\t"\\/\u2028\u2029',
  payloadJson: '{"2":2.0, "10":-0, "a":1e0}',
  nested: [null, true, false, { z: -0.125, a: 1e21 }],
};
const cases = [
  produce('boundaries-and-strings', { values: boundaries, strings }),
  produce('seeded-binary64', sampled),
  produce('scalar-zero', 0),
  produce('scalar-rounded-integer', 9007199254740992),
];
const malformedMarkers = [];
for (const field of ['operation', 'contentDigest', 'previousCommitDigest']) {
  for (const value of [-0.125, false]) {
    const records = Buffer.from(cases[2].recordBytesBase64, 'base64')
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const marker = records[1].managedSession;
    marker[field] = value;
    const bytes = encode(records);
    malformedMarkers.push({
      name: `${field}:${value}`,
      recordBytesBase64: bytes.toString('base64'),
      recordDigest: hash(bytes),
      metadata: {
        ...cases[2].metadata,
        [field]: value,
        commitDigest: managedToolDigest(marker),
      },
    });
  }
}
process.stdout.write(
  JSON.stringify(
    {
      provenance:
        'Actual built TypeScript digest/descriptor functions; synthetic test envelopes. No SQL or authority admission.',
      sessionKey,
      cwd,
      parentUuid,
      cases,
      malformedMarkers,
    },
    null,
    2,
  ) + '\n',
);
