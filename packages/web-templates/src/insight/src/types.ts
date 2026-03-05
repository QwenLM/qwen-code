/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InsightData } from '../../../src/services/insight/types/StaticInsightTypes';
import type { QualitativeInsights as QualitativeData } from '../../../src/services/insight/types/QualitativeInsightTypes';

// Supported languages for insight report
export type SupportedLanguage = 'en' | 'zh' | 'ja' | 'de' | 'pt' | 'ru';

declare global {
  interface Window {
    React: typeof import('react');
    ReactDOM: typeof import('react-dom/client');
    Chart: any;
    html2canvas: any;
    INSIGHT_DATA: InsightData;
    INSIGHT_LANGUAGE?: SupportedLanguage;
  }
}

export type { InsightData, QualitativeData };
