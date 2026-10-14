#!/usr/bin/env node
import { CommanderError } from 'commander';
import { createProgram } from './program.js';
import { redact } from './settings/secrets.js';

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else {
    console.error('Error:', redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = process.exitCode || 1;
  }
}
