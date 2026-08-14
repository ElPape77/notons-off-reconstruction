#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { Client } from 'pg';

import { loadOffCatalogAdminDatabaseUrl } from './off-database-url.js';

const loadLocalEnvironment = (invocationDirectory: string): void => {
  try {
    loadEnvFile(resolve(invocationDirectory, '.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const bootstrapSql = `
set password_encryption = 'scram-sha-256';
do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'off_catalog_owner') then
    create role off_catalog_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'off_catalog_importer') then
    create role off_catalog_importer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'off_catalog_reader') then
    create role off_catalog_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end
$roles$;
alter role off_catalog_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication;
alter role off_catalog_importer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role off_catalog_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
do $reader_memberships$
declare
  v_reader oid := (
    select role.oid
    from pg_catalog.pg_roles role
    where role.rolname = 'off_catalog_reader'
  );
begin
  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = v_reader
       or membership.member = v_reader
  ) then
    raise exception 'off_catalog_reader_role_membership_forbidden';
  end if;
end
$reader_memberships$;
revoke all on database notons_off_catalog from public;
grant connect on database notons_off_catalog to off_catalog_owner, off_catalog_importer, off_catalog_reader;
alter database notons_off_catalog owner to off_catalog_owner;
set role off_catalog_owner;
create schema if not exists off_catalog authorization off_catalog_owner;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
revoke all on schema public from public;
revoke all on schema off_catalog from public;
create table if not exists off_catalog.schema_migrations (
  filename text primary key,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default clock_timestamp()
);
alter table off_catalog.schema_migrations owner to off_catalog_owner;
revoke all on off_catalog.schema_migrations from public, off_catalog_importer, off_catalog_reader;
reset role;
alter role off_catalog_reader in database notons_off_catalog set statement_timeout = '5s';
alter role off_catalog_reader in database notons_off_catalog set lock_timeout = '1s';
alter role off_catalog_reader in database notons_off_catalog set idle_in_transaction_session_timeout = '5s';
alter role off_catalog_reader in database notons_off_catalog set transaction_timeout = '8s';
alter role off_catalog_reader in database notons_off_catalog set default_transaction_read_only = 'on';
`;

async function run(): Promise<void> {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  loadLocalEnvironment(invocationDirectory);
  const connectionString = await loadOffCatalogAdminDatabaseUrl(invocationDirectory);
  if (!connectionString) {
    throw new Error(
      'OFF_CATALOG_ADMIN_DATABASE_URL ou OFF_CATALOG_ADMIN_DATABASE_URL_FILE est obligatoire.',
    );
  }
  const migrationsDirectory = fileURLToPath(
    new URL('../../../ops/off-catalog/migrations/', import.meta.url),
  );
  const migrationDirectoryStats = await lstat(migrationsDirectory);
  if (!migrationDirectoryStats.isDirectory() || migrationDirectoryStats.isSymbolicLink()) {
    throw new Error('Le répertoire des migrations OFF est absent ou non sûr.');
  }
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  if (filenames.length === 0) throw new Error('Aucune migration OFF n’a été trouvée.');
  for (const filename of filenames) {
    if (!/^\d{3}_[a-z0-9_-]+\.sql$/.test(filename)) {
      throw new Error(`Nom de migration OFF non sûr : ${filename}`);
    }
    const migrationStats = await lstat(resolve(migrationsDirectory, filename));
    if (!migrationStats.isFile() || migrationStats.isSymbolicLink()) {
      throw new Error(`Migration OFF absente ou non sûre : ${filename}`);
    }
  }
  const migrationNumbers = filenames.map((filename) => Number(filename.slice(0, 3)));
  if (
    new Set(migrationNumbers).size !== migrationNumbers.length ||
    migrationNumbers.some((number, index) => number !== index + 1)
  ) {
    throw new Error('La séquence des migrations OFF est incomplète ou ambiguë.');
  }

  const client = new Client({
    connectionString,
    application_name: 'notons-off-empty-database-init',
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const identity = await client.query<{ database_name: string }>(
      `select current_database() as database_name
       from pg_catalog.pg_database
       where datname = current_database()
         and datallowconn
         and datconnlimit <> -2
         and not datistemplate`,
    );
    if (identity.rows[0]?.database_name !== 'notons_off_catalog') {
      throw new Error('L’initialiseur refuse toute base autre que notons_off_catalog.');
    }
    const foreignRelation = await client.query<{ qualified_name: string }>(
      `select pg_catalog.format('%I.%I', namespace.nspname, relation.relname) as qualified_name
       from pg_catalog.pg_class relation
       join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname not in ('pg_catalog', 'information_schema', 'off_catalog')
         and namespace.nspname !~ '^pg_toast'
         and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
       order by namespace.nspname, relation.relname
       limit 1`,
    );
    if (foreignRelation.rows[0]) {
      throw new Error(
        `La base OFF n’est pas isolée : relation étrangère ${foreignRelation.rows[0].qualified_name}.`,
      );
    }
    const untrackedOffRelation = await client.query<{ qualified_name: string }>(
      `select pg_catalog.format('%I.%I', namespace.nspname, relation.relname) as qualified_name
       from pg_catalog.pg_class relation
       join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'off_catalog'
         and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
         and pg_catalog.to_regclass('off_catalog.schema_migrations') is null
       order by relation.relname
       limit 1`,
    );
    if (untrackedOffRelation.rows[0]) {
      throw new Error(
        `La base OFF n’est ni vide ni initialisée : ${untrackedOffRelation.rows[0].qualified_name}.`,
      );
    }
    await client.query('begin');
    try {
      await client.query(bootstrapSql);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }

    let applied = 0;
    for (const filename of filenames) {
      const migrationBytes = await readFile(resolve(migrationsDirectory, filename));
      const contents = migrationBytes.toString('utf8');
      // The ledger identifies the exact checked-out file, not a newline-normalised
      // variant. That makes its value identical to the public manifest checksum.
      const sha256 = createHash('sha256').update(migrationBytes).digest('hex');
      const recorded = await client.query<{ sha256: string }>(
        'select sha256 from off_catalog.schema_migrations where filename = $1',
        [filename],
      );
      if (recorded.rows[0]) {
        if (recorded.rows[0].sha256 !== sha256) {
          throw new Error(`Migration OFF déjà appliquée mais modifiée : ${filename}`);
        }
        continue;
      }

      await client.query('begin');
      try {
        await client.query('set local role off_catalog_owner');
        await client.query(contents);
        await client.query('reset role');
        await client.query(
          'insert into off_catalog.schema_migrations(filename, sha256) values ($1, $2)',
          [filename, sha256],
        );
        await client.query('commit');
        applied += 1;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }

    process.stdout.write(
      `${JSON.stringify({ database: 'notons_off_catalog', migrations: filenames.length, applied })}\n`,
    );
  } finally {
    await client.end();
  }
}

new Command()
  .name('notons-off-init')
  .description(
    'Initialise exclusivement une base PostgreSQL vide nommée notons_off_catalog et applique ses migrations',
  )
  .showHelpAfterError()
  .action(run)
  .parseAsync()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Erreur d’initialisation OFF : ${message}\n`);
    process.exitCode = 1;
  });
