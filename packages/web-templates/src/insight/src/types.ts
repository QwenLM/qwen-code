/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InsightData } from '../../../src/services/insight/types/StaticInsightTypes';
import type { QualitativeInsights as QualitativeData } from '../../../src/services/insight/types/QualitativeInsightTypes';

declare global {
  interface Window {
    React: typeof import('react');
    ReactDOM: typeof import('react-dom/client');
    Chart: any;
    html2canvas: any;
    INSIGHT_DATA: InsightData;
    /** The UI language code for the insight report (e.g., 'en', 'zh', 'ja'). */
    INSIGHT_LANGUAGE: string;
    /** Translation dictionary for the insight report static text. */
    INSIGHT_TRANSLATIONS: Record<string, string>;
  }
}

export type { InsightData, QualitativeData };
