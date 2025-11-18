/**
 * Processus Principal Electron
 * Agents Électriques Québécois - Application Desktop
 */

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const isDev = require('electron-is-dev');

let mainWindow;
let backendProcess;

// Configuration
const BACKEND_PORT = 3000;
const WS_PORT = 3001;

/**
 * Créer la fenêtre principale
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    title: 'Agents Électriques Québécois',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/preload.js')
    },
    backgroundColor: '#1e1e1e',
    show: false // Ne pas afficher tant que le contenu n'est pas chargé
  });

  // Charger l'interface
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Afficher quand prêt
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    if (isDev) {
      mainWindow.webContents.openDevTools();
    }
  });

  // Menu de l'application
  createMenu();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Créer le menu de l'application
 */
function createMenu() {
  const template = [
    {
      label: 'Fichier',
      submenu: [
        {
          label: 'Ouvrir Plan PDF...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            openPlanDialog();
          }
        },
        { type: 'separator' },
        {
          label: 'Nouveau Projet',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow.webContents.send('new-project');
          }
        },
        { type: 'separator' },
        {
          label: 'Quitter',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Refaire' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Actualiser' },
        { role: 'forceReload', label: 'Forcer l\'actualisation' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom réel' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' }
      ]
    },
    {
      label: 'Agents',
      submenu: [
        {
          label: 'Initialiser Base de Connaissances',
          click: () => {
            mainWindow.webContents.send('init-knowledge-base');
          }
        },
        {
          label: 'Statut Backend',
          click: () => {
            mainWindow.webContents.send('check-backend-status');
          }
        }
      ]
    },
    {
      label: 'Aide',
      submenu: [
        {
          label: 'Documentation CEQ',
          click: () => {
            require('electron').shell.openExternal('https://www.rbq.gouv.qc.ca/');
          }
        },
        {
          label: 'Normes RSST',
          click: () => {
            require('electron').shell.openExternal('https://www.legisquebec.gouv.qc.ca/');
          }
        },
        { type: 'separator' },
        {
          label: 'À propos',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'À propos',
              message: 'Agents Électriques Québécois',
              detail: `Version: 0.1.0\n\nSystème d'agents IA pour l'industrie électrique québécoise\n\nConforme aux normes CEQ, RBQ, RSST, CSA`,
              buttons: ['OK']
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * Ouvrir dialogue de sélection de plan PDF
 */
async function openPlanDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Ouvrir Plan Électrique',
    filters: [
      { name: 'Plans', extensions: ['pdf', 'png', 'jpg', 'jpeg'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }
    ],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    mainWindow.webContents.send('plan-selected', filePath);
  }
}

/**
 * Démarrer le backend Node.js
 */
function startBackend() {
  console.log('Démarrage du backend...');

  const serverPath = path.join(__dirname, '../../src/server.ts');

  // Démarrer avec tsx pour support TypeScript
  backendProcess = spawn('npx', ['tsx', serverPath], {
    cwd: path.join(__dirname, '../..'),
    env: {
      ...process.env,
      PORT: BACKEND_PORT.toString(),
      WS_PORT: WS_PORT.toString(),
      NODE_ENV: isDev ? 'development' : 'production'
    }
  });

  backendProcess.stdout.on('data', (data) => {
    console.log(`[Backend] ${data.toString().trim()}`);
  });

  backendProcess.stderr.on('data', (data) => {
    console.error(`[Backend Error] ${data.toString().trim()}`);
  });

  backendProcess.on('close', (code) => {
    console.log(`Backend terminé avec code ${code}`);
  });

  backendProcess.on('error', (error) => {
    console.error('Erreur démarrage backend:', error);
    dialog.showErrorBox(
      'Erreur Backend',
      `Impossible de démarrer le serveur backend:\n${error.message}`
    );
  });
}

/**
 * Arrêter le backend
 */
function stopBackend() {
  if (backendProcess) {
    console.log('Arrêt du backend...');
    backendProcess.kill();
    backendProcess = null;
  }
}

// ============================================================================
// IPC Handlers
// ============================================================================

// Sélectionner fichier
ipcMain.handle('select-file', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

// Sauvegarder fichier
ipcMain.handle('save-file', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

// Obtenir info système
ipcMain.handle('get-system-info', () => {
  return {
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    backendPort: BACKEND_PORT,
    wsPort: WS_PORT
  };
});

// Ouvrir URL externe
ipcMain.on('open-external', (event, url) => {
  require('electron').shell.openExternal(url);
});

// ============================================================================
// Événements de l'application
// ============================================================================

app.whenReady().then(() => {
  // Démarrer le backend
  startBackend();

  // Attendre un peu que le backend démarre
  setTimeout(() => {
    createWindow();
  }, 2000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('will-quit', () => {
  stopBackend();
});

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  dialog.showErrorBox('Erreur Critique', error.message);
});
