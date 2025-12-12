/**
 * Agent de Gestion des Approvisionnements - Québec
 * Spécialiste en gestion de matériel électrique certifié CSA
 */

import { logger } from '../utils/logger.js';

export interface MaterialOrder {
  orderId: string;
  projectId: string;
  items: MaterialItem[];
  totalCost: number;
  supplier: string;
  orderDate: Date;
  expectedDelivery: Date;
  status: 'pending' | 'ordered' | 'delivered' | 'cancelled';
}

export interface MaterialItem {
  sku: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  certifications: string[]; // CSA, UL, etc.
  inStock: boolean;
  leadTime?: number; // jours
}

export interface BOM {
  projectId: string;
  generatedDate: Date;
  categories: MaterialCategory[];
  totalCost: number;
  allCertified: boolean;
}

export interface MaterialCategory {
  name: string;
  items: MaterialItem[];
  subtotal: number;
}

export interface Inventory {
  warehouseId: string;
  items: InventoryItem[];
  lastUpdated: Date;
}

export interface InventoryItem extends MaterialItem {
  currentStock: number;
  minimumStock: number;
  location: string;
  needsReorder: boolean;
}

export class SupplyManagerAgent {
  private agentName = 'Agent de Gestion des Approvisionnements';

  /**
   * Générer une liste de matériel (BOM) à partir des plans
   */
  async generateBOM(planData: any, projectData: any): Promise<BOM> {
    logger.info(`${this.agentName}: Génération du BOM pour projet ${projectData.id}`);

    const categories: MaterialCategory[] = [];

    // 1. Panneau et disjoncteurs
    const panelCategory = this.generatePanelMaterials(projectData);
    categories.push(panelCategory);

    // 2. Câblage
    const wiringCategory = this.generateWiringMaterials(projectData);
    categories.push(wiringCategory);

    // 3. Boîtes et dispositifs
    const devicesCategory = this.generateDeviceMaterials(projectData);
    categories.push(devicesCategory);

    // 4. Équipements spéciaux Québec
    if (this.hasQuebecSpecialEquipment(projectData)) {
      const specialCategory = this.generateQuebecSpecialEquipment(projectData);
      categories.push(specialCategory);
    }

    // 5. Conduits et supports
    const conduitsCategory = this.generateConduitMaterials(projectData);
    categories.push(conduitsCategory);

    // 6. Mise à la terre
    const groundingCategory = this.generateGroundingMaterials(projectData);
    categories.push(groundingCategory);

    const totalCost = categories.reduce((sum, cat) => sum + cat.subtotal, 0);
    const allCertified = this.verifyAllCertifications(categories);

    return {
      projectId: projectData.id,
      generatedDate: new Date(),
      categories,
      totalCost,
      allCertified
    };
  }

  /**
   * Générer matériel panneau et disjoncteurs
   */
  private generatePanelMaterials(projectData: any): MaterialCategory {
    const items: MaterialItem[] = [];

    // Panneau principal
    const serviceSize = projectData.serviceSize || 200;
    items.push({
      sku: `PANEL-${serviceSize}A`,
      description: `Panneau de distribution ${serviceSize}A, 240V`,
      quantity: 1,
      unit: 'unité',
      unitPrice: serviceSize >= 200 ? 350 : 250,
      totalPrice: serviceSize >= 200 ? 350 : 250,
      certifications: ['CSA', 'UL'],
      inStock: true
    });

    // Disjoncteur principal
    items.push({
      sku: `BREAKER-MAIN-${serviceSize}A`,
      description: `Disjoncteur principal ${serviceSize}A, 2 pôles`,
      quantity: 1,
      unit: 'unité',
      unitPrice: 120,
      totalPrice: 120,
      certifications: ['CSA', 'UL'],
      inStock: true
    });

    // Disjoncteurs de dérivation
    const circuitCount = projectData.circuits?.length || 20;

    // Disjoncteurs DDFT (GFCI)
    items.push({
      sku: 'BREAKER-GFCI-20A',
      description: 'Disjoncteur DDFT 20A, 1 pôle',
      quantity: 5, // Cuisine, SDB, extérieur, garage, sous-sol
      unit: 'unité',
      unitPrice: 65,
      totalPrice: 325,
      certifications: ['CSA', 'UL'],
      inStock: true
    });

    // Disjoncteurs CAFCI
    const bedroomCount = projectData.bedroomCount || 3;
    items.push({
      sku: 'BREAKER-CAFCI-15A',
      description: 'Disjoncteur CAFCI 15A, 1 pôle',
      quantity: bedroomCount,
      unit: 'unité',
      unitPrice: 75,
      totalPrice: bedroomCount * 75,
      certifications: ['CSA', 'UL'],
      inStock: true
    });

    // Disjoncteurs standards
    items.push({
      sku: 'BREAKER-STD-15A',
      description: 'Disjoncteur standard 15A, 1 pôle',
      quantity: Math.max(0, circuitCount - 5 - bedroomCount),
      unit: 'unité',
      unitPrice: 12,
      totalPrice: Math.max(0, circuitCount - 5 - bedroomCount) * 12,
      certifications: ['CSA', 'UL'],
      inStock: true
    });

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);

    return {
      name: 'Panneau et Disjoncteurs',
      items,
      subtotal
    };
  }

  /**
   * Générer matériel de câblage
   */
  private generateWiringMaterials(projectData: any): MaterialCategory {
    const items: MaterialItem[] = [];
    const squareFeet = projectData.squareFeet || 1500;

    // Estimer longueur de câbles
    const wire14Length = Math.ceil(squareFeet * 0.5); // pieds
    const wire12Length = Math.ceil(squareFeet * 0.3);

    items.push({
      sku: 'WIRE-14-2-CU',
      description: 'Câble 14/2 NMD90 cuivre (Loomex)',
      quantity: wire14Length,
      unit: 'pieds',
      unitPrice: 0.65,
      totalPrice: wire14Length * 0.65,
      certifications: ['CSA'],
      inStock: true
    });

    items.push({
      sku: 'WIRE-12-2-CU',
      description: 'Câble 12/2 NMD90 cuivre (Loomex)',
      quantity: wire12Length,
      unit: 'pieds',
      unitPrice: 0.85,
      totalPrice: wire12Length * 0.85,
      certifications: ['CSA'],
      inStock: true
    });

    // Câble d'alimentation principal
    const serviceSize = projectData.serviceSize || 200;
    const serviceWire = serviceSize >= 200 ? '2/0 AWG' : '1/0 AWG';

    items.push({
      sku: `WIRE-SERVICE-${serviceWire}`,
      description: `Câble d'alimentation ${serviceWire} cuivre`,
      quantity: 50,
      unit: 'pieds',
      unitPrice: 8.50,
      totalPrice: 425,
      certifications: ['CSA'],
      inStock: true
    });

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);

    return {
      name: 'Câblage',
      items,
      subtotal
    };
  }

  /**
   * Générer matériel dispositifs et boîtes
   */
  private generateDeviceMaterials(projectData: any): MaterialCategory {
    const items: MaterialItem[] = [];

    // Prises standards
    items.push({
      sku: 'OUTLET-15A-DUPLEX',
      description: 'Prise duplex 15A, mise à la terre',
      quantity: 30,
      unit: 'unité',
      unitPrice: 1.25,
      totalPrice: 37.50,
      certifications: ['CSA', 'UL'],
      inStock: true
    });

    // Interrupteurs
    items.push({
      sku: 'SWITCH-15A-SINGLE',
      description: 'Interrupteur simple 15A',
      quantity: 15,
      unit: 'unité',
      unitPrice: 1.10,
      totalPrice: 16.50,
      certifications: ['CSA', 'UL'],
      inStock: true
    });

    // Boîtes électriques
    items.push({
      sku: 'BOX-SINGLE-PLASTIC',
      description: 'Boîte simple en plastique',
      quantity: 45,
      unit: 'unité',
      unitPrice: 0.85,
      totalPrice: 38.25,
      certifications: ['CSA'],
      inStock: true
    });

    // Plaques murales
    items.push({
      sku: 'PLATE-SINGLE-WHITE',
      description: 'Plaque murale simple blanche',
      quantity: 45,
      unit: 'unité',
      unitPrice: 0.50,
      totalPrice: 22.50,
      certifications: ['CSA'],
      inStock: true
    });

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);

    return {
      name: 'Boîtes et Dispositifs',
      items,
      subtotal
    };
  }

  /**
   * Générer équipements spéciaux québécois
   */
  private generateQuebecSpecialEquipment(projectData: any): MaterialCategory {
    const items: MaterialItem[] = [];

    // Cuisinière ≥5000W
    if (projectData.hasStove) {
      items.push({
        sku: 'OUTLET-STOVE-50A',
        description: 'Prise cuisinière 50A, 240V',
        quantity: 1,
        unit: 'unité',
        unitPrice: 25,
        totalPrice: 25,
        certifications: ['CSA', 'UL'],
        inStock: true
      });

      items.push({
        sku: 'WIRE-6-3-STOVE',
        description: 'Câble 6/3 pour cuisinière',
        quantity: 25,
        unit: 'pieds',
        unitPrice: 3.50,
        totalPrice: 87.50,
        certifications: ['CSA'],
        inStock: true
      });
    }

    // Planchers chauffants
    if (projectData.hasHeatedFloor) {
      const area = projectData.heatedFloorArea || 50; // pi²

      items.push({
        sku: 'HEATED-FLOOR-MAT',
        description: 'Tapis chauffant électrique 120V',
        quantity: area,
        unit: 'pi²',
        unitPrice: 12,
        totalPrice: area * 12,
        certifications: ['CSA', 'UL'],
        inStock: false,
        leadTime: 7
      });

      items.push({
        sku: 'THERMOSTAT-FLOOR',
        description: 'Thermostat pour plancher chauffant avec sonde',
        quantity: 1,
        unit: 'unité',
        unitPrice: 85,
        totalPrice: 85,
        certifications: ['CSA', 'UL'],
        inStock: true
      });
    }

    // Équipements extérieurs résistants au froid québécois
    if (projectData.hasExteriorEquipment) {
      items.push({
        sku: 'BOX-EXTERIOR-COLD',
        description: 'Boîtier extérieur IP65 certifié -40°C',
        quantity: 2,
        unit: 'unité',
        unitPrice: 45,
        totalPrice: 90,
        certifications: ['CSA', 'UL', 'IP65'],
        inStock: true
      });

      items.push({
        sku: 'WIRE-EXTERIOR-COLD',
        description: 'Câble extérieur résistant au froid -40°C',
        quantity: 100,
        unit: 'pieds',
        unitPrice: 1.85,
        totalPrice: 185,
        certifications: ['CSA'],
        inStock: true
      });
    }

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);

    return {
      name: 'Équipements Spéciaux Québec',
      items,
      subtotal
    };
  }

  /**
   * Générer matériel conduits
   */
  private generateConduitMaterials(projectData: any): MaterialCategory {
    const items: MaterialItem[] = [];

    if (projectData.needsConduit) {
      items.push({
        sku: 'CONDUIT-EMT-1/2',
        description: 'Conduit EMT 1/2 pouce',
        quantity: 100,
        unit: 'pieds',
        unitPrice: 1.25,
        totalPrice: 125,
        certifications: ['CSA'],
        inStock: true
      });

      items.push({
        sku: 'CONNECTOR-EMT-1/2',
        description: 'Connecteur EMT 1/2 pouce',
        quantity: 20,
        unit: 'unité',
        unitPrice: 0.75,
        totalPrice: 15,
        certifications: ['CSA'],
        inStock: true
      });
    }

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);

    return {
      name: 'Conduits et Supports',
      items,
      subtotal
    };
  }

  /**
   * Générer matériel mise à la terre
   */
  private generateGroundingMaterials(projectData: any): MaterialCategory {
    const items: MaterialItem[] = [];

    items.push({
      sku: 'GROUND-ROD-8FT',
      description: 'Électrode de mise à la terre 8 pieds',
      quantity: 2,
      unit: 'unité',
      unitPrice: 18,
      totalPrice: 36,
      certifications: ['CSA'],
      inStock: true
    });

    items.push({
      sku: 'WIRE-GROUND-6AWG',
      description: 'Conducteur de mise à la terre 6 AWG cuivre nu',
      quantity: 50,
      unit: 'pieds',
      unitPrice: 1.20,
      totalPrice: 60,
      certifications: ['CSA'],
      inStock: true
    });

    items.push({
      sku: 'CLAMP-GROUND-ROD',
      description: 'Collier pour électrode de terre',
      quantity: 2,
      unit: 'unité',
      unitPrice: 3.50,
      totalPrice: 7,
      certifications: ['CSA'],
      inStock: true
    });

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);

    return {
      name: 'Mise à la Terre',
      items,
      subtotal
    };
  }

  /**
   * Vérifier les certifications CSA/UL
   */
  private verifyAllCertifications(categories: MaterialCategory[]): boolean {
    for (const category of categories) {
      for (const item of category.items) {
        if (!item.certifications.includes('CSA') && !item.certifications.includes('UL')) {
          logger.warn(`${this.agentName}: Matériel sans certification: ${item.description}`);
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Créer un bon de commande
   */
  async createPurchaseOrder(bom: BOM, supplier: string): Promise<MaterialOrder> {
    logger.info(`${this.agentName}: Création du bon de commande pour ${supplier}`);

    const allItems = bom.categories.flatMap(cat => cat.items);

    const order: MaterialOrder = {
      orderId: this.generateOrderId(),
      projectId: bom.projectId,
      items: allItems,
      totalCost: bom.totalCost * 1.15, // +15% taxes Québec (TPS+TVQ)
      supplier,
      orderDate: new Date(),
      expectedDelivery: this.calculateDeliveryDate(allItems),
      status: 'pending'
    };

    return order;
  }

  /**
   * Vérifier les stocks disponibles
   */
  async checkInventory(items: MaterialItem[]): Promise<InventoryItem[]> {
    logger.info(`${this.agentName}: Vérification des stocks`);

    // Simuler une vérification d'inventaire
    return items.map(item => ({
      ...item,
      currentStock: item.inStock ? Math.floor(Math.random() * 100) + item.quantity : 0,
      minimumStock: item.quantity,
      location: 'Entrepôt Montréal',
      needsReorder: !item.inStock
    }));
  }

  // Méthodes utilitaires privées
  private hasQuebecSpecialEquipment(data: any): boolean {
    return data.hasStove || data.hasHeatedFloor || data.hasExteriorEquipment;
  }

  private generateOrderId(): string {
    return `PO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  private calculateDeliveryDate(items: MaterialItem[]): Date {
    const maxLeadTime = Math.max(...items.map(i => i.leadTime || 0), 2);
    const deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + maxLeadTime);
    return deliveryDate;
  }
}
