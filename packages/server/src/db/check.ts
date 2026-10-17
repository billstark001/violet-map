import { loadMigrations } from './migrations.js';

const migrations = loadMigrations();

console.log(`Validated ${migrations.length} migration(s), including SQL/journal order and SHA-256 calculation.`);
