import type { ChildProcess } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

const MAX_STARTUP_OUTPUT = 65_536;

/** Wait for a bounded startup marker across stdout chunks, ignoring ANSI color.
 * The pattern must include a delimiter after variable fields such as a port.
 * Removes its listeners/timer on every outcome; the caller owns process cleanup.
 */
export function waitForProcessOutput(
  child: ChildProcess,
  pattern: RegExp,
  label: string,
  timeoutMs = 15_000,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    if (!child.stdout) return reject(new Error(`${label} has no stdout pipe`));
    if (child.exitCode !== null || child.signalCode !== null)
      return reject(new Error(`${label} exited before startup`));
    let output = '',
      diagnostics = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onOutput);
      child.stderr?.off('data', onDiagnostic);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (message: string) => {
      cleanup();
      reject(new Error(`${label} ${message}\n${stripVTControlCharacters(diagnostics)}`));
    };
    const onDiagnostic = (bytes: Buffer) => {
      diagnostics = (diagnostics + String(bytes)).slice(-MAX_STARTUP_OUTPUT);
    };
    const onOutput = (bytes: Buffer) => {
      onDiagnostic(bytes);
      output = (output + String(bytes)).slice(-MAX_STARTUP_OUTPUT);
      const match = stripVTControlCharacters(output).match(pattern);
      if (match) {
        cleanup();
        resolve(match);
      }
    };
    const onError = (error: Error) => fail(`failed: ${error.message}`);
    const onExit = (code: number | null) => fail(`exited ${code}`);
    const timer = setTimeout(() => fail('startup timed out'), timeoutMs);
    child.stdout.on('data', onOutput);
    child.stderr?.on('data', onDiagnostic);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
