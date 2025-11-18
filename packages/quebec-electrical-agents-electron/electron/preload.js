/**
 * Quebec Electrical Agents - Electron Preload Script
 *
 * Provides secure bridge between main and renderer processes
 * via contextBridge API.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Qwen Code CLI
  qwenInit: () => ipcRenderer.invoke('qwen-init'),
  qwenSend: (message) => ipcRenderer.invoke('qwen-send', message),
  qwenStop: () => ipcRenderer.invoke('qwen-stop'),

  onQwenOutput: (callback) => {
    ipcRenderer.on('qwen-output', (event, data) => callback(data));
  },

  onQwenError: (callback) => {
    ipcRenderer.on('qwen-error', (event, data) => callback(data));
  },

  onQwenStopped: (callback) => {
    ipcRenderer.on('qwen-stopped', (event, code) => callback(code));
  },

  // File operations
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  selectFiles: (options) => ipcRenderer.invoke('select-files', options),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),

  // Photo GPS
  extractPhotoGPS: (photoPath) => ipcRenderer.invoke('extract-photo-gps', photoPath),

  // App info
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Storage
  storeGet: (key) => ipcRenderer.invoke('store-get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store-set', key, value),
  storeClear: () => ipcRenderer.invoke('store-clear')
});

console.log('✅ Preload script loaded');
