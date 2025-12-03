/**
 * Agent de Suivi de Matériel - Québec
 * Spécialiste en suivi de matériel électrique certifié CSA/UL
 */

import { logger } from '../utils/logger.js';

export interface MaterialTracking {
  trackingId: string;
  materialId: string;
  description: string;
  quantity: number;
  unit: string;
  location: MaterialLocation;
  status: 'in-stock' | 'in-transit' | 'on-site' | 'installed' | 'returned';
  certifications: CertificationInfo[];
  movements: MaterialMovement[];
}

export interface MaterialLocation {
  type: 'warehouse' | 'truck' | 'site' | 'installed';
  name: string;
  address?: string;
  zone?: string;
  bin?: string;
}

export interface CertificationInfo {
  type: 'CSA' | 'UL' | 'CSA-US' | 'IP-Rating' | 'Temperature-Rating';
  certificationNumber?: string;
  validUntil?: Date;
  verified: boolean;
  verificationDate: Date;
}

export interface MaterialMovement {
  movementId: string;
  date: Date;
  from: MaterialLocation;
  to: MaterialLocation;
  quantity: number;
  movedBy: string;
  reason: string;
  signedBy?: string;
}

export interface MaterialAudit {
  auditId: string;
  auditDate: Date;
  auditor: string;
  discrepancies: Discrepancy[];
  certificationsChecked: number;
  certificationsValid: number;
  recommendations: string[];
}

export interface Discrepancy {
  materialId: string;
  type: 'quantity' | 'location' | 'certification' | 'condition';
  expected: string;
  actual: string;
  severity: 'low' | 'medium' | 'high';
  resolution?: string;
}

export class MaterialTrackerAgent {
  private agentName = 'Agent de Suivi de Matériel';

  /**
   * Enregistrer la réception de matériel
   */
  async receiveMaterial(
    materialId: string,
    description: string,
    quantity: number,
    unit: string,
    supplier: string,
    certifications: CertificationInfo[]
  ): Promise<MaterialTracking> {
    logger.info(`${this.agentName}: Réception de matériel ${materialId} - ${quantity} ${unit}`);

    // Vérifier les certifications obligatoires
    const certificationCheck = await this.verifyCertifications(certifications);

    if (!certificationCheck.allValid) {
      logger.warn(`${this.agentName}: Certifications manquantes ou invalides!`);
    }

    const tracking: MaterialTracking = {
      trackingId: this.generateTrackingId(),
      materialId,
      description,
      quantity,
      unit,
      location: {
        type: 'warehouse',
        name: 'Entrepôt principal Montréal',
        zone: 'A',
        bin: this.assignBin(materialId)
      },
      status: 'in-stock',
      certifications,
      movements: [
        {
          movementId: this.generateMovementId(),
          date: new Date(),
          from: { type: 'warehouse', name: supplier },
          to: { type: 'warehouse', name: 'Entrepôt principal Montréal' },
          quantity,
          movedBy: 'Système',
          reason: 'Réception fournisseur'
        }
      ]
    };

    logger.info(`${this.agentName}: Matériel enregistré - Tracking ID: ${tracking.trackingId}`);

    return tracking;
  }

  /**
   * Déplacer du matériel
   */
  async moveMaterial(
    trackingId: string,
    fromLocation: MaterialLocation,
    toLocation: MaterialLocation,
    quantity: number,
    movedBy: string,
    reason: string
  ): Promise<MaterialMovement> {
    logger.info(`${this.agentName}: Déplacement matériel ${trackingId}`);

    const movement: MaterialMovement = {
      movementId: this.generateMovementId(),
      date: new Date(),
      from: fromLocation,
      to: toLocation,
      quantity,
      movedBy,
      reason
    };

    // Mettre à jour le statut selon la destination
    let newStatus: MaterialTracking['status'] = 'in-stock';

    if (toLocation.type === 'truck') {
      newStatus = 'in-transit';
    } else if (toLocation.type === 'site') {
      newStatus = 'on-site';
    } else if (toLocation.type === 'installed') {
      newStatus = 'installed';
    }

    logger.info(`${this.agentName}: Matériel déplacé vers ${toLocation.name} - Statut: ${newStatus}`);

    return movement;
  }

  /**
   * Vérifier les certifications CSA/UL
   */
  async verifyCertifications(certifications: CertificationInfo[]): Promise<any> {
    logger.info(`${this.agentName}: Vérification des certifications`);

    const requiredCerts = ['CSA', 'UL', 'CSA-US'];
    const hasRequired = certifications.some(c =>
      requiredCerts.includes(c.type) && c.verified
    );

    const results = {
      allValid: hasRequired,
      missing: [] as string[],
      expired: [] as string[]
    };

    if (!hasRequired) {
      results.missing.push('Certification CSA ou UL requise pour usage au Québec');
    }

    // Vérifier certifications expirées
    certifications.forEach(cert => {
      if (cert.validUntil && cert.validUntil < new Date()) {
        results.expired.push(`${cert.type} - ${cert.certificationNumber}`);
        results.allValid = false;
      }
    });

    return results;
  }

  /**
   * Effectuer un audit de matériel
   */
  async performMaterialAudit(projectId: string, materials: MaterialTracking[]): Promise<MaterialAudit> {
    logger.info(`${this.agentName}: Audit de matériel pour projet ${projectId}`);

    const discrepancies: Discrepancy[] = [];
    const recommendations: string[] = [];
    let certificationsChecked = 0;
    let certificationsValid = 0;

    // Vérifier chaque matériel
    for (const material of materials) {
      // Vérifier les quantités
      const physicalCount = await this.performPhysicalCount(material.trackingId);
      if (physicalCount !== material.quantity) {
        discrepancies.push({
          materialId: material.materialId,
          type: 'quantity',
          expected: `${material.quantity} ${material.unit}`,
          actual: `${physicalCount} ${material.unit}`,
          severity: Math.abs(physicalCount - material.quantity) > 10 ? 'high' : 'medium'
        });
      }

      // Vérifier les certifications
      for (const cert of material.certifications) {
        certificationsChecked++;

        const certValid = cert.verified &&
                         (!cert.validUntil || cert.validUntil > new Date());

        if (certValid) {
          certificationsValid++;
        } else {
          discrepancies.push({
            materialId: material.materialId,
            type: 'certification',
            expected: `Certification ${cert.type} valide`,
            actual: cert.validUntil && cert.validUntil < new Date() ?
                   'Expirée' : 'Non vérifiée',
            severity: 'high'
          });
        }
      }

      // Vérifier exigences spécifiques au Québec
      if (material.location.type === 'site' && material.description.includes('extérieur')) {
        const hasColdRating = material.certifications.some(c =>
          c.type === 'Temperature-Rating' && c.verified
        );

        if (!hasColdRating) {
          discrepancies.push({
            materialId: material.materialId,
            type: 'certification',
            expected: 'Certification température -40°C pour équipement extérieur',
            actual: 'Certification manquante',
            severity: 'high'
          });

          recommendations.push(
            `${material.description}: Vérifier certification -40°C pour usage extérieur au Québec`
          );
        }
      }
    }

    // Recommandations générales
    if (certificationsValid / certificationsChecked < 0.95) {
      recommendations.push('Améliorer le processus de vérification des certifications à la réception');
    }

    if (discrepancies.filter(d => d.type === 'quantity').length > 0) {
      recommendations.push('Effectuer comptages physiques plus fréquents');
    }

    return {
      auditId: this.generateAuditId(),
      auditDate: new Date(),
      auditor: this.agentName,
      discrepancies,
      certificationsChecked,
      certificationsValid,
      recommendations
    };
  }

  /**
   * Générer rapport de suivi de matériel
   */
  async generateMaterialReport(materials: MaterialTracking[]): Promise<string> {
    logger.info(`${this.agentName}: Génération du rapport de suivi de matériel`);

    const totalItems = materials.length;
    const inStock = materials.filter(m => m.status === 'in-stock').length;
    const onSite = materials.filter(m => m.status === 'on-site').length;
    const installed = materials.filter(m => m.status === 'installed').length;
    const inTransit = materials.filter(m => m.status === 'in-transit').length;

    const totalValue = materials.reduce((sum, m) => sum + (m.quantity * 10), 0); // Estimation

    const certIssues = materials.filter(m =>
      !m.certifications.some(c => (c.type === 'CSA' || c.type === 'UL') && c.verified)
    );

    const report = `
RAPPORT DE SUIVI DE MATÉRIEL - QUÉBEC
======================================
Date: ${new Date().toLocaleDateString('fr-CA')}
Agent: ${this.agentName}

RÉSUMÉ INVENTAIRE
-----------------
Total items suivis: ${totalItems}
En stock: ${inStock}
Sur chantier: ${onSite}
Installé: ${installed}
En transit: ${inTransit}

Valeur totale estimée: ${totalValue.toLocaleString('fr-CA')} $

CERTIFICATIONS
--------------
Items certifiés CSA/UL: ${totalItems - certIssues.length}
Items sans certification: ${certIssues.length}

${certIssues.length > 0 ? `
⚠️  ITEMS SANS CERTIFICATION VALIDE:
${certIssues.map(item =>
  `   - ${item.description} (${item.materialId})`
).join('\n')}
` : ''}

MATÉRIEL PAR STATUT
-------------------
${this.groupMaterialsByStatus(materials)}

MOUVEMENTS RÉCENTS (7 derniers jours)
--------------------------------------
${this.getRecentMovements(materials, 7)}

ALERTES
-------
${this.generateAlerts(materials).join('\n')}

CONFORMITÉ QUÉBEC
-----------------
- Tous les équipements doivent être certifiés CSA ou UL
- Équipements extérieurs: certification -40°C obligatoire
- Documentation des certifications requise pour inspection RBQ
- Conservation des certificats: minimum 5 ans

RECOMMANDATIONS
---------------
- Vérifier certifications à la réception
- Maintenir documentation à jour
- Effectuer audits trimestriels
- Former équipe sur exigences CSA/RBQ
${certIssues.length > 0 ? '- URGENT: Régulariser items sans certification' : ''}
`;

    return report;
  }

  /**
   * Suivre matériel spécifique au Québec
   */
  async trackQuebecSpecialEquipment(equipmentType: string): Promise<string[]> {
    logger.info(`${this.agentName}: Suivi équipement spécial Québec: ${equipmentType}`);

    const specialRequirements: { [key: string]: string[] } = {
      'cuisinière': [
        'Circuit dédié 40A minimum',
        'Câble 6/3 AWG minimum',
        'Prise 50A certifiée CSA',
        'Protection selon CEQ 6-304'
      ],
      'plancher-chauffant': [
        'Système certifié CSA',
        'Thermostat avec sonde',
        'Protection selon CEQ 62-116',
        'Isolation thermique appropriée'
      ],
      'extérieur': [
        'Boîtiers IP65 minimum',
        'Certification -40°C à +40°C',
        'Câbles résistants UV et gel',
        'Entrées étanches'
      ],
      'chauffage': [
        'Thermostats programmables',
        'Protection contre surchauffe',
        'Dimensionnement selon charge',
        'Conformité RSST pour sécurité'
      ]
    };

    return specialRequirements[equipmentType] || [];
  }

  // Méthodes utilitaires privées
  private generateTrackingId(): string {
    return `MTR-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }

  private generateMovementId(): string {
    return `MOV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  private generateAuditId(): string {
    return `AUD-${Date.now()}`;
  }

  private assignBin(materialId: string): string {
    // Logique simple d'attribution de bin
    const hash = materialId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const binNumber = (hash % 50) + 1;
    return `BIN-${binNumber.toString().padStart(3, '0')}`;
  }

  private async performPhysicalCount(trackingId: string): Promise<number> {
    // Simuler un comptage physique
    // Dans une vraie implémentation, ceci nécessiterait intervention humaine
    return Math.floor(Math.random() * 100) + 1;
  }

  private groupMaterialsByStatus(materials: MaterialTracking[]): string {
    const groups: { [key: string]: MaterialTracking[] } = {
      'in-stock': [],
      'in-transit': [],
      'on-site': [],
      'installed': []
    };

    materials.forEach(m => {
      if (groups[m.status]) {
        groups[m.status].push(m);
      }
    });

    return Object.entries(groups)
      .filter(([_, items]) => items.length > 0)
      .map(([status, items]) => {
        const label = {
          'in-stock': 'En stock',
          'in-transit': 'En transit',
          'on-site': 'Sur chantier',
          'installed': 'Installé'
        }[status];

        return `${label}: ${items.length} items\n${items.slice(0, 3).map(i =>
          `   - ${i.description} (${i.quantity} ${i.unit})`
        ).join('\n')}${items.length > 3 ? `\n   ... et ${items.length - 3} autres` : ''}`;
      })
      .join('\n\n');
  }

  private getRecentMovements(materials: MaterialTracking[], days: number): string {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const recentMovements = materials
      .flatMap(m => m.movements)
      .filter(mov => mov.date >= cutoffDate)
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 10);

    if (recentMovements.length === 0) {
      return 'Aucun mouvement récent';
    }

    return recentMovements.map(mov =>
      `${mov.date.toLocaleDateString('fr-CA')}: ${mov.from.name} → ${mov.to.name} (${mov.quantity} unités) - ${mov.reason}`
    ).join('\n');
  }

  private generateAlerts(materials: MaterialTracking[]): string[] {
    const alerts: string[] = [];

    // Alertes certifications manquantes
    const uncertified = materials.filter(m =>
      !m.certifications.some(c => (c.type === 'CSA' || c.type === 'UL') && c.verified)
    );

    if (uncertified.length > 0) {
      alerts.push(`⚠️  ${uncertified.length} items sans certification CSA/UL valide`);
    }

    // Alertes certifications expirantes
    const expiringDate = new Date();
    expiringDate.setMonth(expiringDate.getMonth() + 1);

    const expiring = materials.filter(m =>
      m.certifications.some(c =>
        c.validUntil && c.validUntil < expiringDate && c.validUntil > new Date()
      )
    );

    if (expiring.length > 0) {
      alerts.push(`⚠️  ${expiring.length} certifications expirent dans moins d'un mois`);
    }

    if (alerts.length === 0) {
      alerts.push('✓ Aucune alerte active');
    }

    return alerts;
  }
}
