/**
 * Agent de Gestion de Projet Électrique - Québec
 * Spécialiste en coordination et suivi de projets électriques RBQ
 */

import { logger } from '../utils/logger.js';

export interface ProjectStatus {
  projectId: string;
  name: string;
  client: string;
  status: 'planning' | 'permit-pending' | 'in-progress' | 'inspection' | 'completed';
  completion: number; // percentage
  budget: BudgetTracking;
  timeline: TimelineTracking;
  team: TeamMember[];
  risks: Risk[];
  compliance: ComplianceStatus;
}

export interface BudgetTracking {
  estimated: number;
  actual: number;
  remaining: number;
  variance: number;
  laborCost: number;
  materialCost: number;
  permitCost: number;
}

export interface TimelineTracking {
  startDate: Date;
  estimatedCompletion: Date;
  actualCompletion?: Date;
  daysElapsed: number;
  daysRemaining: number;
  milestones: Milestone[];
}

export interface Milestone {
  name: string;
  targetDate: Date;
  completedDate?: Date;
  status: 'pending' | 'completed' | 'delayed';
}

export interface TeamMember {
  name: string;
  role: 'master-electrician' | 'journeyman' | 'apprentice';
  rbqLicense?: string;
  assignedTasks: string[];
  hoursWorked: number;
}

export interface Risk {
  id: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  probability: 'low' | 'medium' | 'high';
  mitigation: string;
  status: 'identified' | 'mitigated' | 'closed';
}

export interface ComplianceStatus {
  rbqPermit: boolean;
  municipalPermit: boolean;
  hydroQuebecApproval: boolean;
  inspectionsPassed: number;
  inspectionsRequired: number;
  certificateIssued: boolean;
}

export class ProjectManagerAgent {
  private agentName = 'Agent de Gestion de Projet Électrique';

  /**
   * Créer et initialiser un nouveau projet
   */
  async initializeProject(projectData: any): Promise<ProjectStatus> {
    logger.info(`${this.agentName}: Initialisation du projet ${projectData.name}`);

    const budget = this.estimateBudget(projectData);
    const timeline = this.createTimeline(projectData);
    const team = this.assembleTeam(projectData);
    const risks = this.identifyRisks(projectData);

    return {
      projectId: projectData.id,
      name: projectData.name,
      client: projectData.client,
      status: 'planning',
      completion: 0,
      budget,
      timeline,
      team,
      risks,
      compliance: {
        rbqPermit: false,
        municipalPermit: false,
        hydroQuebecApproval: false,
        inspectionsPassed: 0,
        inspectionsRequired: 3,
        certificateIssued: false
      }
    };
  }

  /**
   * Mettre à jour le statut du projet
   */
  async updateProjectStatus(projectId: string, updates: any): Promise<ProjectStatus> {
    logger.info(`${this.agentName}: Mise à jour du projet ${projectId}`);

    // Logique de mise à jour du statut
    // Dans une vraie implémentation, ceci récupérerait les données de la DB

    const updatedStatus: ProjectStatus = {
      ...updates,
      completion: this.calculateCompletion(updates)
    };

    // Vérifier les alertes
    if (updatedStatus.budget.variance > 10) {
      logger.warn(`${this.agentName}: Dépassement budgétaire de ${updatedStatus.budget.variance}%`);
    }

    if (updatedStatus.timeline.daysRemaining < 0) {
      logger.warn(`${this.agentName}: Projet en retard de ${Math.abs(updatedStatus.timeline.daysRemaining)} jours`);
    }

    return updatedStatus;
  }

  /**
   * Générer un rapport de projet détaillé
   */
  async generateProjectReport(projectId: string, status: ProjectStatus): Promise<string> {
    logger.info(`${this.agentName}: Génération du rapport de projet`);

    const report = `
RAPPORT DE PROJET ÉLECTRIQUE - QUÉBEC
======================================
Projet: ${status.name}
Client: ${status.client}
Date: ${new Date().toLocaleDateString('fr-CA')}

STATUT GÉNÉRAL
--------------
Avancement: ${status.completion}%
Statut: ${this.getStatusLabel(status.status)}

BUDGET
------
Budget estimé: ${status.budget.estimated.toLocaleString('fr-CA')} $
Coût actuel: ${status.budget.actual.toLocaleString('fr-CA')} $
Restant: ${status.budget.remaining.toLocaleString('fr-CA')} $
Écart: ${status.budget.variance > 0 ? '+' : ''}${status.budget.variance}%

Détail des coûts:
- Main-d'œuvre: ${status.budget.laborCost.toLocaleString('fr-CA')} $
- Matériel: ${status.budget.materialCost.toLocaleString('fr-CA')} $
- Permis: ${status.budget.permitCost.toLocaleString('fr-CA')} $

ÉCHÉANCIER
----------
Date de début: ${status.timeline.startDate.toLocaleDateString('fr-CA')}
Fin prévue: ${status.timeline.estimatedCompletion.toLocaleDateString('fr-CA')}
Jours écoulés: ${status.timeline.daysElapsed}
Jours restants: ${status.timeline.daysRemaining}

Jalons:
${status.timeline.milestones.map(m =>
  `  ${m.status === 'completed' ? '✓' : '○'} ${m.name} - ${m.targetDate.toLocaleDateString('fr-CA')}`
).join('\n')}

ÉQUIPE
------
${status.team.map(member =>
  `${member.name} - ${this.getRoleLabel(member.role)}${member.rbqLicense ? ' (RBQ: ' + member.rbqLicense + ')' : ''}`
).join('\n')}

CONFORMITÉ RBQ
--------------
${status.compliance.rbqPermit ? '✓' : '○'} Permis RBQ
${status.compliance.municipalPermit ? '✓' : '○'} Permis municipal
${status.compliance.hydroQuebecApproval ? '✓' : '○'} Approbation Hydro-Québec
Inspections: ${status.compliance.inspectionsPassed}/${status.compliance.inspectionsRequired}
${status.compliance.certificateIssued ? '✓' : '○'} Certificat de conformité

RISQUES
-------
${status.risks.map(risk =>
  `${this.getRiskIcon(risk.severity)} ${risk.description} (${risk.status})`
).join('\n')}

NOTES
-----
- Maître électricien responsable: ${status.team.find(m => m.role === 'master-electrician')?.name || 'À assigner'}
- Licence RBQ requise pour tous les travaux
- Inspection municipale obligatoire avant mise sous tension
`;

    return report;
  }

  /**
   * Suivre les heures de travail de l'équipe
   */
  async trackLaborHours(projectId: string, member: string, hours: number): Promise<void> {
    logger.info(`${this.agentName}: Enregistrement de ${hours}h pour ${member}`);

    // Logique d'enregistrement des heures
    // Calcul des coûts de main-d'œuvre
    // Mise à jour du budget
  }

  /**
   * Identifier les risques du projet
   */
  private identifyRisks(projectData: any): Risk[] {
    const risks: Risk[] = [];

    // Risque hivernal au Québec
    const currentMonth = new Date().getMonth();
    if (currentMonth >= 10 || currentMonth <= 3) {
      risks.push({
        id: 'risk-weather',
        description: 'Travaux hivernaux - conditions météo difficiles',
        severity: 'medium',
        probability: 'high',
        mitigation: 'Prévoir équipements résistants au froid, chauffage temporaire',
        status: 'identified'
      });
    }

    // Risque de délai de permis
    risks.push({
      id: 'risk-permits',
      description: 'Délai d\'obtention des permis RBQ/municipaux',
      severity: 'medium',
      probability: 'medium',
      mitigation: 'Soumettre demandes dès que possible, suivi régulier',
      status: 'identified'
    });

    // Risque de disponibilité des matériaux
    if (projectData.hasSpecialEquipment) {
      risks.push({
        id: 'risk-materials',
        description: 'Disponibilité des équipements spécialisés',
        severity: 'high',
        probability: 'medium',
        mitigation: 'Commander matériel à l\'avance, identifier fournisseurs alternatifs',
        status: 'identified'
      });
    }

    return risks;
  }

  /**
   * Estimer le budget du projet
   */
  private estimateBudget(projectData: any): BudgetTracking {
    // Estimation basée sur la complexité et la taille
    const laborHours = projectData.estimatedHours || 80;
    const laborRate = 75; // $/heure pour compagnon électricien au Québec
    const laborCost = laborHours * laborRate;

    const materialCost = projectData.estimatedMaterialCost || 5000;

    const permitCost = 200 + (projectData.requiresHydroConnection ? 500 : 0);

    const total = laborCost + materialCost + permitCost;

    return {
      estimated: total,
      actual: 0,
      remaining: total,
      variance: 0,
      laborCost,
      materialCost,
      permitCost
    };
  }

  /**
   * Créer l'échéancier du projet
   */
  private createTimeline(projectData: any): TimelineTracking {
    const startDate = new Date();
    const duration = projectData.estimatedDuration || 20; // jours
    const estimatedCompletion = new Date(startDate);
    estimatedCompletion.setDate(estimatedCompletion.getDate() + duration);

    const milestones: Milestone[] = [
      {
        name: 'Obtention des permis',
        targetDate: new Date(startDate.getTime() + 5 * 24 * 60 * 60 * 1000),
        status: 'pending'
      },
      {
        name: 'Installation panneau principal',
        targetDate: new Date(startDate.getTime() + 10 * 24 * 60 * 60 * 1000),
        status: 'pending'
      },
      {
        name: 'Câblage complet',
        targetDate: new Date(startDate.getTime() + 15 * 24 * 60 * 60 * 1000),
        status: 'pending'
      },
      {
        name: 'Inspection finale',
        targetDate: new Date(startDate.getTime() + 19 * 24 * 60 * 60 * 1000),
        status: 'pending'
      }
    ];

    return {
      startDate,
      estimatedCompletion,
      daysElapsed: 0,
      daysRemaining: duration,
      milestones
    };
  }

  /**
   * Assembler l'équipe de projet
   */
  private assembleTeam(projectData: any): TeamMember[] {
    return [
      {
        name: 'Maître électricien (à assigner)',
        role: 'master-electrician',
        rbqLicense: 'Requis',
        assignedTasks: ['Supervision générale', 'Conformité RBQ'],
        hoursWorked: 0
      },
      {
        name: 'Compagnon 1 (à assigner)',
        role: 'journeyman',
        assignedTasks: ['Installation', 'Câblage'],
        hoursWorked: 0
      },
      {
        name: 'Apprenti (à assigner)',
        role: 'apprentice',
        assignedTasks: ['Assistance', 'Préparation'],
        hoursWorked: 0
      }
    ];
  }

  /**
   * Calculer le pourcentage d'achèvement
   */
  private calculateCompletion(status: any): number {
    const milestoneWeight = 60;
    const budgetWeight = 20;
    const complianceWeight = 20;

    const milestonesComplete = status.timeline?.milestones?.filter(
      (m: Milestone) => m.status === 'completed'
    ).length || 0;
    const totalMilestones = status.timeline?.milestones?.length || 1;

    const milestoneScore = (milestonesComplete / totalMilestones) * milestoneWeight;
    const budgetScore = (status.budget?.actual / status.budget?.estimated || 0) * budgetWeight;
    const complianceScore = (status.compliance?.inspectionsPassed / status.compliance?.inspectionsRequired || 0) * complianceWeight;

    return Math.min(100, Math.round(milestoneScore + budgetScore + complianceScore));
  }

  // Méthodes utilitaires
  private getStatusLabel(status: string): string {
    const labels: { [key: string]: string } = {
      'planning': 'Planification',
      'permit-pending': 'En attente de permis',
      'in-progress': 'En cours',
      'inspection': 'Inspection',
      'completed': 'Complété'
    };
    return labels[status] || status;
  }

  private getRoleLabel(role: string): string {
    const labels: { [key: string]: string } = {
      'master-electrician': 'Maître électricien',
      'journeyman': 'Compagnon électricien',
      'apprentice': 'Apprenti électricien'
    };
    return labels[role] || role;
  }

  private getRiskIcon(severity: string): string {
    const icons: { [key: string]: string } = {
      'low': '○',
      'medium': '◐',
      'high': '●',
      'critical': '⚠'
    };
    return icons[severity] || '○';
  }
}
