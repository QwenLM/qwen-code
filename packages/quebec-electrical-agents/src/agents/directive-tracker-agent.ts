/**
 * Agent de Suivi de Directive - Québec
 * Spécialiste en suivi des directives CEQ/RSST/RBQ
 */

import { logger } from '../utils/logger.js';

export interface Directive {
  directiveId: string;
  source: 'CEQ' | 'RSST' | 'RBQ' | 'CSA' | 'Municipal' | 'Internal';
  title: string;
  description: string;
  issuedDate: Date;
  effectiveDate: Date;
  category: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  affectedProjects: string[];
  status: 'active' | 'superseded' | 'archived';
  supersededBy?: string;
}

export interface DirectiveCompliance {
  directiveId: string;
  projectId: string;
  compliant: boolean;
  lastChecked: Date;
  findings: string[];
  correctiveActions: string[];
}

export interface DirectiveUpdate {
  updateId: string;
  source: string;
  updateDate: Date;
  changes: Change[];
  impactedDirectives: string[];
  actionRequired: boolean;
}

export interface Change {
  section: string;
  changeType: 'new' | 'modified' | 'removed';
  description: string;
  oldValue?: string;
  newValue?: string;
}

export class DirectiveTrackerAgent {
  private agentName = 'Agent de Suivi de Directive';

  /**
   * Récupérer toutes les directives actives
   */
  async getActiveDirectives(source?: string): Promise<Directive[]> {
    logger.info(`${this.agentName}: Récupération des directives actives ${source || 'toutes sources'}`);

    // Simuler une base de données de directives
    const allDirectives = this.getDirectiveDatabase();

    if (source) {
      return allDirectives.filter(d => d.source === source && d.status === 'active');
    }

    return allDirectives.filter(d => d.status === 'active');
  }

  /**
   * Base de données de directives simulée
   */
  private getDirectiveDatabase(): Directive[] {
    return [
      {
        directiveId: 'CEQ-2024-001',
        source: 'CEQ',
        title: 'Nouvelles exigences CAFCI pour chambres',
        description: 'Obligation d\'installer des disjoncteurs CAFCI dans toutes les chambres à coucher',
        issuedDate: new Date('2024-01-15'),
        effectiveDate: new Date('2024-06-01'),
        category: 'Protection électrique',
        priority: 'high',
        affectedProjects: ['residential'],
        status: 'active'
      },
      {
        directiveId: 'CEQ-2024-002',
        source: 'CEQ',
        title: 'Circuit cuisinière ≥5000W',
        description: 'Circuit dédié 40A minimum pour cuisinières de 5000W et plus',
        issuedDate: new Date('2023-11-01'),
        effectiveDate: new Date('2024-01-01'),
        category: 'Circuits spéciaux',
        priority: 'high',
        affectedProjects: ['residential', 'commercial'],
        status: 'active'
      },
      {
        directiveId: 'CEQ-2024-003',
        source: 'CEQ',
        title: 'Planchers chauffants CEQ 62-116',
        description: 'Exigences pour installation de planchers chauffants électriques',
        issuedDate: new Date('2023-09-15'),
        effectiveDate: new Date('2024-01-01'),
        category: 'Chauffage électrique',
        priority: 'medium',
        affectedProjects: ['residential'],
        status: 'active'
      },
      {
        directiveId: 'RSST-2024-001',
        source: 'RSST',
        title: 'Protection contre chocs électriques - Article 185',
        description: 'Renforcement des exigences de mise à la terre et protection différentielle',
        issuedDate: new Date('2024-02-01'),
        effectiveDate: new Date('2024-04-01'),
        category: 'Sécurité',
        priority: 'critical',
        affectedProjects: ['all'],
        status: 'active'
      },
      {
        directiveId: 'RSST-2024-002',
        source: 'RSST',
        title: 'Cadenassage des équipements électriques',
        description: 'Procédures obligatoires de cadenassage pour maintenance',
        issuedDate: new Date('2023-12-01'),
        effectiveDate: new Date('2024-01-01'),
        category: 'Sécurité',
        priority: 'high',
        affectedProjects: ['all'],
        status: 'active'
      },
      {
        directiveId: 'RBQ-2024-001',
        source: 'RBQ',
        title: 'Formation continue maîtres électriciens',
        description: 'Obligation de 8 heures de formation continue annuelle',
        issuedDate: new Date('2024-01-01'),
        effectiveDate: new Date('2024-01-01'),
        category: 'Formation',
        priority: 'medium',
        affectedProjects: ['all'],
        status: 'active'
      },
      {
        directiveId: 'RBQ-2024-002',
        source: 'RBQ',
        title: 'Inspection municipale pré-mise sous tension',
        description: 'Inspection obligatoire avant toute mise sous tension',
        issuedDate: new Date('2023-10-01'),
        effectiveDate: new Date('2024-01-01'),
        category: 'Conformité',
        priority: 'critical',
        affectedProjects: ['all'],
        status: 'active'
      },
      {
        directiveId: 'CSA-2024-001',
        source: 'CSA',
        title: 'Équipements certifiés températures extrêmes',
        description: 'Certification obligatoire -40°C pour équipements extérieurs au Québec',
        issuedDate: new Date('2023-11-15'),
        effectiveDate: new Date('2024-01-01'),
        category: 'Équipements',
        priority: 'high',
        affectedProjects: ['all'],
        status: 'active'
      },
      {
        directiveId: 'INTERNAL-2024-001',
        source: 'Internal',
        title: 'Étiquetage complet des panneaux',
        description: 'Tous les circuits doivent être clairement étiquetés',
        issuedDate: new Date('2024-01-01'),
        effectiveDate: new Date('2024-01-01'),
        category: 'Qualité',
        priority: 'medium',
        affectedProjects: ['all'],
        status: 'active'
      },
      {
        directiveId: 'MUNICIPAL-2024-001',
        source: 'Municipal',
        title: 'Délais d\'inspection - Ville de Montréal',
        description: 'Demande d\'inspection au moins 48h à l\'avance',
        issuedDate: new Date('2024-01-15'),
        effectiveDate: new Date('2024-02-01'),
        category: 'Administration',
        priority: 'medium',
        affectedProjects: ['montreal'],
        status: 'active'
      }
    ];
  }

  /**
   * Vérifier la conformité d'un projet aux directives
   */
  async checkProjectCompliance(projectId: string, projectData: any): Promise<DirectiveCompliance[]> {
    logger.info(`${this.agentName}: Vérification conformité projet ${projectId}`);

    const activeDirectives = await this.getActiveDirectives();
    const complianceResults: DirectiveCompliance[] = [];

    for (const directive of activeDirectives) {
      // Vérifier si la directive s'applique au projet
      if (!this.directiveApplies(directive, projectData)) {
        continue;
      }

      const compliance = await this.checkDirectiveCompliance(directive, projectData);
      complianceResults.push({
        directiveId: directive.directiveId,
        projectId,
        compliant: compliance.compliant,
        lastChecked: new Date(),
        findings: compliance.findings,
        correctiveActions: compliance.correctiveActions
      });
    }

    return complianceResults;
  }

  /**
   * Vérifier si une directive s'applique au projet
   */
  private directiveApplies(directive: Directive, projectData: any): boolean {
    if (directive.affectedProjects.includes('all')) {
      return true;
    }

    return directive.affectedProjects.some(ap => {
      if (ap === 'residential' && projectData.type === 'residential') return true;
      if (ap === 'commercial' && projectData.type === 'commercial') return true;
      if (ap === 'montreal' && projectData.city === 'Montreal') return true;
      return false;
    });
  }

  /**
   * Vérifier conformité à une directive spécifique
   */
  private async checkDirectiveCompliance(directive: Directive, projectData: any): Promise<any> {
    const findings: string[] = [];
    const correctiveActions: string[] = [];
    let compliant = true;

    switch (directive.directiveId) {
      case 'CEQ-2024-001': // CAFCI chambres
        if (projectData.type === 'residential') {
          const bedrooms = projectData.circuits?.filter((c: any) => c.location === 'bedroom') || [];
          const missingCAFCI = bedrooms.filter((b: any) => !b.hasCAFCI);

          if (missingCAFCI.length > 0) {
            compliant = false;
            findings.push(`${missingCAFCI.length} chambres sans protection CAFCI`);
            correctiveActions.push('Installer disjoncteurs CAFCI pour toutes les chambres');
          }
        }
        break;

      case 'CEQ-2024-002': // Circuit cuisinière
        if (projectData.hasStove && projectData.stoveRating >= 5000) {
          if (!projectData.stoveCircuit || projectData.stoveCircuit < 40) {
            compliant = false;
            findings.push('Circuit cuisinière insuffisant pour appareil ≥5000W');
            correctiveActions.push('Installer circuit dédié 40A minimum');
          }
        }
        break;

      case 'CEQ-2024-003': // Planchers chauffants
        if (projectData.hasHeatedFloor) {
          if (!projectData.heatedFloorCompliance) {
            compliant = false;
            findings.push('Installation planchers chauffants non conforme CEQ 62-116');
            correctiveActions.push('Installer thermostat limiteur et protection appropriée');
          }
        }
        break;

      case 'RSST-2024-001': // Protection contre chocs
        if (!projectData.hasGrounding || projectData.groundResistance >= 25) {
          compliant = false;
          findings.push('Mise à la terre inadéquate (résistance ≥ 25Ω)');
          correctiveActions.push('Améliorer système de mise à la terre');
        }

        const requiredGFCI = ['bathroom', 'kitchen', 'exterior', 'garage'];
        const missingGFCI = requiredGFCI.filter(loc =>
          !projectData.circuits?.some((c: any) => c.location === loc && c.hasGFCI)
        );

        if (missingGFCI.length > 0) {
          compliant = false;
          findings.push(`Protection DDFT manquante: ${missingGFCI.join(', ')}`);
          correctiveActions.push('Installer disjoncteurs DDFT dans zones requises');
        }
        break;

      case 'RBQ-2024-002': // Inspection municipale
        if (!projectData.inspectionScheduled) {
          compliant = false;
          findings.push('Inspection municipale non planifiée');
          correctiveActions.push('Planifier inspection avant mise sous tension');
        }
        break;

      case 'CSA-2024-001': // Équipements températures extrêmes
        if (projectData.hasExteriorEquipment && !projectData.hasColdRatedEquipment) {
          compliant = false;
          findings.push('Équipements extérieurs non certifiés -40°C');
          correctiveActions.push('Utiliser équipements certifiés températures extrêmes');
        }
        break;
    }

    return { compliant, findings, correctiveActions };
  }

  /**
   * Surveiller les mises à jour réglementaires
   */
  async monitorDirectiveUpdates(): Promise<DirectiveUpdate[]> {
    logger.info(`${this.agentName}: Surveillance des mises à jour réglementaires`);

    // Simuler des mises à jour récentes
    const updates: DirectiveUpdate[] = [
      {
        updateId: 'UPD-2024-001',
        source: 'CEQ',
        updateDate: new Date('2024-01-15'),
        changes: [
          {
            section: 'Section 26-724',
            changeType: 'modified',
            description: 'Extension CAFCI aux salles familiales',
            oldValue: 'Chambres à coucher uniquement',
            newValue: 'Chambres et salles familiales'
          }
        ],
        impactedDirectives: ['CEQ-2024-001'],
        actionRequired: true
      }
    ];

    return updates;
  }

  /**
   * Générer rapport de conformité aux directives
   */
  async generateDirectiveReport(projectId: string, compliance: DirectiveCompliance[]): Promise<string> {
    logger.info(`${this.agentName}: Génération rapport de conformité aux directives`);

    const compliantCount = compliance.filter(c => c.compliant).length;
    const nonCompliantCount = compliance.length - compliantCount;

    const criticalIssues = compliance.filter(c =>
      !c.compliant && c.directiveId.includes('RSST') || c.directiveId.includes('RBQ')
    );

    const report = `
RAPPORT DE CONFORMITÉ AUX DIRECTIVES - QUÉBEC
=============================================
Projet: ${projectId}
Date: ${new Date().toLocaleDateString('fr-CA')}
Agent: ${this.agentName}

RÉSUMÉ
------
Directives vérifiées: ${compliance.length}
Conformes: ${compliantCount}
Non-conformes: ${nonCompliantCount}
${criticalIssues.length > 0 ? `⚠️  Issues critiques: ${criticalIssues.length}` : ''}

DÉTAIL PAR DIRECTIVE
--------------------
${compliance.map(c => {
  const icon = c.compliant ? '✓' : '✗';
  return `
${icon} Directive: ${c.directiveId}
   Conforme: ${c.compliant ? 'OUI' : 'NON'}
   Dernière vérification: ${c.lastChecked.toLocaleDateString('fr-CA')}
   ${c.findings.length > 0 ?
    `\n   Constats:\n${c.findings.map(f => `     - ${f}`).join('\n')}` :
    ''
  }
   ${c.correctiveActions.length > 0 ?
    `\n   Actions correctives:\n${c.correctiveActions.map(a => `     - ${a}`).join('\n')}` :
    ''
  }
`;
}).join('\n')}

${criticalIssues.length > 0 ? `
ACTIONS PRIORITAIRES
--------------------
${criticalIssues.map(issue => `
⚠️  ${issue.directiveId}
   ${issue.correctiveActions.join('\n   ')}
`).join('\n')}
` : ''}

RECOMMANDATIONS
---------------
- Corriger immédiatement les non-conformités RSST et RBQ
- Mettre en place un système de veille réglementaire
- Former l'équipe aux nouvelles directives
- Documenter toutes les actions correctives
- Planifier revues de conformité trimestrielles

PROCHAINE RÉVISION
-------------------
Date recommandée: ${new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toLocaleDateString('fr-CA')}
(90 jours)
`;

    return report;
  }

  /**
   * Créer des alertes pour directives critiques
   */
  async createDirectiveAlerts(compliance: DirectiveCompliance[]): Promise<string[]> {
    const alerts: string[] = [];

    const criticalNonCompliance = compliance.filter(c =>
      !c.compliant && (c.directiveId.includes('RSST') || c.directiveId.includes('RBQ'))
    );

    for (const nc of criticalNonCompliance) {
      alerts.push(
        `ALERTE CRITIQUE: Non-conformité ${nc.directiveId} - ${nc.findings.join(', ')}`
      );
    }

    return alerts;
  }

  /**
   * Enregistrer l'accusé de réception d'une directive
   */
  async acknowledgeDirective(directiveId: string, userId: string): Promise<void> {
    logger.info(`${this.agentName}: Accusé de réception directive ${directiveId} par ${userId}`);

    // Logique d'enregistrement
    // Dans une vraie implémentation, ceci serait sauvegardé en DB
  }
}
