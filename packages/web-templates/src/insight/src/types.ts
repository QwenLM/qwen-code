/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InsightData } from '../../../src/services/insight/types/StaticInsightTypes';
import type { QualitativeInsights as QualitativeData } from '../../../src/services/insight/types/QualitativeInsightTypes';

export type Translations = Record<string, string>;

declare global {
  interface Window {
    React: typeof import('react');
    ReactDOM: typeof import('react-dom/client');
    Chart: any;
    html2canvas: any;
    INSIGHT_DATA: InsightData;
    INSIGHT_TRANSLATIONS: Translations;
    INSIGHT_LANGUAGE: string;
  }
}

export type { InsightData, QualitativeData };
