/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InsightData } from '../../../cli/src/services/insight/types/StaticInsightTypes';
import type { QualitativeInsights as QualitativeData } from '../../../cli/src/services/insight/types/QualitativeInsightTypes';

// Translation types
export interface InsightTranslations {
  title: string;
  headerTitle: string;
  headerSubtitle: string;
  exportCard: string;
  lightTheme: string;
  darkTheme: string;
  atAGlance: string;
  whatsWorking: string;
  whatsHindering: string;
  quickWins: string;
  ambitiousWorkflows: string;
  seeMore: string;
  navWork: string;
  navUsage: string;
  navWins: string;
  navFriction: string;
  navFeatures: string;
  navPatterns: string;
  navHorizon: string;
  sectionWork: string;
  sectionUsage: string;
  sectionWins: string;
  sectionFriction: string;
  sectionFeatures: string;
  sectionPatterns: string;
  sectionHorizon: string;
  whatYouWorkOn: string;
  sessions: string;
  howYouUse: string;
  topToolsUsed: string;
  whatYouWanted: string;
  impressiveWorkflows: string;
  primarySuccess: string;
  outcomes: string;
  whereThingsGoWrong: string;
  frictionIntro: string;
  featuresToTry: string;
  newUsagePatterns: string;
  onTheHorizon: string;
  memorableMoment: string;
  totalMessages: string;
  totalSessions: string;
  totalHours: string;
  currentStreak: string;
  longestStreak: string;
  longestSession: string;
  mostActiveHour: string;
  linesAdded: string;
  linesRemoved: string;
  filesChanged: string;
  copy: string;
  copied: string;
  noData: string;
}

declare global {
  interface Window {
    React: typeof import('react');
    ReactDOM: typeof import('react-dom/client');
    Chart: any;
    html2canvas: any;
    INSIGHT_DATA: InsightData;
    INSIGHT_TRANSLATIONS: InsightTranslations;
    INSIGHT_LANGUAGE: string;
  }
}

export type { InsightData, QualitativeData };
