// npm run public — starts the app AND the ngrok tunnel on your fixed ngrok address, in one terminal.
// Ctrl+C stops both. Needs: ngrok installed and logged in (ngrok config add-authtoken ...) and, in .env,
// NGROK_DOMAIN=your-name.ngrok-free.app plus PUBLIC_APP_URL=https://your-name.ngrok-free.app
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = process.env.PORT || 3000;
const domain = (process.env.NGROK_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const publicUrl = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!domain) fail('Set NGROK_DOMAIN in .env to your free ngrok domain, e.g. NGROK_DOMAIN=your-name.ngrok-free.app');
if (publicUrl !== `https://${domain}`) {
  fail(`PUBLIC_APP_URL must be https://${domain} so emailed links use this address. It is now: ${publicUrl || '(empty)'}`);
}

/** ngrok from PATH, or where winget installs it (PATH is only updated for new terminals). */
function findNgrok() {
  if (spawnSync('ngrok', ['version'], { shell: process.platform === 'win32' }).status === 0) return 'ngrok';
  const wingetDir = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetDir)) {
    const pkg = fs.readdirSync(wingetDir).find(d => d.toLowerCase().startsWith('ngrok.ngrok'));
    const exe = pkg && path.join(wingetDir, pkg, 'ngrok.exe');
    if (exe && fs.existsSync(exe)) return exe;
  }
  return fail('ngrok was not found. Install it (winget install Ngrok.Ngrok) and open a new terminal.');
}

const ngrokBin = findNgrok();
const children = [];
const stopAll = () => { for (const child of children) child.kill(); };
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });

const app = spawn(process.execPath, [path.join(root, 'backend/src/server.js')], { cwd: root, stdio: 'inherit' });
children.push(app);
app.on('exit', (code) => { console.error(`\nThe app stopped (exit ${code}). Stopping the tunnel too.`); stopAll(); process.exit(code || 1); });

// Wait for the app before opening the tunnel, so the first visitor never sees an ngrok error page.
const started = Date.now();
while (Date.now() - started < 30000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.ok) break;
  } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 500));
}

const tunnel = spawn(ngrokBin, ['http', `--url=https://${domain}`, String(port), '--log=stdout', '--log-level=warn'], { stdio: ['ignore', 'inherit', 'inherit'] });
children.push(tunnel);
tunnel.on('exit', (code) => {
  console.error(`\nThe ngrok tunnel stopped (exit ${code}). Check: ngrok config add-authtoken <token>, and that NGROK_DOMAIN is the domain shown in your ngrok dashboard.`);
  stopAll();
  process.exit(code || 1);
});

console.log(`\n==================================================\n Public address: https://${domain}\n Candidates' emailed links use this address.\n Keep this terminal open while the campaign runs. Ctrl+C stops everything.\n==================================================\n`);
