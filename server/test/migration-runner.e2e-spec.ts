import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client, Pool } from 'pg';

import { applyMigrations, type MigrationLogger } from '../src/scripts/migrate';

/**
 * Integration tests for the per-migration runner (`src/scripts/migrate.ts`).
 *
 * Runs against the e2e Postgres (DATABASE_URL injected by vitest.config.e2e.ts).
 * Each test gets its own throwaway database so the runner's schema/table writes
 * never touch the shared e2e schema, and synthetic migration fixtures keep the
 * assertions focused on the runner's tracking/ordering logic.
 */

const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

interface FixtureMigration {
  tag: string;
  when: number;
  sql: string;
}

const silentLogger: MigrationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function baseConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for migration-runner e2e tests');
  return url;
}

/** Connect to the maintenance `postgres` database so we can CREATE/DROP scratch DBs. */
function adminConnectionString(): string {
  const url = new URL(baseConnectionString());
  url.pathname = '/postgres';
  return url.toString();
}

function scratchConnectionString(databaseName: string): string {
  const url = new URL(baseConnectionString());
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function buildFixtureFolder(migrations: FixtureMigration[]): string {
  const folder = mkdtempSync(join(tmpdir(), 'migrate-fixture-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const entries = migrations.map((migration, idx) => {
    writeFileSync(join(folder, `${migration.tag}.sql`), migration.sql);
    return { idx, version: '7', when: migration.when, tag: migration.tag, breakpoints: true };
  });
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }, null, 2));
  return folder;
}

async function ensureLegacyTable(client: Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
}

/** Pre-seed rows in the exact stock-migrator format (hash + created_at, no tag). */
async function seedLegacyRows(client: Client, folder: string, count: number): Promise<void> {
  const metas = readMigrationFiles({ migrationsFolder: folder });
  for (const meta of metas.slice(0, count)) {
    await client.query(`INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (hash, created_at) VALUES ($1, $2)`, [meta.hash, meta.folderMillis]);
  }
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${name}`]);
  return rows[0]?.exists ?? false;
}

async function appliedRows(client: Client): Promise<{ hash: string; tag: string | null; created_at: string | null }[]> {
  const { rows } = await client.query(`SELECT hash, tag, created_at FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ORDER BY id`);
  return rows;
}

describe('per-migration runner', () => {
  let admin: Client;
  let scratchDatabases: string[] = [];
  let fixtureFolders: string[] = [];

  beforeAll(async () => {
    admin = new Client({ connectionString: adminConnectionString() });
    await admin.connect();
  });

  afterAll(async () => {
    await admin.end();
  });

  afterEach(async () => {
    for (const folder of fixtureFolders) rmSync(folder, { recursive: true, force: true });
    fixtureFolders = [];
    for (const databaseName of scratchDatabases) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    }
    scratchDatabases = [];
  });

  async function createScratchDatabase(): Promise<string> {
    const databaseName = `migrate_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    scratchDatabases.push(databaseName);
    return databaseName;
  }

  function fixture(migrations: FixtureMigration[]): string {
    const folder = buildFixtureFolder(migrations);
    fixtureFolders.push(folder);
    return folder;
  }

  /** Run the real runner against a scratch DB using a dedicated pooled client. */
  async function run(databaseName: string, folder: string, logger: MigrationLogger = silentLogger) {
    const pool = new Pool({ connectionString: scratchConnectionString(databaseName) });
    const client = await pool.connect();
    try {
      return await applyMigrations(client, folder, logger);
    } finally {
      client.release();
      await pool.end();
    }
  }

  /** Open a plain client against a scratch DB for assertions/seeding. */
  async function withClient<T>(databaseName: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: scratchConnectionString(databaseName) });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  it('applies all migrations on a fresh database, then is a no-op', async () => {
    const folder = fixture([
      { tag: '0000_first', when: 1000, sql: 'CREATE TABLE tbl_a (id integer PRIMARY KEY);' },
      { tag: '0001_second', when: 2000, sql: 'CREATE TABLE tbl_b (id integer PRIMARY KEY);' },
      { tag: '0002_third', when: 3000, sql: 'CREATE TABLE tbl_c (id integer PRIMARY KEY);' },
    ]);
    const databaseName = await createScratchDatabase();

    const first = await run(databaseName, folder);
    expect(first).toEqual({ applied: 3, skipped: 0 });

    await withClient(databaseName, async (client) => {
      expect(await tableExists(client, 'tbl_a')).toBe(true);
      expect(await tableExists(client, 'tbl_b')).toBe(true);
      expect(await tableExists(client, 'tbl_c')).toBe(true);

      const rows = await appliedRows(client);
      expect(rows.map((row) => row.tag)).toEqual(['0000_first', '0001_second', '0002_third']);
      expect(rows.map((row) => row.created_at)).toEqual(['1000', '2000', '3000']);
    });

    const second = await run(databaseName, folder);
    expect(second).toEqual({ applied: 0, skipped: 3 });
  });

  it('applies only the migrations whose hash is missing', async () => {
    const folder = fixture([
      { tag: '0000_first', when: 1000, sql: 'CREATE TABLE tbl_a (id integer PRIMARY KEY);' },
      { tag: '0001_second', when: 2000, sql: 'CREATE TABLE tbl_b (id integer PRIMARY KEY);' },
      { tag: '0002_third', when: 3000, sql: 'CREATE TABLE tbl_c (id integer PRIMARY KEY);' },
    ]);
    const databaseName = await createScratchDatabase();

    await withClient(databaseName, async (client) => {
      await ensureLegacyTable(client);
      await seedLegacyRows(client, folder, 1); // pretend 0000 already applied
    });

    const result = await run(databaseName, folder);
    expect(result).toEqual({ applied: 2, skipped: 1 });

    await withClient(databaseName, async (client) => {
      expect(await tableExists(client, 'tbl_a')).toBe(false); // skipped, never created
      expect(await tableExists(client, 'tbl_b')).toBe(true);
      expect(await tableExists(client, 'tbl_c')).toBe(true);
    });
  });

  it('recognises legacy stock-format rows (hash, no tag) as already applied', async () => {
    const folder = fixture([
      { tag: '0000_first', when: 1000, sql: 'CREATE TABLE tbl_a (id integer PRIMARY KEY);' },
      { tag: '0001_second', when: 2000, sql: 'CREATE TABLE tbl_b (id integer PRIMARY KEY);' },
    ]);
    const databaseName = await createScratchDatabase();

    await withClient(databaseName, async (client) => {
      await ensureLegacyTable(client);
      await seedLegacyRows(client, folder, 2); // all applied by the stock migrator
    });

    const result = await run(databaseName, folder);
    expect(result).toEqual({ applied: 0, skipped: 2 });

    await withClient(databaseName, async (client) => {
      expect(await tableExists(client, 'tbl_a')).toBe(false);
      expect(await tableExists(client, 'tbl_b')).toBe(false);
    });
  });

  it('applies a low-`when` migration that follows a higher-`when` applied one (the core regression)', async () => {
    // 0001 has a *lower* timestamp than the already-applied 0000 — the exact
    // shape the stock watermark migrator skips.
    const folder = fixture([
      { tag: '0000_high', when: 5000, sql: 'CREATE TABLE tbl_high (id integer PRIMARY KEY);' },
      { tag: '0001_low', when: 1000, sql: 'CREATE TABLE tbl_low (id integer PRIMARY KEY);' },
    ]);
    const databaseName = await createScratchDatabase();

    await withClient(databaseName, async (client) => {
      await ensureLegacyTable(client);
      await seedLegacyRows(client, folder, 1); // 0000_high already applied
    });

    const result = await run(databaseName, folder);
    expect(result).toEqual({ applied: 1, skipped: 1 });

    await withClient(databaseName, async (client) => {
      expect(await tableExists(client, 'tbl_low')).toBe(true);
    });
  });

  it('warns and skips on hash drift instead of re-applying an edited migration', async () => {
    const databaseName = await createScratchDatabase();
    const original = fixture([{ tag: '0000_first', when: 1000, sql: 'CREATE TABLE tbl_a (id integer PRIMARY KEY);' }]);
    expect(await run(databaseName, original)).toEqual({ applied: 1, skipped: 0 });

    // Same tag, edited body => different hash. The runner stored a tag for the
    // first apply, so it can detect the drift.
    const edited = fixture([{ tag: '0000_first', when: 1000, sql: 'CREATE TABLE tbl_a (id integer PRIMARY KEY, extra integer);' }]);

    const warnings: string[] = [];
    const result = await run(databaseName, edited, { ...silentLogger, warn: (message) => warnings.push(message) });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(warnings.some((message) => message.includes('hash drift') && message.includes('0000_first'))).toBe(true);
  });
});
