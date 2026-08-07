// Builds qwen2 from the PROMOTED package code (packages/cli opentui backend).
// `qwen2`                          -> scripted validation conversation
// `qwen2 --resume <session.jsonl>` -> replay a REAL qwen-code session on OpenTUI
import { startOpenTuiUI } from '../../packages/cli/src/ui/render/opentuiEntry.js';
import { loadTranscriptEvents } from '../../packages/cli/src/ui/opentui/transcriptAdapter.js';
import type { StreamEvent } from '../../packages/cli/src/ui/model/streamingModel.js';

const args = process.argv.slice(2);
const ri = args.indexOf('--resume');
let events: AsyncIterable<StreamEvent> | undefined;
if (ri !== -1 && args[ri + 1]) {
  const list = loadTranscriptEvents(args[ri + 1]);
  events = (async function* () {
    for (const ev of list) {
      yield ev;
      // small stagger so streaming UI is observable
      await new Promise((r) => setTimeout(r, 8));
    }
  })();
}

await startOpenTuiUI({ events });
