/**
 * PGI Dashboard Component - Heavy dashboard with Recharts visualizations.
 *
 * Features:
 * - Rentabilité (Profitability) - Bar Chart
 * - Main d'œuvre (Labor) - Line Chart
 * - Matériel (Materials) - Pie Chart
 * - Project sections: KORLCC, Alexis Nihon, Urgences
 * - Real-time alerts and statistics
 *
 * Uses Recharts library for data visualization.
 */

"use client";

import { PGIData } from "@/types/artifact";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  TrendingUp,
  Users,
  Package,
  AlertTriangle,
  DollarSign,
  Clock,
} from "lucide-react";
import { useMemo } from "react";

interface PGIDashboardProps {
  data: PGIData;
}

// Cyberpunk color palette for charts
const CHART_COLORS = {
  primary: "#00f0ff", // Cyan
  secondary: "#b000ff", // Purple
  accent: "#ff006e", // Pink
  warning: "#ffbe0b", // Yellow
  success: "#00ff41", // Green
  projects: [
    "#00f0ff", // KORLCC - Cyan
    "#b000ff", // Alexis Nihon - Purple
    "#ff006e", // Urgences - Pink
    "#ffbe0b", // Additional - Yellow
    "#00ff41", // Additional - Green
  ],
};

export default function PGIDashboard({ data }: PGIDashboardProps) {
  /**
   * Prepare data for Rentabilité (Profitability) Bar Chart.
   */
  const rentabiliteData = useMemo(() => {
    if (!data.rentabilite) return [];

    return data.rentabilite.projects.map((project) => ({
      name: project.name,
      budget: project.budget,
      dépensé: project.spent,
      restant: project.budget - project.spent,
      completion: project.completion,
    }));
  }, [data.rentabilite]);

  /**
   * Prepare data for Main d'œuvre (Labor) Line Chart.
   */
  const laborData = useMemo(() => {
    return data.labor.map((entry) => ({
      date: new Date(entry.date).toLocaleDateString("fr-CA", {
        month: "short",
        day: "numeric",
      }),
      heures: entry.hours,
      coût: entry.cost,
      travailleurs: entry.workers,
      projet: entry.project,
    }));
  }, [data.labor]);

  /**
   * Prepare data for Matériel (Materials) Pie Chart.
   */
  const materialsData = useMemo(() => {
    return data.materials.map((material, index) => ({
      name: material.category,
      value: material.cost,
      quantity: material.quantity,
      unit: material.unit,
      color: CHART_COLORS.projects[index % CHART_COLORS.projects.length],
    }));
  }, [data.materials]);

  /**
   * Calculate summary statistics.
   */
  const stats = useMemo(() => {
    const totalBudget = data.rentabilite?.total_budget || 0;
    const totalSpent = data.rentabilite?.total_spent || 0;
    const totalLabor = data.labor.reduce((sum, l) => sum + l.hours, 0);
    const totalMaterials = data.materials.reduce((sum, m) => sum + m.cost, 0);

    return {
      totalBudget,
      totalSpent,
      profitMargin: data.rentabilite?.profit_margin || 0,
      totalLabor,
      totalMaterials,
      activeProjects: data.projects_active,
    };
  }, [data]);

  /**
   * Get status color for project.
   */
  const getProjectStatusColor = (status: string) => {
    switch (status) {
      case "urgent":
        return "bg-red-500/20 text-red-400 border-red-500/50";
      case "active":
        return "bg-green-500/20 text-green-400 border-green-500/50";
      case "completed":
        return "bg-blue-500/20 text-blue-400 border-blue-500/50";
      case "pending":
        return "bg-yellow-500/20 text-yellow-400 border-yellow-500/50";
      default:
        return "bg-gray-500/20 text-gray-400 border-gray-500/50";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          icon={<DollarSign className="w-6 h-6" />}
          title="Budget Total"
          value={`${(stats.totalBudget / 1000).toFixed(0)}K $`}
          subtitle={`${stats.profitMargin.toFixed(1)}% marge`}
          color="primary"
        />
        <StatCard
          icon={<Users className="w-6 h-6" />}
          title="Main d'œuvre"
          value={`${stats.totalLabor.toFixed(0)}h`}
          subtitle="Cette semaine"
          color="secondary"
        />
        <StatCard
          icon={<Package className="w-6 h-6" />}
          title="Matériel"
          value={`${(stats.totalMaterials / 1000).toFixed(0)}K $`}
          subtitle={`${data.materials.length} catégories`}
          color="accent"
        />
      </div>

      {/* Alerts */}
      {data.alerts && data.alerts.length > 0 && (
        <div className="cyber-card space-y-2">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-5 h-5 text-cyber-yellow" />
            <h3 className="font-semibold">Alertes</h3>
          </div>
          <div className="space-y-2">
            {data.alerts.map((alert, index) => (
              <div
                key={index}
                className="alert-badge alert-badge-warning"
              >
                {alert}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Project Cards */}
      {data.rentabilite && (
        <div className="space-y-4">
          <h3 className="text-xl font-bold flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-cyber-blue" />
            Projets Actifs
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {data.rentabilite.projects.map((project) => (
              <div key={project.name} className="cyber-card space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold">{project.name}</h4>
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-medium border ${getProjectStatusColor(
                      project.status
                    )}`}
                  >
                    {project.status}
                  </span>
                </div>

                {/* Progress bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Progression</span>
                    <span>{project.completion.toFixed(0)}%</span>
                  </div>
                  <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyber-blue to-cyber-purple transition-all"
                      style={{ width: `${project.completion}%` }}
                    />
                  </div>
                </div>

                {/* Budget info */}
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-muted-foreground">Budget</p>
                    <p className="font-semibold">
                      {(project.budget / 1000).toFixed(0)}K $
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Dépensé</p>
                    <p className="font-semibold">
                      {(project.spent / 1000).toFixed(0)}K $
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rentabilité Bar Chart */}
      {rentabiliteData.length > 0 && (
        <div className="cyber-card space-y-4">
          <h3 className="text-xl font-bold flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-cyber-blue" />
            Rentabilité par Projet
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={rentabiliteData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" />
              <YAxis stroke="hsl(var(--muted-foreground))" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Legend />
              <Bar dataKey="budget" fill={CHART_COLORS.primary} name="Budget" />
              <Bar dataKey="dépensé" fill={CHART_COLORS.secondary} name="Dépensé" />
              <Bar dataKey="restant" fill={CHART_COLORS.success} name="Restant" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Main d'œuvre Line Chart */}
      {laborData.length > 0 && (
        <div className="cyber-card space-y-4">
          <h3 className="text-xl font-bold flex items-center gap-2">
            <Clock className="w-5 h-5 text-cyber-purple" />
            Main d'œuvre - 7 derniers jours
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={laborData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" />
              <YAxis stroke="hsl(var(--muted-foreground))" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="heures"
                stroke={CHART_COLORS.primary}
                strokeWidth={3}
                name="Heures"
                dot={{ fill: CHART_COLORS.primary, r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="travailleurs"
                stroke={CHART_COLORS.accent}
                strokeWidth={2}
                name="Travailleurs"
                dot={{ fill: CHART_COLORS.accent, r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Matériel Pie Chart */}
      {materialsData.length > 0 && (
        <div className="cyber-card space-y-4">
          <h3 className="text-xl font-bold flex items-center gap-2">
            <Package className="w-5 h-5 text-cyber-pink" />
            Matériel par Catégorie
          </h3>
          <ResponsiveContainer width="100%" height={400}>
            <PieChart>
              <Pie
                data={materialsData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) =>
                  `${name}: ${(percent * 100).toFixed(0)}%`
                }
                outerRadius={120}
                fill="#8884d8"
                dataKey="value"
              >
                {materialsData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
                formatter={(value: number) => `${value.toFixed(2)} $`}
              />
              <Legend />
            </PieChart>
          </ResponsiveContainer>

          {/* Materials table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <th className="text-left py-2">Catégorie</th>
                  <th className="text-right py-2">Quantité</th>
                  <th className="text-right py-2">Coût</th>
                </tr>
              </thead>
              <tbody>
                {data.materials.map((material, index) => (
                  <tr key={index} className="border-b border-border/50">
                    <td className="py-2">{material.category}</td>
                    <td className="text-right py-2">
                      {material.quantity} {material.unit}
                    </td>
                    <td className="text-right py-2 font-semibold">
                      {material.cost.toFixed(2)} $
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-border font-bold">
                <tr>
                  <td className="py-2">Total</td>
                  <td></td>
                  <td className="text-right py-2 text-cyber-blue">
                    {stats.totalMaterials.toFixed(2)} $
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Stat Card Component
 */
interface StatCardProps {
  icon: React.ReactNode;
  title: string;
  value: string;
  subtitle: string;
  color: "primary" | "secondary" | "accent";
}

function StatCard({ icon, title, value, subtitle, color }: StatCardProps) {
  const colorClasses = {
    primary: "text-cyber-blue",
    secondary: "text-cyber-purple",
    accent: "text-cyber-pink",
  };

  return (
    <div className="cyber-card">
      <div className="flex items-center gap-3">
        <div className={`${colorClasses[color]}`}>{icon}</div>
        <div className="flex-1">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}
