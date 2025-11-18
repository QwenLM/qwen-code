/**
 * Quebec Electrical Agents - Main Export
 * Système d'agents IA pour l'industrie électrique québécoise
 */

// Services
export { OrchestrationService } from './services/orchestration-service.js';
export { PlanAnalyzerService } from './services/plan-analyzer-service.js';
export { QuebecStandardsService } from './services/quebec-standards-service.js';

// Agents
export { ElectricalSafetyAgent } from './agents/electrical-safety-agent.js';
export { SitePlannerAgent } from './agents/site-planner-agent.js';
export { ElectricalCalculatorAgent } from './agents/electrical-calculator-agent.js';
export { ProjectManagerAgent } from './agents/project-manager-agent.js';
export { DiagnosticianAgent } from './agents/diagnostician-agent.js';
export { ComplianceQCAgent } from './agents/compliance-qc-agent.js';
export { SupplyManagerAgent } from './agents/supply-manager-agent.js';
export { TrainingCoordinatorAgent } from './agents/training-coordinator-agent.js';
export { DirectiveTrackerAgent } from './agents/directive-tracker-agent.js';
export { MaterialTrackerAgent } from './agents/material-tracker-agent.js';
export { DashboardCreatorAgent } from './agents/dashboard-creator-agent.js';

// Utilities
export { logger } from './utils/logger.js';

// Types
export type {
  SafetyCheckResult,
  SafetyViolation
} from './agents/electrical-safety-agent.js';

export type {
  SitePlan,
  WorkPhase,
  Permit
} from './agents/site-planner-agent.js';

export type {
  LoadCalculation,
  CircuitDesign
} from './agents/electrical-calculator-agent.js';

export type {
  ProjectStatus,
  BudgetTracking,
  TimelineTracking
} from './agents/project-manager-agent.js';

export type {
  DiagnosticReport,
  Issue,
  TestResults
} from './agents/diagnostician-agent.js';

export type {
  ComplianceAudit,
  StandardCheck,
  Deficiency
} from './agents/compliance-qc-agent.js';

export type {
  MaterialOrder,
  MaterialItem,
  BOM
} from './agents/supply-manager-agent.js';

export type {
  TrainingProgram,
  TrainingSession,
  TrainingNeed
} from './agents/training-coordinator-agent.js';

export type {
  Directive,
  DirectiveCompliance,
  DirectiveUpdate
} from './agents/directive-tracker-agent.js';

export type {
  MaterialTracking,
  MaterialLocation,
  MaterialAudit
} from './agents/material-tracker-agent.js';

export type {
  DashboardConfig,
  Widget,
  ChatMessage
} from './agents/dashboard-creator-agent.js';

export type {
  PlanAnalysisResult,
  DetectedEquipment,
  BOMItem
} from './services/plan-analyzer-service.js';

export type {
  KnowledgeResult
} from './services/quebec-standards-service.js';

export type {
  OrchestrationResult,
  WorkflowStep
} from './services/orchestration-service.js';
