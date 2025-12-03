/**
 * Agent de Diagnostic Électrique - Québec
 * Spécialiste en analyse et détection de problèmes électriques
 */

import { logger } from '../utils/logger.js';

export interface DiagnosticReport {
  systemId: string;
  timestamp: Date;
  issues: Issue[];
  recommendations: string[];
  urgency: 'low' | 'medium' | 'high' | 'critical';
  estimatedRepairCost: number;
}

export interface Issue {
  id: string;
  category: 'safety' | 'performance' | 'compliance' | 'maintenance';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  location: string;
  cause: string;
  solution: string;
  ceqViolation?: string;
}

export interface TestResults {
  continuity: boolean;
  insulation: number; // MegaOhms
  groundResistance: number; // Ohms
  voltageBalance: boolean;
  gfciTest: boolean;
  thermalScan?: ThermalData[];
}

export interface ThermalData {
  location: string;
  temperature: number;
  normal: boolean;
  alert?: string;
}

export class DiagnosticianAgent {
  private agentName = 'Agent de Diagnostic Électrique';

  /**
   * Effectuer un diagnostic complet du système électrique
   */
  async performCompleteDiagnostic(systemData: any): Promise<DiagnosticReport> {
    logger.info(`${this.agentName}: Diagnostic complet du système ${systemData.id}`);

    const issues: Issue[] = [];

    // 1. Tests électriques de base
    const testResults = await this.performElectricalTests(systemData);
    issues.push(...this.analyzeTestResults(testResults));

    // 2. Inspection visuelle
    const visualIssues = await this.performVisualInspection(systemData);
    issues.push(...visualIssues);

    // 3. Vérification de conformité CEQ
    const complianceIssues = await this.checkCEQCompliance(systemData);
    issues.push(...complianceIssues);

    // 4. Considérations climatiques québécoises
    const weatherIssues = await this.checkWeatherRelatedIssues(systemData);
    issues.push(...weatherIssues);

    // Déterminer l'urgence globale
    const urgency = this.determineUrgency(issues);

    // Générer recommandations
    const recommendations = this.generateRecommendations(issues);

    // Estimer coût des réparations
    const estimatedRepairCost = this.estimateRepairCost(issues);

    return {
      systemId: systemData.id,
      timestamp: new Date(),
      issues,
      recommendations,
      urgency,
      estimatedRepairCost
    };
  }

  /**
   * Effectuer les tests électriques standards
   */
  private async performElectricalTests(systemData: any): Promise<TestResults> {
    logger.info(`${this.agentName}: Exécution des tests électriques`);

    return {
      continuity: systemData.continuityTest || true,
      insulation: systemData.insulationTest || 500, // MΩ
      groundResistance: systemData.groundTest || 5, // Ω
      voltageBalance: systemData.voltageBalance || true,
      gfciTest: systemData.gfciTest || true,
      thermalScan: systemData.thermalData || []
    };
  }

  /**
   * Analyser les résultats des tests
   */
  private analyzeTestResults(results: TestResults): Issue[] {
    const issues: Issue[] = [];

    // Test d'isolation insuffisant
    if (results.insulation < 1.0) {
      issues.push({
        id: 'test-insulation-fail',
        category: 'safety',
        severity: 'critical',
        description: 'Résistance d\'isolation insuffisante',
        location: 'Système général',
        cause: 'Détérioration de l\'isolation des câbles',
        solution: 'Identifier et remplacer les câbles défectueux',
        ceqViolation: 'CEQ Section 10 - Installation et mise à la terre'
      });
    }

    // Résistance de terre excessive
    if (results.groundResistance > 25) {
      issues.push({
        id: 'test-ground-fail',
        category: 'safety',
        severity: 'high',
        description: 'Résistance de mise à la terre excessive',
        location: 'Système de mise à la terre',
        cause: 'Électrode inadéquate ou connexions corrodées',
        solution: 'Améliorer le système de mise à la terre, ajouter électrodes',
        ceqViolation: 'CEQ 10-700 - Mise à la terre'
      });
    }

    // GFCI défectueux
    if (!results.gfciTest) {
      issues.push({
        id: 'test-gfci-fail',
        category: 'safety',
        severity: 'critical',
        description: 'Disjoncteur DDFT ne déclenche pas',
        location: 'Circuits protégés par DDFT',
        cause: 'DDFT défectueux ou mal installé',
        solution: 'Remplacer immédiatement le disjoncteur DDFT',
        ceqViolation: 'CEQ 26-700 - Protection différentielle'
      });
    }

    // Déséquilibre de tension
    if (!results.voltageBalance) {
      issues.push({
        id: 'test-voltage-imbalance',
        category: 'performance',
        severity: 'medium',
        description: 'Déséquilibre de tension entre phases',
        location: 'Entrée de service',
        cause: 'Charge déséquilibrée ou problème du réseau Hydro-Québec',
        solution: 'Rééquilibrer les charges, contacter Hydro-Québec si nécessaire'
      });
    }

    // Analyse thermique
    if (results.thermalScan) {
      results.thermalScan.forEach(thermal => {
        if (!thermal.normal) {
          issues.push({
            id: `thermal-${thermal.location}`,
            category: 'safety',
            severity: 'high',
            description: `Surchauffe détectée: ${thermal.temperature}°C`,
            location: thermal.location,
            cause: 'Surcharge, connexion desserrée ou câble sous-dimensionné',
            solution: 'Inspecter connexions, vérifier dimensionnement, réduire charge'
          });
        }
      });
    }

    return issues;
  }

  /**
   * Inspection visuelle du système
   */
  private async performVisualInspection(systemData: any): Promise<Issue[]> {
    const issues: Issue[] = [];

    // Panneau surchargé
    if (systemData.breakerUsage && systemData.breakerUsage > 0.8) {
      issues.push({
        id: 'visual-panel-full',
        category: 'performance',
        severity: 'medium',
        description: 'Panneau électrique à plus de 80% de capacité',
        location: 'Panneau principal',
        cause: 'Ajouts de circuits au fil du temps',
        solution: 'Considérer un panneau additionnel ou upgrade du service'
      });
    }

    // Câblage apparent endommagé
    if (systemData.hasVisibleWireDamage) {
      issues.push({
        id: 'visual-wire-damage',
        category: 'safety',
        severity: 'critical',
        description: 'Câblage endommagé visible',
        location: systemData.damageLocation || 'À identifier',
        cause: 'Usure, rongeurs, dommages mécaniques',
        solution: 'Remplacer immédiatement les sections endommagées',
        ceqViolation: 'CEQ 12-500 - Protection mécanique'
      });
    }

    // Absence d'étiquetage
    if (!systemData.hasProperLabeling) {
      issues.push({
        id: 'visual-no-labels',
        category: 'compliance',
        severity: 'low',
        description: 'Circuits non étiquetés au panneau',
        location: 'Panneau de distribution',
        cause: 'Étiquetage non effectué ou perdu',
        solution: 'Identifier et étiqueter tous les circuits',
        ceqViolation: 'CEQ 2-100 - Identification'
      });
    }

    return issues;
  }

  /**
   * Vérifier la conformité au CEQ
   */
  private async checkCEQCompliance(systemData: any): Promise<Issue[]> {
    const issues: Issue[] = [];

    // Vérifier si le système est ancien
    const installYear = systemData.installYear || 2000;
    const currentYear = new Date().getFullYear();

    if (currentYear - installYear > 25) {
      issues.push({
        id: 'compliance-old-system',
        category: 'compliance',
        severity: 'medium',
        description: 'Système électrique datant de plus de 25 ans',
        location: 'Système complet',
        cause: 'Âge du système',
        solution: 'Évaluer la mise à niveau complète selon les normes CEQ actuelles'
      });
    }

    // Aluminium ancien (pré-1970)
    if (systemData.hasAluminumWiring && installYear < 1970) {
      issues.push({
        id: 'compliance-aluminum',
        category: 'safety',
        severity: 'high',
        description: 'Câblage en aluminium ancien',
        location: 'Circuits de dérivation',
        cause: 'Pratique courante avant 1970',
        solution: 'Remplacer par du cuivre ou utiliser connecteurs spéciaux CO/ALR',
        ceqViolation: 'Non conforme aux normes CEQ actuelles'
      });
    }

    return issues;
  }

  /**
   * Vérifier les problèmes liés au climat québécois
   */
  private async checkWeatherRelatedIssues(systemData: any): Promise<Issue[]> {
    const issues: Issue[] = [];

    // Équipement extérieur non protégé
    if (systemData.hasExteriorEquipment && !systemData.hasWeatherProtection) {
      issues.push({
        id: 'weather-no-protection',
        category: 'maintenance',
        severity: 'medium',
        description: 'Équipement extérieur sans protection adéquate',
        location: 'Installations extérieures',
        cause: 'Protection inadéquate pour climat québécois',
        solution: 'Installer boîtiers IP65 minimum, chauffage anti-gel si nécessaire'
      });
    }

    // Accumulation de glace sur mât
    if (systemData.hasOverheadService && systemData.winterSeason) {
      issues.push({
        id: 'weather-ice-buildup',
        category: 'maintenance',
        severity: 'low',
        description: 'Risque d\'accumulation de glace sur entrée aérienne',
        location: 'Mât et branchement aérien',
        cause: 'Conditions hivernales québécoises',
        solution: 'Inspecter régulièrement, déglacer si nécessaire, considérer entrée souterraine'
      });
    }

    // Câbles extérieurs non certifiés froid
    if (systemData.hasExteriorCables && !systemData.coldRatedCables) {
      issues.push({
        id: 'weather-cable-rating',
        category: 'compliance',
        severity: 'medium',
        description: 'Câbles extérieurs non certifiés pour températures extrêmes',
        location: 'Câblage extérieur',
        cause: 'Câbles standards non adaptés au climat',
        solution: 'Remplacer par câbles certifiés -40°C à +75°C'
      });
    }

    return issues;
  }

  /**
   * Déterminer l'urgence globale
   */
  private determineUrgency(issues: Issue[]): 'low' | 'medium' | 'high' | 'critical' {
    if (issues.some(i => i.severity === 'critical')) return 'critical';
    if (issues.some(i => i.severity === 'high')) return 'high';
    if (issues.some(i => i.severity === 'medium')) return 'medium';
    return 'low';
  }

  /**
   * Générer des recommandations
   */
  private generateRecommendations(issues: Issue[]): string[] {
    const recommendations: string[] = [];

    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const highCount = issues.filter(i => i.severity === 'high').length;

    if (criticalCount > 0) {
      recommendations.push(
        `⚠️ URGENT: ${criticalCount} problème(s) critique(s) nécessitant une intervention immédiate`
      );
    }

    if (highCount > 0) {
      recommendations.push(
        `Planifier rapidement la résolution de ${highCount} problème(s) à haute priorité`
      );
    }

    recommendations.push(
      'Effectuer un entretien préventif annuel',
      'Mettre à jour l\'étiquetage du panneau',
      'Documenter toutes les modifications futures',
      'Conserver les certificats d\'inspection RBQ'
    );

    return recommendations;
  }

  /**
   * Estimer le coût des réparations
   */
  private estimateRepairCost(issues: Issue[]): number {
    let total = 0;

    issues.forEach(issue => {
      switch (issue.severity) {
        case 'critical':
          total += 1500;
          break;
        case 'high':
          total += 800;
          break;
        case 'medium':
          total += 400;
          break;
        case 'low':
          total += 150;
          break;
      }
    });

    return total;
  }
}
