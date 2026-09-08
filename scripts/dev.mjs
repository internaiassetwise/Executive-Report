import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      // Kill only the process trees started by this launcher.
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
}

function start(name, cwd, args) {
  const child = spawn(process.execPath, args, {
    cwd: resolve(root, cwd), stdio: 'inherit',
    detached: process.platform !== 'win32', windowsHide: true,
    env: { ...process.env },
  });
  children.push(child);
  child.on('error', () => { console.error(`${name} could not start.`); stop(1); });
  child.on('exit', (code) => {
    if (!stopping) { console.error(`${name} stopped.`); stop(code ?? 1); }
  });
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
start('Backend', 'backend', ['src/server.mjs']);
const frontendPort = process.env.FRONTEND_PORT || '3000';
start('Frontend', 'frontend', [resolve(root, 'node_modules/vinext/dist/cli.js'), 'dev', '--host', '127.0.0.1', '--port', frontendPort]);
