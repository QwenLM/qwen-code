/**
 * Agent de Planification de Chantier - Québec
 * Spécialiste en organisation des travaux électriques conformes RBQ
 */

import { logger } from '../utils/logger.js';

export interface SitePlan {
  projectId: string;
  phases: WorkPhase[];
  permits: Permit[];
  inspections: Inspection[];
  weather: WeatherConsiderations;
  resources: ResourceAllocation;
}

export interface WorkPhase {
  id: string;
  name: string;
  description: string;
  duration: number; // en jours
  dependencies: string[];
  requiredCertifications: string[];
  weatherDependent: boolean;
}

export interface Permit {
  type: 'RBQ' | 'Municipal' | 'Hydro-Québec';
  number?: string;
  status: 'pending' | 'approved' | 'rejected';
  applicationDate?: Date;
  expiryDate?: Date;
}

export interface Inspection {
  type: string;
  scheduledDate?: Date;
  inspector?: string;
  status: 'pending' | 'passed' | 'failed';
  notes?: string;
}

export interface WeatherConsiderations {
  winterWork: boolean;
  heatingRequired: boolean;
  specialEquipment: string[];
}

export interface ResourceAllocation {
  masterElectrician: string;
  journeymen: number;
  apprentices: number;
  equipment: string[];
}

export class SitePlannerAgent {
  private agentName = 'Agent de Planification de Chantier';

  /**
   * Créer un plan de chantier complet pour un projet électrique
   */
  async createSitePlan(projectData: any): Promise<SitePlan> {
    logger.info(`${this.agentName}: Création du plan de chantier`);

    const phases = this.defineWorkPhases(projectData);
    const permits = this.identifyRequiredPermits(projectData);
    const inspections = this.scheduleInspections(phases);
    const weather = this.assessWeatherImpact(projectData);
    const resources = this.allocateResources(projectData, phases);

    return {
      projectId: projectData.id,
      phases,
      permits,
      inspections,
      weather,
      resources
    };
  }

  /**
   * Définir les phases de travail selon le type de projet
   */
  private defineWorkPhases(projectData: any): WorkPhase[] {
    const phases: WorkPhase[] = [];

    // Phase 1: Préparation et permis
    phases.push({
      id: 'phase-1',
      name: 'Préparation et obtention des permis',
      description: 'Demande de permis RBQ et municipal, planification détaillée',
      duration: 5,
      dependencies: [],
      requiredCertifications: ['Licence RBQ maître électricien'],
      weatherDependent: false
    });

    // Phase 2: Installation temporaire (si nécessaire)
    if (projectData.requiresTemporaryPower) {
      phases.push({
        id: 'phase-2',
        name: 'Installation électrique temporaire',
        description: 'Mise en place du service temporaire pour le chantier',
        duration: 2,
        dependencies: ['phase-1'],
        requiredCertifications: ['Licence RBQ'],
        weatherDependent: true
      });
    }

    // Phase 3: Travaux de distribution principale
    phases.push({
      id: 'phase-3',
      name: 'Installation du panneau principal',
      description: 'Installation du panneau de distribution, branchement Hydro-Québec',
      duration: 3,
      dependencies: ['phase-1'],
      requiredCertifications: ['Licence RBQ', 'Formation Hydro-Québec'],
      weatherDependent: false
    });

    // Phase 4: Distribution secondaire
    phases.push({
      id: 'phase-4',
      name: 'Distribution et câblage',
      description: 'Tirage des câbles, installation des conduits',
      duration: projectData.estimatedDuration || 10,
      dependencies: ['phase-3'],
      requiredCertifications: ['Compagnon électricien'],
      weatherDependent: false
    });

    // Phase 5: Dispositifs et appareillages
    phases.push({
      id: 'phase-5',
      name: 'Installation des dispositifs',
      description: 'Prises, interrupteurs, luminaires, équipements spéciaux',
      duration: 5,
      dependencies: ['phase-4'],
      requiredCertifications: ['Compagnon électricien'],
      weatherDependent: false
    });

    // Phase 6: Équipements spéciaux Québec
    if (this.hasQuebecSpecialEquipment(projectData)) {
      phases.push({
        id: 'phase-6',
        name: 'Équipements spéciaux',
        description: 'Cuisinière ≥5000W, planchers chauffants, dégivreur de toiture',
        duration: 3,
        dependencies: ['phase-4'],
        requiredCertifications: ['Compagnon électricien', 'Formation spécialisée'],
        weatherDependent: false
      });
    }

    // Phase 7: Tests et mise en service
    phases.push({
      id: 'phase-7',
      name: 'Tests et vérifications',
      description: 'Tests de continuité, isolation, DDFT, mise sous tension',
      duration: 2,
      dependencies: ['phase-5', 'phase-6'].filter(Boolean),
      requiredCertifications: ['Maître électricien'],
      weatherDependent: false
    });

    // Phase 8: Inspection finale
    phases.push({
      id: 'phase-8',
      name: 'Inspection et certification',
      description: 'Inspection municipale, certification RBQ',
      duration: 1,
      dependencies: ['phase-7'],
      requiredCertifications: ['Maître électricien'],
      weatherDependent: false
    });

    return phases;
  }

  /**
   * Identifier les permis requis selon le projet
   */
  private identifyRequiredPermits(projectData: any): Permit[] {
    const permits: Permit[] = [];

    // Permis RBQ obligatoire
    permits.push({
      type: 'RBQ',
      status: 'pending'
    });

    // Permis municipal pour travaux électriques
    permits.push({
      type: 'Municipal',
      status: 'pending'
    });

    // Branchement Hydro-Québec si nouveau service
    if (projectData.newService) {
      permits.push({
        type: 'Hydro-Québec',
        status: 'pending'
      });
    }

    return permits;
  }

  /**
   * Planifier les inspections obligatoires
   */
  private scheduleInspections(phases: WorkPhase[]): Inspection[] {
    const inspections: Inspection[] = [];

    // Inspection avant enfouissement des câbles
    inspections.push({
      type: 'Inspection intermédiaire - câblage',
      status: 'pending',
      notes: 'Avant fermeture des murs et plafonds'
    });

    // Inspection avant mise sous tension
    inspections.push({
      type: 'Inspection pré-mise sous tension',
      status: 'pending',
      notes: 'Tests de continuité et isolation requis'
    });

    // Inspection finale municipale
    inspections.push({
      type: 'Inspection finale municipale',
      status: 'pending',
      notes: 'Requise avant certificat de conformité RBQ'
    });

    return inspections;
  }

  /**
   * Évaluer l'impact des conditions hivernales québécoises
   */
  private assessWeatherImpact(projectData: any): WeatherConsiderations {
    const currentMonth = new Date().getMonth();
    const isWinter = currentMonth >= 10 || currentMonth <= 3; // Nov-Apr

    return {
      winterWork: isWinter,
      heatingRequired: isWinter && projectData.hasExteriorWork,
      specialEquipment: isWinter ? [
        'Chauffage temporaire de chantier',
        'Équipements certifiés -40°C',
        'Câbles résistants au froid',
        'Générateur de secours'
      ] : []
    };
  }

  /**
   * Allouer les ressources humaines et matérielles
   */
  private allocateResources(projectData: any, phases: WorkPhase[]): ResourceAllocation {
    // Calcul basé sur la complexité du projet
    const complexity = this.assessProjectComplexity(projectData);

    let journeymen = 2;
    let apprentices = 1;

    if (complexity === 'high') {
      journeymen = 4;
      apprentices = 2;
    } else if (complexity === 'medium') {
      journeymen = 3;
      apprentices = 1;
    }

    return {
      masterElectrician: 'Requis (licence RBQ)',
      journeymen,
      apprentices,
      equipment: [
        'Outils manuels standards',
        'Équipement de test (multimètre, testeur DDFT)',
        'Échafaudage/escabeau',
        'EPI complets (casque, gants isolants, lunettes)',
        'Véhicule de service'
      ]
    };
  }

  /**
   * Générer un calendrier de projet détaillé
   */
  async generateProjectSchedule(sitePlan: SitePlan): Promise<string> {
    logger.info(`${this.agentName}: Génération du calendrier de projet`);

    let schedule = `
CALENDRIER DE PROJET - ${sitePlan.projectId}
==========================================

`;

    let currentDay = 0;
    for (const phase of sitePlan.phases) {
      schedule += `\nPhase: ${phase.name}\n`;
      schedule += `Durée: ${phase.duration} jours ouvrables\n`;
      schedule += `Début: Jour ${currentDay + 1}\n`;
      schedule += `Fin: Jour ${currentDay + phase.duration}\n`;
      schedule += `Certifications requises: ${phase.requiredCertifications.join(', ')}\n`;

      if (phase.weatherDependent && sitePlan.weather.winterWork) {
        schedule += `⚠️  ATTENTION: Travaux extérieurs en hiver - prévoir équipement spécialisé\n`;
      }

      currentDay += phase.duration;
    }

    schedule += `\n\nDURÉE TOTALE ESTIMÉE: ${currentDay} jours ouvrables\n`;

    if (sitePlan.weather.winterWork) {
      schedule += `\n⚠️  CONSIDÉRATIONS HIVERNALES:\n`;
      sitePlan.weather.specialEquipment.forEach(eq => {
        schedule += `   - ${eq}\n`;
      });
    }

    return schedule;
  }

  // Méthodes utilitaires privées
  private hasQuebecSpecialEquipment(data: any): boolean {
    return data.hasStove5000W || data.hasHeatedFloor || data.hasRoofHeating;
  }

  private assessProjectComplexity(data: any): 'low' | 'medium' | 'high' {
    const factors = [
      data.numberOfCircuits > 20,
      data.hasThreePhase,
      data.hasSpecialEquipment,
      data.squareFeet > 2000
    ];

    const trueCount = factors.filter(Boolean).length;

    if (trueCount >= 3) return 'high';
    if (trueCount >= 2) return 'medium';
    return 'low';
  }
}
