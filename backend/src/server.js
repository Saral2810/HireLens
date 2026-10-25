import app from './app.js';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================`);
  console.log(` HR Screening backend running on port ${PORT}`);
  console.log(` Open http://localhost:${PORT}`);
  console.log(`==================================================`);
});

let isShuttingDown = false;
export const gracefulShutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
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
