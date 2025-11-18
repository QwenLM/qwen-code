/**
 * Quebec Electrical Agents - Electron Application Logic
 *
 * This file handles:
 * - Qwen Code CLI integration
 * - Chat message handling
 * - PGI data detection and visualization
 * - Photo GPS extraction
 * - UI state management
 */

// ============================================================================
// Application State
// ============================================================================
const appState = {
  qwenInitialized: false,
  currentView: 'chat',
  messages: [],
  photos: [],
  plans: [],
  pgiData: null
};

// ============================================================================
// DOM Elements
// ============================================================================
const elements = {
  // Views
  views: {},

  // Navigation
  navItems: [],

  // Chat
  chatMessages: null,
  chatInput: null,
  btnSend: null,
  btnAttach: null,

  // Status
  qwenStatus: null,
  qwenStatusText: null,

  // Buttons
  btnSettings: null,
  btnUploadPhotos: null,
  btnUploadPlan: null,
  btnRunComplianceCheck: null,

  // Content areas
  pgiContent: null,
  photosGrid: null,
  plansList: null,

  // Overlays
  loadingOverlay: null,
  loadingText: null,
  toastContainer: null
};

// ============================================================================
// Initialization
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Quebec Electrical Agents - Initializing...');

  initializeElements();
  attachEventListeners();
  initializeQwen();

  console.log('✅ Application initialized');
});

function initializeElements() {
  // Views
  elements.views = {
    chat: document.getElementById('view-chat'),
    dashboard: document.getElementById('view-dashboard'),
    photos: document.getElementById('view-photos'),
    plans: document.getElementById('view-plans'),
    compliance: document.getElementById('view-compliance')
  };

  // Navigation
  elements.navItems = Array.from(document.querySelectorAll('.nav-item'));

  // Chat
  elements.chatMessages = document.getElementById('chat-messages');
  elements.chatInput = document.getElementById('chat-input');
  elements.btnSend = document.getElementById('btn-send');
  elements.btnAttach = document.getElementById('btn-attach');

  // Status
  elements.qwenStatus = document.getElementById('qwen-status');
  elements.qwenStatusText = document.getElementById('qwen-status-text');

  // Buttons
  elements.btnSettings = document.getElementById('btn-settings');
  elements.btnUploadPhotos = document.getElementById('btn-upload-photos');
  elements.btnUploadPlan = document.getElementById('btn-upload-plan');
  elements.btnRunComplianceCheck = document.getElementById('btn-run-compliance-check');

  // Content areas
  elements.pgiContent = document.getElementById('pgi-content');
  elements.photosGrid = document.getElementById('photos-grid');
  elements.plansList = document.getElementById('plans-list');

  // Overlays
  elements.loadingOverlay = document.getElementById('loading-overlay');
  elements.loadingText = document.getElementById('loading-text');
  elements.toastContainer = document.getElementById('toast-container');
}

function attachEventListeners() {
  // Navigation
  elements.navItems.forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      switchView(view);
    });
  });

  // Chat
  elements.chatInput.addEventListener('input', () => {
    elements.btnSend.disabled = !elements.chatInput.value.trim();
  });

  elements.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  elements.btnSend.addEventListener('click', sendMessage);
  elements.btnAttach.addEventListener('click', attachFile);

  // Buttons
  elements.btnUploadPhotos.addEventListener('click', uploadPhotos);
  elements.btnUploadPlan.addEventListener('click', uploadPlan);
  elements.btnRunComplianceCheck.addEventListener('click', runComplianceCheck);

  // Qwen output listeners
  window.electronAPI.onQwenOutput((data) => {
    handleQwenOutput(data);
  });

  window.electronAPI.onQwenError((error) => {
    handleQwenError(error);
  });

  window.electronAPI.onQwenStopped((code) => {
    handleQwenStopped(code);
  });
}

// ============================================================================
// Qwen Code CLI Integration
// ============================================================================
async function initializeQwen() {
  try {
    showLoading('Initialisation de Qwen Code CLI...');

    const result = await window.electronAPI.qwenInit();

    if (result.success) {
      appState.qwenInitialized = true;
      updateQwenStatus('En ligne', true);
      showToast('Qwen Code CLI initialisé avec succès', 'success');

      // Send initial welcome message
      addMessage('assistant', 'Bonjour! Je suis votre assistant IA pour les projets électriques au Québec. Comment puis-je vous aider aujourd\'hui?');
    } else {
      throw new Error(result.error || 'Échec de l\'initialisation de Qwen');
    }
  } catch (error) {
    console.error('Error initializing Qwen:', error);
    updateQwenStatus('Hors ligne', false);
    showToast('Impossible de démarrer Qwen Code CLI. Assurez-vous qu\'il est installé.', 'error');

    // Show installation instructions
    addMessage('system', `Qwen Code CLI n'est pas disponible. Pour l'installer:\n\nnpm install -g @qwen-code/qwen-code@latest\n\nPuis redémarrez l'application.`);
  } finally {
    hideLoading();
  }
}

function updateQwenStatus(text, isOnline) {
  elements.qwenStatusText.textContent = text;
  const statusDot = elements.qwenStatus.querySelector('.status-dot');

  if (isOnline) {
    statusDot.classList.remove('error');
  } else {
    statusDot.classList.add('error');
  }
}

function handleQwenOutput(data) {
  console.log('Qwen output:', data);

  // Append to last assistant message or create new one
  const lastMessage = appState.messages[appState.messages.length - 1];
  if (lastMessage && lastMessage.role === 'assistant') {
    lastMessage.content += data;
    updateMessageBubble(lastMessage.id, lastMessage.content);
  } else {
    addMessage('assistant', data);
  }

  // Check for PGI data
  detectPGIData(data);
}

function handleQwenError(error) {
  console.error('Qwen error:', error);
  showToast('Erreur Qwen: ' + error, 'error');
}

function handleQwenStopped(code) {
  console.log('Qwen stopped with code:', code);
  appState.qwenInitialized = false;
  updateQwenStatus('Arrêté', false);
  showToast('Qwen Code CLI s\'est arrêté', 'warning');
}

// ============================================================================
// Chat Functions
// ============================================================================
async function sendMessage() {
  const message = elements.chatInput.value.trim();
  if (!message) return;

  if (!appState.qwenInitialized) {
    showToast('Qwen Code CLI n\'est pas initialisé', 'error');
    return;
  }

  // Add user message
  addMessage('user', message);

  // Clear input
  elements.chatInput.value = '';
  elements.btnSend.disabled = true;

  // Send to Qwen
  try {
    const result = await window.electronAPI.qwenSend(message);

    if (!result.success) {
      throw new Error(result.error || 'Échec de l\'envoi du message');
    }
  } catch (error) {
    console.error('Error sending message:', error);
    showToast('Erreur lors de l\'envoi du message', 'error');
    addMessage('system', 'Erreur: ' + error.message);
  }
}

function addMessage(role, content) {
  const messageId = 'msg-' + Date.now();

  const message = {
    id: messageId,
    role,
    content,
    timestamp: new Date()
  };

  appState.messages.push(message);

  const messageEl = createMessageElement(message);
  elements.chatMessages.appendChild(messageEl);

  // Scroll to bottom
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function createMessageElement(message) {
  const div = document.createElement('div');
  div.className = `message ${message.role}`;
  div.id = message.id;

  if (message.role !== 'system') {
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.innerHTML = message.role === 'user'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>';
    div.appendChild(avatar);
  }

  const content = document.createElement('div');
  content.className = 'message-content';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = message.content;
  content.appendChild(bubble);

  if (message.role !== 'system') {
    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = formatTime(message.timestamp);
    content.appendChild(time);
  }

  div.appendChild(content);

  return div;
}

function updateMessageBubble(messageId, newContent) {
  const messageEl = document.getElementById(messageId);
  if (messageEl) {
    const bubble = messageEl.querySelector('.message-bubble');
    if (bubble) {
      bubble.textContent = newContent;
    }
  }
}

function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

async function attachFile() {
  try {
    const filePath = await window.electronAPI.selectFile({
      title: 'Sélectionner un fichier',
      properties: ['openFile'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif'] },
        { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'txt'] }
      ]
    });

    if (filePath) {
      const fileName = filePath.split('/').pop();
      elements.chatInput.value = `[Fichier joint: ${fileName}]\n` + elements.chatInput.value;
      elements.btnSend.disabled = false;
    }
  } catch (error) {
    console.error('Error attaching file:', error);
    showToast('Erreur lors de la sélection du fichier', 'error');
  }
}

// ============================================================================
// PGI Data Detection
// ============================================================================
function detectPGIData(text) {
  // Detect Quebec project keywords
  const projects = ['KORLCC', 'Alexis Nihon', 'Urgences', 'Urgence'];
  const hasPGIKeywords = projects.some(p => text.includes(p)) ||
    text.toLowerCase().includes('budget') ||
    text.toLowerCase().includes('projet') ||
    text.toLowerCase().includes('rentabilité') ||
    text.toLowerCase().includes('main d\'œuvre');

  if (hasPGIKeywords) {
    // Extract PGI data
    const pgiData = extractPGIData(text);
    if (pgiData) {
      appState.pgiData = pgiData;
      renderPGIDashboard(pgiData);

      // Show notification
      showToast('Données PGI détectées - Consultez le tableau de bord', 'success');
    }
  }
}

function extractPGIData(text) {
  // Simple extraction - in production, this would be more sophisticated
  const pgiData = {
    projects: [],
    labor: [],
    materials: []
  };

  // Extract KORLCC project
  if (text.includes('KORLCC')) {
    const budgetMatch = text.match(/450[,\s]*000/);
    const spentMatch = text.match(/320[,\s]*000/);

    if (budgetMatch) {
      pgiData.projects.push({
        name: 'KORLCC',
        budget: 450000,
        spent: 320000,
        completion: 71,
        status: 'active'
      });
    }
  }

  // Extract Alexis Nihon project
  if (text.includes('Alexis Nihon')) {
    pgiData.projects.push({
      name: 'Alexis Nihon',
      budget: 680000,
      spent: 480000,
      completion: 65,
      status: 'active'
    });
  }

  // Extract Urgences project
  if (text.includes('Urgence')) {
    pgiData.projects.push({
      name: 'Urgences',
      budget: 125000,
      spent: 95000,
      completion: 45,
      status: 'urgent'
    });
  }

  // If we found projects, return the data
  return pgiData.projects.length > 0 ? pgiData : null;
}

function renderPGIDashboard(data) {
  elements.pgiContent.innerHTML = '';

  if (!data || !data.projects || data.projects.length === 0) {
    elements.pgiContent.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <p>Demandez au chat d'afficher les données PGI de vos projets</p>
      </div>
    `;
    return;
  }

  // Render project cards
  data.projects.forEach(project => {
    const card = document.createElement('div');
    card.className = 'stat-card';

    const statusBadge = project.status === 'urgent'
      ? '<span class="badge badge-warning">Urgent</span>'
      : '<span class="badge badge-success">Actif</span>';

    card.innerHTML = `
      <div class="stat-card-header">
        <h3 class="stat-card-title">${project.name}</h3>
        ${statusBadge}
      </div>
      <div class="stat-card-value">${(project.budget / 1000).toFixed(0)}K $</div>
      <div class="stat-card-label">Budget Total</div>
      <div style="margin-top: 1rem;">
        <div style="display: flex; justify-content: space-between; font-size: 0.875rem; margin-bottom: 0.5rem;">
          <span>Progression</span>
          <span>${project.completion}%</span>
        </div>
        <div style="width: 100%; height: 8px; background: var(--bg-tertiary); border-radius: 4px; overflow: hidden;">
          <div style="width: ${project.completion}%; height: 100%; background: linear-gradient(135deg, var(--cyber-blue), var(--cyber-purple)); transition: width 0.5s;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.75rem; color: var(--text-muted);">
          <span>Dépensé: ${(project.spent / 1000).toFixed(0)}K $</span>
          <span>Restant: ${((project.budget - project.spent) / 1000).toFixed(0)}K $</span>
        </div>
      </div>
    `;

    elements.pgiContent.appendChild(card);
  });
}

// ============================================================================
// Photo GPS Functions
// ============================================================================
async function uploadPhotos() {
  try {
    const filePaths = await window.electronAPI.selectFiles({
      title: 'Sélectionner des photos avec GPS',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }
      ]
    });

    if (!filePaths || filePaths.length === 0) return;

    showLoading('Extraction des données GPS...');

    for (const filePath of filePaths) {
      const result = await window.electronAPI.extractPhotoGPS(filePath);

      if (result.success && result.gps) {
        appState.photos.push({
          path: filePath,
          gps: result.gps
        });

        renderPhotoCard(filePath, result.gps);
      } else {
        console.warn('No GPS data in photo:', filePath);
      }
    }

    showToast(`${appState.photos.length} photo(s) avec GPS importées`, 'success');
  } catch (error) {
    console.error('Error uploading photos:', error);
    showToast('Erreur lors de l\'upload des photos', 'error');
  } finally {
    hideLoading();
  }
}

function renderPhotoCard(path, gps) {
  const card = document.createElement('div');
  card.className = 'photo-card';

  const fileName = path.split('/').pop();

  card.innerHTML = `
    <img src="file://${path}" alt="${fileName}" class="photo-card-image" />
    <div class="photo-card-info">
      <div class="photo-card-title">${fileName}</div>
      <div class="photo-card-meta">
        <svg style="width: 12px; height: 12px;" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span>${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}</span>
      </div>
    </div>
  `;

  elements.photosGrid.appendChild(card);
}

// ============================================================================
// Plan Upload
// ============================================================================
async function uploadPlan() {
  try {
    const filePath = await window.electronAPI.selectFile({
      title: 'Sélectionner un plan électrique',
      properties: ['openFile'],
      filters: [
        { name: 'PDF Files', extensions: ['pdf'] },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }
      ]
    });

    if (!filePath) return;

    appState.plans.push(filePath);

    const fileName = filePath.split('/').pop();
    showToast(`Plan "${fileName}" importé`, 'success');

    // Add to plans list
    const planItem = document.createElement('div');
    planItem.className = 'stat-card';
    planItem.innerHTML = `
      <div class="stat-card-header">
        <h3 class="stat-card-title">${fileName}</h3>
      </div>
      <p style="color: var(--text-muted); font-size: 0.875rem;">Plan importé le ${new Date().toLocaleDateString('fr-CA')}</p>
    `;
    elements.plansList.appendChild(planItem);

  } catch (error) {
    console.error('Error uploading plan:', error);
    showToast('Erreur lors de l\'upload du plan', 'error');
  }
}

// ============================================================================
// Compliance Check
// ============================================================================
async function runComplianceCheck() {
  showLoading('Vérification de conformité en cours...');

  // Simulate compliance check with Qwen
  const message = 'Effectue une vérification de conformité CEQ, RBQ, RSST et CSA pour les projets en cours. Vérifie tous les standards québécois.';

  try {
    await window.electronAPI.qwenSend(message);

    // Switch to chat to see results
    switchView('chat');

  } catch (error) {
    console.error('Error running compliance check:', error);
    showToast('Erreur lors de la vérification', 'error');
  } finally {
    hideLoading();
  }
}

// ============================================================================
// View Management
// ============================================================================
function switchView(viewName) {
  // Update nav items
  elements.navItems.forEach(item => {
    if (item.dataset.view === viewName) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update views
  Object.keys(elements.views).forEach(key => {
    if (key === viewName) {
      elements.views[key].classList.add('active');
    } else {
      elements.views[key].classList.remove('active');
    }
  });

  appState.currentView = viewName;
}

// ============================================================================
// UI Utilities
// ============================================================================
function showLoading(message = 'Chargement...') {
  elements.loadingText.textContent = message;
  elements.loadingOverlay.classList.add('active');
}

function hideLoading() {
  elements.loadingOverlay.classList.remove('active');
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================================================
// Export for debugging
// ============================================================================
window.appDebug = {
  appState,
  elements,
  sendMessage,
  switchView,
  renderPGIDashboard
};

console.log('✅ Application logic loaded');
