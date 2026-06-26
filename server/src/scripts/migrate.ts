import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { Pool, type PoolClient } from 'pg';

/**
 * Per-migration runner that replaces drizzle-orm's stock migrator.
 *
 * The stock migrator tracks only a single high-water mark (the newest
 * `created_at` in `drizzle.__drizzle_migrations`) and applies any journal entry
 * whose `when` timestamp is strictly greater. That silently skips migrations
 * whose timestamps predate an already-applied migration — exactly what happens
 * when this project is carried as a fork on top of a moving upstream.
 *
 * This runner instead tracks applied migrations by **content hash** (computed
 * the same way drizzle does, via `readMigrationFiles`). Each journal migration
 * whose hash is not already recorded is applied, in journal order, independent
 * of `when` timestamps. The tracking table format is unchanged, so existing
 * databases migrated by the stock migrator are recognised as applied with no
 * manual seeding, and reverting to the stock migrator stays possible.
 *
 * See `PER_MIGRATION_RUNNER_PLAN.md` for the full rationale.
 */

const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

// Stable, arbitrary session-level advisory lock key so concurrent container
// starts / replicas serialise the whole migration run.
const ADVISORY_LOCK_KEY = 472839101;

export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: MigrationLogger = {
  info: (message) => console.log(`[migrate] ${message}`),
  warn: (message) => console.warn(`[migrate] ${message}`),
  error: (message) => console.error(`[migrate] ${message}`),
};

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

interface Journal {
  entries: JournalEntry[];
}

export interface ApplyMigrationsResult {
  applied: number;
  skipped: number;
}

export function resolveMigrationsFolder(): string {
  const candidates = [
    join(__dirname, '..', '..', 'migrations'),
    join(__dirname, '..', 'db', 'migrations'),
    join(process.cwd(), 'migrations'),
    join(process.cwd(), 'src', 'db', 'migrations'),
  ];

  const match = candidates.find((path) => existsSync(path));
  if (!match) {
    throw new Error(`Unable to locate migrations folder. Checked: ${candidates.join(', ')}`);
  }
  return match;
}

function readJournal(migrationsFolder: string): Journal {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  return journal;
}

/**
 * Reuse the exact table the stock migrator creates, and additively widen it with
 * a nullable `tag` column. The tag is purely for logging and the drift guard;
 * `hash` stays the source of truth. Legacy rows keep `tag = NULL`.
 */
async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`,
  );
  await client.query(`ALTER TABLE "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ADD COLUMN IF NOT EXISTS tag text`);
}

interface AppliedRow {
  hash: string;
  tag: string | null;
}

async function loadAppliedMigrations(client: PoolClient): Promise<AppliedRow[]> {
  const { rows } = await client.query<AppliedRow>(`SELECT hash, tag FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`);
  return rows;
}

async function applyMigration(client: PoolClient, migration: MigrationMeta, tag: string): Promise<void> {
  await client.query('BEGIN');
  try {
    for (const statement of migration.sql) {
      const trimmed = statement.trim();
      if (trimmed.length === 0) continue;
      await client.query(statement);
    }
    await client.query(`INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (hash, created_at, tag) VALUES ($1, $2, $3)`, [
      migration.hash,
      migration.folderMillis,
      tag,
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Apply every journal migration whose content hash is not already recorded, in
 * journal order, each in its own transaction. Requires an already-connected,
 * dedicated `client` (the advisory lock and the work must share one session).
 */
export async function applyMigrations(
  client: PoolClient,
  migrationsFolder: string,
  logger: MigrationLogger = defaultLogger,
): Promise<ApplyMigrationsResult> {
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await ensureMigrationsTable(client);

    // `readMigrationFiles` returns migrations in the same order as the journal
    // entries, with drizzle-compatible sha256 hashes. We read the journal
    // separately only for tags/idx, which `readMigrationFiles` omits.
    const migrations = readMigrationFiles({ migrationsFolder });
    const journal = readJournal(migrationsFolder);

    const appliedRows = await loadAppliedMigrations(client);
    const appliedHashes = new Set(appliedRows.map((row) => row.hash));
    const appliedTagHashes = new Map<string, string>();
    for (const row of appliedRows) {
      if (row.tag) appliedTagHashes.set(row.tag, row.hash);
    }

    let applied = 0;
    let skipped = 0;

    for (let i = 0; i < migrations.length; i++) {
      const migration = migrations[i];
      const tag = journal.entries[i]?.tag ?? `migration_${i}`;

      if (appliedHashes.has(migration.hash)) {
        skipped++;
        continue;
      }

      // Hash drift guard: a row recorded under this tag but with a different
      // hash means an already-applied migration file was edited (an
      // anti-pattern). Skip-with-warning rather than destructively re-running.
      const recordedHash = appliedTagHashes.get(tag);
      if (recordedHash && recordedHash !== migration.hash) {
        logger.warn(
          `hash drift for ${tag}: recorded ${recordedHash.slice(0, 12)} but file hashes ${migration.hash.slice(0, 12)}. ` +
            `Skipping (never edit an already-applied migration). Generate a new migration instead.`,
        );
        skipped++;
        continue;
      }

      logger.info(`applying ${tag} …`);
      try {
        await applyMigration(client, migration, tag);
      } catch (err) {
        logger.error(`failed applying ${tag}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      applied++;
    }

    logger.info(`done: ${applied} applied, ${skipped} already present (${migrations.length} total)`);
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}

async function bootstrapExtensions(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "pg_trgm";
    CREATE EXTENSION IF NOT EXISTS "vector";
  `);
}

async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });

  // A single dedicated session: the advisory lock and all migration work must
  // share one connection.
  const client = await pool.connect();
  try {
    await bootstrapExtensions(client);
    const migrationsFolder = resolveMigrationsFolder();
    defaultLogger.info(`running migrations from ${migrationsFolder}`);
    await applyMigrations(client, migrationsFolder, defaultLogger);
  } finally {
    client.release();
    await pool.end();
  }
}

// Only auto-run when invoked as a script, so tests can import the helpers.
if (typeof require !== 'undefined' && require.main === module) {
  runMigrations().catch((err) => {
    defaultLogger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
