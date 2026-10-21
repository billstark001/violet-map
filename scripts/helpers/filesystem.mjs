import fs from 'node:fs/promises';
import path from 'node:path';

export function isWithinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Canonicalize existing ancestors without creating the requested destination. */
export async function canonicalPath(file) {
  file = path.resolve(file);
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    return parent === file ? file : path.join(await canonicalPath(parent), path.basename(file));
  }
}
