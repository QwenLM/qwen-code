/**
 * Agent de Sécurité Électrique - Québec
 * Spécialiste en conformité RSST et sécurité des installations électriques
 */

import { logger } from '../utils/logger.js';
import { QuebecStandardsService } from '../services/quebec-standards-service.js';

export interface SafetyCheckResult {
  compliant: boolean;
  violations: SafetyViolation[];
  recommendations: string[];
  rsstReferences: string[];
}

export interface SafetyViolation {
  code: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  location?: string;
  remedy: string;
}

export class ElectricalSafetyAgent {
  private standardsService: QuebecStandardsService;
  private agentName = 'Agent de Sécurité Électrique';

  constructor() {
    this.standardsService = new QuebecStandardsService();
  }

  /**
   * Vérifie la conformité RSST d'une installation
   */
  async checkRSSTCompliance(installationData: any): Promise<SafetyCheckResult> {
    logger.info(`${this.agentName}: Vérification RSST en cours...`);

    const violations: SafetyViolation[] = [];
    const recommendations: string[] = [];
    const rsstReferences: string[] = [];

    // Vérification des dispositifs de protection
    if (!this.hasProperGrounding(installationData)) {
      violations.push({
        code: 'RSST-185',
        severity: 'critical',
        description: 'Mise à la terre inadéquate ou manquante',
        remedy: 'Installer un système de mise à la terre conforme au CEQ Section 10'
      });
      rsstReferences.push('RSST Article 185 - Protection contre les contacts indirects');
    }

    // Vérification DDFT/GFCI
    if (!this.hasRequiredGFCI(installationData)) {
      violations.push({
        code: 'CEQ-26-700',
        severity: 'high',
        description: 'Absence de DDFT dans les zones humides',
        remedy: 'Installer des disjoncteurs différentiels (GFCI) dans salles de bain, cuisine, extérieur'
      });
      rsstReferences.push('CEQ Section 26-700 - Protection par DDFT');
    }

    // Vérification protection arc électrique (CAFCI)
    if (this.requiresArcFaultProtection(installationData)) {
      violations.push({
        code: 'CEQ-26-724',
        severity: 'high',
        description: 'Protection CAFCI manquante pour les chambres',
        remedy: 'Installer des disjoncteurs CAFCI pour tous les circuits de chambres à coucher'
      });
    }

    // Conditions hivernales québécoises
    if (this.hasOutdoorEquipment(installationData)) {
      recommendations.push(
        'Utiliser des équipements certifiés pour températures extrêmes (-40°C à +40°C)',
        'Prévoir des entrées de câbles étanches contre le gel et l\'humidité',
        'Installer des chauffages de prévention du gel pour panneaux extérieurs'
      );
    }

    // Espaces de travail sécuritaires (RSST Article 177)
    if (!this.hasSafeWorkingSpace(installationData)) {
      violations.push({
        code: 'RSST-177',
        severity: 'medium',
        description: 'Espace de travail insuffisant devant les équipements électriques',
        remedy: 'Maintenir un dégagement minimum de 1m devant les panneaux électriques'
      });
      rsstReferences.push('RSST Article 177 - Espaces de travail');
    }

    const compliant = violations.filter(v => v.severity === 'critical' || v.severity === 'high').length === 0;

    logger.info(`${this.agentName}: Analyse complétée - ${compliant ? 'CONFORME' : 'NON CONFORME'}`);

    return {
      compliant,
      violations,
      recommendations,
      rsstReferences
    };
  }

  /**
   * Génère un rapport de sécurité détaillé
   */
  async generateSafetyReport(projectId: string): Promise<string> {
    logger.info(`${this.agentName}: Génération du rapport de sécurité pour projet ${projectId}`);

    const report = `
RAPPORT DE SÉCURITÉ ÉLECTRIQUE - QUÉBEC
========================================
Projet: ${projectId}
Agent: ${this.agentName}
Date: ${new Date().toLocaleDateString('fr-CA')}

NORMES DE RÉFÉRENCE:
- RSST (Règlement sur la santé et la sécurité du travail)
- CEQ (Code électrique du Québec)
- CSA C22.1

POINTS DE VÉRIFICATION OBLIGATOIRES:

1. Mise à la terre (RSST Article 185)
   ☐ Électrode de mise à la terre conforme
   ☐ Conducteur de liaison principal dimensionné selon CEQ Table 17
   ☐ Continuité vérifiée

2. Protection différentielle (CEQ 26-700)
   ☐ DDFT dans salles de bain
   ☐ DDFT dans cuisine (prises comptoirs)
   ☐ DDFT extérieur
   ☐ DDFT garage et sous-sol

3. Protection contre les arcs (CEQ 26-724)
   ☐ CAFCI chambres à coucher
   ☐ CAFCI salles familiales
   ☐ CAFCI salles à manger

4. Équipements spéciaux Québec
   ☐ Circuit cuisinière ≥5000W (CEQ 6-304)
   ☐ Planchers chauffants (CEQ 62-116)
   ☐ Dégivreur de toiture (si applicable)

5. Conditions climatiques
   ☐ Équipements certifiés -40°C
   ☐ Entrées étanches IP65 minimum
   ☐ Protection contre le gel

RESPONSABILITÉS RBQ:
- Maître électricien responsable de la conformité
- Inspection municipale requise avant mise sous tension
- Certificat de conformité RBQ obligatoire

RECOMMANDATIONS:
- Vérifier les distances d'approche (RSST Article 185)
- Former le personnel aux procédures de cadenassage
- Tenir un registre des inspections périodiques
`;

    return report;
  }

  /**
   * Vérifie les exigences de cadenassage (RSST)
   */
  async checkLockoutTagoutCompliance(equipment: any): Promise<boolean> {
    logger.info(`${this.agentName}: Vérification des procédures de cadenassage`);

    // Selon RSST Article 185-187
    const hasLockoutProcedure = equipment.lockoutProcedure !== undefined;
    const hasIdentification = equipment.hasProperLabeling;
    const hasIsolationDevice = equipment.hasDisconnectSwitch;

    return hasLockoutProcedure && hasIdentification && hasIsolationDevice;
  }

  // Méthodes privées de vérification
  private hasProperGrounding(data: any): boolean {
    return data.grounding && data.grounding.electrode && data.grounding.conductor;
  }

  private hasRequiredGFCI(data: any): boolean {
    const requiredLocations = ['bathroom', 'kitchen', 'exterior', 'garage', 'basement'];
    return requiredLocations.every(loc =>
      data.circuits?.some((c: any) => c.location === loc && c.hasGFCI)
    );
  }

  private requiresArcFaultProtection(data: any): boolean {
    const bedrooms = data.circuits?.filter((c: any) => c.location === 'bedroom');
    return bedrooms?.some((b: any) => !b.hasCAFCI) || false;
  }

  private hasOutdoorEquipment(data: any): boolean {
    return data.circuits?.some((c: any) => c.location === 'exterior') || false;
  }

  private hasSafeWorkingSpace(data: any): boolean {
    return data.workingSpace?.clearance >= 1000; // 1000mm minimum
  }
}
