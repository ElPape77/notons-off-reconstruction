import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.OFF_CATALOG_ADMIN_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('OFF_CATALOG_ADMIN_DATABASE_URL is required.');
if (process.env.OFF_CATALOG_DISPOSABLE_READER_LOGIN_SMOKE !== '1') {
  throw new Error(
    'Authenticated reader smoke refused: set OFF_CATALOG_DISPOSABLE_READER_LOGIN_SMOKE=1 only for a disposable OFF database.',
  );
}

const testsDirectory = path.join(root, 'ops', 'off-catalog', 'tests');
const discoveredNativeTests = readdirSync(testsDirectory)
  .filter((filename) => /^\d{3}_[a-z0-9_.-]+_smoke\.sql$/.test(filename))
  .sort();
const expectedNativeTests = [
  '002_resumable_activation_smoke.sql',
  '003_verified_staging_seal_smoke.sql',
  '004_indexable_published_view_smoke.sql',
  '005_reader_runtime_hardening_smoke.sql',
  '006_indexed_ranking_categories_smoke.sql',
  '007_sealed_reconstruction_resume_smoke.sql',
  '008_native_activation_wrappers_smoke.sql',
  '009_attested_migration_ledger_smoke.sql',
  '010_off_allergens_projection_smoke.sql',
];
if (JSON.stringify(discoveredNativeTests) !== JSON.stringify(expectedNativeTests)) {
  throw new Error('The expected OFF catalogue test inventory is incomplete or ambiguous.');
}
const tests = ['001_catalog_separation.test.sql', ...expectedNativeTests];
const readerRole = 'off_catalog_reader';

const adminClient = (applicationName) =>
  new pg.Client({
    connectionString: databaseUrl,
    application_name: applicationName,
    connectionTimeoutMillis: 10_000,
  });

const verifyAuthenticatedReaderSession = async () => {
  const failures = [];
  const password = randomBytes(32).toString('hex');
  const readerUrl = new URL(databaseUrl);
  readerUrl.username = readerRole;
  readerUrl.password = password;

  const administrator = adminClient('notons-off-reader-runtime-smoke-admin');
  let restorationRequired = false;
  try {
    await administrator.connect();
    const initialRole = await administrator.query(
      `select rolcanlogin, rolpassword is null as password_is_null
       from pg_catalog.pg_authid
       where rolname = 'off_catalog_reader'`,
    );
    if (
      initialRole.rows.length !== 1 ||
      initialRole.rows[0]?.rolcanlogin !== false ||
      initialRole.rows[0]?.password_is_null !== true
    ) {
      throw new Error(
        'Disposable reader smoke refuses to overwrite a role unless it starts as NOLOGIN PASSWORD NULL.',
      );
    }

    await administrator.query("set password_encryption = 'scram-sha-256'");
    // Set before ALTER: a lost connection can make its outcome ambiguous, so
    // the independent finally connection must restore the role in that case.
    restorationRequired = true;
    await administrator.query(`alter role off_catalog_reader login password '${password}'`);
    const activatedRole = await administrator.query(
      `select rolcanlogin, rolpassword like 'SCRAM-SHA-256$%' as password_is_scram
       from pg_catalog.pg_authid
       where rolname = 'off_catalog_reader'`,
    );
    if (
      activatedRole.rows.length !== 1 ||
      activatedRole.rows[0]?.rolcanlogin !== true ||
      activatedRole.rows[0]?.password_is_scram !== true
    ) {
      throw new Error('off_catalog_reader did not receive a temporary SCRAM credential.');
    }

    const reader = new pg.Client({
      connectionString: readerUrl.toString(),
      application_name: 'notons-off-reader-runtime-smoke-exact-login',
      connectionTimeoutMillis: 10_000,
    });
    try {
      await reader.connect();
      const runtime = await reader.query(
        `select
           session_user as session_user_name,
           current_user as current_user_name,
           current_setting('statement_timeout') as statement_timeout,
           current_setting('lock_timeout') as lock_timeout,
           current_setting('idle_in_transaction_session_timeout')
             as idle_in_transaction_session_timeout,
           current_setting('transaction_timeout') as transaction_timeout,
           current_setting('default_transaction_read_only')
             as default_transaction_read_only,
           current_setting('transaction_read_only') as transaction_read_only`,
      );
      const settings = runtime.rows[0];
      const expectedSettings = {
        statement_timeout: '5s',
        lock_timeout: '1s',
        idle_in_transaction_session_timeout: '5s',
        transaction_timeout: '8s',
        default_transaction_read_only: 'on',
        transaction_read_only: 'on',
      };
      if (
        settings?.session_user_name !== readerRole ||
        settings?.current_user_name !== readerRole ||
        Object.entries(expectedSettings).some(([name, expected]) => settings?.[name] !== expected)
      ) {
        throw new Error(
          `Authenticated reader runtime contract mismatch: ${JSON.stringify(settings)}.`,
        );
      }

      await reader.query('select canonical_gtin from off_catalog.products_published limit 1');
    } finally {
      await reader.end();
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (restorationRequired) {
      // Use a fresh administrative connection so an ambiguous failure on the
      // first connection cannot leave a password-bearing LOGIN role behind.
      const restoration = adminClient('notons-off-reader-runtime-smoke-restore');
      try {
        await restoration.connect();
        await restoration.query('alter role off_catalog_reader nologin password null');
        const restoredRole = await restoration.query(
          `select rolcanlogin, rolpassword is null as password_is_null
           from pg_catalog.pg_authid
           where rolname = 'off_catalog_reader'`,
        );
        if (
          restoredRole.rows.length !== 1 ||
          restoredRole.rows[0]?.rolcanlogin !== false ||
          restoredRole.rows[0]?.password_is_null !== true
        ) {
          throw new Error('off_catalog_reader was not restored to NOLOGIN PASSWORD NULL.');
        }
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await restoration.end();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    try {
      await administrator.end();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Authenticated OFF reader smoke failed.');
  }
};

for (const filename of tests) {
  execFileSync(
    'psql',
    [
      databaseUrl,
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--file',
      path.join(testsDirectory, filename),
    ],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
}

await verifyAuthenticatedReaderSession();

console.log(
  `OFF catalogue smoke tests passed on the disposable database: ${tests.length} files and one authenticated reader session.`,
);
