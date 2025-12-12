/**
 * Agent de Calcul Électrique - Québec
 * Spécialiste en dimensionnement selon le Code Électrique du Québec (CEQ)
 */

import { logger } from '../utils/logger.js';

export interface LoadCalculation {
  totalLoad: number; // en watts
  serviceSize: number; // en ampères
  wireSize: string;
  breakerSize: number;
  conduitSize?: string;
  voltDrop: number;
  details: CalculationDetail[];
}

export interface CalculationDetail {
  item: string;
  load: number;
  demandFactor: number;
  appliedLoad: number;
  ceqReference: string;
}

export interface CircuitDesign {
  circuitNumber: number;
  description: string;
  voltage: number;
  amperage: number;
  wireSize: string;
  wireType: string;
  conduitSize: string;
  breakerType: string;
  length: number;
  voltDrop: number;
}

export class ElectricalCalculatorAgent {
  private agentName = 'Agent de Calcul Électrique';

  /**
   * Calculer la charge totale et le service requis (CEQ Section 8)
   */
  async calculateServiceSize(buildingData: any): Promise<LoadCalculation> {
    logger.info(`${this.agentName}: Calcul de la charge électrique selon CEQ Section 8`);

    const details: CalculationDetail[] = [];
    let totalAppliedLoad = 0;

    // 1. Charge de base (éclairage et prises) - CEQ 8-200
    const baseLoad = this.calculateBaseLoad(buildingData);
    details.push({
      item: 'Charge de base (éclairage et prises)',
      load: baseLoad.load,
      demandFactor: baseLoad.demandFactor,
      appliedLoad: baseLoad.appliedLoad,
      ceqReference: 'CEQ 8-200'
    });
    totalAppliedLoad += baseLoad.appliedLoad;

    // 2. Cuisinière ≥5000W (spécifique au Québec) - CEQ 6-304
    if (buildingData.hasStove) {
      const stoveLoad = {
        load: buildingData.stoveRating || 12000,
        demandFactor: 0.80, // CEQ Table 8
        appliedLoad: (buildingData.stoveRating || 12000) * 0.80
      };
      details.push({
        item: 'Cuisinière électrique (≥5000W)',
        load: stoveLoad.load,
        demandFactor: stoveLoad.demandFactor,
        appliedLoad: stoveLoad.appliedLoad,
        ceqReference: 'CEQ 6-304, Table 8'
      });
      totalAppliedLoad += stoveLoad.appliedLoad;
    }

    // 3. Chauffage électrique - CEQ 8-200(3)
    if (buildingData.electricHeating) {
      const heatingLoad = {
        load: buildingData.heatingLoad || 15000,
        demandFactor: 1.0, // 100% pour chauffage au Québec
        appliedLoad: buildingData.heatingLoad || 15000
      };
      details.push({
        item: 'Chauffage électrique',
        load: heatingLoad.load,
        demandFactor: heatingLoad.demandFactor,
        appliedLoad: heatingLoad.appliedLoad,
        ceqReference: 'CEQ 8-200(3)'
      });
      totalAppliedLoad += heatingLoad.appliedLoad;
    }

    // 4. Planchers chauffants - CEQ 62-116
    if (buildingData.hasHeatedFloor) {
      const floorLoad = {
        load: buildingData.heatedFloorArea * 150, // 150W/m² typique
        demandFactor: 1.0,
        appliedLoad: buildingData.heatedFloorArea * 150
      };
      details.push({
        item: 'Planchers chauffants',
        load: floorLoad.load,
        demandFactor: floorLoad.demandFactor,
        appliedLoad: floorLoad.appliedLoad,
        ceqReference: 'CEQ 62-116'
      });
      totalAppliedLoad += floorLoad.appliedLoad;
    }

    // 5. Chauffe-eau - CEQ Table 8
    if (buildingData.hasWaterHeater) {
      const waterHeaterLoad = {
        load: 4500, // Typique 60 gallons
        demandFactor: 1.0,
        appliedLoad: 4500
      };
      details.push({
        item: 'Chauffe-eau électrique',
        load: waterHeaterLoad.load,
        demandFactor: waterHeaterLoad.demandFactor,
        appliedLoad: waterHeaterLoad.appliedLoad,
        ceqReference: 'CEQ Table 8'
      });
      totalAppliedLoad += waterHeaterLoad.appliedLoad;
    }

    // Calcul du service requis (240V)
    const serviceAmperage = Math.ceil(totalAppliedLoad / 240);
    const standardServiceSize = this.getStandardServiceSize(serviceAmperage);

    // Dimensionnement du fil d'alimentation - CEQ Table 2
    const wireSize = this.getWireSizeForAmperage(standardServiceSize, 'copper');

    logger.info(`${this.agentName}: Service requis: ${standardServiceSize}A`);

    return {
      totalLoad: totalAppliedLoad,
      serviceSize: standardServiceSize,
      wireSize,
      breakerSize: standardServiceSize,
      voltDrop: 0, // Calculé séparément pour chaque circuit
      details
    };
  }

  /**
   * Dimensionner un circuit individuel selon CEQ
   */
  async designCircuit(circuitData: any): Promise<CircuitDesign> {
    logger.info(`${this.agentName}: Dimensionnement du circuit ${circuitData.description}`);

    const voltage = circuitData.voltage || 120;
    const load = circuitData.load;
    const length = circuitData.length || 15; // mètres

    // Calcul du courant
    const current = load / voltage;

    // Majoration selon CEQ 8-104
    const derated = circuitData.continuous ? current * 1.25 : current;

    // Choix du disjoncteur standard
    const breakerSize = this.getStandardBreakerSize(derated);

    // Dimensionnement du fil - CEQ Table 2 avec correction de température
    const wireSize = this.getWireSizeForCircuit(breakerSize, circuitData.wireType || 'copper');

    // Calcul de la chute de tension (max 3% selon CEQ)
    const voltDrop = this.calculateVoltageDrop(current, length, wireSize, voltage);

    // Vérification de la conformité
    if (voltDrop > 3.0) {
      logger.warn(`${this.agentName}: Chute de tension excessive: ${voltDrop.toFixed(2)}% - augmenter la section du fil`);
    }

    // Dimensionnement du conduit si nécessaire
    const conduitSize = circuitData.needsConduit ?
      this.getConduitSize(wireSize, circuitData.numberOfConductors || 3) : 'N/A';

    // Type de disjoncteur selon l'application
    let breakerType = 'Disjoncteur thermomagnétique standard';
    if (circuitData.location === 'bathroom' || circuitData.location === 'kitchen') {
      breakerType = 'Disjoncteur DDFT (GFCI)';
    } else if (circuitData.location === 'bedroom') {
      breakerType = 'Disjoncteur CAFCI';
    }

    return {
      circuitNumber: circuitData.number,
      description: circuitData.description,
      voltage,
      amperage: breakerSize,
      wireSize,
      wireType: circuitData.wireType || 'copper',
      conduitSize,
      breakerType,
      length,
      voltDrop
    };
  }

  /**
   * Calculer la charge de base selon CEQ 8-200
   */
  private calculateBaseLoad(buildingData: any): any {
    const area = buildingData.squareFeet * 0.092903; // Conversion en m²

    // Premier 90 m² @ 5000W, reste @ 1000W par 90m²
    let baseLoad: number;
    if (area <= 90) {
      baseLoad = 5000;
    } else {
      baseLoad = 5000 + Math.ceil((area - 90) / 90) * 1000;
    }

    return {
      load: baseLoad,
      demandFactor: 1.0,
      appliedLoad: baseLoad
    };
  }

  /**
   * Obtenir la taille de service standard la plus proche
   */
  private getStandardServiceSize(calculated: number): number {
    const standardSizes = [100, 125, 150, 200, 225, 300, 400, 600];
    return standardSizes.find(size => size >= calculated) || 600;
  }

  /**
   * Dimensionnement du fil selon CEQ Table 2
   */
  private getWireSizeForAmperage(amperage: number, wireType: 'copper' | 'aluminum'): string {
    // Basé sur CEQ Table 2 (conducteurs en cuivre à 75°C)
    const copperTable: { [key: number]: string } = {
      100: '3 AWG',
      125: '1 AWG',
      150: '1/0 AWG',
      200: '3/0 AWG',
      225: '4/0 AWG',
      300: '350 kcmil',
      400: '600 kcmil',
      600: '1200 kcmil'
    };

    const aluminumTable: { [key: number]: string } = {
      100: '1 AWG',
      125: '1/0 AWG',
      150: '2/0 AWG',
      200: '4/0 AWG',
      225: '250 kcmil',
      300: '500 kcmil',
      400: '750 kcmil',
      600: '1750 kcmil'
    };

    return wireType === 'copper' ? copperTable[amperage] : aluminumTable[amperage];
  }

  /**
   * Choix du disjoncteur standard
   */
  private getStandardBreakerSize(current: number): number {
    const standardSizes = [15, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    return standardSizes.find(size => size >= current) || 100;
  }

  /**
   * Dimensionnement du fil pour circuit
   */
  private getWireSizeForCircuit(breaker: number, wireType: string): string {
    const wireSizes: { [key: number]: string } = {
      15: '14 AWG',
      20: '12 AWG',
      30: '10 AWG',
      40: '8 AWG',
      50: '6 AWG',
      60: '4 AWG'
    };

    return wireSizes[breaker] || '14 AWG';
  }

  /**
   * Calcul de la chute de tension
   */
  private calculateVoltageDrop(current: number, length: number, wireSize: string, voltage: number): number {
    // Résistance approximative en ohms par 100m pour fils de cuivre
    const resistances: { [key: string]: number } = {
      '14 AWG': 0.83,
      '12 AWG': 0.52,
      '10 AWG': 0.33,
      '8 AWG': 0.21,
      '6 AWG': 0.13,
      '4 AWG': 0.082
    };

    const resistance = resistances[wireSize] || 0.83;
    const voltDrop = (2 * resistance * length * current) / 100; // Facteur 2 pour aller-retour
    const percentDrop = (voltDrop / voltage) * 100;

    return percentDrop;
  }

  /**
   * Dimensionnement du conduit selon CEQ
   */
  private getConduitSize(wireSize: string, numberOfConductors: number): string {
    // Simplification - dans la réalité, utiliser CEQ Table 8
    if (numberOfConductors <= 3) {
      return wireSize.includes('14') || wireSize.includes('12') ? '1/2"' : '3/4"';
    }
    return '1"';
  }
}
