/**
 * Agent de Formation - Québec
 * Spécialiste en coordination de formation selon RSST
 */

import { logger } from '../utils/logger.js';

export interface TrainingProgram {
  programId: string;
  name: string;
  description: string;
  duration: number; // heures
  certification: string;
  topics: string[];
  requiredFor: string[];
  validityPeriod?: number; // mois
}

export interface TrainingSession {
  sessionId: string;
  programId: string;
  date: Date;
  instructor: string;
  participants: Participant[];
  location: string;
  status: 'scheduled' | 'completed' | 'cancelled';
}

export interface Participant {
  name: string;
  employeeId: string;
  role: string;
  attended: boolean;
  score?: number;
  certificationIssued: boolean;
  expiryDate?: Date;
}

export interface TrainingNeed {
  employeeId: string;
  name: string;
  role: string;
  requiredTraining: string[];
  completedTraining: string[];
  missingTraining: string[];
  expiringCertifications: ExpCert[];
}

export interface ExpCert {
  certification: string;
  expiryDate: Date;
  daysRemaining: number;
}

export class TrainingCoordinatorAgent {
  private agentName = 'Agent de Formation';

  /**
   * Identifier les besoins de formation pour un projet
   */
  async identifyTrainingNeeds(projectData: any, team: any[]): Promise<TrainingNeed[]> {
    logger.info(`${this.agentName}: Identification des besoins de formation`);

    const needs: TrainingNeed[] = [];

    for (const member of team) {
      const required = this.getRequiredTrainingForRole(member.role, projectData);
      const completed = member.completedTraining || [];
      const missing = required.filter(r => !completed.includes(r));
      const expiring = this.checkExpiringCertifications(member);

      needs.push({
        employeeId: member.id,
        name: member.name,
        role: member.role,
        requiredTraining: required,
        completedTraining: completed,
        missingTraining: missing,
        expiringCertifications: expiring
      });
    }

    return needs;
  }

  /**
   * Obtenir la formation requise selon le rôle et le projet
   */
  private getRequiredTrainingForRole(role: string, projectData: any): string[] {
    const training: string[] = [];

    // Formation de base obligatoire RSST
    training.push('RSST - Santé et sécurité générale');

    if (role === 'master-electrician' || role === 'journeyman') {
      training.push('CEQ - Code électrique du Québec (mise à jour)');
      training.push('RSST Article 185 - Protection contre chocs électriques');
      training.push('Cadenassage et étiquetage');
      training.push('Travail en hauteur');
    }

    if (role === 'master-electrician') {
      training.push('Licence RBQ - Formation continue');
      training.push('Gestion de projet électrique');
      training.push('Inspection et certification');
    }

    // Formation spécifique au projet
    if (projectData.hasThreePhase) {
      training.push('Systèmes triphasés haute tension');
    }

    if (projectData.hasHeatedFloor) {
      training.push('Installation planchers chauffants (CEQ 62-116)');
    }

    if (projectData.hasSpecialEquipment) {
      training.push('Équipements électriques spécialisés');
    }

    // Conditions hivernales québécoises
    const currentMonth = new Date().getMonth();
    if (currentMonth >= 10 || currentMonth <= 3) {
      training.push('Travaux électriques en conditions hivernales');
    }

    return training;
  }

  /**
   * Vérifier les certifications expirantes
   */
  private checkExpiringCertifications(member: any): ExpCert[] {
    const expiring: ExpCert[] = [];
    const now = new Date();
    const threeMonthsFromNow = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    if (member.certifications) {
      for (const cert of member.certifications) {
        const expiryDate = new Date(cert.expiryDate);
        if (expiryDate <= threeMonthsFromNow) {
          const daysRemaining = Math.floor((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

          expiring.push({
            certification: cert.name,
            expiryDate,
            daysRemaining
          });
        }
      }
    }

    return expiring;
  }

  /**
   * Obtenir les programmes de formation disponibles
   */
  async getAvailablePrograms(): Promise<TrainingProgram[]> {
    logger.info(`${this.agentName}: Récupération des programmes de formation`);

    return [
      {
        programId: 'RSST-BASE',
        name: 'RSST - Santé et sécurité générale',
        description: 'Formation de base en santé et sécurité du travail selon RSST',
        duration: 8,
        certification: 'Certificat RSST',
        topics: [
          'Droits et obligations',
          'Identification des dangers',
          'Équipements de protection individuelle',
          'Procédures d\'urgence'
        ],
        requiredFor: ['Tous les travailleurs'],
        validityPeriod: 36
      },
      {
        programId: 'RSST-185',
        name: 'RSST Article 185 - Protection électrique',
        description: 'Protection contre les chocs électriques et contacts indirects',
        duration: 4,
        certification: 'Certificat RSST Article 185',
        topics: [
          'Risques électriques',
          'Mise à la terre',
          'Protection différentielle',
          'Distances de sécurité'
        ],
        requiredFor: ['Électriciens', 'Techniciens'],
        validityPeriod: 36
      },
      {
        programId: 'CEQ-UPDATE',
        name: 'Mise à jour Code Électrique du Québec',
        description: 'Changements récents au CEQ et bonnes pratiques',
        duration: 16,
        certification: 'Attestation CEQ',
        topics: [
          'Modifications récentes au CEQ',
          'Nouvelles exigences DDFT/CAFCI',
          'Planchers chauffants CEQ 62-116',
          'Circuits spéciaux ≥5000W'
        ],
        requiredFor: ['Maîtres électriciens', 'Compagnons'],
        validityPeriod: 24
      },
      {
        programId: 'LOCKOUT',
        name: 'Cadenassage et étiquetage',
        description: 'Procédures de cadenassage selon RSST',
        duration: 4,
        certification: 'Certificat cadenassage',
        topics: [
          'Principes du cadenassage',
          'Identification des sources d\'énergie',
          'Procédures de vérification',
          'Cadenassage de groupe'
        ],
        requiredFor: ['Électriciens', 'Maintenanciers'],
        validityPeriod: 36
      },
      {
        programId: 'HEIGHT-WORK',
        name: 'Travail en hauteur',
        description: 'Sécurité lors de travaux en hauteur selon RSST',
        duration: 8,
        certification: 'Certificat travail en hauteur',
        topics: [
          'Équipements de protection contre les chutes',
          'Échafaudages et plateformes',
          'Procédures de sauvetage',
          'Inspection des équipements'
        ],
        requiredFor: ['Électriciens', 'Monteurs de lignes'],
        validityPeriod: 36
      },
      {
        programId: 'RBQ-CONTINUING',
        name: 'Formation continue RBQ',
        description: 'Formation continue obligatoire pour licence RBQ',
        duration: 8,
        certification: 'Attestation RBQ',
        topics: [
          'Évolutions réglementaires',
          'Nouvelles technologies',
          'Gestion de la qualité',
          'Responsabilités professionnelles'
        ],
        requiredFor: ['Maîtres électriciens'],
        validityPeriod: 12
      },
      {
        programId: 'WINTER-WORK',
        name: 'Travaux électriques en conditions hivernales',
        description: 'Adaptation au climat québécois',
        duration: 4,
        certification: 'Attestation conditions hivernales',
        topics: [
          'Équipements certifiés -40°C',
          'Protection contre le gel',
          'Chauffage temporaire de chantier',
          'Entrées de câbles étanches'
        ],
        requiredFor: ['Électriciens travaillant à l\'extérieur'],
        validityPeriod: 24
      },
      {
        programId: 'HEATED-FLOOR',
        name: 'Installation planchers chauffants',
        description: 'Planchers chauffants électriques selon CEQ 62-116',
        duration: 8,
        certification: 'Certification planchers chauffants',
        topics: [
          'CEQ Section 62-116',
          'Dimensionnement et calculs',
          'Installation et protection',
          'Thermostats et contrôles',
          'Tests et mise en service'
        ],
        requiredFor: ['Électriciens spécialisés'],
        validityPeriod: 36
      }
    ];
  }

  /**
   * Planifier une session de formation
   */
  async scheduleTrainingSession(
    programId: string,
    date: Date,
    instructor: string,
    participants: string[],
    location: string
  ): Promise<TrainingSession> {
    logger.info(`${this.agentName}: Planification de session de formation ${programId}`);

    const session: TrainingSession = {
      sessionId: this.generateSessionId(),
      programId,
      date,
      instructor,
      participants: participants.map(p => ({
        name: p,
        employeeId: '',
        role: '',
        attended: false,
        certificationIssued: false
      })),
      location,
      status: 'scheduled'
    };

    return session;
  }

  /**
   * Générer un rapport de formation
   */
  async generateTrainingReport(needs: TrainingNeed[]): Promise<string> {
    logger.info(`${this.agentName}: Génération du rapport de formation`);

    const totalEmployees = needs.length;
    const employeesNeedingTraining = needs.filter(n => n.missingTraining.length > 0).length;
    const expiringCerts = needs.reduce((sum, n) => sum + n.expiringCertifications.length, 0);

    const report = `
RAPPORT DE FORMATION - QUÉBEC
==============================
Date: ${new Date().toLocaleDateString('fr-CA')}
Agent: ${this.agentName}

RÉSUMÉ
------
Employés total: ${totalEmployees}
Employés nécessitant formation: ${employeesNeedingTraining}
Certifications expirantes (3 mois): ${expiringCerts}

BESOINS PAR EMPLOYÉ
-------------------
${needs.map(need => `
${need.name} (${need.role})
  Formation complétée: ${need.completedTraining.length}
  Formation manquante: ${need.missingTraining.length}
  ${need.missingTraining.length > 0 ?
    `\n  À compléter:\n${need.missingTraining.map(t => `    - ${t}`).join('\n')}` :
    '  ✓ Toutes les formations requises complétées'
  }
  ${need.expiringCertifications.length > 0 ?
    `\n  ⚠️ Certifications expirantes:\n${need.expiringCertifications.map(c =>
      `    - ${c.certification} (expire dans ${c.daysRemaining} jours)`
    ).join('\n')}` :
    ''
  }
`).join('\n')}

PRIORITÉS
---------
1. Renouveler les certifications expirantes immédiatement
2. Compléter les formations obligatoires RSST
3. Formations spécifiques au projet
4. Formation continue RBQ (maîtres électriciens)

CONFORMITÉ RÉGLEMENTAIRE
-------------------------
- RSST: Formation de base obligatoire pour tous
- RBQ: Formation continue annuelle pour maîtres électriciens
- CEQ: Mise à jour recommandée aux 2 ans
- Cadenassage: Obligatoire pour travaux électriques

RECOMMANDATIONS
---------------
- Planifier sessions de groupe pour optimiser les coûts
- Programmer formations durant période creuse hivernale
- Documenter toutes les formations dans les dossiers RBQ
- Prévoir budget formation annuel: 500$ par électricien
`;

    return report;
  }

  /**
   * Enregistrer la complétion d'une formation
   */
  async recordTrainingCompletion(
    sessionId: string,
    participantId: string,
    score: number
  ): Promise<void> {
    logger.info(`${this.agentName}: Enregistrement complétion formation ${sessionId}`);

    const passingScore = 70;
    const passed = score >= passingScore;

    if (passed) {
      // Émettre certificat
      const expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + 36); // 36 mois de validité

      logger.info(`${this.agentName}: Certificat émis - expire ${expiryDate.toLocaleDateString('fr-CA')}`);
    } else {
      logger.warn(`${this.agentName}: Échec - note: ${score}% (minimum: ${passingScore}%)`);
    }
  }

  // Méthodes utilitaires privées
  private generateSessionId(): string {
    return `TRAIN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }
}
