import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function readJson<T>(file: string, fallback: () => T): Promise<T> {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON in ${file}`);
  }
}

/** Only application-owned files are replaced. Locks never get reclaimed by age. */
export async function updateJson<T>(file: string, fallback: () => T, update: (value: T) => void): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let handle;
  for (let attempt = 0; ; attempt++) {
    try {
      handle = await fs.open(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt >= 100)
        throw new Error(`CLI file is locked: ${lock}; verify its owner has stopped before removing the lock`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error(`Refusing to replace a symbolic link: ${file}`);
    const value = await readJson(file, fallback);
    update(value);
    const output = await fs.open(temporary, 'wx', 0o600);
    try {
      if (process.platform === 'win32')
        await promisify(execFile)('icacls', [temporary, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(F)`]);
      await output.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await output.sync();
    } finally {
      await output.close();
    }
    await fs.rename(temporary, file);
    return value;
  } finally {
    await fs.rm(temporary, { force: true });
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}
