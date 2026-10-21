import type { ChildProcess, ExecFileOptions } from 'node:child_process';

export function execute(
  command: string,
  args: readonly string[],
  options?: ExecFileOptions & { encoding?: BufferEncoding },
): Promise<{ stdout: string; stderr: string }>;
export function execute(
  command: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding: 'buffer' | null },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export function stopProcess(child: ChildProcess, timeoutMs?: number): Promise<void>;
