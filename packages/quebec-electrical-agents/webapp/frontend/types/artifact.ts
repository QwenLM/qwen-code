/**
 * Type definitions for artifacts displayed in the Artifact Panel.
 *
 * Artifacts can be:
 * - Code snippets (various languages)
 * - PGI Dashboard data
 * - Electrical plan with photo markers
 * - BOM (Bill of Materials)
 * - Compliance reports
 */

export type ArtifactType =
  | "code"
  | "pgi_dashboard"
  | "plan_with_photos"
  | "bom"
  | "compliance"
  | "markdown";

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  content: any; // Content depends on type
  language?: string; // For code artifacts
  createdAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  artifact?: Artifact;
}

// PGI specific types

export interface PGIProject {
  name: string;
  status: "active" | "completed" | "pending" | "urgent";
  budget: number;
  spent: number;
  completion: number;
}

export interface PGIRentabilite {
  projects: PGIProject[];
  total_budget: number;
  total_spent: number;
  profit_margin: number;
}

export interface PGILabor {
  date: string;
  hours: number;
  cost: number;
  project: string;
  workers: number;
}

export interface PGIMaterial {
  category: string;
  quantity: number;
  cost: number;
  unit: string;
}

export interface PGIData {
  type: "pgi_dashboard";
  title: string;
  generated_at: string;
  rentabilite?: PGIRentabilite;
  labor: PGILabor[];
  materials: PGIMaterial[];
  projects_active: number;
  total_revenue: number;
  alerts: string[];
}

// Photo GPS types

export interface PhotoMetadata {
  filename: string;
  captured_at?: string;
  camera_make?: string;
  camera_model?: string;
  gps?: {
    latitude: number;
    longitude: number;
    altitude?: number;
  };
  width: number;
  height: number;
}

export interface PhotoOnPlan {
  photo_path: string;
  photo_metadata: PhotoMetadata;
  plan_coordinates: {
    x: number;
    y: number;
    plan_width: number;
    plan_height: number;
  };
  distance_from_reference?: number;
  notes: string[];
}

export interface PlanWithPhotos {
  plan_path: string;
  plan_image_url: string;
  photos: PhotoOnPlan[];
}
