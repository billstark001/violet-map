import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { sensitiveValue } from './settings/secrets.js';

export interface SecretInput {
  stdin?: boolean;
  file?: string;
}

export async function readSecret(input: SecretInput, label: string): Promise<string> {
  if (input.stdin && input.file) throw new Error('Choose either stdin or a file for secret input');
  let value: string;
  if (input.file) value = await fs.readFile(input.file, 'utf8');
  else if (input.stdin) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024 * 1024) throw new Error('Secret input exceeds 1 MiB');
      chunks.push(bytes);
    }
    value = Buffer.concat(chunks).toString('utf8');
  } else {
    if (!process.stdin.isTTY) throw new Error(`${label} requires an interactive terminal or explicit stdin/file input`);
    const output = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const prompt = createInterface({ input: process.stdin, output, terminal: true });
    process.stderr.write(`${label}: `);
    try {
      value = await prompt.question('');
    } finally {
      prompt.close();
      process.stderr.write('\n');
    }
  }
  value = value.replace(/\r?\n$/, '');
  if (!value) throw new Error(`${label} must not be empty`);
  return sensitiveValue(value);
}
