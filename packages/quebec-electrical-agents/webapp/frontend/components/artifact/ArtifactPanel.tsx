/**
 * Artifact panel - displays different types of artifacts.
 *
 * Supports:
 * - PGI Dashboard (with Recharts)
 * - Plans with photo GPS markers
 * - Code snippets
 * - Markdown content
 * - BOM / Compliance reports
 */

"use client";

import { Artifact } from "@/types/artifact";
import PGIDashboard from "@/components/pgi/Dashboard";
import PlanWithPhotos from "@/components/components/PlanWithPhotos";
import { FileText, Code, LayoutDashboard } from "lucide-react";

interface ArtifactPanelProps {
  artifact: Artifact | null;
}

export default function ArtifactPanel({ artifact }: ArtifactPanelProps) {
  if (!artifact) {
    return (
      <div className="h-full flex items-center justify-center p-12">
        <div className="text-center space-y-4">
          <div className="mx-auto w-20 h-20 rounded-full bg-muted flex items-center justify-center">
            <LayoutDashboard className="w-10 h-10 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-muted-foreground">
              Aucun artefact à afficher
            </h3>
            <p className="text-sm text-muted-foreground mt-2">
              Les données PGI, plans et autres artefacts apparaîtront ici
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Artifact header */}
      <div className="sticky top-0 z-10 px-6 py-4 border-b border-border bg-card/95 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          {artifact.type === "pgi_dashboard" && (
            <LayoutDashboard className="w-5 h-5 text-cyber-blue" />
          )}
          {artifact.type === "code" && <Code className="w-5 h-5 text-cyber-purple" />}
          {artifact.type === "plan_with_photos" && (
            <FileText className="w-5 h-5 text-cyber-pink" />
          )}

          <div>
            <h2 className="text-lg font-semibold">{artifact.title}</h2>
            <p className="text-xs text-muted-foreground">
              {new Date(artifact.createdAt).toLocaleString("fr-CA")}
            </p>
          </div>
        </div>
      </div>

      {/* Artifact content */}
      <div className="p-6">
        {artifact.type === "pgi_dashboard" && (
          <PGIDashboard data={artifact.content} />
        )}

        {artifact.type === "plan_with_photos" && (
          <PlanWithPhotos data={artifact.content} />
        )}

        {artifact.type === "code" && (
          <div className="cyber-card">
            <pre className="overflow-x-auto">
              <code className="text-sm">{artifact.content}</code>
            </pre>
          </div>
        )}

        {artifact.type === "markdown" && (
          <div
            className="prose prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: artifact.content }}
          />
        )}

        {artifact.type === "bom" && (
          <div className="space-y-4">
            <h3 className="text-xl font-bold">Bill of Materials</h3>
            <div className="cyber-card">
              <pre className="text-sm">{JSON.stringify(artifact.content, null, 2)}</pre>
            </div>
          </div>
        )}

        {artifact.type === "compliance" && (
          <div className="space-y-4">
            <h3 className="text-xl font-bold">Rapport de Conformité</h3>
            <div className="cyber-card">
              <pre className="text-sm">{JSON.stringify(artifact.content, null, 2)}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
