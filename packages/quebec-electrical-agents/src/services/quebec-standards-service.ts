/**
 * Service des Normes Québécoises
 * Interface avec la base de connaissances FAISS pour CEQ, RBQ, RSST, CSA
 */

import { logger } from '../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

export interface KnowledgeResult {
  text: string;
  source: 'CEQ' | 'RBQ' | 'RSST' | 'CSA' | 'Hydro-Québec' | 'Quebec Climate' | 'Quebec Standards';
  section: string;
  category: string;
  score: number;
  metadata: { [key: string]: any };
}

export class QuebecStandardsService {
  private pythonScriptPath: string;
  private isInitialized: boolean = false;

  constructor() {
    this.pythonScriptPath = path.join(__dirname, '../../python/knowledge_base.py');
  }

  /**
   * Initialiser la base de connaissances FAISS
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info('QuebecStandardsService: Base de connaissances déjà initialisée');
      return;
    }

    logger.info('QuebecStandardsService: Initialisation de la base de connaissances FAISS...');

    try {
      const command = `python3 "${this.pythonScriptPath}" init`;
      const { stdout } = await execAsync(command);

      const result = JSON.parse(stdout);

      if (result.status === 'success') {
        this.isInitialized = true;
        logger.info(`QuebecStandardsService: Base initialisée avec ${result.documents} documents`);
      } else {
        throw new Error('Échec initialisation base de connaissances');
      }
    } catch (error) {
      logger.error('QuebecStandardsService: Erreur initialisation', error);
      throw error;
    }
  }

  /**
   * Rechercher dans la base de connaissances
   */
  async search(
    query: string,
    source?: 'CEQ' | 'RBQ' | 'RSST' | 'CSA',
    k: number = 5
  ): Promise<KnowledgeResult[]> {
    logger.info(`QuebecStandardsService: Recherche "${query}" (source: ${source || 'all'})`);

    try {
      const sourceArg = source || '';
      const command = `python3 "${this.pythonScriptPath}" search "${query}" "${sourceArg}" ${k}`;

      const { stdout } = await execAsync(command);
      const results: KnowledgeResult[] = JSON.parse(stdout);

      logger.info(`QuebecStandardsService: ${results.length} résultats trouvés`);

      return results;
    } catch (error) {
      logger.error('QuebecStandardsService: Erreur recherche', error);
      return [];
    }
  }

  /**
   * Recherche spécifique Québec (priorise normes québécoises)
   */
  async searchQuebecSpecific(query: string, k: number = 5): Promise<KnowledgeResult[]> {
    logger.info(`QuebecStandardsService: Recherche Québec spécifique "${query}"`);

    try {
      const command = `python3 "${this.pythonScriptPath}" quebec-search "${query}" ${k}`;

      const { stdout } = await execAsync(command);
      const results: KnowledgeResult[] = JSON.parse(stdout);

      logger.info(`QuebecStandardsService: ${results.length} résultats québécois trouvés`);

      return results;
    } catch (error) {
      logger.error('QuebecStandardsService: Erreur recherche Québec', error);
      return [];
    }
  }

  /**
   * Obtenir informations sur un code CEQ spécifique
   */
  async getCEQSection(section: string): Promise<KnowledgeResult[]> {
    const query = `CEQ Section ${section}`;
    return this.search(query, 'CEQ', 3);
  }

  /**
   * Obtenir exigences RSST pour sécurité
   */
  async getRSSTSafetyRequirements(topic: string): Promise<KnowledgeResult[]> {
    const query = `RSST sécurité ${topic}`;
    return this.search(query, 'RSST', 5);
  }

  /**
   * Obtenir exigences RBQ
   */
  async getRBQRequirements(topic: string): Promise<KnowledgeResult[]> {
    const query = `RBQ ${topic}`;
    return this.search(query, 'RBQ', 5);
  }

  /**
   * Vérifier conformité équipement spécial Québec
   */
  async checkQuebecSpecialEquipment(equipmentType: string): Promise<KnowledgeResult[]> {
    const queries = {
      'stove': 'cuisinière 5000W circuit dédié CEQ 6-304',
      'heated-floor': 'plancher chauffant thermostat CEQ 62-116',
      'gfci': 'DDFT protection zones humides CEQ 26-700',
      'cafci': 'CAFCI protection chambres CEQ 26-724'
    };

    const query = queries[equipmentType as keyof typeof queries] || equipmentType;

    return this.searchQuebecSpecific(query, 3);
  }

  /**
   * Obtenir informations climat hivernal Québec
   */
  async getWinterRequirements(): Promise<KnowledgeResult[]> {
    return this.searchQuebecSpecific('hiver froid équipements extérieurs -40°C', 5);
  }

  /**
   * Générer guide de conformité
   */
  async generateComplianceGuide(projectType: string): Promise<string> {
    logger.info(`QuebecStandardsService: Génération guide conformité pour ${projectType}`);

    // Rechercher informations pertinentes
    const ceqResults = await this.search(`${projectType} installation électrique`, 'CEQ', 5);
    const rsstResults = await this.search(`${projectType} sécurité`, 'RSST', 3);
    const rbqResults = await this.search(`${projectType} conformité`, 'RBQ', 3);

    // Générer guide
    let guide = `
GUIDE DE CONFORMITÉ ÉLECTRIQUE - QUÉBEC
Type de projet: ${projectType}
========================================

NORMES CEQ (Code Électrique du Québec)
---------------------------------------
${ceqResults.map(r => `• ${r.section}: ${r.text}`).join('\n')}

EXIGENCES RSST (Santé et Sécurité)
-----------------------------------
${rsstResults.map(r => `• ${r.section}: ${r.text}`).join('\n')}

EXIGENCES RBQ (Régie du Bâtiment)
----------------------------------
${rbqResults.map(r => `• ${r.section}: ${r.text}`).join('\n')}

SPÉCIFICITÉS QUÉBÉCOISES
-------------------------
• Conditions hivernales: Équipements certifiés -40°C requis
• Certification CSA ou UL obligatoire pour tous équipements
• Inspection municipale avant mise sous tension
• Licence RBQ du maître électricien obligatoire

RESSOURCES
----------
• Code Électrique du Québec: https://www.rbq.gouv.qc.ca/
• RSST: https://www.legisquebec.gouv.qc.ca/
• Hydro-Québec: https://www.hydroquebec.com/
`;

    return guide;
  }
}
