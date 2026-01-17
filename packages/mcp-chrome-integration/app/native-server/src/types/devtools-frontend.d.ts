// Minimal ambient declarations to avoid compiling chrome-devtools-frontend sources.
// We intentionally treat these modules as `any` to keep our build lightweight and decoupled
// from DevTools' internal TypeScript and lib targets.

declare module 'chrome-devtools-frontend/front_end/models/trace/trace.js' {
  // Shape used by our code: TraceModel + Types + Insights
  export const TraceModel: any;
  export const Types: any;
  export const Insights: any;
}

declare module 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceTraceFormatter.js' {
  export class PerformanceTraceFormatter {
    constructor(...args: any[]);
    formatTraceSummary(): string;
  }
}

declare module 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceInsightFormatter.js' {
  export class PerformanceInsightFormatter {
    constructor(...args: any[]);
    formatInsight(): string;
  }
}

declare module 'chrome-devtools-frontend/front_end/models/ai_assistance/performance/AIContext.js' {
  export const AgentFocus: any;
}
