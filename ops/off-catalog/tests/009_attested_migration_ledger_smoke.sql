\set ON_ERROR_STOP on

-- Prove that the runtime importer can attest only the exact, byte-for-byte
-- migration ledger used by this public revision. The ledger table itself
-- remains private, and every negative case must fail closed.
begin;

do $migration_ledger_metadata$
declare
  v_importer oid := (
    select role.oid
    from pg_catalog.pg_roles role
    where role.rolname = 'off_catalog_importer'
  );
  v_owner text;
  v_security_definer boolean;
  v_configuration text[];
begin
  select
    pg_catalog.pg_get_userbyid(procedure.proowner),
    procedure.prosecdef,
    procedure.proconfig
  into v_owner, v_security_definer, v_configuration
  from pg_catalog.pg_proc procedure
  where procedure.oid =
    'off_catalog.attest_schema_migration_ledger(text[],text[])'::regprocedure;

  if v_owner is distinct from 'off_catalog_owner'
     or v_security_definer is distinct from true then
    raise exception 'migration_ledger_function_security_mismatch';
  end if;
  if not coalesce(v_configuration, array[]::text[]) @> array[
    'search_path=""',
    'statement_timeout=5s',
    'lock_timeout=1s'
  ] then
    raise exception 'migration_ledger_function_configuration_mismatch: %',
      v_configuration;
  end if;
  if not pg_catalog.has_function_privilege(
    'off_catalog_importer',
    'off_catalog.attest_schema_migration_ledger(text[],text[])',
    'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'off_catalog_reader',
    'off_catalog.attest_schema_migration_ledger(text[],text[])',
    'EXECUTE'
  ) or exists (
    select 1
    from pg_catalog.pg_proc procedure
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) privilege
    where procedure.oid =
      'off_catalog.attest_schema_migration_ledger(text[],text[])'::regprocedure
      and privilege.privilege_type = 'EXECUTE'
      and (
        privilege.grantee not in (procedure.proowner, v_importer)
        or (
          privilege.grantee = v_importer
          and privilege.is_grantable
        )
      )
  ) then
    raise exception 'migration_ledger_function_acl_mismatch';
  end if;
  if pg_catalog.has_table_privilege(
    'off_catalog_importer', 'off_catalog.schema_migrations', 'SELECT'
  ) or pg_catalog.has_table_privilege(
    'off_catalog_reader', 'off_catalog.schema_migrations', 'SELECT'
  ) or exists (
    select 1
    from pg_catalog.pg_class relation
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) privilege
    where relation.oid = 'off_catalog.schema_migrations'::regclass
      and privilege.privilege_type = 'SELECT'
      and privilege.grantee <> relation.relowner
  ) or exists (
    select 1
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation
      on relation.oid = attribute.attrelid
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        attribute.attacl,
        pg_catalog.acldefault('c', relation.relowner)
      )
    ) privilege
    where relation.oid = 'off_catalog.schema_migrations'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and privilege.privilege_type = 'SELECT'
      and privilege.grantee <> relation.relowner
  ) then
    raise exception 'migration_ledger_table_acl_mismatch';
  end if;
end
$migration_ledger_metadata$;

set local role off_catalog_importer;

do $migration_ledger_importer_contract$
declare
  v_filenames text[] := array[
    '001_catalog_foundation.sql',
    '002_runtime_indexes.sql',
    '003_reader_search_privilege.sql',
    '004_resumable_initial_activation.sql',
    '005_verified_staging_seal.sql',
    '006_runtime_query_indexes.sql',
    '007_indexable_published_view.sql',
    '008_native_archive_reconstruction.sql',
    '009_reader_runtime_hardening.sql',
    '010_indexed_ranking_categories.sql',
    '011_sealed_reconstruction_resume.sql',
    '012_attested_migration_ledger.sql'
  ];
  v_sha256 text[] := array[
    '899a5d466941cc0a49e92435e18fdead186bde9a79fadb1d1daac52c7cac0eed',
    'ac47bef58a7ff766641ef42f20e9f58b3ecffb7591a46e5f48160f73246e91b5',
    'f80e730ff747ba5e3702337b6610a950f3a04fdf051f74e23995e844a08289f9',
    '6e0e44eb4893967422655dc0b3d1395e7c562e59ef1b80de89cbe57b345e6776',
    '6b1135f7b5f7968b8ea48d4183de0238d618675c653802c89ec7676ac843c24e',
    'f48c395a006a0089460133dc2a974f118ff300ce774b9fa2570381a6fe143404',
    '63b1cb8e173fd17281b6dcc1ea671e29f2dd79bde299fe872765ed483b45ceb7',
    '0cfa2a417af18664edf7648cad40a68ef3aafd3e3f06d7a027833e5b227d20d6',
    '88c6af7d8f36ec4519b9e98808b608c1f67b1f627a49c6fa9e3a1fac1255bf05',
    '1822888684b8b358d3e22e32e41dbc79105e0a4059225a68971a8f71a58f395e',
    '14fb606e2c185e55b684b82fb698accd3cca612fdcfce0169dd142e33cc416a1',
    '8c72fd1e1c6c01e31df8de8e3bffd1ed578db076d9260be27aeb5404ce3f21f5'
  ];
  v_bad_sha256 text[];
  v_verified boolean;
begin
  select off_catalog.attest_schema_migration_ledger(v_filenames, v_sha256)
  into v_verified;
  if v_verified is distinct from true then
    raise exception 'exact_migration_ledger_not_attested';
  end if;

  v_bad_sha256 := v_sha256;
  v_bad_sha256[1] := repeat('0', 64);
  begin
    perform off_catalog.attest_schema_migration_ledger(
      v_filenames, v_bad_sha256
    );
    raise exception 'migration_ledger_bad_hash_accepted';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'off_catalog_schema_migration_ledger_mismatch' then
        raise;
      end if;
  end;

  begin
    perform off_catalog.attest_schema_migration_ledger(
      v_filenames[1:11], v_sha256[1:11]
    );
    raise exception 'migration_ledger_missing_entry_accepted';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'off_catalog_schema_migration_ledger_mismatch' then
        raise;
      end if;
  end;

  begin
    perform off_catalog.attest_schema_migration_ledger(
      v_filenames || array['013_unexpected_migration.sql'],
      v_sha256 || array[repeat('f', 64)]
    );
    raise exception 'migration_ledger_extra_entry_accepted';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'off_catalog_schema_migration_ledger_mismatch' then
        raise;
      end if;
  end;

  begin
    perform pg_catalog.count(*) from off_catalog.schema_migrations;
    raise exception 'importer_read_private_migration_ledger';
  exception
    when insufficient_privilege then null;
  end;
end
$migration_ledger_importer_contract$;

reset role;
set local role off_catalog_reader;

do $migration_ledger_reader_contract$
begin
  begin
    perform off_catalog.attest_schema_migration_ledger(
      array['001_catalog_foundation.sql'],
      array[repeat('0', 64)]
    );
    raise exception 'reader_executed_migration_ledger_attestation';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform pg_catalog.count(*) from off_catalog.schema_migrations;
    raise exception 'reader_read_private_migration_ledger';
  exception
    when insufficient_privilege then null;
  end;
end
$migration_ledger_reader_contract$;

reset role;
rollback;
