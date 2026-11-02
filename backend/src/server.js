import app from './app.js';
import dotenv from 'dotenv';
import { startScheduler, stopScheduler } from './services/campaignScheduler.js';

dotenv.config();

const PORT = process.env.PORT || 3000;
// Only this computer by default: the public address comes through the tunnel (ngrok), which connects
// locally. Set HOST=0.0.0.0 only where the server must be reached directly (Docker, a cloud host).
const HOST = process.env.HOST || '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
  console.log(`==================================================`);
  console.log(` HireLens backend running on port ${PORT}`);
  console.log(` Open http://localhost:${PORT}`);
  console.log(`==================================================`);
  // Starts scheduled campaigns (and their invite emails) and closes campaigns at their close time.
  startScheduler();
});

let isShuttingDown = false;
export const gracefulShutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  stopScheduler();
  console.log(`\n[Server] Received ${signal}. Shutting down...`);

  server.close(() => {
    console.log('[Server] HTTP connections closed. Exiting.');
    process.exit(0);
  });

  // Safety timeout: force exit if closing connections takes too long
  setTimeout(() => {
    console.error('[Server] Shutdown timed out (10s). Forcing exit.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default server;
