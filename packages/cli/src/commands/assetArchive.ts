import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openPromise } from 'yauzl';

/** Read JAR entries lazily instead of depending on a platform unzip command. */
export async function extractMinecraftAssets(archive: string, output: string): Promise<void> {
  const zip = await openPromise(archive, { autoClose: false, strictFileNames: true });
  try {
    for await (const entry of zip.eachEntry()) {
      if (!entry.fileName.startsWith('assets/minecraft/') || entry.fileName.endsWith('/')) continue;
      const file = path.join(output, entry.fileName);
      await mkdir(path.dirname(file), { recursive: true });
      await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(file));
    }
  } finally {
    const closed = once(zip, 'close');
    zip.close();
    await closed;
  }
}
