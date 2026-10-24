import app from './app.js';
import dotenv from 'dotenv';
import queueService from './services/queueService.js';
import { startWorker as startJobQueueWorker, stopWorker as stopJobQueueWorker } from './services/jobQueue.js';
import './services/workers/campaignWorker.js'; // Start campaign ingestion worker
import dispatcher from './workers/dispatcher.js';
import schedulerService from './services/schedulerService.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================`);
  console.log(` Gnani.ai Backend Server running on port ${PORT}`);
  console.log(` Frontend Dashboard served at http://localhost:${PORT}`);
  console.log(`==================================================`);
  
  // Start queue background worker
  queueService.startQueueWorker(2000);
  
  // Start job queue background worker
  startJobQueueWorker(5000);
  
  // Start the Postgres-driven AI Dialer dispatcher
  dispatcher.start();

  // Initialize the persistent Job Scheduler Service
  schedulerService.init().catch(err => console.error('[SchedulerService] Failed to init on startup:', err));
});

// Graceful Shutdown for AWS Cloud (ECS Fargate, App Runner, EC2, Kubernetes)
let isShuttingDown = false;
export const gracefulShutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new HTTP requests
  server.close(async () => {
    console.log('[Server] HTTP connections closed.');

    try {
      // Cleanly stop background timers and workers
      queueService.stopQueueWorker();
      stopJobQueueWorker();
      dispatcher.stop();
      schedulerService.stop();

      console.log('[Server] All background services stopped cleanly. Exiting.');
      process.exit(0);
    } catch (err) {
      console.error('[Server] Error during background worker shutdown:', err);
      process.exit(1);
    }
  });

  // Safety timeout: force exit if closing connections exceeds 25 seconds
  setTimeout(() => {
    console.error('[Server] Graceful shutdown timed out (25s). Forcing exit.');
    process.exit(1);
  }, 25000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default server;

