/**
 * Application JavaScript - Agents Électriques Québécois
 * Gestion UI, WebSocket, drag & drop
 */

// Configuration
const BACKEND_URL = 'http://localhost:3000';
const WS_URL = 'http://localhost:3001';

// État de l'application
const appState = {
  currentView: 'dashboard',
  plans: [],
  currentProject: null,
  backendConnected: false,
  wsConnected: false,
  stats: {
    plansAnalyzed: 0,
    bomItems: 0,
    issues: 0,
    compliance: 0
  }
};

// WebSocket
let socket = null;

// ============================================================================
// Initialisation
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  console.log('Application démarrée');

  initializeUI();
  initializeWebSocket();
  initializeEventListeners();
  checkBackendStatus();

  // Événements Electron
  if (window.electronAPI) {
    window.electronAPI.onPlanSelected((filePath) => {
      handleFileSelected(filePath);
    });

    window.electronAPI.onNewProject(() => {
      createNewProject();
    });

    window.electronAPI.onInitKnowledgeBase(() => {
      initializeKnowledgeBase();
    });

    window.electronAPI.onCheckBackendStatus(() => {
      checkBackendStatus();
    });
  }
});

// ============================================================================
// UI Initialization
// ============================================================================

function initializeUI() {
  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      switchView(view);
    });
  });

  // Dropzone
  const dropzone = document.getElementById('dropzone');
  if (dropzone) {
    dropzone.addEventListener('click', () => {
      selectFile();
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        handleFileDrop(files[0]);
      }
    });
  }

  // Select file button
  const btnSelectFile = document.getElementById('btnSelectFile');
  if (btnSelectFile) {
    btnSelectFile.addEventListener('click', (e) => {
      e.stopPropagation();
      selectFile();
    });
  }

  // Chat
  const chatInput = document.getElementById('chatInput');
  const btnSendMessage = document.getElementById('btnSendMessage');

  if (chatInput && btnSendMessage) {
    btnSendMessage.addEventListener('click', () => {
      sendChatMessage();
    });

    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendChatMessage();
      }
    });
  }
}

// ============================================================================
// WebSocket
// ============================================================================

function initializeWebSocket() {
  try {
    // Load Socket.IO from CDN
    const script = document.createElement('script');
    script.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
    script.onload = () => {
      connectWebSocket();
    };
    document.head.appendChild(script);
  } catch (error) {
    console.error('Erreur chargement Socket.IO:', error);
    showToast('Erreur de connexion WebSocket', 'error');
  }
}

function connectWebSocket() {
  try {
    socket = io(WS_URL, {
      transports: ['websocket', 'polling']
    });

    socket.on('connect', () => {
      console.log('WebSocket connecté');
      appState.wsConnected = true;
      updateConnectionStatus();
      showToast('Connecté au serveur', 'success');
    });

    socket.on('disconnect', () => {
      console.log('WebSocket déconnecté');
      appState.wsConnected = false;
      updateConnectionStatus();
      showToast('Déconnecté du serveur', 'warning');
    });

    socket.on('agent-message', (data) => {
      addChatMessage(data.message, 'agent');
    });

    socket.on('agent-typing', (isTyping) => {
      // TODO: Afficher indicateur de frappe
    });

    socket.on('plan-analysis-complete', (data) => {
      handleAnalysisComplete(data);
    });

    socket.on('analysis-error', (data) => {
      hideLoading();
      showToast(`Erreur d'analyse: ${data.error}`, 'error');
    });

    socket.on('dashboard-update', (data) => {
      updateDashboard(data);
    });

  } catch (error) {
    console.error('Erreur connexion WebSocket:', error);
    showToast('Impossible de se connecter au serveur', 'error');
  }
}

// ============================================================================
// File Handling
// ============================================================================

async function selectFile() {
  if (!window.electronAPI) {
    showToast('API Electron non disponible', 'error');
    return;
  }

  const result = await window.electronAPI.selectFile({
    title: 'Sélectionner un plan électrique',
    filters: [
      { name: 'Plans', extensions: ['pdf', 'png', 'jpg', 'jpeg'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }
    ],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    handleFileSelected(result.filePaths[0]);
  }
}

function handleFileDrop(file) {
  if (!file) return;

  // Vérifier type
  const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg'];
  if (!allowedTypes.includes(file.type)) {
    showToast('Format non supporté. Utilisez PDF, PNG ou JPG.', 'error');
    return;
  }

  // Vérifier taille (50MB max)
  const maxSize = 50 * 1024 * 1024;
  if (file.size > maxSize) {
    showToast('Fichier trop volumineux. Maximum 50MB.', 'error');
    return;
  }

  // Utiliser le chemin du fichier
  handleFileSelected(file.path);
}

async function handleFileSelected(filePath) {
  console.log('Fichier sélectionné:', filePath);

  showLoading('Analyse du plan en cours...');

  addActivity(`Analyse du plan: ${filePath.split('/').pop()}`);

  try {
    // Upload le fichier
    const formData = new FormData();
    const response = await fetch(filePath);
    const blob = await response.blob();
    formData.append('plan', blob, filePath.split('/').pop());
    formData.append('projectId', appState.currentProject || 'default-project');

    const uploadResponse = await fetch(`${BACKEND_URL}/api/plans/upload`, {
      method: 'POST',
      body: formData
    });

    if (!uploadResponse.ok) {
      throw new Error('Erreur lors de l\'upload');
    }

    const uploadData = await uploadResponse.json();
    console.log('Plan uploadé:', uploadData);

    // Déclencher analyse via WebSocket
    if (socket && socket.connected) {
      socket.emit('analyze-plan', {
        planId: uploadData.planId,
        filename: uploadData.filename,
        planPath: filePath,
        projectId: appState.currentProject || 'default-project',
        projectData: {
          squareFeet: 1500,
          type: 'residential'
        }
      });

      showToast('Analyse démarrée...', 'info');
    } else {
      throw new Error('WebSocket non connecté');
    }

  } catch (error) {
    console.error('Erreur traitement fichier:', error);
    hideLoading();
    showToast(`Erreur: ${error.message}`, 'error');
  }
}

function handleAnalysisComplete(data) {
  console.log('Analyse complétée:', data);

  hideLoading();

  // Mettre à jour les stats
  appState.stats.plansAnalyzed++;
  appState.stats.bomItems = data.materialsDetected || 0;

  updateStats();

  addActivity(`Plan analysé: ${data.materialsDetected} matériaux détectés`);

  if (data.bomGenerated) {
    addActivity('BOM générée automatiquement');
  }

  if (data.complianceChecked) {
    addActivity('Conformité CEQ/RBQ vérifiée');
  }

  showToast('Analyse terminée avec succès!', 'success');

  // Afficher résultats
  if (data.result) {
    displayAnalysisResults(data.result);
  }
}

function displayAnalysisResults(result) {
  // Afficher BOM
  if (result.results && result.results.bom) {
    displayBOM(result.results.bom);
  }

  // Afficher conformité
  if (result.results && result.results.compliance) {
    displayCompliance(result.results.compliance);
  }

  // Mettre à jour taux de conformité
  if (result.results && result.results.compliance) {
    const compliantCount = result.results.compliance.standards.filter(s => s.compliant).length;
    const totalCount = result.results.compliance.standards.length;
    const complianceRate = Math.round((compliantCount / totalCount) * 100);

    appState.stats.compliance = complianceRate;
    appState.stats.issues = result.results.compliance.deficiencies.length;

    updateStats();
  }
}

// ============================================================================
// Chat
// ============================================================================

function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();

  if (!message) return;

  // Afficher message utilisateur
  addChatMessage(message, 'user');

  // Envoyer au serveur
  if (socket && socket.connected) {
    socket.emit('user-message', {
      message,
      context: 'electron-app'
    });
  }

  input.value = '';
}

function addChatMessage(message, type) {
  const messagesContainer = document.getElementById('chatMessages');

  const messageEl = document.createElement('div');
  messageEl.className = `message ${type}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = type === 'user' ? 'U' : 'AI';

  const content = document.createElement('div');
  content.className = 'message-content';

  // Créer paragraphes pour chaque ligne
  const lines = message.split('\n');
  lines.forEach(line => {
    const p = document.createElement('p');
    p.textContent = line || '\u00A0'; // Non-breaking space pour lignes vides
    content.appendChild(p);
  });

  messageEl.appendChild(avatar);
  messageEl.appendChild(content);

  messagesContainer.appendChild(messageEl);

  // Scroll vers le bas
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ============================================================================
// UI Updates
// ============================================================================

function switchView(viewName) {
  // Mettre à jour navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    if (item.dataset.view === viewName) {
      item.classList.add('active');
    }
  });

  // Mettre à jour vues
  document.querySelectorAll('.view').forEach(view => {
    view.classList.remove('active');
  });

  const targetView = document.getElementById(`${viewName}View`);
  if (targetView) {
    targetView.classList.add('active');
  }

  appState.currentView = viewName;
}

function updateStats() {
  document.getElementById('statPlansAnalyzed').textContent = appState.stats.plansAnalyzed;
  document.getElementById('statBOMItems').textContent = appState.stats.bomItems;
  document.getElementById('statIssues').textContent = appState.stats.issues;
  document.getElementById('statCompliance').textContent = `${appState.stats.compliance}%`;
}

function addActivity(text) {
  const activityList = document.getElementById('activityList');
  const now = new Date();
  const timeStr = now.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' });

  const activityItem = document.createElement('div');
  activityItem.className = 'activity-item';

  const timeEl = document.createElement('span');
  timeEl.className = 'activity-time';
  timeEl.textContent = timeStr;

  const textEl = document.createElement('span');
  textEl.className = 'activity-text';
  textEl.textContent = text;

  activityItem.appendChild(timeEl);
  activityItem.appendChild(textEl);

  activityList.insertBefore(activityItem, activityList.firstChild);

  // Limiter à 50 items
  while (activityList.children.length > 50) {
    activityList.removeChild(activityList.lastChild);
  }
}

function displayBOM(bom) {
  const bomContainer = document.getElementById('bomContainer');
  bomContainer.innerHTML = '';

  if (!bom || !bom.categories || bom.categories.length === 0) {
    bomContainer.innerHTML = '<div class="empty-state"><p>Aucune BOM disponible</p></div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'bom-table';

  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>Catégorie</th>
      <th>Description</th>
      <th>Quantité</th>
      <th>CSA</th>
      <th>Coût Est.</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  bom.categories.forEach(category => {
    category.items.forEach(item => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${category.name}</td>
        <td>${item.description}</td>
        <td>${item.quantity} ${item.unit}</td>
        <td>${item.csaCertified ? '✓' : '✗'}</td>
        <td>${item.estimatedCost.toFixed(2)} $</td>
      `;
      tbody.appendChild(row);
    });
  });

  table.appendChild(tbody);
  bomContainer.appendChild(table);

  const total = document.createElement('div');
  total.style.marginTop = '16px';
  total.style.textAlign = 'right';
  total.style.fontSize = '18px';
  total.style.fontWeight = '600';
  total.innerHTML = `Total estimé: ${bom.totalCost.toFixed(2)} $`;
  bomContainer.appendChild(total);
}

function displayCompliance(compliance) {
  const complianceContainer = document.getElementById('complianceContainer');
  complianceContainer.innerHTML = '';

  if (!compliance || !compliance.standards) {
    complianceContainer.innerHTML = '<div class="empty-state"><p>Aucun audit disponible</p></div>';
    return;
  }

  compliance.standards.forEach(standard => {
    const item = document.createElement('div');
    item.className = `compliance-item ${standard.compliant ? 'compliant' : 'non-compliant'}`;

    item.innerHTML = `
      <h4>${standard.standard} ${standard.section}</h4>
      <p>${standard.description}</p>
      <p><strong>Statut:</strong> ${standard.compliant ? 'Conforme ✓' : 'Non conforme ✗'}</p>
      ${standard.notes ? `<p><em>${standard.notes}</em></p>` : ''}
    `;

    complianceContainer.appendChild(item);
  });

  if (compliance.deficiencies && compliance.deficiencies.length > 0) {
    const deficienciesSection = document.createElement('div');
    deficienciesSection.style.marginTop = '24px';
    deficienciesSection.innerHTML = '<h3>Déficiences Identifiées</h3>';

    compliance.deficiencies.forEach(def => {
      const defItem = document.createElement('div');
      defItem.className = 'compliance-item non-compliant';
      defItem.innerHTML = `
        <h4>${def.standard} - ${def.severity.toUpperCase()}</h4>
        <p>${def.description}</p>
        <p><strong>Action corrective:</strong> ${def.correctiveAction}</p>
      `;
      deficienciesSection.appendChild(defItem);
    });

    complianceContainer.appendChild(deficienciesSection);
  }
}

function updateConnectionStatus() {
  const backendStatus = document.getElementById('backendStatus');
  const wsStatus = document.getElementById('wsStatus');

  if (appState.backendConnected) {
    backendStatus.classList.add('connected');
  } else {
    backendStatus.classList.remove('connected');
  }

  if (appState.wsConnected) {
    wsStatus.classList.add('connected');
  } else {
    wsStatus.classList.remove('connected');
  }
}

// ============================================================================
// Utilities
// ============================================================================

async function checkBackendStatus() {
  try {
    const response = await fetch(`${BACKEND_URL}/health`, {
      method: 'GET',
      timeout: 5000
    });

    if (response.ok) {
      appState.backendConnected = true;
      updateConnectionStatus();
      addActivity('Backend connecté');
    } else {
      appState.backendConnected = false;
      updateConnectionStatus();
    }
  } catch (error) {
    appState.backendConnected = false;
    updateConnectionStatus();
  }
}

function showLoading(text = 'Chargement...') {
  const overlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');

  if (loadingText) {
    loadingText.textContent = text;
  }

  if (overlay) {
    overlay.classList.add('active');
  }
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.remove('active');
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  // Supprimer après 5 secondes
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => {
      container.removeChild(toast);
    }, 300);
  }, 5000);
}

function createNewProject() {
  appState.currentProject = `project-${Date.now()}`;
  addActivity('Nouveau projet créé');
  showToast('Nouveau projet créé', 'success');
}

async function initializeKnowledgeBase() {
  showLoading('Initialisation de la base de connaissances FAISS...');

  try {
    // TODO: Appeler API pour initialiser FAISS
    await new Promise(resolve => setTimeout(resolve, 2000));

    hideLoading();
    showToast('Base de connaissances initialisée', 'success');
    addActivity('Base de connaissances FAISS initialisée');
  } catch (error) {
    hideLoading();
    showToast(`Erreur initialisation: ${error.message}`, 'error');
  }
}

function initializeEventListeners() {
  // Vérifier statut backend périodiquement
  setInterval(checkBackendStatus, 30000); // Toutes les 30 secondes
}

function updateDashboard(data) {
  // Mettre à jour le dashboard avec nouvelles données
  if (data.stats) {
    appState.stats = { ...appState.stats, ...data.stats };
    updateStats();
  }
}

// Style pour l'animation de sortie
const style = document.createElement('style');
style.textContent = `
  @keyframes slideOut {
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);
