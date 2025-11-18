/**
 * Agent de Conformité Qualité - Québec
 * Spécialiste en vérification de conformité CEQ/RBQ
 */

import { logger } from '../utils/logger.js';

export interface ComplianceAudit {
  auditId: string;
  projectId: string;
  auditDate: Date;
  auditor: string;
  standards: StandardCheck[];
  overallCompliance: boolean;
  deficiencies: Deficiency[];
  certificationReady: boolean;
}

export interface StandardCheck {
  standard: string; // CEQ, RBQ, RSST, CSA
  section: string;
  description: string;
  compliant: boolean;
  notes?: string;
}

export interface Deficiency {
  id: string;
  severity: 'minor' | 'major' | 'critical';
  standard: string;
  description: string;
  location: string;
  correctiveAction: string;
  deadline?: Date;
  resolved: boolean;
}

export class ComplianceQCAgent {
  private agentName = 'Agent de Conformité Qualité';

  /**
   * Effectuer un audit complet de conformité
   */
  async performComplianceAudit(projectData: any): Promise<ComplianceAudit> {
    logger.info(`${this.agentName}: Audit de conformité pour projet ${projectData.id}`);

    const standards: StandardCheck[] = [];
    const deficiencies: Deficiency[] = [];

    // 1. Vérification CEQ (Code Électrique du Québec)
    const ceqChecks = await this.verifyCEQCompliance(projectData);
    standards.push(...ceqChecks.standards);
    deficiencies.push(...ceqChecks.deficiencies);

    // 2. Vérification RBQ (Régie du Bâtiment du Québec)
    const rbqChecks = await this.verifyRBQCompliance(projectData);
    standards.push(...rbqChecks.standards);
    deficiencies.push(...rbqChecks.deficiencies);

    // 3. Vérification RSST (Santé et Sécurité du Travail)
    const rsstChecks = await this.verifyRSSTCompliance(projectData);
    standards.push(...rsstChecks.standards);
    deficiencies.push(...rsstChecks.deficiencies);

    // 4. Vérification CSA (Canadian Standards Association)
    const csaChecks = await this.verifyCSACompliance(projectData);
    standards.push(...csaChecks.standards);
    deficiencies.push(...csaChecks.deficiencies);

    const overallCompliance = deficiencies.filter(d => d.severity === 'critical').length === 0;
    const certificationReady = deficiencies.length === 0;

    return {
      auditId: this.generateAuditId(),
      projectId: projectData.id,
      auditDate: new Date(),
      auditor: projectData.auditor || 'Agent IA Conformité',
      standards,
      overallCompliance,
      deficiencies,
      certificationReady
    };
  }

  /**
   * Vérifier la conformité au Code Électrique du Québec
   */
  private async verifyCEQCompliance(projectData: any): Promise<any> {
    const standards: StandardCheck[] = [];
    const deficiencies: Deficiency[] = [];

    // CEQ Section 2 - Définitions et règles générales
    standards.push({
      standard: 'CEQ',
      section: '2-100',
      description: 'Identification et étiquetage des circuits',
      compliant: projectData.hasCircuitLabels || false,
      notes: projectData.hasCircuitLabels ? 'Conforme' : 'Circuits non étiquetés'
    });

    if (!projectData.hasCircuitLabels) {
      deficiencies.push({
        id: 'ceq-2-100',
        severity: 'minor',
        standard: 'CEQ 2-100',
        description: 'Circuits non étiquetés au panneau',
        location: 'Panneau de distribution',
        correctiveAction: 'Étiqueter tous les circuits',
        resolved: false
      });
    }

    // CEQ Section 6 - Branchements
    standards.push({
      standard: 'CEQ',
      section: '6-304',
      description: 'Circuit cuisinière ≥5000W',
      compliant: !projectData.hasStove || (projectData.stoveCircuit && projectData.stoveCircuit >= 40),
      notes: projectData.hasStove ? `Circuit ${projectData.stoveCircuit}A` : 'N/A'
    });

    if (projectData.hasStove && (!projectData.stoveCircuit || projectData.stoveCircuit < 40)) {
      deficiencies.push({
        id: 'ceq-6-304',
        severity: 'major',
        standard: 'CEQ 6-304',
        description: 'Circuit cuisinière insuffisant',
        location: 'Circuit cuisinière',
        correctiveAction: 'Installer circuit dédié 40A minimum',
        resolved: false
      });
    }

    // CEQ Section 10 - Mise à la terre
    standards.push({
      standard: 'CEQ',
      section: '10-700',
      description: 'Système de mise à la terre',
      compliant: projectData.hasGrounding && projectData.groundResistance < 25,
      notes: projectData.groundResistance ? `${projectData.groundResistance}Ω` : 'Non testé'
    });

    if (!projectData.hasGrounding || projectData.groundResistance >= 25) {
      deficiencies.push({
        id: 'ceq-10-700',
        severity: 'critical',
        standard: 'CEQ 10-700',
        description: 'Mise à la terre inadéquate',
        location: 'Électrode de mise à la terre',
        correctiveAction: 'Améliorer le système de mise à la terre (résistance < 25Ω)',
        resolved: false
      });
    }

    // CEQ Section 26 - Installations dans les habitations
    standards.push({
      standard: 'CEQ',
      section: '26-700',
      description: 'Protection DDFT/GFCI zones humides',
      compliant: this.hasRequiredGFCI(projectData),
      notes: 'Salles de bain, cuisine, extérieur, garage'
    });

    if (!this.hasRequiredGFCI(projectData)) {
      deficiencies.push({
        id: 'ceq-26-700',
        severity: 'critical',
        standard: 'CEQ 26-700',
        description: 'Protection DDFT manquante',
        location: 'Zones humides',
        correctiveAction: 'Installer disjoncteurs DDFT dans toutes les zones requises',
        resolved: false
      });
    }

    // CEQ Section 26-724 - Protection arc électrique (CAFCI)
    standards.push({
      standard: 'CEQ',
      section: '26-724',
      description: 'Protection CAFCI chambres à coucher',
      compliant: this.hasRequiredCAFCI(projectData),
      notes: 'Obligatoire pour toutes les chambres'
    });

    if (!this.hasRequiredCAFCI(projectData)) {
      deficiencies.push({
        id: 'ceq-26-724',
        severity: 'major',
        standard: 'CEQ 26-724',
        description: 'Protection CAFCI manquante',
        location: 'Circuits des chambres',
        correctiveAction: 'Installer disjoncteurs CAFCI pour toutes les chambres',
        resolved: false
      });
    }

    // CEQ Section 62 - Installations de chauffage électrique
    if (projectData.hasHeatedFloor) {
      standards.push({
        standard: 'CEQ',
        section: '62-116',
        description: 'Planchers chauffants électriques',
        compliant: projectData.heatedFloorCompliance || false,
        notes: 'Thermostat et protection requis'
      });

      if (!projectData.heatedFloorCompliance) {
        deficiencies.push({
          id: 'ceq-62-116',
          severity: 'major',
          standard: 'CEQ 62-116',
          description: 'Installation plancher chauffant non conforme',
          location: 'Planchers chauffants',
          correctiveAction: 'Installer thermostat limiteur et protection appropriée',
          resolved: false
        });
      }
    }

    return { standards, deficiencies };
  }

  /**
   * Vérifier la conformité RBQ
   */
  private async verifyRBQCompliance(projectData: any): Promise<any> {
    const standards: StandardCheck[] = [];
    const deficiencies: Deficiency[] = [];

    // Licence de maître électricien
    standards.push({
      standard: 'RBQ',
      section: 'Licence',
      description: 'Travaux effectués par titulaire de licence RBQ',
      compliant: projectData.hasMasterElectrician || false,
      notes: projectData.rbqLicense || 'Licence à vérifier'
    });

    if (!projectData.hasMasterElectrician) {
      deficiencies.push({
        id: 'rbq-license',
        severity: 'critical',
        standard: 'RBQ - Licence',
        description: 'Absence de maître électricien titulaire',
        location: 'Projet général',
        correctiveAction: 'Assigner un maître électricien avec licence RBQ valide',
        resolved: false
      });
    }

    // Permis de travaux
    standards.push({
      standard: 'RBQ',
      section: 'Permis',
      description: 'Permis de travaux électriques obtenu',
      compliant: projectData.hasPermit || false,
      notes: projectData.permitNumber || 'Permis en attente'
    });

    if (!projectData.hasPermit) {
      deficiencies.push({
        id: 'rbq-permit',
        severity: 'critical',
        standard: 'RBQ - Permis',
        description: 'Permis de travaux électriques non obtenu',
        location: 'Administratif',
        correctiveAction: 'Obtenir permis avant début des travaux',
        resolved: false
      });
    }

    // Inspection municipale
    standards.push({
      standard: 'RBQ',
      section: 'Inspection',
      description: 'Inspection municipale effectuée',
      compliant: projectData.inspectionPassed || false,
      notes: projectData.inspectionDate || 'À planifier'
    });

    return { standards, deficiencies };
  }

  /**
   * Vérifier la conformité RSST
   */
  private async verifyRSSTCompliance(projectData: any): Promise<any> {
    const standards: StandardCheck[] = [];
    const deficiencies: Deficiency[] = [];

    // RSST Article 177 - Espaces de travail
    standards.push({
      standard: 'RSST',
      section: 'Article 177',
      description: 'Espace de travail sécuritaire devant panneaux',
      compliant: projectData.hasWorkingSpace || false,
      notes: 'Minimum 1m de dégagement requis'
    });

    if (!projectData.hasWorkingSpace) {
      deficiencies.push({
        id: 'rsst-177',
        severity: 'major',
        standard: 'RSST Article 177',
        description: 'Espace de travail insuffisant',
        location: 'Devant panneaux électriques',
        correctiveAction: 'Maintenir un dégagement de 1m minimum',
        resolved: false
      });
    }

    // RSST Article 185 - Protection contre chocs électriques
    standards.push({
      standard: 'RSST',
      section: 'Article 185',
      description: 'Protection contre contacts indirects',
      compliant: projectData.hasGrounding || false,
      notes: 'Mise à la terre et protection différentielle'
    });

    return { standards, deficiencies };
  }

  /**
   * Vérifier la conformité CSA
   */
  private async verifyCSACompliance(projectData: any): Promise<any> {
    const standards: StandardCheck[] = [];
    const deficiencies: Deficiency[] = [];

    // CSA C22.1 - Certification des équipements
    standards.push({
      standard: 'CSA',
      section: 'C22.1',
      description: 'Équipements certifiés CSA ou équivalent',
      compliant: projectData.hasCSACertifiedEquipment || false,
      notes: 'Tous les appareils doivent porter marque CSA, UL ou équivalent'
    });

    if (!projectData.hasCSACertifiedEquipment) {
      deficiencies.push({
        id: 'csa-c22-1',
        severity: 'major',
        standard: 'CSA C22.1',
        description: 'Équipements non certifiés détectés',
        location: 'Équipements électriques',
        correctiveAction: 'Utiliser uniquement équipements certifiés CSA/UL',
        resolved: false
      });
    }

    // Certification pour températures extrêmes (Québec)
    if (projectData.hasExteriorEquipment) {
      standards.push({
        standard: 'CSA',
        section: 'Certification climatique',
        description: 'Équipements extérieurs certifiés -40°C',
        compliant: projectData.hasColdRatedEquipment || false,
        notes: 'Requis pour climat québécois'
      });

      if (!projectData.hasColdRatedEquipment) {
        deficiencies.push({
          id: 'csa-cold-rating',
          severity: 'major',
          standard: 'CSA - Certification climatique',
          description: 'Équipements extérieurs non certifiés températures extrêmes',
          location: 'Installations extérieures',
          correctiveAction: 'Remplacer par équipements certifiés -40°C à +40°C',
          resolved: false
        });
      }
    }

    return { standards, deficiencies };
  }

  /**
   * Générer un rapport de conformité
   */
  async generateComplianceReport(audit: ComplianceAudit): Promise<string> {
    logger.info(`${this.agentName}: Génération du rapport de conformité`);

    const criticalDeficiencies = audit.deficiencies.filter(d => d.severity === 'critical');
    const majorDeficiencies = audit.deficiencies.filter(d => d.severity === 'major');
    const minorDeficiencies = audit.deficiencies.filter(d => d.severity === 'minor');

    const report = `
RAPPORT DE CONFORMITÉ ÉLECTRIQUE - QUÉBEC
=========================================
Audit ID: ${audit.auditId}
Projet: ${audit.projectId}
Date: ${audit.auditDate.toLocaleDateString('fr-CA')}
Auditeur: ${audit.auditor}

RÉSULTAT GLOBAL
---------------
${audit.certificationReady ? '✓ PRÊT POUR CERTIFICATION' : '✗ NON CONFORME - CORRECTIONS REQUISES'}
Conformité globale: ${audit.overallCompliance ? 'OUI' : 'NON'}

DÉFICIENCES IDENTIFIÉES
------------------------
Critiques: ${criticalDeficiencies.length}
Majeures: ${majorDeficiencies.length}
Mineures: ${minorDeficiencies.length}

${criticalDeficiencies.length > 0 ? `
DÉFICIENCES CRITIQUES (à corriger immédiatement):
${criticalDeficiencies.map(d =>
  `⚠️  ${d.standard}: ${d.description}
     Location: ${d.location}
     Action: ${d.correctiveAction}
`).join('\n')}
` : ''}

${majorDeficiencies.length > 0 ? `
DÉFICIENCES MAJEURES (à corriger avant certification):
${majorDeficiencies.map(d =>
  `●  ${d.standard}: ${d.description}
     Location: ${d.location}
     Action: ${d.correctiveAction}
`).join('\n')}
` : ''}

${minorDeficiencies.length > 0 ? `
DÉFICIENCES MINEURES:
${minorDeficiencies.map(d =>
  `○  ${d.standard}: ${d.description}
     Location: ${d.location}
     Action: ${d.correctiveAction}
`).join('\n')}
` : ''}

VÉRIFICATIONS PAR NORME
-----------------------
${audit.standards.map(s =>
  `${s.compliant ? '✓' : '✗'} ${s.standard} ${s.section}: ${s.description}
   ${s.notes || ''}`
).join('\n')}

PROCHAINES ÉTAPES
-----------------
${audit.certificationReady ?
  '1. Planifier inspection finale municipale\n2. Obtenir certificat de conformité RBQ\n3. Mise sous tension autorisée' :
  '1. Corriger toutes les déficiences critiques\n2. Corriger les déficiences majeures\n3. Effectuer nouvel audit\n4. Planifier inspection municipale'
}

NOTES
-----
- Toutes les déficiences critiques doivent être corrigées avant mise sous tension
- Les déficiences majeures doivent être corrigées avant certification RBQ
- Conserver ce rapport pour l'inspection municipale
- Licence RBQ du maître électricien doit être valide
`;

    return report;
  }

  // Méthodes utilitaires privées
  private hasRequiredGFCI(data: any): boolean {
    const requiredLocations = ['bathroom', 'kitchen', 'exterior', 'garage', 'basement'];
    return requiredLocations.every(loc =>
      data.circuits?.some((c: any) => c.location === loc && c.hasGFCI)
    );
  }

  private hasRequiredCAFCI(data: any): boolean {
    const bedrooms = data.circuits?.filter((c: any) => c.location === 'bedroom') || [];
    return bedrooms.length === 0 || bedrooms.every((b: any) => b.hasCAFCI);
  }

  private generateAuditId(): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    return `AUDIT-QC-${timestamp}-${random}`;
  }
}
