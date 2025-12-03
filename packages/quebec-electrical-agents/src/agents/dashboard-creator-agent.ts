/**
 * Agent de Création de Dashboard - Québec
 * Spécialiste en visualisation de données avec communication temps réel
 */

import { logger } from '../utils/logger.js';

export interface DashboardConfig {
  dashboardId: string;
  name: string;
  description: string;
  layout: DashboardLayout;
  widgets: Widget[];
  theme: 'light' | 'dark';
  refreshInterval: number; // secondes
  userPreferences: UserPreferences;
}

export interface DashboardLayout {
  columns: number;
  rows: number;
  responsive: boolean;
  breakpoints: Breakpoint[];
}

export interface Breakpoint {
  name: string;
  minWidth: number;
  columns: number;
}

export interface Widget {
  widgetId: string;
  type: WidgetType;
  title: string;
  position: { x: number; y: number; width: number; height: number };
  dataSource: string;
  config: WidgetConfig;
  interactive: boolean;
}

export type WidgetType =
  | 'project-status'
  | 'compliance-gauge'
  | 'budget-chart'
  | 'timeline'
  | 'team-roster'
  | 'material-inventory'
  | 'safety-alerts'
  | 'directive-tracker'
  | 'bom-viewer'
  | 'plan-viewer'
  | 'chat-interface'
  | 'real-time-metrics';

export interface WidgetConfig {
  chartType?: 'bar' | 'line' | 'pie' | 'gauge' | 'doughnut';
  colors?: string[];
  showLegend?: boolean;
  dataFormat?: 'percentage' | 'currency' | 'number' | 'text';
  updateFrequency?: number; // secondes
  filters?: { [key: string]: any };
}

export interface UserPreferences {
  defaultView: string;
  language: 'fr' | 'en';
  notifications: boolean;
  autoRefresh: boolean;
}

export interface ChatMessage {
  messageId: string;
  userId: string;
  userName: string;
  message: string;
  timestamp: Date;
  type: 'user' | 'agent' | 'system';
  context?: string;
}

export class DashboardCreatorAgent {
  private agentName = 'Agent de Création de Dashboard';

  /**
   * Créer un dashboard personnalisé basé sur les besoins
   */
  async createCustomDashboard(requirements: any, userRole: string): Promise<DashboardConfig> {
    logger.info(`${this.agentName}: Création dashboard pour rôle ${userRole}`);

    const layout = this.createResponsiveLayout();
    const widgets = await this.selectWidgetsForRole(userRole, requirements);
    const theme = requirements.preferredTheme || 'light';

    const dashboard: DashboardConfig = {
      dashboardId: this.generateDashboardId(),
      name: `Dashboard ${userRole} - Électrique Québec`,
      description: `Dashboard personnalisé pour ${userRole} avec focus sur normes québécoises`,
      layout,
      widgets,
      theme,
      refreshInterval: 30, // 30 secondes
      userPreferences: {
        defaultView: 'overview',
        language: 'fr',
        notifications: true,
        autoRefresh: true
      }
    };

    logger.info(`${this.agentName}: Dashboard créé avec ${widgets.length} widgets`);

    return dashboard;
  }

  /**
   * Créer un layout responsive
   */
  private createResponsiveLayout(): DashboardLayout {
    return {
      columns: 12,
      rows: 8,
      responsive: true,
      breakpoints: [
        { name: 'desktop', minWidth: 1200, columns: 12 },
        { name: 'tablet', minWidth: 768, columns: 8 },
        { name: 'mobile', minWidth: 0, columns: 4 }
      ]
    };
  }

  /**
   * Sélectionner widgets selon le rôle
   */
  private async selectWidgetsForRole(role: string, requirements: any): Promise<Widget[]> {
    const widgets: Widget[] = [];

    switch (role) {
      case 'master-electrician':
        widgets.push(
          this.createWidget('project-status', 'Statut des Projets', 0, 0, 6, 3, {
            chartType: 'pie',
            showLegend: true
          }),
          this.createWidget('compliance-gauge', 'Conformité CEQ/RBQ', 6, 0, 3, 3, {
            chartType: 'gauge',
            colors: ['#4caf50', '#ff9800', '#f44336']
          }),
          this.createWidget('safety-alerts', 'Alertes Sécurité RSST', 9, 0, 3, 3, {
            updateFrequency: 10
          }),
          this.createWidget('team-roster', 'Équipe de Projet', 0, 3, 4, 2, {}),
          this.createWidget('budget-chart', 'Suivi Budgétaire', 4, 3, 4, 2, {
            chartType: 'bar',
            dataFormat: 'currency'
          }),
          this.createWidget('directive-tracker', 'Directives CEQ/RBQ', 8, 3, 4, 2, {}),
          this.createWidget('chat-interface', 'Assistant IA', 0, 5, 6, 3, {}),
          this.createWidget('real-time-metrics', 'Métriques Temps Réel', 6, 5, 6, 3, {
            updateFrequency: 5
          })
        );
        break;

      case 'journeyman':
        widgets.push(
          this.createWidget('project-status', 'Projet Actuel', 0, 0, 6, 2, {}),
          this.createWidget('safety-alerts', 'Sécurité RSST', 6, 0, 6, 2, {}),
          this.createWidget('material-inventory', 'Matériel Requis', 0, 2, 6, 3, {}),
          this.createWidget('plan-viewer', 'Visualisation Plans', 6, 2, 6, 3, {}),
          this.createWidget('chat-interface', 'Support Technique', 0, 5, 12, 3, {})
        );
        break;

      case 'project-manager':
        widgets.push(
          this.createWidget('project-status', 'Vue d\'Ensemble Projets', 0, 0, 8, 2, {
            chartType: 'bar'
          }),
          this.createWidget('budget-chart', 'Budget Multi-Projets', 8, 0, 4, 2, {
            chartType: 'line',
            dataFormat: 'currency'
          }),
          this.createWidget('timeline', 'Échéanciers', 0, 2, 12, 2, {}),
          this.createWidget('team-roster', 'Ressources Humaines', 0, 4, 4, 2, {}),
          this.createWidget('compliance-gauge', 'Conformité Globale', 4, 4, 4, 2, {}),
          this.createWidget('directive-tracker', 'Veille Réglementaire', 8, 4, 4, 2, {}),
          this.createWidget('chat-interface', 'Coordination Équipe', 0, 6, 6, 2, {}),
          this.createWidget('real-time-metrics', 'KPIs Temps Réel', 6, 6, 6, 2, {})
        );
        break;

      case 'superintendent':
        widgets.push(
          this.createWidget('project-status', 'Projets Actifs', 0, 0, 6, 2, {}),
          this.createWidget('safety-alerts', 'Incidents et Alertes', 6, 0, 6, 2, {}),
          this.createWidget('timeline', 'Planning Global', 0, 2, 8, 2, {}),
          this.createWidget('compliance-gauge', 'Conformité RBQ', 8, 2, 4, 2, {}),
          this.createWidget('material-inventory', 'Inventaire Matériel', 0, 4, 6, 2, {}),
          this.createWidget('team-roster', 'Affectations Équipes', 6, 4, 6, 2, {}),
          this.createWidget('chat-interface', 'Communication', 0, 6, 12, 2, {})
        );
        break;

      default:
        // Dashboard générique
        widgets.push(
          this.createWidget('project-status', 'Aperçu', 0, 0, 12, 2, {}),
          this.createWidget('chat-interface', 'Assistant', 0, 2, 12, 4, {})
        );
    }

    return widgets;
  }

  /**
   * Créer un widget
   */
  private createWidget(
    type: WidgetType,
    title: string,
    x: number,
    y: number,
    width: number,
    height: number,
    config: WidgetConfig
  ): Widget {
    return {
      widgetId: this.generateWidgetId(),
      type,
      title,
      position: { x, y, width, height },
      dataSource: this.getDataSourceForWidgetType(type),
      config,
      interactive: true
    };
  }

  /**
   * Obtenir la source de données pour un type de widget
   */
  private getDataSourceForWidgetType(type: WidgetType): string {
    const dataSources: { [key in WidgetType]: string } = {
      'project-status': '/api/projects/status',
      'compliance-gauge': '/api/compliance/summary',
      'budget-chart': '/api/projects/budget',
      'timeline': '/api/projects/timeline',
      'team-roster': '/api/team/roster',
      'material-inventory': '/api/materials/inventory',
      'safety-alerts': '/api/safety/alerts',
      'directive-tracker': '/api/directives/active',
      'bom-viewer': '/api/bom/current',
      'plan-viewer': '/api/plans/viewer',
      'chat-interface': '/api/chat/agent',
      'real-time-metrics': 'websocket:/api/metrics/live'
    };

    return dataSources[type];
  }

  /**
   * Générer code React pour le dashboard
   */
  async generateDashboardCode(config: DashboardConfig): Promise<string> {
    logger.info(`${this.agentName}: Génération du code React pour dashboard ${config.dashboardId}`);

    const code = `
import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box } from '@mui/material';
import { io } from 'socket.io-client';

// Widgets
import ProjectStatusWidget from './widgets/ProjectStatusWidget';
import ComplianceGaugeWidget from './widgets/ComplianceGaugeWidget';
import BudgetChartWidget from './widgets/BudgetChartWidget';
import TimelineWidget from './widgets/TimelineWidget';
import TeamRosterWidget from './widgets/TeamRosterWidget';
import MaterialInventoryWidget from './widgets/MaterialInventoryWidget';
import SafetyAlertsWidget from './widgets/SafetyAlertsWidget';
import DirectiveTrackerWidget from './widgets/DirectiveTrackerWidget';
import BOMViewerWidget from './widgets/BOMViewerWidget';
import PlanViewerWidget from './widgets/PlanViewerWidget';
import ChatInterfaceWidget from './widgets/ChatInterfaceWidget';
import RealTimeMetricsWidget from './widgets/RealTimeMetricsWidget';

const Dashboard = () => {
  const [socket, setSocket] = useState(null);
  const [dashboardData, setDashboardData] = useState({});

  useEffect(() => {
    // Connexion WebSocket pour communication temps réel
    const newSocket = io('${process.env.REACT_APP_WS_URL || 'http://localhost:3001'}');
    setSocket(newSocket);

    newSocket.on('dashboard-update', (data) => {
      setDashboardData(prev => ({ ...prev, ...data }));
    });

    // Nettoyage
    return () => newSocket.close();
  }, []);

  const renderWidget = (widget) => {
    const WidgetComponents = {
      'project-status': ProjectStatusWidget,
      'compliance-gauge': ComplianceGaugeWidget,
      'budget-chart': BudgetChartWidget,
      'timeline': TimelineWidget,
      'team-roster': TeamRosterWidget,
      'material-inventory': MaterialInventoryWidget,
      'safety-alerts': SafetyAlertsWidget,
      'directive-tracker': DirectiveTrackerWidget,
      'bom-viewer': BOMViewerWidget,
      'plan-viewer': PlanViewerWidget,
      'chat-interface': ChatInterfaceWidget,
      'real-time-metrics': RealTimeMetricsWidget
    };

    const WidgetComponent = WidgetComponents[widget.type];

    return (
      <Grid
        item
        xs={12}
        md={widget.position.width}
        key={widget.widgetId}
      >
        <Paper
          elevation={3}
          sx={{
            p: 2,
            height: \`\${widget.position.height * 100}px\`,
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <Typography variant="h6" gutterBottom>
            {widget.title}
          </Typography>
          <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
            <WidgetComponent
              config={widget.config}
              dataSource={widget.dataSource}
              socket={socket}
              data={dashboardData[widget.type]}
            />
          </Box>
        </Paper>
      </Grid>
    );
  };

  return (
    <Box sx={{ flexGrow: 1, p: 3 }}>
      <Typography variant="h4" gutterBottom>
        ${config.name}
      </Typography>
      <Typography variant="subtitle1" color="textSecondary" gutterBottom>
        ${config.description}
      </Typography>
      <Grid container spacing={3} sx={{ mt: 2 }}>
        ${config.widgets.map(w => 'renderWidget(widget)').join('\n        ')}
      </Grid>
    </Box>
  );
};

export default Dashboard;
`;

    return code;
  }

  /**
   * Créer interface de chat temps réel avec agent
   */
  async createChatInterface(): Promise<string> {
    logger.info(`${this.agentName}: Création interface de chat temps réel`);

    const chatCode = `
import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  TextField,
  Button,
  Paper,
  Typography,
  List,
  ListItem,
  Avatar,
  Chip
} from '@mui/material';
import { Send as SendIcon } from '@mui/icons-material';

const ChatInterface = ({ socket }) => {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [agentTyping, setAgentTyping] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!socket) return;

    // Écouter les messages de l'agent
    socket.on('agent-message', (message) => {
      setMessages(prev => [...prev, {
        ...message,
        type: 'agent',
        timestamp: new Date()
      }]);
      setAgentTyping(false);
    });

    socket.on('agent-typing', (isTyping) => {
      setAgentTyping(isTyping);
    });

    // Message de bienvenue
    setMessages([{
      type: 'agent',
      message: 'Bonjour! Je suis votre assistant IA spécialisé en électricité québécoise. Comment puis-je vous aider aujourd\\'hui?',
      timestamp: new Date(),
      context: 'welcome'
    }]);

    return () => {
      socket.off('agent-message');
      socket.off('agent-typing');
    };
  }, [socket]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = () => {
    if (!inputMessage.trim() || !socket) return;

    const userMessage = {
      type: 'user',
      message: inputMessage,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);

    // Envoyer au serveur via WebSocket
    socket.emit('user-message', {
      message: inputMessage,
      context: 'dashboard-chat'
    });

    setInputMessage('');
    setAgentTyping(true);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <List sx={{ flexGrow: 1, overflow: 'auto', mb: 2 }}>
        {messages.map((msg, index) => (
          <ListItem
            key={index}
            sx={{
              flexDirection: msg.type === 'user' ? 'row-reverse' : 'row',
              alignItems: 'flex-start'
            }}
          >
            <Avatar
              sx={{
                bgcolor: msg.type === 'agent' ? '#1976d2' : '#4caf50',
                ml: msg.type === 'user' ? 1 : 0,
                mr: msg.type === 'agent' ? 1 : 0
              }}
            >
              {msg.type === 'agent' ? 'AI' : 'U'}
            </Avatar>
            <Paper
              elevation={1}
              sx={{
                p: 2,
                maxWidth: '70%',
                bgcolor: msg.type === 'user' ? '#e3f2fd' : '#f5f5f5'
              }}
            >
              <Typography variant="body1">{msg.message}</Typography>
              <Typography variant="caption" color="textSecondary">
                {msg.timestamp.toLocaleTimeString('fr-CA')}
              </Typography>
            </Paper>
          </ListItem>
        ))}
        {agentTyping && (
          <ListItem>
            <Avatar sx={{ bgcolor: '#1976d2', mr: 1 }}>AI</Avatar>
            <Chip label="L'agent réfléchit..." size="small" />
          </ListItem>
        )}
        <div ref={messagesEndRef} />
      </List>

      <Box sx={{ display: 'flex', gap: 1 }}>
        <TextField
          fullWidth
          multiline
          maxRows={3}
          placeholder="Posez votre question sur les normes CEQ, RBQ, RSST..."
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          onKeyPress={handleKeyPress}
          variant="outlined"
          size="small"
        />
        <Button
          variant="contained"
          endIcon={<SendIcon />}
          onClick={handleSendMessage}
          disabled={!inputMessage.trim()}
        >
          Envoyer
        </Button>
      </Box>

      <Typography variant="caption" color="textSecondary" sx={{ mt: 1 }}>
        Suggestions: "Vérifier conformité CEQ", "Calculer charge électrique", "Générer BOM"
      </Typography>
    </Box>
  );
};

export default ChatInterface;
`;

    return chatCode;
  }

  /**
   * Créer widget de visualisation de plans avec drag & drop
   */
  async createPlanViewerWidget(): Promise<string> {
    logger.info(`${this.agentName}: Création widget visualisation plans PDF`);

    const planViewerCode = `
import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Box,
  Typography,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  IconButton,
  Chip
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  Visibility as ViewIcon,
  GetApp as DownloadIcon
} from '@mui/icons-material';
import { Document, Page, pdfjs } from 'react-pdf';

// Configuration du worker PDF.js
pdfjs.GlobalWorkerOptions.workerSrc = \`//cdnjs.cloudflare.com/ajax/libs/pdf.js/\${pdfjs.version}/pdf.worker.min.js\`;

const PlanViewerWidget = ({ socket }) => {
  const [uploadedPlans, setUploadedPlans] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingStatus, setProcessingStatus] = useState('');
  const [selectedPlan, setSelectedPlan] = useState(null);

  const onDrop = useCallback(async (acceptedFiles) => {
    const file = acceptedFiles[0];
    if (!file) return;

    // Vérifier type et taille
    if (!file.type.includes('pdf') && !file.type.includes('image')) {
      alert('Format non supporté. Utilisez PDF, JPG ou PNG.');
      return;
    }

    if (file.size > 50 * 1024 * 1024) { // 50MB
      alert('Fichier trop volumineux. Maximum 50MB.');
      return;
    }

    setProcessingStatus('Téléversement en cours...');

    // Upload via FormData
    const formData = new FormData();
    formData.append('plan', file);
    formData.append('projectId', 'current-project'); // À adapter

    try {
      const response = await fetch('/api/plans/upload', {
        method: 'POST',
        body: formData,
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          setUploadProgress(percentCompleted);
        }
      });

      const result = await response.json();

      setProcessingStatus('Analyse du plan par les agents IA...');

      // Déclencher analyse par tous les agents
      socket.emit('analyze-plan', {
        planId: result.planId,
        filename: file.name
      });

      // Écouter résultats de l'analyse
      socket.on('plan-analysis-complete', (data) => {
        setUploadedPlans(prev => [...prev, {
          id: result.planId,
          name: file.name,
          uploadDate: new Date(),
          status: 'analyzed',
          bomGenerated: data.bomGenerated,
          complianceChecked: data.complianceChecked,
          materialsDetected: data.materialsDetected
        }]);

        setProcessingStatus('');
        setUploadProgress(0);
      });

    } catch (error) {
      console.error('Erreur upload:', error);
      setProcessingStatus('Erreur lors du téléversement');
    }
  }, [socket]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'image/*': ['.png', '.jpg', '.jpeg']
    },
    multiple: false
  });

  return (
    <Box>
      {/* Zone de Drag & Drop */}
      <Box
        {...getRootProps()}
        sx={{
          border: '2px dashed',
          borderColor: isDragActive ? 'primary.main' : 'grey.400',
          borderRadius: 2,
          p: 3,
          textAlign: 'center',
          cursor: 'pointer',
          bgcolor: isDragActive ? 'action.hover' : 'background.paper',
          mb: 2
        }}
      >
        <input {...getInputProps()} />
        <UploadIcon sx={{ fontSize: 48, color: 'primary.main', mb: 1 }} />
        <Typography variant="h6">
          {isDragActive ?
            'Déposez le plan ici...' :
            'Glissez-déposez un plan électrique (PDF/JPG/PNG)'
          }
        </Typography>
        <Typography variant="body2" color="textSecondary">
          ou cliquez pour sélectionner un fichier
        </Typography>
        <Typography variant="caption" color="textSecondary">
          Maximum 50MB
        </Typography>
      </Box>

      {/* Progression */}
      {uploadProgress > 0 && (
        <Box sx={{ mb: 2 }}>
          <LinearProgress variant="determinate" value={uploadProgress} />
          <Typography variant="caption" color="textSecondary">
            {processingStatus}
          </Typography>
        </Box>
      )}

      {/* Liste des plans */}
      {uploadedPlans.length > 0 && (
        <List>
          {uploadedPlans.map((plan) => (
            <ListItem
              key={plan.id}
              secondaryAction={
                <>
                  <IconButton edge="end" onClick={() => setSelectedPlan(plan)}>
                    <ViewIcon />
                  </IconButton>
                  <IconButton edge="end">
                    <DownloadIcon />
                  </IconButton>
                </>
              }
            >
              <ListItemText
                primary={plan.name}
                secondary={
                  <>
                    {plan.uploadDate.toLocaleDateString('fr-CA')}
                    <Box sx={{ mt: 0.5 }}>
                      {plan.bomGenerated && (
                        <Chip label="BOM générée" size="small" color="success" sx={{ mr: 0.5 }} />
                      )}
                      {plan.complianceChecked && (
                        <Chip label="Conforme CEQ" size="small" color="primary" sx={{ mr: 0.5 }} />
                      )}
                      <Chip
                        label={\`\${plan.materialsDetected} matériaux détectés\`}
                        size="small"
                        variant="outlined"
                      />
                    </Box>
                  </>
                }
              />
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
};

export default PlanViewerWidget;
`;

    return planViewerCode;
  }

  /**
   * Générer documentation complète du dashboard
   */
  async generateDashboardDocumentation(config: DashboardConfig): Promise<string> {
    logger.info(`${this.agentName}: Génération documentation dashboard`);

    const doc = `
# Documentation Dashboard Électrique Québécois

## Vue d'ensemble

Dashboard: ${config.name}
Description: ${config.description}
Dernière mise à jour: ${new Date().toLocaleDateString('fr-CA')}

## Architecture

### Technologies
- **Frontend**: React 18 + TypeScript
- **UI Framework**: Material-UI (MUI)
- **Graphiques**: Chart.js / D3.js
- **WebSocket**: Socket.IO pour communication temps réel
- **PDF**: React-PDF pour visualisation plans

### Structure des Widgets

${config.widgets.map(w => `
#### ${w.title} (${w.type})
- Position: (${w.position.x}, ${w.position.y})
- Dimensions: ${w.position.width}x${w.position.height}
- Source de données: ${w.dataSource}
- Rafraîchissement: ${w.config.updateFrequency || config.refreshInterval}s
- Configuration: ${JSON.stringify(w.config, null, 2)}
`).join('\n')}

## Fonctionnalités Principales

### 1. Drag & Drop de Plans
- Formats supportés: PDF, JPG, PNG
- Taille maximum: 50MB
- Analyse automatique par agents IA
- Génération BOM automatique
- Vérification conformité CEQ/RBQ

### 2. Communication Temps Réel
- Chat intégré avec agents IA
- Notifications instantanées
- Mises à jour live des métriques
- Synchronisation multi-utilisateurs

### 3. Visualisation de Données
- Graphiques interactifs
- Tableaux de bord personnalisables
- Exports PDF/Excel
- Historique et tendances

### 4. Conformité Québec
- Suivi directives CEQ/RBQ/RSST
- Alertes non-conformités
- Rapports d'audit
- Suivi certifications CSA/UL

## Configuration WebSocket

\`\`\`javascript
const socket = io('http://localhost:3001', {
  transports: ['websocket'],
  auth: {
    token: 'user-auth-token'
  }
});

// Événements disponibles
socket.on('dashboard-update', (data) => { /* ... */ });
socket.on('agent-message', (message) => { /* ... */ });
socket.on('plan-analysis-complete', (result) => { /* ... */ });
socket.on('compliance-alert', (alert) => { /* ... */ });
\`\`\`

## API Endpoints

### Plans
- \`POST /api/plans/upload\` - Téléverser plan
- \`GET /api/plans/:id\` - Récupérer plan
- \`POST /api/agents/analyze\` - Déclencher analyse

### Projets
- \`GET /api/projects/status\` - Statut projets
- \`GET /api/projects/budget\` - Données budgétaires
- \`GET /api/projects/timeline\` - Échéanciers

### Conformité
- \`GET /api/compliance/summary\` - Résumé conformité
- \`GET /api/directives/active\` - Directives actives
- \`POST /api/compliance/check\` - Vérifier conformité

### Matériel
- \`GET /api/materials/inventory\` - Inventaire
- \`GET /api/bom/current\` - BOM projet actuel
- \`POST /api/materials/track\` - Suivre matériel

## Utilisation

### Démarrage
\`\`\`bash
npm install
npm start
\`\`\`

### Variables d'environnement
\`\`\`
REACT_APP_API_URL=http://localhost:3000
REACT_APP_WS_URL=http://localhost:3001
REACT_APP_LANGUAGE=fr
\`\`\`

### Personnalisation
Modifier \`dashboardConfig.json\` pour ajuster:
- Layout et positionnement widgets
- Couleurs et thème
- Fréquence de rafraîchissement
- Préférences utilisateur

## Support

Pour questions techniques ou suggestions:
- Email: support@electrical-agents-quebec.ca
- Documentation: https://docs.electrical-agents-quebec.ca
`;

    return doc;
  }

  // Méthodes utilitaires privées
  private generateDashboardId(): string {
    return `DASH-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  private generateWidgetId(): string {
    return `WGT-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }
}
