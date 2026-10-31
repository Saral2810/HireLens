import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { requireAuth, requireRole } from './middleware/auth.js';
import { limits } from './middleware/rateLimit.js';
import { securityHeaders, allowedOrigins } from './middleware/securityHeaders.js';
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
app.disable('x-powered-by');

// Serve the built React client (run `npm run build` first). In dev, use `npm run client:dev` instead.
const frontendPath = path.join(__dirname, '../../client/dist');

// Middleware
app.use(securityHeaders({ indexFile: path.join(frontendPath, 'index.html') }));
// Only the app's own address may call the API from a browser (it used to be any website).
const origins = allowedOrigins();
app.use(cors({ origin: (origin, done) => done(null, !origin || origins.has(origin)) }));
app.use(express.json({ limit: '2mb' }));

// Log incoming requests. The path only: query strings can carry invite tokens (/join?t=...).
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
} else {
  console.log('[App] client/dist not found — run `npm run build` to serve the UI from this server.');
}

app.use('/api', limits.api);
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

// Unknown API paths answer in JSON, like the rest of the API.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not Found', message: 'No such API endpoint.' }));

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

// Global Error Handler. The details go to the server log only: internal messages (database, Gnani,
// parser errors) are never sent to the browser. Errors the app raises on purpose with a 4xx status
// carry a message written for the user, and those are passed on.
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad Request', message: 'The request body is not valid JSON.' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Payload Too Large', message: 'The request is too large.' });
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status < 500) return res.status(status).json({ error: 'Request Error', message: err.message || 'The request could not be completed.' });
  res.status(status).json({ error: 'Server Error', message: 'Something went wrong on our side. Please try again in a moment.' });
});

export default app;
