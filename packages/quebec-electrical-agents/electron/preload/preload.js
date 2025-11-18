/**
 * Preload Script - Pont sécurisé entre Main et Renderer
 * Expose des APIs sécurisées au renderer process
 */

const { contextBridge, ipcRenderer } = require('electron');

// Exposer APIs sécurisées au renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Système
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // Fichiers
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  saveFile: (options) => ipcRenderer.invoke('save-file', options),

  // Navigation
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Événements from main
  onPlanSelected: (callback) => {
    ipcRenderer.on('plan-selected', (event, filePath) => callback(filePath));
  },
  onNewProject: (callback) => {
    ipcRenderer.on('new-project', () => callback());
  },
  onInitKnowledgeBase: (callback) => {
    ipcRenderer.on('init-knowledge-base', () => callback());
  },
  onCheckBackendStatus: (callback) => {
    ipcRenderer.on('check-backend-status', () => callback());
  },

  // Nettoyer listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});

// Logger pour debug
console.log('Preload script chargé');
