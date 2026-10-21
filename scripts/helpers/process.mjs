import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';

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

const stopping = new WeakMap();

/** Wait for stdio to close as well as graceful shutdown; concurrent callers share cleanup. */
export function stopProcess(child, timeoutMs = 10000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError('invalid shutdown timeout');
  if (stopping.has(child)) return stopping.get(child);
  // A terminated process can still have buffered output. Its streams keep close pending.
  if (
    (child.exitCode !== null || child.signalCode !== null) &&
    (!child.stdout || child.stdout.destroyed) &&
    (!child.stderr || child.stderr.destroyed)
  )
    return Promise.resolve();
  const stopped = new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.once('close', onClose);
    child.once('error', onError);
    if (child.exitCode !== null || child.signalCode !== null) return;
    timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    // Windows signals terminate immediately, so supervised servers implement this IPC protocol.
    if (process.platform === 'win32' && child.connected) {
      child.send({ type: 'violet-map:shutdown' }, (error) => {
        if (error) child.kill('SIGTERM');
      });
    } else child.kill('SIGTERM');
  });
  stopping.set(child, stopped);
  return stopped;
}

const MAX_STARTUP_OUTPUT = 65_536;

/** Wait for a bounded stdout marker, joining chunks and ignoring ANSI color.
 * Include a delimiter after variable fields (ports, for example).
 * The caller owns shutdown; all readiness listeners are removed on completion.
 */
export function waitForProcessOutput(child, pattern, label, timeoutMs = 15_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError('invalid startup timeout');
  return new Promise((resolve, reject) => {
    if (!child.stdout) return reject(new Error(`${label} has no stdout pipe`));
    if (child.exitCode !== null || child.signalCode !== null)
      return reject(new Error(`${label} exited before startup`));
    let output = '',
      diagnostics = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onOutput);
      child.stderr?.off('data', onDiagnostic);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const fail = (message) => {
      cleanup();
      reject(new Error(`${label} ${message}\n${stripVTControlCharacters(diagnostics)}`));
    };
    const onDiagnostic = (bytes) => {
      diagnostics = (diagnostics + String(bytes)).slice(-MAX_STARTUP_OUTPUT);
    };
    const onOutput = (bytes) => {
      onDiagnostic(bytes);
      output = (output + String(bytes)).slice(-MAX_STARTUP_OUTPUT);
      const match = stripVTControlCharacters(output).match(pattern);
      if (match) {
        cleanup();
        resolve(match);
      }
    };
    const onError = (error) => fail(`failed: ${error.message}`);
    const onClose = (code) => fail(`exited ${code}`);
    const timer = setTimeout(() => fail('startup timed out'), timeoutMs);
    child.stdout.on('data', onOutput);
    child.stderr?.on('data', onDiagnostic);
    child.once('error', onError);
    child.once('close', onClose);
  });
}
