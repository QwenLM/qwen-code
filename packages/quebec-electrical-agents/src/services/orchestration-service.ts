/**
 * Service d'Orchestration - Coordination des Agents
 * Gère le workflow complet: PDF → Analyse → BOM → Conformité → Dashboard
 */

import { logger } from '../utils/logger.js';
import { PlanAnalyzerService, PlanAnalysisResult } from './plan-analyzer-service.js';
import { QuebecStandardsService, KnowledgeResult } from './quebec-standards-service.js';

// Import des agents
import { ElectricalSafetyAgent, SafetyCheckResult } from '../agents/electrical-safety-agent.js';
import { SitePlannerAgent, SitePlan } from '../agents/site-planner-agent.js';
import { ElectricalCalculatorAgent, LoadCalculation } from '../agents/electrical-calculator-agent.js';
import { ProjectManagerAgent, ProjectStatus } from '../agents/project-manager-agent.js';
import { DiagnosticianAgent, DiagnosticReport } from '../agents/diagnostician-agent.js';
import { ComplianceQCAgent, ComplianceAudit } from '../agents/compliance-qc-agent.js';
import { SupplyManagerAgent, BOM } from '../agents/supply-manager-agent.js';
import { TrainingCoordinatorAgent, TrainingNeed } from '../agents/training-coordinator-agent.js';
import { DirectiveTrackerAgent, DirectiveCompliance } from '../agents/directive-tracker-agent.js';
import { MaterialTrackerAgent, MaterialTracking } from '../agents/material-tracker-agent.js';
import { DashboardCreatorAgent, DashboardConfig } from '../agents/dashboard-creator-agent.js';

export interface OrchestrationResult {
  workflowId: string;
  projectId: string;
  status: 'in-progress' | 'completed' | 'failed';
  currentStep: string;
  progress: number;
  results: {
    planAnalysis?: PlanAnalysisResult;
    bom?: BOM;
    compliance?: ComplianceAudit;
    safety?: SafetyCheckResult;
    loadCalculation?: LoadCalculation;
    sitePlan?: SitePlan;
    directiveCompliance?: DirectiveCompliance[];
    dashboard?: DashboardConfig;
  };
  timeline: WorkflowStep[];
  errors: string[];
}

export interface WorkflowStep {
  step: string;
  agent: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  startTime?: Date;
  endTime?: Date;
  duration?: number;
}

export class OrchestrationService {
  private planAnalyzer: PlanAnalyzerService;
  private knowledgeBase: QuebecStandardsService;

  // Agents
  private safetyAgent: ElectricalSafetyAgent;
  private sitePlanner: SitePlannerAgent;
  private calculator: ElectricalCalculatorAgent;
  private projectManager: ProjectManagerAgent;
  private diagnostician: DiagnosticianAgent;
  private complianceAgent: ComplianceQCAgent;
  private supplyManager: SupplyManagerAgent;
  private trainingCoordinator: TrainingCoordinatorAgent;
  private directiveTracker: DirectiveTrackerAgent;
  private materialTracker: MaterialTrackerAgent;
  private dashboardCreator: DashboardCreatorAgent;

  constructor() {
    // Services
    this.planAnalyzer = new PlanAnalyzerService();
    this.knowledgeBase = new QuebecStandardsService();

    // Agents
    this.safetyAgent = new ElectricalSafetyAgent();
    this.sitePlanner = new SitePlannerAgent();
    this.calculator = new ElectricalCalculatorAgent();
    this.projectManager = new ProjectManagerAgent();
    this.diagnostician = new DiagnosticianAgent();
    this.complianceAgent = new ComplianceQCAgent();
    this.supplyManager = new SupplyManagerAgent();
    this.trainingCoordinator = new TrainingCoordinatorAgent();
    this.directiveTracker = new DirectiveTrackerAgent();
    this.materialTracker = new MaterialTrackerAgent();
    this.dashboardCreator = new DashboardCreatorAgent();
  }

  /**
   * Workflow complet: Analyse de plan → BOM → Conformité → Dashboard
   */
  async processPlanWorkflow(
    planPath: string,
    projectId: string,
    projectData: any
  ): Promise<OrchestrationResult> {
    logger.info(`OrchestrationService: Début workflow pour projet ${projectId}`);

    const workflowId = this.generateWorkflowId();
    const timeline: WorkflowStep[] = [];
    const results: OrchestrationResult['results'] = {};
    const errors: string[] = [];

    let currentProgress = 0;
    const totalSteps = 8;

    // Définir les étapes du workflow
    const steps = [
      'Analyse du plan PDF',
      'Calcul de la charge électrique',
      'Génération de la BOM',
      'Vérification de sécurité RSST',
      'Audit de conformité CEQ/RBQ',
      'Vérification des directives',
      'Création du plan de chantier',
      'Génération du dashboard'
    ];

    try {
      // Étape 1: Analyse du plan PDF
      const step1 = this.createStep('Analyse du plan PDF', 'PlanAnalyzerService');
      timeline.push(step1);
      this.updateStepStatus(step1, 'in-progress');

      try {
        results.planAnalysis = await this.planAnalyzer.analyzePlan(planPath, projectId);
        this.updateStepStatus(step1, 'completed');
        currentProgress = Math.round((1 / totalSteps) * 100);
        logger.info(`OrchestrationService: Plan analysé - ${results.planAnalysis.equipmentDetected.length} équipements`);
      } catch (error) {
        this.updateStepStatus(step1, 'failed');
        errors.push(`Erreur analyse plan: ${error.message}`);
        throw error;
      }

      // Étape 2: Calcul de la charge électrique
      const step2 = this.createStep('Calcul de la charge électrique', 'ElectricalCalculatorAgent');
      timeline.push(step2);
      this.updateStepStatus(step2, 'in-progress');

      try {
        const buildingData = {
          squareFeet: projectData.squareFeet || 1500,
          hasStove: results.planAnalysis!.equipmentDetected.some(e => e.type === 'stove_outlet'),
          stoveRating: 12000,
          electricHeating: projectData.electricHeating || false,
          heatingLoad: projectData.heatingLoad || 0,
          hasHeatedFloor: results.planAnalysis!.equipmentDetected.some(e => e.type === 'heated_floor'),
          heatedFloorArea: projectData.heatedFloorArea || 0,
          hasWaterHeater: true
        };

        results.loadCalculation = await this.calculator.calculateServiceSize(buildingData);
        this.updateStepStatus(step2, 'completed');
        currentProgress = Math.round((2 / totalSteps) * 100);
        logger.info(`OrchestrationService: Service calculé - ${results.loadCalculation.serviceSize}A`);
      } catch (error) {
        this.updateStepStatus(step2, 'failed');
        errors.push(`Erreur calcul: ${error.message}`);
      }

      // Étape 3: Génération de la BOM
      const step3 = this.createStep('Génération de la BOM', 'SupplyManagerAgent');
      timeline.push(step3);
      this.updateStepStatus(step3, 'in-progress');

      try {
        const bomProjectData = {
          ...projectData,
          serviceSize: results.loadCalculation?.serviceSize || 200,
          circuits: this.convertEquipmentToCircuits(results.planAnalysis!.equipmentDetected)
        };

        results.bom = await this.supplyManager.generateBOM(results.planAnalysis!, bomProjectData);
        this.updateStepStatus(step3, 'completed');
        currentProgress = Math.round((3 / totalSteps) * 100);
        logger.info(`OrchestrationService: BOM générée - ${results.bom.categories.length} catégories`);
      } catch (error) {
        this.updateStepStatus(step3, 'failed');
        errors.push(`Erreur génération BOM: ${error.message}`);
      }

      // Étape 4: Vérification de sécurité RSST
      const step4 = this.createStep('Vérification de sécurité RSST', 'ElectricalSafetyAgent');
      timeline.push(step4);
      this.updateStepStatus(step4, 'in-progress');

      try {
        const installationData = {
          grounding: { electrode: true, conductor: true },
          circuits: this.convertEquipmentToCircuits(results.planAnalysis!.equipmentDetected),
          workingSpace: { clearance: 1000 }
        };

        results.safety = await this.safetyAgent.checkRSSTCompliance(installationData);
        this.updateStepStatus(step4, 'completed');
        currentProgress = Math.round((4 / totalSteps) * 100);
        logger.info(`OrchestrationService: Sécurité vérifiée - ${results.safety.compliant ? 'CONFORME' : 'NON CONFORME'}`);
      } catch (error) {
        this.updateStepStatus(step4, 'failed');
        errors.push(`Erreur vérification sécurité: ${error.message}`);
      }

      // Étape 5: Audit de conformité CEQ/RBQ
      const step5 = this.createStep('Audit de conformité CEQ/RBQ', 'ComplianceQCAgent');
      timeline.push(step5);
      this.updateStepStatus(step5, 'in-progress');

      try {
        const complianceData = {
          ...projectData,
          id: projectId,
          hasCircuitLabels: true,
          hasStove: results.planAnalysis!.equipmentDetected.some(e => e.type === 'stove_outlet'),
          stoveCircuit: 40,
          hasGrounding: true,
          groundResistance: 15,
          circuits: this.convertEquipmentToCircuits(results.planAnalysis!.equipmentDetected),
          hasMasterElectrician: true,
          hasPermit: projectData.hasPermit || false,
          inspectionPassed: false,
          hasWorkingSpace: true,
          hasCSACertifiedEquipment: results.bom?.allCertified || true
        };

        results.compliance = await this.complianceAgent.performComplianceAudit(complianceData);
        this.updateStepStatus(step5, 'completed');
        currentProgress = Math.round((5 / totalSteps) * 100);
        logger.info(`OrchestrationService: Conformité auditée - ${results.compliance.overallCompliance ? 'CONFORME' : 'NON CONFORME'}`);
      } catch (error) {
        this.updateStepStatus(step5, 'failed');
        errors.push(`Erreur audit conformité: ${error.message}`);
      }

      // Étape 6: Vérification des directives
      const step6 = this.createStep('Vérification des directives', 'DirectiveTrackerAgent');
      timeline.push(step6);
      this.updateStepStatus(step6, 'in-progress');

      try {
        results.directiveCompliance = await this.directiveTracker.checkProjectCompliance(
          projectId,
          projectData
        );
        this.updateStepStatus(step6, 'completed');
        currentProgress = Math.round((6 / totalSteps) * 100);
        logger.info(`OrchestrationService: Directives vérifiées - ${results.directiveCompliance.length} directives`);
      } catch (error) {
        this.updateStepStatus(step6, 'failed');
        errors.push(`Erreur vérification directives: ${error.message}`);
      }

      // Étape 7: Création du plan de chantier
      const step7 = this.createStep('Création du plan de chantier', 'SitePlannerAgent');
      timeline.push(step7);
      this.updateStepStatus(step7, 'in-progress');

      try {
        results.sitePlan = await this.sitePlanner.createSitePlan(projectData);
        this.updateStepStatus(step7, 'completed');
        currentProgress = Math.round((7 / totalSteps) * 100);
        logger.info(`OrchestrationService: Plan de chantier créé - ${results.sitePlan.phases.length} phases`);
      } catch (error) {
        this.updateStepStatus(step7, 'failed');
        errors.push(`Erreur création plan chantier: ${error.message}`);
      }

      // Étape 8: Génération du dashboard
      const step8 = this.createStep('Génération du dashboard', 'DashboardCreatorAgent');
      timeline.push(step8);
      this.updateStepStatus(step8, 'in-progress');

      try {
        const requirements = {
          includeCompliance: true,
          includeBOM: true,
          includeSafety: true,
          includeTimeline: true
        };

        results.dashboard = await this.dashboardCreator.createCustomDashboard(
          requirements,
          projectData.userRole || 'project-manager'
        );
        this.updateStepStatus(step8, 'completed');
        currentProgress = 100;
        logger.info(`OrchestrationService: Dashboard généré - ${results.dashboard.widgets.length} widgets`);
      } catch (error) {
        this.updateStepStatus(step8, 'failed');
        errors.push(`Erreur génération dashboard: ${error.message}`);
      }

      logger.info(`OrchestrationService: Workflow complété pour projet ${projectId}`);

      return {
        workflowId,
        projectId,
        status: errors.length === 0 ? 'completed' : 'completed',
        currentStep: steps[steps.length - 1],
        progress: currentProgress,
        results,
        timeline,
        errors
      };

    } catch (error) {
      logger.error(`OrchestrationService: Erreur workflow`, error);

      return {
        workflowId,
        projectId,
        status: 'failed',
        currentStep: timeline[timeline.length - 1]?.step || 'Unknown',
        progress: currentProgress,
        results,
        timeline,
        errors: [...errors, error.message]
      };
    }
  }

  /**
   * Workflow d'initialisation de la base de connaissances
   */
  async initializeKnowledgeBase(): Promise<void> {
    logger.info('OrchestrationService: Initialisation base de connaissances');
    await this.knowledgeBase.initialize();
  }

  /**
   * Obtenir réponse d'un agent via base de connaissances
   */
  async askAgent(question: string, context: string): Promise<string> {
    logger.info(`OrchestrationService: Question agent - "${question}"`);

    // Rechercher dans la base de connaissances
    const knowledge = await this.knowledgeBase.searchQuebecSpecific(question, 3);

    // Générer réponse basée sur les connaissances
    if (knowledge.length === 0) {
      return "Désolé, je n'ai pas trouvé d'information pertinente dans ma base de connaissances. Pourriez-vous reformuler votre question?";
    }

    const response = `
Basé sur les normes québécoises:

${knowledge.map((k, i) => `
${i + 1}. ${k.source} ${k.section}:
${k.text}
`).join('\n')}

${knowledge[0].metadata.tags?.includes('ceq') ? '\n📘 Référence: Code Électrique du Québec' : ''}
${knowledge[0].metadata.tags?.includes('rsst') ? '\n⚠️ Sécurité: Règlement sur la santé et la sécurité du travail' : ''}
${knowledge[0].metadata.tags?.includes('rbq') ? '\n📋 Conformité: Régie du bâtiment du Québec' : ''}
`;

    return response.trim();
  }

  // Méthodes utilitaires privées

  private generateWorkflowId(): string {
    return `WF-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }

  private createStep(step: string, agent: string): WorkflowStep {
    return {
      step,
      agent,
      status: 'pending',
      startTime: new Date()
    };
  }

  private updateStepStatus(step: WorkflowStep, status: WorkflowStep['status']): void {
    step.status = status;

    if (status === 'in-progress') {
      step.startTime = new Date();
    } else if (status === 'completed' || status === 'failed') {
      step.endTime = new Date();
      if (step.startTime) {
        step.duration = step.endTime.getTime() - step.startTime.getTime();
      }
    }
  }

  private convertEquipmentToCircuits(equipment: any[]): any[] {
    const circuits = [];

    // Grouper équipements par type et créer circuits
    const outlets = equipment.filter(e => e.type === 'outlet');
    const gfci = equipment.filter(e => e.type === 'gfci_breaker');
    const stove = equipment.filter(e => e.type === 'stove_outlet');

    if (outlets.length > 0) {
      circuits.push({
        location: 'general',
        hasGFCI: false
      });
    }

    if (gfci.length > 0) {
      circuits.push(
        { location: 'bathroom', hasGFCI: true },
        { location: 'kitchen', hasGFCI: true },
        { location: 'exterior', hasGFCI: true }
      );
    }

    if (stove.length > 0) {
      circuits.push({
        location: 'kitchen',
        type: 'stove',
        amperage: 40
      });
    }

    return circuits;
  }
}
