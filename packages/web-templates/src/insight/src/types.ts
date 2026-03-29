/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InsightData as CoreInsightData } from '../../../src/services/insight/types/StaticInsightTypes';
import type { QualitativeInsights as QualitativeData } from '../../../src/services/insight/types/QualitativeInsightTypes';

// Extend the core InsightData type to ensure language is included
export interface InsightData extends Omit<CoreInsightData, 'language'> {
  language?: string;
}

declare global {
  interface Window {
    React: typeof import('react');
    ReactDOM: typeof import('react-dom/client');
    Chart: any;
    html2canvas: any;
    INSIGHT_DATA: InsightData;
  }
}

export type { QualitativeData };
