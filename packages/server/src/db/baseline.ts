import { PGlite } from '@electric-sql/pglite';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseContext } from './connection.js';
import type { Migration } from './migrations.js';

// Compare catalog definitions rather than IF NOT EXISTS or table/column names alone.
// Nullability is checked via attnotnull; its catalog representation varies by engine.
// Names are intentional: later generated ALTER/DROP statements depend on them.
const catalogSql = `
  SELECT 'relation:' || c.relname AS key,
    jsonb_build_object('kind', c.relkind, 'persistence', c.relpersistence,
      'rowSecurity', c.relrowsecurity, 'forceRowSecurity', c.relforcerowsecurity,
      'partition', c.relispartition) AS value
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT 'column:' || c.relname || '.' || a.attname,
    jsonb_build_object('type', format_type(a.atttypid, a.atttypmod),
      'notNull', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid),
      'identity', a.attidentity, 'generated', a.attgenerated,
      'collation', co.collname)
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint:' || c.relname || '.' || con.conname,
    jsonb_build_object('definition', pg_get_constraintdef(con.oid), 'validated', con.convalidated,
      'deferrable', con.condeferrable, 'deferred', con.condeferred)
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND con.contype <> 'n'
  UNION ALL
  SELECT 'index:' || c.relname || '.' || ic.relname,
    jsonb_build_object('definition', pg_get_indexdef(i.indexrelid),
      'valid', i.indisvalid, 'ready', i.indisready, 'clustered', i.indisclustered,
      'replicaIdentity', i.indisreplident)
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'trigger:' || c.relname || '.' || t.tgname,
    jsonb_build_object('definition', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled)
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ORDER BY key`;

interface CatalogEntry extends Record<string, unknown> {
  key: string;
  value: unknown;
}

export async function verifyBaseline(database: DatabaseContext, initial: Migration): Promise<void> {
  // Build the expected catalog from the immutable first SQL migration, never from
  // today's schema.ts (which will evolve). This also works across PostgreSQL/PGlite.
  const reference = await PGlite.create();
  let expected: CatalogEntry[];
  try {
    for (const statement of initial.sql) await reference.exec(statement);
    expected = (await reference.query<CatalogEntry>(catalogSql)).rows;
  } finally {
    await reference.close();
  }
  const actual = await database.query<CatalogEntry>(catalogSql);
  const expectedMap = new Map(expected.map((entry) => [entry.key, entry.value]));
  const actualMap = new Map(actual.map((entry) => [entry.key, entry.value]));
  const differences: string[] = [];
  for (const key of new Set([...expectedMap.keys(), ...actualMap.keys()])) {
    if (!expectedMap.has(key)) differences.push(`${key}: unexpected object`);
    else if (!actualMap.has(key)) differences.push(`${key}: missing object`);
    else if (!isDeepStrictEqual(actualMap.get(key), expectedMap.get(key))) {
      differences.push(
        `${key}: expected ${JSON.stringify(expectedMap.get(key))}; found ${JSON.stringify(actualMap.get(key))}`,
      );
    }
  }
  if (differences.length)
    throw new Error(`Legacy database does not match initial migration:\n${differences.join('\n')}`);
}
