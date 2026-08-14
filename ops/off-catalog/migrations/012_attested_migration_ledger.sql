-- The runtime importer cannot read schema_migrations directly. Expose only a
-- boolean, fail-closed attestation that proves the database was initialised by
-- the exact migration files from the current public Git revision.

create function off_catalog.attest_schema_migration_ledger(
  p_filenames text[],
  p_sha256 text[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '1s'
as $$
declare
  v_expected_count integer;
begin
  if p_filenames is null
     or p_sha256 is null
     or coalesce(pg_catalog.array_ndims(p_filenames), 0) <> 1
     or coalesce(pg_catalog.array_ndims(p_sha256), 0) <> 1
     or pg_catalog.cardinality(p_filenames) <> pg_catalog.cardinality(p_sha256)
     or pg_catalog.array_lower(p_filenames, 1) <> pg_catalog.array_lower(p_sha256, 1)
     or pg_catalog.array_upper(p_filenames, 1) <> pg_catalog.array_upper(p_sha256, 1)
     or pg_catalog.cardinality(p_filenames) not between 1 and 1000 then
    raise exception using
      errcode = '22023', message = 'off_catalog_schema_migration_ledger_input_invalid';
  end if;

  select pg_catalog.count(*)::integer into v_expected_count
  from pg_catalog.generate_subscripts(p_filenames, 1) as expected(index)
  where p_filenames[expected.index] is null
     or p_filenames[expected.index] !~ '^[0-9]{3}_[a-z0-9_-]+\.sql$'
     or p_sha256[expected.index] is null
     or p_sha256[expected.index] !~ '^[0-9a-f]{64}$';
  if v_expected_count <> 0 then
    raise exception using
      errcode = '22023', message = 'off_catalog_schema_migration_ledger_input_invalid';
  end if;

  select pg_catalog.count(*)::integer into v_expected_count
  from (
    select p_filenames[expected.index] as filename
    from pg_catalog.generate_subscripts(p_filenames, 1) as expected(index)
    group by p_filenames[expected.index]
    having pg_catalog.count(*) <> 1
  ) duplicates;
  if v_expected_count <> 0 then
    raise exception using
      errcode = '22023', message = 'off_catalog_schema_migration_ledger_input_invalid';
  end if;

  if exists (
    with expected as (
      select
        p_filenames[expected.index] as filename,
        p_sha256[expected.index] as sha256
      from pg_catalog.generate_subscripts(p_filenames, 1) as expected(index)
    )
    select 1
    from expected
    full join off_catalog.schema_migrations actual using (filename)
    where expected.filename is null
       or actual.filename is null
       or expected.sha256 <> actual.sha256
  ) then
    raise exception using
      errcode = '55000', message = 'off_catalog_schema_migration_ledger_mismatch';
  end if;

  return true;
end;
$$;

revoke all on function off_catalog.attest_schema_migration_ledger(
  text[], text[]
) from public, off_catalog_reader, off_catalog_importer;

grant execute on function off_catalog.attest_schema_migration_ledger(
  text[], text[]
) to off_catalog_importer;

comment on function off_catalog.attest_schema_migration_ledger(
  text[], text[]
) is 'Fail-closed attestation that the isolated OFF database migration ledger exactly matches the current public reconstruction sources.';
