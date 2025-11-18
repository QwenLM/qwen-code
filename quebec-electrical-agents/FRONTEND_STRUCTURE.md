# Structure du Frontend - Dashboard Électrique Québécois

## Répertoire principal
```
frontend/
├── public/
│   ├── index.html
│   └── favicon.ico
├── src/
│   ├── components/
│   │   ├── Dashboard/
│   │   │   ├── DashboardLayout.js
│   │   │   ├── Sidebar.js
│   │   │   ├── Header.js
│   │   │   └── MainContent.js
│   │   ├── PlanViewer/
│   │   │   ├── PlanDropZone.js
│   │   │   ├── PlanCanvas.js
│   │   │   ├── PlanAnnotations.js
│   │   │   └── PlanControls.js
│   │   ├── BOM/
│   │   │   ├── BOMTable.js
│   │   │   ├── BOMFilters.js
│   │   │   └── BOMExport.js
│   │   ├── AgentChat/
│   │   │   ├── AgentChatWindow.js
│   │   │   ├── MessageList.js
│   │   │   └── MessageInput.js
│   │   ├── Projects/
│   │   │   ├── ProjectList.js
│   │   │   ├── ProjectCard.js
│   │   │   └── ProjectForm.js
│   │   └── Common/
│   │       ├── LoadingSpinner.js
│   │       ├── ErrorBoundary.js
│   │       ├── ProgressBar.js
│   │       └── NotificationToast.js
│   ├── pages/
│   │   ├── DashboardPage.js
│   │   ├── ProjectPage.js
│   │   ├── PlanAnalysisPage.js
│   │   └── LoginPage.js
│   ├── services/
│   │   ├── api.js
│   │   ├── auth.js
│   │   ├── socket.js
│   │   └── faissService.js
│   ├── hooks/
│   │   └── useDragDrop.js
│   ├── utils/
│   │   ├── quebecStandards.js
│   │   ├── pdfUtils.js
│   │   └── fileUtils.js
│   ├── context/
│   │   ├── AuthContext.js
│   │   └── ProjectContext.js
│   ├── styles/
│   │   ├── global.css
│   │   └── components/
│   │       ├── dashboard.css
│   │       ├── plan-viewer.css
│   │       └── agent-chat.css
│   ├── App.js
│   └── index.js
├── package.json
└── webpack.config.js
```

## Fichiers principaux détaillés

### 1. PlanDropZone.js - Composant de zone de drop pour les plans
```jsx
// src/components/PlanViewer/PlanDropZone.js
import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Box, Typography, Paper, Alert } from '@mui/material';
import { CloudUpload as UploadIcon } from '@mui/icons-material';
import { api } from '../../services/api';

const PlanDropZone = ({ projectId, onPlanUploaded, onProgress }) => {
  const onDrop = useCallback(async (acceptedFiles) => {
    const file = acceptedFiles[0];
    if (!file) return;

    try {
      onProgress({ status: 'uploading', message: 'Téléchargement du plan en cours...' });

      const formData = new FormData();
      formData.append('plan', file);
      formData.append('projectId', projectId);

      const response = await api.post('/plans/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (progressEvent) => {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress({ 
            status: 'uploading', 
            message: `Téléchargement: ${progress}%`, 
            progress 
          });
        }
      });

      onProgress({ 
        status: 'processing', 
        message: 'Analyse du plan en cours par les agents...', 
        progress: 0 
      });

      await api.post('/agents/analyze', { planId: response.data.planId });

      onPlanUploaded(response.data.planId);

    } catch (error) {
      console.error('Erreur de téléchargement:', error);
      onProgress({ 
        status: 'error', 
        message: error.response?.data?.error || 'Erreur de téléchargement du plan' 
      });
    }
  }, [projectId, onPlanUploaded, onProgress]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/png': ['.png'],
      'image/gif': ['.gif']
    },
    maxFiles: 1,
    maxSize: 50 * 1024 * 1024
  });

  return (
    <Paper 
      elevation={3} 
      {...getRootProps()} 
      sx={{
        p: 4,
        textAlign: 'center',
        cursor: 'pointer',
        border: '2px dashed #ccc',
        '&:hover': {
          borderColor: '#1976d2',
          backgroundColor: '#f0f8ff'
        },
        ...(isDragActive && {
          borderColor: '#1976d2',
          backgroundColor: '#e3f2fd'
        })
      }}
    >
      <input {...getInputProps()} />
      <UploadIcon sx={{ fontSize: 60, color: '#1976d2', mb: 2 }} />
      <Typography variant="h6" gutterBottom>
        {isDragActive 
          ? "Déposez le plan ici..." 
          : "Glissez-déposez un plan électrique ici, ou cliquez pour sélectionner"}
      </Typography>
      <Typography variant="body2" color="textSecondary">
        Formats acceptés: PDF, JPG, PNG (Max 50MB)
      </Typography>
      <Typography variant="caption" color="textSecondary" sx={{ mt: 1, display: 'block' }}>
        Le système analysera automatiquement le plan et générera la liste de matériel selon les normes québécoises (CEQ, RSST, RBQ)
      </Typography>
    </Paper>
  );
};

export default PlanDropZone;
```