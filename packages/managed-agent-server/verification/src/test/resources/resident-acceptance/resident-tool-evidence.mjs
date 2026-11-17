import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

const require = (condition, message) => {
  if (!condition) throw new Error(message);
};
const keys = (value, expected) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort());

export function saveResidentToolEvidence(directory, run, which, messages) {
  require(isAbsolute(directory), 'Absolute owned evidence directory required');
  require(typeof run === 'string' &&
    /^[A-Za-z0-9_-]{8,64}$/.test(run), 'Invalid experiment run');
  require(['first', 'second'].includes(which), 'Invalid experiment Session');
  const marker = `K2_RESIDENT_ACK_${which.toUpperCase()}:${run}`;
  const boundary = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      JSON.stringify(message.content).includes(marker),
  );
  require(boundary >= 0, 'Actual run marker missing');
  const tail = messages.slice(boundary + 1);
  require(tail.length === 6, 'Exactly three actual call/result pairs required');
  const first = `first:${run}`;
  const second = `second:${run}`;
  const names =
    which === 'first'
      ? ['write_file', 'edit', 'read_file']
      : ['read_file', 'edit', 'read_file'];
  const records = [];
  for (let index = 0; index < 3; index++) {
    const assistant = tail[index * 2];
    const result = tail[index * 2 + 1];
    require(assistant.role === 'assistant' &&
      Array.isArray(assistant.tool_calls) &&
      assistant.tool_calls.length ===
        1, 'One actual assistant tool call required');
    const call = assistant.tool_calls[0];
    const id = `ack-${which}-${index}`;
    const name = names[index];
    require(keys(call, ['id', 'type', 'function']) &&
      keys(call.function, ['name', 'arguments']) &&
      call.id === id &&
      call.type === 'function' &&
      call.function?.name === name &&
      typeof call.function.arguments ===
        'string', 'Actual call identity differs');
    const args = JSON.parse(call.function.arguments);
    const expected =
      name === 'write_file'
        ? { file_path: 'proof.txt', content: `before:${run}` }
        : name === 'edit'
          ? {
              file_path: 'proof.txt',
              old_string: which === 'first' ? `before:${run}` : first,
              new_string: which === 'first' ? first : second,
            }
          : { file_path: 'proof.txt' };
    require(keys(args, Object.keys(expected)) &&
      Object.entries(expected).every(
        ([key, value]) => args[key] === value,
      ), 'Only the owned proof-file operation is observable');
    require(keys(result, ['role', 'tool_call_id', 'content']) &&
      result.role === 'tool' &&
      result.tool_call_id === id &&
      Array.isArray(result.content) &&
      result.content.length === 1 &&
      keys(result.content[0], ['type', 'text']) &&
      result.content[0].type === 'text' &&
      typeof result.content[0].text ===
        'string', 'Actual bounded text tool reply required');
    const raw = Buffer.from(JSON.stringify(result));
    require(raw.length <= 8192, 'Tool reply exceeds experiment evidence limit');
    if (name === 'read_file') {
      require(Buffer.from(result.content[0].text).equals(
        Buffer.from(which === 'first' || index === 0 ? first : second),
      ), 'Retained file bytes differ');
    }
    records.push({ call, result });
  }
  const bytes = Buffer.from(
    JSON.stringify({
      format: 'resident-tool-evidence/1',
      run,
      which,
      records,
    }) + '\n',
  );
  require(bytes.length <= 32768, 'Experiment evidence exceeds limit');
  const path = join(directory, `${which}-tools.json`);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      require(fstatSync(existing).size ===
        bytes.length, 'Saved evidence size differs');
      require(readFileSync(existing).equals(bytes), 'Saved evidence differs');
    } finally {
      closeSync(existing);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return createHash('sha256').update(bytes).digest('hex');
}
