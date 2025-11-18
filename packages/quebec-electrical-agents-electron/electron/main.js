/**
 * Quebec Electrical Agents - Electron Main Process
 *
 * This main process:
 * 1. Spawns Qwen Code CLI as a child process
 * 2. Manages IPC communication with renderer
 * 3. Handles file operations (photos, plans)
 * 4. Provides EXIF GPS extraction
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const Store = require('electron-store');
const exifParser = require('exif-parser');

// Application state
const store = new Store();
let mainWindow = null;
let qwenProcess = null;
let qwenResponseBuffer = '';

// Configuration
const QWEN_CLI_COMMAND = 'qwen'; // Assumes qwen is globally installed
const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * Create the main application window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    show: false
  });

  // Load the app
  mainWindow.loadFile(path.join(__dirname, '../src/index.html'));

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDevelopment) {
      mainWindow.webContents.openDevTools();
    }
  });

  // Handle window close
  mainWindow.on('closed', () => {
    mainWindow = null;
    stopQwenProcess();
  });

  console.log('✅ Main window created');
}

/**
 * Start Qwen Code CLI process
 */
function startQwenProcess() {
  return new Promise((resolve, reject) => {
    try {
      console.log('🚀 Starting Qwen Code CLI...');

      // Spawn Qwen Code process
      qwenProcess = spawn(QWEN_CLI_COMMAND, ['--yolo'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: {
          ...process.env,
          FORCE_COLOR: '0', // Disable ANSI colors
          NODE_ENV: 'production'
        }
      });

      // Handle stdout (Qwen responses)
      qwenProcess.stdout.on('data', (data) => {
        const text = data.toString();
        qwenResponseBuffer += text;

        // Send incremental updates to renderer
        if (mainWindow) {
          mainWindow.webContents.send('qwen-output', text);
        }

        console.log('📥 Qwen output:', text.substring(0, 100));
      });

      // Handle stderr (Qwen errors/logs)
      qwenProcess.stderr.on('data', (data) => {
        const error = data.toString();
        console.error('❌ Qwen error:', error);

        if (mainWindow) {
          mainWindow.webContents.send('qwen-error', error);
        }
      });

      // Handle process exit
      qwenProcess.on('exit', (code) => {
        console.log(`🛑 Qwen process exited with code ${code}`);
        qwenProcess = null;

        if (mainWindow) {
          mainWindow.webContents.send('qwen-stopped', code);
        }
      });

      // Handle process errors
      qwenProcess.on('error', (error) => {
        console.error('💥 Failed to start Qwen:', error);
        reject(error);
      });

      // Wait a bit for process to initialize
      setTimeout(() => {
        if (qwenProcess && !qwenProcess.killed) {
          console.log('✅ Qwen Code CLI started successfully');
          resolve();
        } else {
          reject(new Error('Qwen process failed to start'));
        }
      }, 1000);

    } catch (error) {
      console.error('💥 Error starting Qwen:', error);
      reject(error);
    }
  });
}

/**
 * Stop Qwen Code CLI process
 */
function stopQwenProcess() {
  if (qwenProcess && !qwenProcess.killed) {
    console.log('🛑 Stopping Qwen Code CLI...');
    qwenProcess.kill('SIGTERM');
    qwenProcess = null;
  }
}

/**
 * Send message to Qwen Code CLI
 */
function sendToQwen(message) {
  return new Promise((resolve, reject) => {
    if (!qwenProcess || qwenProcess.killed) {
      reject(new Error('Qwen process not running'));
      return;
    }

    try {
      // Clear buffer for new response
      qwenResponseBuffer = '';

      // Send message to Qwen's stdin
      qwenProcess.stdin.write(message + '\n');

      console.log('📤 Sent to Qwen:', message.substring(0, 100));

      // Set timeout for response
      const timeout = setTimeout(() => {
        resolve(qwenResponseBuffer);
      }, 30000); // 30 second timeout

      // Clear timeout on response
      const checkResponse = setInterval(() => {
        if (qwenResponseBuffer.length > 10) {
          clearInterval(checkResponse);
          clearTimeout(timeout);
          resolve(qwenResponseBuffer);
        }
      }, 500);

    } catch (error) {
      console.error('💥 Error sending to Qwen:', error);
      reject(error);
    }
  });
}

/**
 * Extract EXIF GPS data from photo
 */
async function extractPhotoGPS(photoPath) {
  try {
    const buffer = await fs.readFile(photoPath);
    const parser = exifParser.create(buffer);
    const result = parser.parse();

    if (!result.tags || !result.tags.GPSLatitude) {
      return null;
    }

    return {
      latitude: result.tags.GPSLatitude,
      longitude: result.tags.GPSLongitude,
      altitude: result.tags.GPSAltitude || null,
      timestamp: result.tags.GPSDateStamp || result.tags.DateTime || null,
      make: result.tags.Make || null,
      model: result.tags.Model || null
    };
  } catch (error) {
    console.error('Error extracting GPS:', error);
    return null;
  }
}

// ============================================================================
// IPC Handlers
// ============================================================================

/**
 * Initialize Qwen Code CLI
 */
ipcMain.handle('qwen-init', async () => {
  try {
    await startQwenProcess();
    return { success: true };
  } catch (error) {
    console.error('Failed to initialize Qwen:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Send message to Qwen
 */
ipcMain.handle('qwen-send', async (event, message) => {
  try {
    const response = await sendToQwen(message);
    return { success: true, response };
  } catch (error) {
    console.error('Failed to send to Qwen:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Stop Qwen process
 */
ipcMain.handle('qwen-stop', async () => {
  stopQwenProcess();
  return { success: true };
});

/**
 * Select file dialog
 */
ipcMain.handle('select-file', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});

/**
 * Select multiple files dialog
 */
ipcMain.handle('select-files', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    ...options,
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) {
    return [];
  }
  return result.filePaths;
});

/**
 * Read file
 */
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const data = await fs.readFile(filePath);
    return {
      success: true,
      data: data.toString('base64'),
      path: filePath,
      name: path.basename(filePath)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Extract photo GPS data
 */
ipcMain.handle('extract-photo-gps', async (event, photoPath) => {
  try {
    const gps = await extractPhotoGPS(photoPath);
    return { success: true, gps, path: photoPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Get app version
 */
ipcMain.handle('get-version', () => {
  return app.getVersion();
});

/**
 * Get stored data
 */
ipcMain.handle('store-get', (event, key) => {
  return store.get(key);
});

/**
 * Set stored data
 */
ipcMain.handle('store-set', (event, key, value) => {
  store.set(key, value);
  return true;
});

/**
 * Clear stored data
 */
ipcMain.handle('store-clear', () => {
  store.clear();
  return true;
});

// ============================================================================
// App Lifecycle
// ============================================================================

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopQwenProcess();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopQwenProcess();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

console.log('🚀 Quebec Electrical Agents - Electron Main Process Started');
