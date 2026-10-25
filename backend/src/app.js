import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { requireAuth, requireRole } from './middleware/auth.js';
import db from './config/db.js';
import authRouter from './routes/auth.js';
import hrRouter from './routes/hr.js';
import candidateRouter from './routes/candidate.js';
import callRouter from './routes/call.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Log incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Serve the built React client (run `npm run build` first). In dev, use `npm run client:dev` instead.
const frontendPath = path.join(__dirname, '../../client/dist');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
} else {
  console.log('[App] client/dist not found — run `npm run build` to serve the UI from this server.');
}

app.use('/api/auth', authRouter);
app.use('/api/hr', requireAuth, requireRole('superadmin', 'recruiter'), hrRouter);
// The call router is mounted first so its multer limits apply to call audio.
app.use('/api/candidate/call', requireAuth, requireRole('candidate'), callRouter);
app.use('/api/candidate', requireAuth, requireRole('candidate'), candidateRouter);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'production',
    database: db.supabase ? 'connected' : 'not_configured'
  });
});

// Fallback to index.html for single page app routing
app.get('*', (req, res, next) => {
  const apiPrefixes = ['/api', '/health'];
  if (apiPrefixes.some(prefix => req.url.startsWith(prefix))) {
    return next();
  }
  const indexFile = path.join(frontendPath, 'index.html');
  if (!fs.existsSync(indexFile)) {
    return res.status(404).send('UI not built. Run `npm run build`, or use `npm run client:dev` for development.');
  }
  res.sendFile(indexFile);
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.name || 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.'
  });
});

export default app;
