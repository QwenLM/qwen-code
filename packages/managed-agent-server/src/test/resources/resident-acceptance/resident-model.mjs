import { Buffer } from 'node:buffer';
import process from 'node:process';
import { saveResidentToolEvidence } from './resident-tool-evidence.mjs';
import http from 'node:http';
export const MODEL_PORT = 4191;
export const MODEL_BASE_URL = 'http://127.0.0.1:' + MODEL_PORT + '/v1';
export function createResidentModel(run, evidenceDirectory) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(run))
    throw new Error('Invalid model run ID');
  let requests = 0;
  const model = http.createServer(async (req, res) => {
    try {
      if (
        req.method !== 'POST' ||
        req.url !== '/v1/chat/completions' ||
        ++requests > 24
      )
        throw new Error('Unexpected model route/count');
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2097152) throw new Error('Model request too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== 'resident-ack-local' || body.stream !== true)
        throw new Error('Unexpected model parameters');
      const names = body.tools?.map((tool) => tool.function?.name).sort();
      if (
        JSON.stringify(names) !==
        JSON.stringify(['edit', 'read_file', 'write_file'])
      )
        throw new Error('Unexpected tool profile');
      let which = '';
      let results = [];
      for (const message of body.messages ?? []) {
        const content = JSON.stringify(message.content);
        if (message.role === 'user' && content.includes('K2_RESIDENT_ACK_')) {
          if (content.includes('K2_RESIDENT_ACK_FIRST:' + run)) which = 'first';
          else if (content.includes('K2_RESIDENT_ACK_SECOND:' + run))
            which = 'second';
          else throw new Error('Unknown run marker');
          results = [];
        } else if (message.role === 'tool') results.push(message);
      }
      const step = results.length;
      if (!which || step > 3) throw new Error('Unexpected model progression');
      const first = 'first:' + run;
      const second = 'second:' + run;
      if (
        which === 'second' &&
        step >= 1 &&
        !JSON.stringify(results[0]).includes(first)
      )
        throw new Error('Retained file not observed');
      if (
        step === 3 &&
        !JSON.stringify(results[2]).includes(which === 'first' ? first : second)
      )
        throw new Error('Real final read not observed');
      const tool = step < 3;
      let delta;
      if (tool) {
        const name = (
          which === 'first'
            ? ['write_file', 'edit', 'read_file']
            : ['read_file', 'edit', 'read_file']
        )[step];
        const args =
          name === 'write_file'
            ? { file_path: 'proof.txt', content: 'before:' + run }
            : name === 'edit'
              ? {
                  file_path: 'proof.txt',
                  old_string: which === 'first' ? 'before:' + run : first,
                  new_string: which === 'first' ? first : second,
                }
              : { file_path: 'proof.txt' };
        delta = {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `ack-${which}-${step}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        };
      } else {
        saveResidentToolEvidence(evidenceDirectory, run, which, body.messages);
        delta = {
          role: 'assistant',
          content: `K2_RESIDENT_ACK_DONE:${which}:${run}`,
        };
      }
      const chunk = (delta, finish_reason) =>
        JSON.stringify({
          id: `ack-${which}-${step}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'resident-ack-local',
          choices: [{ index: 0, delta, finish_reason }],
        });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      });
      res.end(
        `data: ${chunk(delta, null)}\n\ndata: ${chunk({}, tool ? 'tool_calls' : 'stop')}\n\ndata: [DONE]\n\n`,
      );
    } catch {
      // No request payloads, tool results, tokens or file contents enter logs.
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end('{"error":"resident model contract rejected"}');
      process.exitCode = 1;
    }
  });
  model.requestTimeout = 15000;
  model.headersTimeout = 10000;
  model.maxHeadersCount = 32;
  return model;
}
