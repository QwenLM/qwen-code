/**
 * Service d'Analyse de Plans Électriques - Québec
 * Utilise OCR et vision par ordinateur pour extraire le matériel des plans
 */

import { logger } from '../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);

export interface PlanAnalysisResult {
  planId: string;
  filename: string;
  pagesAnalyzed: number;
  equipmentDetected: DetectedEquipment[];
  textExtracted: ExtractedText[];
  symbolsDetected: ElectricalSymbol[];
  bomGenerated: BOMItem[];
  complianceIssues: string[];
  confidenceScore: number;
}

export interface DetectedEquipment {
  id: string;
  type: string;
  specifications: { [key: string]: string };
  coordinates: { x: number; y: number; width: number; height: number };
  pageNumber: number;
  confidence: number;
  csaCertificationRequired: boolean;
}

export interface ExtractedText {
  text: string;
  coordinates: { x: number; y: number };
  pageNumber: number;
  confidence: number;
}

export interface ElectricalSymbol {
  symbolType: string;
  coordinates: { x: number; y: number };
  pageNumber: number;
  confidence: number;
  relatedEquipment?: string;
}

export interface BOMItem {
  category: string;
  description: string;
  quantity: number;
  unit: string;
  specifications: string;
  csaCertified: boolean;
  estimatedCost: number;
}

export class PlanAnalyzerService {
  private pythonScriptPath: string;
  private tempDir: string;

  constructor() {
    this.pythonScriptPath = path.join(__dirname, '../../python/plan_analyzer.py');
    this.tempDir = path.join(__dirname, '../../temp');
  }

  /**
   * Analyser un plan électrique PDF complet
   */
  async analyzePlan(planPath: string, planId: string): Promise<PlanAnalysisResult> {
    logger.info(`PlanAnalyzerService: Début analyse du plan ${planId}`);

    try {
      // Créer répertoire temporaire pour ce plan
      const planTempDir = await this.createTempDirectory(planId);

      // Convertir PDF en images haute résolution
      const imagePaths = await this.convertPDFToImages(planPath, planTempDir);

      // Analyser chaque page
      const pageResults = [];
      for (let i = 0; i < imagePaths.length; i++) {
        logger.info(`PlanAnalyzerService: Analyse page ${i + 1}/${imagePaths.length}`);
        const pageResult = await this.analyzePage(imagePaths[i], i + 1);
        pageResults.push(pageResult);
      }

      // Agréger les résultats
      const equipmentDetected = pageResults.flatMap(r => r.equipment);
      const textExtracted = pageResults.flatMap(r => r.text);
      const symbolsDetected = pageResults.flatMap(r => r.symbols);

      // Générer BOM à partir des équipements détectés
      const bomGenerated = await this.generateBOMFromEquipment(equipmentDetected);

      // Vérifier conformité CEQ/RBQ
      const complianceIssues = await this.checkQuebecCompliance(equipmentDetected, textExtracted);

      // Calculer score de confiance global
      const confidenceScore = this.calculateOverallConfidence(pageResults);

      // Nettoyer fichiers temporaires
      await this.cleanupTempFiles(planTempDir);

      const result: PlanAnalysisResult = {
        planId,
        filename: path.basename(planPath),
        pagesAnalyzed: imagePaths.length,
        equipmentDetected,
        textExtracted,
        symbolsDetected,
        bomGenerated,
        complianceIssues,
        confidenceScore
      };

      logger.info(`PlanAnalyzerService: Analyse complétée - ${equipmentDetected.length} équipements détectés`);

      return result;

    } catch (error) {
      logger.error(`PlanAnalyzerService: Erreur analyse plan`, error);
      throw error;
    }
  }

  /**
   * Convertir PDF en images haute résolution
   */
  private async convertPDFToImages(pdfPath: string, outputDir: string): Promise<string[]> {
    logger.info(`PlanAnalyzerService: Conversion PDF en images`);

    // Utiliser pdftocairo pour conversion haute qualité
    const dpi = 300; // 300 DPI pour bonne reconnaissance
    const command = `pdftocairo -png -r ${dpi} "${pdfPath}" "${path.join(outputDir, 'page')}"`;

    try {
      await execAsync(command);

      // Lire les fichiers générés
      const files = await fs.readdir(outputDir);
      const imageFiles = files
        .filter(file => file.endsWith('.png'))
        .sort()
        .map(file => path.join(outputDir, file));

      logger.info(`PlanAnalyzerService: ${imageFiles.length} pages converties`);

      return imageFiles;
    } catch (error) {
      logger.error(`PlanAnalyzerService: Erreur conversion PDF`, error);
      throw new Error('Erreur lors de la conversion du PDF');
    }
  }

  /**
   * Analyser une page individuelle
   */
  private async analyzePage(imagePath: string, pageNumber: number): Promise<any> {
    logger.info(`PlanAnalyzerService: Analyse page ${pageNumber}`);

    // Appeler script Python pour analyse détaillée
    const command = `python3 "${this.pythonScriptPath}" analyze-page "${imagePath}" ${pageNumber}`;

    try {
      const { stdout } = await execAsync(command);
      const result = JSON.parse(stdout);

      return {
        pageNumber,
        equipment: result.equipment || [],
        text: result.text || [],
        symbols: result.symbols || [],
        confidence: result.confidence || 0
      };
    } catch (error) {
      logger.error(`PlanAnalyzerService: Erreur analyse page ${pageNumber}`, error);

      // Retourner résultat vide en cas d'erreur
      return {
        pageNumber,
        equipment: [],
        text: [],
        symbols: [],
        confidence: 0
      };
    }
  }

  /**
   * Générer BOM à partir des équipements détectés
   */
  private async generateBOMFromEquipment(equipment: DetectedEquipment[]): Promise<BOMItem[]> {
    logger.info(`PlanAnalyzerService: Génération BOM`);

    const bom: BOMItem[] = [];
    const equipmentByType = new Map<string, DetectedEquipment[]>();

    // Grouper par type
    equipment.forEach(eq => {
      const type = eq.type;
      if (!equipmentByType.has(type)) {
        equipmentByType.set(type, []);
      }
      equipmentByType.get(type)!.push(eq);
    });

    // Créer items BOM
    for (const [type, items] of equipmentByType.entries()) {
      const bomItem = this.createBOMItem(type, items);
      if (bomItem) {
        bom.push(bomItem);
      }
    }

    // Trier par catégorie
    bom.sort((a, b) => a.category.localeCompare(b.category));

    logger.info(`PlanAnalyzerService: BOM généré avec ${bom.length} items`);

    return bom;
  }

  /**
   * Créer un item BOM à partir d'équipements similaires
   */
  private createBOMItem(type: string, equipment: DetectedEquipment[]): BOMItem | null {
    const quantity = equipment.length;

    // Mapping type -> BOM item
    const bomMapping: { [key: string]: Partial<BOMItem> } = {
      'outlet': {
        category: 'Dispositifs',
        description: 'Prise duplex 15A mise à la terre',
        unit: 'unité',
        csaCertified: true,
        estimatedCost: 1.25
      },
      'switch': {
        category: 'Dispositifs',
        description: 'Interrupteur simple 15A',
        unit: 'unité',
        csaCertified: true,
        estimatedCost: 1.10
      },
      'light_fixture': {
        category: 'Luminaires',
        description: 'Luminaire encastré LED',
        unit: 'unité',
        csaCertified: true,
        estimatedCost: 25.00
      },
      'panel': {
        category: 'Panneaux',
        description: 'Panneau de distribution',
        unit: 'unité',
        csaCertified: true,
        estimatedCost: 300.00
      },
      'breaker': {
        category: 'Protection',
        description: 'Disjoncteur thermomagnétique',
        unit: 'unité',
        csaCertified: true,
        estimatedCost: 12.00
      },
      'gfci_breaker': {
        category: 'Protection',
        description: 'Disjoncteur DDFT (GFCI)',
        unit: 'unité',
        csaCertified: true,
        estimatedCost: 65.00
      },
      'stove_outlet': {
        category: 'Équipements Spéciaux Québec',
        description: 'Prise cuisinière 50A 240V (≥5000W CEQ 6-304)',
        unit: 'unité',
        csaCertified: true,
        estimatedCost: 25.00
      },
      'heated_floor': {
        category: 'Équipements Spéciaux Québec',
        description: 'Système plancher chauffant électrique (CEQ 62-116)',
        unit: 'pi²',
        csaCertified: true,
        estimatedCost: 12.00
      }
    };

    const template = bomMapping[type];
    if (!template) {
      logger.warn(`PlanAnalyzerService: Type inconnu pour BOM: ${type}`);
      return null;
    }

    // Extraire spécifications des équipements
    const specs = equipment
      .map(eq => Object.entries(eq.specifications).map(([k, v]) => `${k}: ${v}`).join(', '))
      .filter((spec, index, self) => self.indexOf(spec) === index)
      .join('; ');

    return {
      category: template.category!,
      description: template.description!,
      quantity,
      unit: template.unit!,
      specifications: specs || 'Standard',
      csaCertified: template.csaCertified!,
      estimatedCost: template.estimatedCost! * quantity
    };
  }

  /**
   * Vérifier conformité aux normes québécoises
   */
  private async checkQuebecCompliance(
    equipment: DetectedEquipment[],
    text: ExtractedText[]
  ): Promise<string[]> {
    logger.info(`PlanAnalyzerService: Vérification conformité CEQ/RBQ`);

    const issues: string[] = [];

    // Vérifier cuisinière ≥5000W (CEQ 6-304)
    const stoveOutlets = equipment.filter(eq => eq.type === 'stove_outlet');
    const stoveText = text.filter(t =>
      t.text.toLowerCase().includes('cuisinière') ||
      t.text.toLowerCase().includes('stove') ||
      t.text.toLowerCase().includes('5000w') ||
      t.text.toLowerCase().includes('5kw')
    );

    if (stoveText.length > 0 && stoveOutlets.length === 0) {
      issues.push('CEQ 6-304: Cuisinière ≥5000W détectée mais prise dédiée non visible sur plan');
    }

    // Vérifier GFCI/DDFT pour zones humides (CEQ 26-700)
    const gfciBreakers = equipment.filter(eq => eq.type === 'gfci_breaker');
    const bathroomText = text.filter(t =>
      t.text.toLowerCase().includes('sdb') ||
      t.text.toLowerCase().includes('salle de bain') ||
      t.text.toLowerCase().includes('bathroom')
    );

    if (bathroomText.length > 0 && gfciBreakers.length === 0) {
      issues.push('CEQ 26-700: Salle de bain détectée - vérifier protection DDFT');
    }

    // Vérifier planchers chauffants (CEQ 62-116)
    const heatedFloors = equipment.filter(eq => eq.type === 'heated_floor');
    if (heatedFloors.length > 0) {
      const thermostatText = text.filter(t =>
        t.text.toLowerCase().includes('thermostat') ||
        t.text.toLowerCase().includes('thermo')
      );

      if (thermostatText.length === 0) {
        issues.push('CEQ 62-116: Plancher chauffant sans thermostat visible');
      }
    }

    // Vérifier certifications CSA
    const uncertifiedEquipment = equipment.filter(eq => !eq.csaCertificationRequired);
    if (uncertifiedEquipment.length > 0) {
      issues.push(
        `${uncertifiedEquipment.length} équipements nécessitent vérification certification CSA/UL`
      );
    }

    logger.info(`PlanAnalyzerService: ${issues.length} problèmes de conformité détectés`);

    return issues;
  }

  /**
   * Calculer score de confiance global
   */
  private calculateOverallConfidence(pageResults: any[]): number {
    if (pageResults.length === 0) return 0;

    const totalConfidence = pageResults.reduce((sum, result) => sum + result.confidence, 0);
    return Math.round((totalConfidence / pageResults.length) * 100) / 100;
  }

  /**
   * Créer répertoire temporaire
   */
  private async createTempDirectory(planId: string): Promise<string> {
    const dir = path.join(this.tempDir, planId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Nettoyer fichiers temporaires
   */
  private async cleanupTempFiles(dir: string): Promise<void> {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      logger.info(`PlanAnalyzerService: Fichiers temporaires nettoyés: ${dir}`);
    } catch (error) {
      logger.warn(`PlanAnalyzerService: Erreur nettoyage fichiers temp`, error);
    }
  }
}
