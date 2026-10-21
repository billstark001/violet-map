import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

/** Reuse pnpm's active JS or standalone executable, avoiding Windows .cmd shells. */
export function execute(command, args, options) {
  const manager = process.env.npm_execpath;
  if (command === 'pnpm' && manager && /^pnpm\.(?:[cm]?js|exe)$/i.test(path.basename(manager))) {
    return /\.exe$/i.test(manager)
      ? executeFile(manager, args, options)
      : executeFile(process.execPath, [manager, ...args], options);
  }
  return executeFile(command, args, options);
}

/** IPC permits graceful cleanup on Windows, where kill(SIGTERM) terminates immediately. */
export async function stopProcess(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const onExit = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      child.once('exit', onExit);
      child.once('error', onError);
      timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      if (process.platform === 'win32' && child.connected) {
        child.send({ type: 'violet-map:shutdown' }, (error) => {
          if (error) child.kill('SIGTERM');
        });
      } else child.kill('SIGTERM');
    });
  } finally {
    clearTimeout(timer);
  }
}
