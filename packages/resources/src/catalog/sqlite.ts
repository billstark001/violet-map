import { canonicalJson, parseArtifactRef, type ArtifactRef } from '@violet-map/core/resources';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { byteCapacity } from '../budget.js';
import type { ActionIndex } from '../catalog.js';
import { assertActionKey } from '../catalog.js';

/** Explicit sub-entry only. This disposable index is never a publication authority. */
export class SqliteActionIndex implements ActionIndex {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly maxBytes: number,
  ) {
    byteCapacity(maxBytes);
    if (!path || path === ':memory:') throw new TypeError('SQLite index requires an explicit file path');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version !== 0 && version !== 1)
        throw new Error('unsupported resource index schema; explicit reindex required');
      if (version === 0) {
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        if (tables.length) throw new Error('unrecognized resource index; explicit reindex required');
        this.db.exec(
          'CREATE TABLE actions (key TEXT PRIMARY KEY, ref TEXT NOT NULL, bytes INTEGER NOT NULL, sequence INTEGER NOT NULL); PRAGMA user_version=1',
        );
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      this.trim();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  async get(key: string) {
    assertActionKey(key);
    const row = this.db.prepare('SELECT ref FROM actions WHERE key=?').get(key) as { ref: string } | undefined;
    return row ? parseArtifactRef(JSON.parse(row.ref)) : undefined;
  }
  private trim() {
    let total = Number(
      (this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM actions').get() as { bytes: number }).bytes,
    );
    const oldest = this.db.prepare('SELECT key,bytes FROM actions ORDER BY sequence,key').iterate();
    for (const row of oldest) {
      if (total <= this.maxBytes) break;
      this.db.prepare('DELETE FROM actions WHERE key=?').run(row.key);
      total -= Number(row.bytes);
    }
  }
  async set(key: string, ref: ArtifactRef) {
    assertActionKey(key);
    const json = canonicalJson(parseArtifactRef(ref));
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(json) + 64;
    if (bytes > this.maxBytes) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT OR REPLACE INTO actions VALUES (?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM actions))')
        .run(key, json, bytes);
      this.trim();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async delete(key: string) {
    assertActionKey(key);
    this.db.prepare('DELETE FROM actions WHERE key=?').run(key);
  }
  close() {
    this.db.close();
  }
}
