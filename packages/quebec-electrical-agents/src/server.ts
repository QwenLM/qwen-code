/**
 * Serveur Principal - Système d'Agents Électriques Québécois
 * Express + Socket.IO pour API REST et WebSocket
 */

import express, { Express, Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { logger } from './utils/logger.js';
import { OrchestrationService } from './services/orchestration-service.js';

// Configuration
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;

// Initialisation Express
const app: Express = express();
const httpServer = createServer(app);

// Initialisation Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration Multer pour upload de fichiers
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|png|jpg|jpeg/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Format de fichier non supporté. Utilisez PDF, PNG ou JPG.'));
    }
  }
});

// Service d'orchestration
const orchestration = new OrchestrationService();

// Initialisation
async function initialize() {
  try {
    logger.info('Initialisation du système...');

    // Créer répertoires nécessaires
    const fs = await import('fs/promises');
    await fs.mkdir(path.join(__dirname, '../uploads'), { recursive: true });
    await fs.mkdir(path.join(__dirname, '../logs'), { recursive: true });
    await fs.mkdir(path.join(__dirname, '../data'), { recursive: true });

    // Initialiser base de connaissances FAISS
    await orchestration.initializeKnowledgeBase();

    logger.info('Système initialisé avec succès');
  } catch (error) {
    logger.error('Erreur initialisation système', error);
    throw error;
  }
}

// ============================================================================
// ROUTES API
// ============================================================================

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'quebec-electrical-agents',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  });
});

// Upload et analyse de plan
app.post('/api/plans/upload', upload.single('plan'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }

    const { projectId } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId requis' });
    }

    logger.info(`Upload plan: ${req.file.filename} pour projet ${projectId}`);

    // Retourner info plan uploadé
    const planInfo = {
      planId: Date.now().toString(),
      filename: req.file.originalname,
      path: req.file.path,
      size: req.file.size,
      uploadDate: new Date()
    };

    res.json(planInfo);

  } catch (error) {
    logger.error('Erreur upload plan', error);
    res.status(500).json({ error: 'Erreur lors de l\'upload du plan' });
  }
});

// Déclencher analyse complète
app.post('/api/agents/analyze', async (req: Request, res: Response) => {
  try {
    const { planPath, projectId, projectData } = req.body;

    if (!planPath || !projectId) {
      return res.status(400).json({ error: 'planPath et projectId requis' });
    }

    logger.info(`Démarrage analyse pour projet ${projectId}`);

    // Lancer workflow d'orchestration en arrière-plan
    orchestration.processPlanWorkflow(planPath, projectId, projectData || {})
      .then(result => {
        // Notifier via WebSocket
        io.emit('analysis-complete', result);
        logger.info(`Analyse complétée pour projet ${projectId}`);
      })
      .catch(error => {
        logger.error('Erreur workflow orchestration', error);
        io.emit('analysis-error', { projectId, error: error.message });
      });

    res.json({
      status: 'started',
      message: 'Analyse en cours...',
      projectId
    });

  } catch (error) {
    logger.error('Erreur démarrage analyse', error);
    res.status(500).json({ error: 'Erreur lors du démarrage de l\'analyse' });
  }
});

// Rechercher dans la base de connaissances
app.get('/api/knowledge/search', async (req: Request, res: Response) => {
  try {
    const { q, source, k } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Paramètre q (query) requis' });
    }

    const query = q as string;
    const sourceFilter = source as 'CEQ' | 'RBQ' | 'RSST' | 'CSA' | undefined;
    const limit = k ? parseInt(k as string) : 5;

    const response = await orchestration.askAgent(query, 'api-request');

    res.json({
      query,
      response,
      source: sourceFilter || 'all',
      limit
    });

  } catch (error) {
    logger.error('Erreur recherche knowledge base', error);
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
});

// ============================================================================
// WEBSOCKET
// ============================================================================

io.on('connection', (socket) => {
  logger.info(`Client connecté: ${socket.id}`);

  // Message utilisateur → agent
  socket.on('user-message', async (data) => {
    try {
      const { message, context } = data;

      logger.info(`Message utilisateur: "${message}"`);

      // Indicateur de frappe
      socket.emit('agent-typing', true);

      // Obtenir réponse de l'agent via orchestration
      const response = await orchestration.askAgent(message, context || 'chat');

      // Envoyer réponse
      socket.emit('agent-message', {
        message: response,
        timestamp: new Date(),
        context
      });

      socket.emit('agent-typing', false);

    } catch (error) {
      logger.error('Erreur traitement message utilisateur', error);
      socket.emit('agent-error', { error: 'Erreur lors du traitement de votre message' });
      socket.emit('agent-typing', false);
    }
  });

  // Analyse de plan
  socket.on('analyze-plan', async (data) => {
    try {
      const { planId, filename, planPath, projectId, projectData } = data;

      logger.info(`WebSocket: Analyse plan ${filename} (${planId})`);

      socket.emit('analysis-status', { status: 'started', planId });

      // Lancer workflow
      const result = await orchestration.processPlanWorkflow(
        planPath,
        projectId || planId,
        projectData || {}
      );

      // Envoyer résultat complet
      socket.emit('plan-analysis-complete', {
        planId,
        bomGenerated: !!result.results.bom,
        complianceChecked: !!result.results.compliance,
        materialsDetected: result.results.planAnalysis?.equipmentDetected.length || 0,
        result
      });

    } catch (error) {
      logger.error('Erreur analyse plan WebSocket', error);
      socket.emit('analysis-error', { error: error.message });
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Client déconnecté: ${socket.id}`);
  });
});

// ============================================================================
// DÉMARRAGE SERVEUR
// ============================================================================

async function startServer() {
  try {
    // Initialiser le système
    await initialize();

    // Démarrer serveur HTTP
    app.listen(PORT, () => {
      logger.info(`🚀 Serveur API démarré sur port ${PORT}`);
      logger.info(`📡 API: http://localhost:${PORT}`);
      logger.info(`📋 Health: http://localhost:${PORT}/health`);
    });

    // Démarrer serveur WebSocket
    httpServer.listen(WS_PORT, () => {
      logger.info(`🔌 Serveur WebSocket démarré sur port ${WS_PORT}`);
    });

  } catch (error) {
    logger.error('Erreur démarrage serveur', error);
    process.exit(1);
  }
}

// Gestion des erreurs non catchées
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Démarrage
startServer();

export { app, io };
