/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InsightData } from '../../../src/services/insight/types/StaticInsightTypes';
import type { QualitativeInsights as QualitativeData } from '../../../src/services/insight/types/QualitativeInsightTypes';

/**
 * Localized strings for the insight report
 */
export interface InsightLocalizedStrings {
  language: string;
  title: string;
  subtitle: string;
  messagesAcrossSessions: string;
  atAGlance: string;
  whatsWorking: string;
  whatsHindering: string;
  quickWins: string;
  ambitiousWorkflows: string;
  impressiveThingsYouDid: string;
  whereThingsGoWrong: string;
  existingFeaturesToTry: string;
  newWaysToUse: string;
  onTheHorizon: string;
  whatYouWorkOn: string;
  howYouUseQwenCode: string;
  whatYouWanted: string;
  topToolsUsed: string;
  whatHelpedMost: string;
  outcomes: string;
  primaryFrictionTypes: string;
  inferredSatisfaction: string;
  suggestedQwenMdAdditions: string;
  copyToQwenMd: string;
  copyAllChecked: string;
  copiedAll: string;
  whyForYou: string;
  pasteIntoQwenCode: string;
  gettingStarted: string;
  keyPattern: string;
  exportCard: string;
  lightTheme: string;
  darkTheme: string;
  noDataAvailable: string;
  seeMoreImpressive: string;
  seeMoreFriction: string;
  seeMoreFeatures: string;
  seeMoreHorizon: string;
  outputLanguage?: string;
}

declare global {
  interface Window {
    React: typeof import('react');
    ReactDOM: typeof import('react-dom/client');
    Chart: any;
    html2canvas: any;
    INSIGHT_DATA: InsightData;
    INSIGHT_I18N: InsightLocalizedStrings;
  }
}

export type { InsightData, QualitativeData };
