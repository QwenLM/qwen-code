import * as fs from 'fs';

// Import DevTools trace engine and formatters from chrome-devtools-frontend
// We intentionally use deep imports to match the package structure.
// These modules are ESM and require NodeNext module resolution.
// Types are loosely typed to minimize coupling with DevTools internals.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as TraceEngine from 'chrome-devtools-frontend/front_end/models/trace/trace.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { PerformanceTraceFormatter } from 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceTraceFormatter.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { PerformanceInsightFormatter } from 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceInsightFormatter.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { AgentFocus } from 'chrome-devtools-frontend/front_end/models/ai_assistance/performance/AIContext.js';

const engine = TraceEngine.TraceModel.Model.createWithAllHandlers();

function readJsonFile(path: string): any {
  const text = fs.readFileSync(path, 'utf-8');
  return JSON.parse(text);
}

export async function parseTrace(json: any): Promise<{
  parsedTrace: any;
  insights: any | null;
}> {
  engine.resetProcessor();
  const events = Array.isArray(json) ? json : json.traceEvents;
  if (!events || !Array.isArray(events)) {
    throw new Error('Invalid trace format: expected array or {traceEvents: []}');
  }
  await engine.parse(events);
  const parsedTrace = engine.parsedTrace();
  const insights = parsedTrace?.insights ?? null;
  if (!parsedTrace) throw new Error('No parsed trace returned by engine');
  return { parsedTrace, insights };
}

export function getTraceSummary(parsedTrace: any): string {
  const focus = AgentFocus.fromParsedTrace(parsedTrace);
  const formatter = new PerformanceTraceFormatter(focus);
  return formatter.formatTraceSummary();
}

export function getInsightText(parsedTrace: any, insights: any, insightName: string): string {
  if (!insights) throw new Error('No insights available for this trace');
  const mainNavId = parsedTrace.data?.Meta?.mainFrameNavigations?.at(0)?.args?.data?.navigationId;
  const NO_NAV = TraceEngine.Types.Events.NO_NAVIGATION;
  const set = insights.get(mainNavId ?? NO_NAV);
  if (!set) throw new Error('No insights for selected navigation');
  const model = set.model || {};
  if (!(insightName in model)) throw new Error(`Insight not found: ${insightName}`);
  const formatter = new PerformanceInsightFormatter(
    AgentFocus.fromParsedTrace(parsedTrace),
    model[insightName],
  );
  return formatter.formatInsight();
}

export async function analyzeTraceFile(
  filePath: string,
  insightName?: string,
): Promise<{
  summary: string;
  insight?: string;
}> {
  const json = readJsonFile(filePath);
  const { parsedTrace, insights } = await parseTrace(json);
  const summary = getTraceSummary(parsedTrace);
  if (insightName) {
    try {
      const insight = getInsightText(parsedTrace, insights, insightName);
      return { summary, insight };
    } catch {
      // If requested insight missing, still return summary
      return { summary };
    }
  }
  return { summary };
}

export default { analyzeTraceFile };
