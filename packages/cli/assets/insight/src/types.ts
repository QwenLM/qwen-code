/* eslint-disable @typescript-eslint/no-explicit-any */
import { InsightData } from '../../../src/services/insight/types/StaticInsightTypes';
import { QualitativeInsights as QualitativeData } from '../../../src/services/insight/types/QualitativeInsightTypes';

declare global {
  interface Window {
    React: typeof import('react');
    ReactDOM: typeof import('react-dom/client');
    Chart: any;
    html2canvas: any;
    INSIGHT_DATA: InsightData;
  }
}

export type { InsightData, QualitativeData };
