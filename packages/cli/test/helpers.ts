import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(VIOLET_|DATABASE_|DATA_DIR$|ROOT_|S3_|AWS_)/.test(key)) delete env[key];
  return { ...env, ...extra };
}
export function invoke(
  args: string[],
  options: { home: string; input?: string; env?: NodeJS.ProcessEnv; cwd?: string },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        '--conditions=development',
        '--import',
        require.resolve('tsx'),
        fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
        '--cli-home',
        options.home,
        ...args,
      ],
      {
        env: cleanEnvironment(options.env),
        cwd: options.cwd ?? options.home,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
    child.stdin!.end(options.input ?? '');
  });
}
