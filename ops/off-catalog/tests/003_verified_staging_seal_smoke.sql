\set ON_ERROR_STOP on

begin;

do $acl_checks$
begin
  if has_table_privilege(
    'off_catalog_importer', 'off_catalog.products_staging', 'UPDATE'
  ) or has_table_privilege(
    'off_catalog_importer', 'off_catalog.products_staging', 'DELETE'
  ) then
    raise exception 'seal_acl_importer_can_rewrite_staging';
  end if;
  if not has_table_privilege(
    'off_catalog_importer', 'off_catalog.products_staging', 'INSERT'
  ) then
    raise exception 'seal_acl_importer_cannot_copy_unsealed_staging';
  end if;
  if not has_function_privilege(
    'off_catalog_importer',
    'off_catalog.normalize_gtin(text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'off_catalog_importer',
    'off_catalog.open_food_facts_url_is_valid(text)',
    'EXECUTE'
  ) then
    raise exception 'seal_acl_importer_cannot_evaluate_staging_constraints';
  end if;
  if has_function_privilege(
    'off_catalog_reader',
    'off_catalog.normalize_gtin(text)',
    'EXECUTE'
  ) or has_function_privilege(
    'off_catalog_reader',
    'off_catalog.open_food_facts_url_is_valid(text)',
    'EXECUTE'
  ) then
    raise exception 'seal_acl_reader_can_execute_import_validators';
  end if;
  if has_table_privilege(
    'off_catalog_importer', 'off_catalog.datasets', 'DELETE'
  ) then
    raise exception 'seal_acl_importer_can_delete_dataset';
  end if;
  if has_function_privilege(
    'off_catalog_importer',
    'off_catalog.seal_staged_dataset(uuid,text,bigint)',
    'EXECUTE'
  ) then
    raise exception 'seal_acl_importer_can_forge_source_attestation';
  end if;
  if has_function_privilege(
    'off_catalog_reader',
    'off_catalog.seal_staged_dataset(uuid,text,bigint)',
    'EXECUTE'
  ) or has_function_privilege(
    'public',
    'off_catalog.seal_staged_dataset(uuid,text,bigint)',
    'EXECUTE'
  ) then
    raise exception 'seal_acl_untrusted_role_can_seal';
  end if;
end
$acl_checks$;

insert into off_catalog.datasets (
  id, source_url, source_filename, source_sha256,
  importer_version, projection_version, import_contract,
  expected_rows, staged_rows, status
) values (
  '93000000-0000-4000-8000-000000000001',
  'https://static.openfoodfacts.org/data/notons-seal-smoke.csv.gz',
  'notons-seal-smoke.csv.gz', repeat('c', 64),
  'seal-smoke-v1', 'seal-smoke-v1', '{}'::jsonb,
  1, 1, 'copying'
);

set local role off_catalog_importer;
insert into off_catalog.products_staging (
  dataset_id, barcode, canonical_gtin, name, brand, open_food_facts_url
) values (
  '93000000-0000-4000-8000-000000000001',
  '3017620422003', '03017620422003',
  'Produit OFF scellé', 'Marque OFF',
  'https://world.openfoodfacts.org/product/3017620422003'
);
reset role;

update off_catalog.datasets
set status = 'staged'
where id = '93000000-0000-4000-8000-000000000001';

do $seal_and_guards$
declare
  v_fingerprint text;
  v_verified_at timestamptz;
begin
  select count(*)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 8675309)::numeric), 0)::text
  into v_fingerprint
  from off_catalog.products_staging staged
  where dataset_id = '93000000-0000-4000-8000-000000000001';

  begin
    perform off_catalog.seal_staged_dataset(
      '93000000-0000-4000-8000-000000000001',
      '1|0|0', 1
    );
    raise exception 'seal_mismatch_was_accepted';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'verification_fingerprint_mismatch' then
        raise exception 'seal_mismatch_wrong_error: %', sqlerrm;
      end if;
  end;

  select off_catalog.seal_staged_dataset(
    '93000000-0000-4000-8000-000000000001',
    v_fingerprint, 1
  ) into v_verified_at;

  if v_verified_at is null or not exists (
    select 1 from off_catalog.datasets dataset
    where dataset.id = '93000000-0000-4000-8000-000000000001'
      and dataset.source_fingerprint = v_fingerprint
      and dataset.source_fingerprint_verified_at = v_verified_at
      and dataset.status = 'staged'
  ) then
    raise exception 'seal_was_not_persisted';
  end if;

  begin
    insert into off_catalog.products_staging (
      dataset_id, barcode, canonical_gtin, name
    ) values (
      '93000000-0000-4000-8000-000000000001',
      '4006381333931', '04006381333931',
      'Mutation interdite'
    );
    raise exception 'sealed_staging_insert_was_accepted';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'verified_staging_is_immutable' then
        raise exception 'sealed_staging_insert_wrong_error: %', sqlerrm;
      end if;
  end;

  begin
    update off_catalog.products_staging
    set name = 'Mutation interdite'
    where dataset_id = '93000000-0000-4000-8000-000000000001';
    raise exception 'sealed_staging_update_was_accepted';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'verified_staging_is_immutable' then
        raise exception 'sealed_staging_update_wrong_error: %', sqlerrm;
      end if;
  end;

  begin
    delete from off_catalog.products_staging
    where dataset_id = '93000000-0000-4000-8000-000000000001';
    raise exception 'sealed_staging_delete_was_accepted';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'verified_staging_is_immutable' then
        raise exception 'sealed_staging_delete_wrong_error: %', sqlerrm;
      end if;
  end;
end
$seal_and_guards$;

do $adoption_not_delegated$
begin
  if has_function_privilege(
    'off_catalog_importer',
    'off_catalog.adopt_existing_verified_activation(uuid,text,text,bigint)',
    'EXECUTE'
  ) or has_function_privilege(
    'off_catalog_reader',
    'off_catalog.adopt_existing_verified_activation(uuid,text,text,bigint)',
    'EXECUTE'
  ) or has_function_privilege(
    'public',
    'off_catalog.adopt_existing_verified_activation(uuid,text,text,bigint)',
    'EXECUTE'
  ) then
    raise exception 'recovery_adoption_was_delegated';
  end if;
end
$adoption_not_delegated$;

-- Reproduce a dataset that migration 004 had already moved to `activating`
-- before migration 005 introduced its NOT VALID seal constraint. The recovery
-- function must be able to add the seal while keeping the partial checkpoint,
-- but no untrusted runtime role may invoke that exception path.
insert into off_catalog.datasets (
  id, source_url, source_filename, source_sha256,
  importer_version, projection_version, import_contract,
  expected_rows, staged_rows, status
) values (
  '93000000-0000-4000-8000-000000000002',
  'https://static.openfoodfacts.org/data/notons-adoption-smoke.csv.gz',
  'notons-adoption-smoke.csv.gz', repeat('d', 64),
  'adoption-smoke-v1', 'adoption-smoke-v1', '{}'::jsonb,
  2, 2, 'copying'
);

set local role off_catalog_importer;
insert into off_catalog.products_staging (
  dataset_id, barcode, canonical_gtin, name, brand, open_food_facts_url
) values
  (
    '93000000-0000-4000-8000-000000000002',
    '4006381333931', '04006381333931',
    'Produit adoption A', 'Marque OFF',
    'https://world.openfoodfacts.org/product/4006381333931'
  ),
  (
    '93000000-0000-4000-8000-000000000002',
    '5449000000996', '05449000000996',
    'Produit adoption B', 'Marque OFF',
    'https://world.openfoodfacts.org/product/5449000000996'
  );
reset role;

alter table off_catalog.datasets
  drop constraint datasets_activation_requires_verified_source;
update off_catalog.datasets
set status = 'activating'
where id = '93000000-0000-4000-8000-000000000002';
select off_catalog.activate_initial_dataset_batch(
  '93000000-0000-4000-8000-000000000002', 1
);
alter table off_catalog.datasets
  add constraint datasets_activation_requires_verified_source check (
    status not in ('activating', 'active') or source_fingerprint is not null
  ) not valid;

do $adopt_existing_activation$
declare
  v_fingerprint text;
  v_verified_at timestamptz;
  v_activated_rows bigint;
begin
  select count(*)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 8675309)::numeric), 0)::text
  into v_fingerprint
  from off_catalog.products_staging staged
  where dataset_id = '93000000-0000-4000-8000-000000000002';

  select dataset.activated_rows into v_activated_rows
  from off_catalog.datasets dataset
  where dataset.id = '93000000-0000-4000-8000-000000000002';
  if v_activated_rows <> 1 then
    raise exception 'legacy_partial_activation_fixture_failed';
  end if;

  begin
    perform off_catalog.adopt_existing_verified_activation(
      '93000000-0000-4000-8000-000000000002',
      null, v_fingerprint, 2
    );
    raise exception 'null_source_sha_was_accepted';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'source_sha256_mismatch' then
        raise exception 'null_source_sha_wrong_error: %', sqlerrm;
      end if;
  end;

  begin
    perform off_catalog.adopt_existing_verified_activation(
      '93000000-0000-4000-8000-000000000002',
      repeat('d', 64), v_fingerprint, null
    );
    raise exception 'null_expected_rows_was_accepted';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'verification_row_count_mismatch' then
        raise exception 'null_expected_rows_wrong_error: %', sqlerrm;
      end if;
  end;

  select off_catalog.adopt_existing_verified_activation(
    '93000000-0000-4000-8000-000000000002',
    repeat('d', 64), v_fingerprint, 2
  ) into v_verified_at;

  if v_verified_at is null or not exists (
    select 1
    from off_catalog.datasets dataset
    where dataset.id = '93000000-0000-4000-8000-000000000002'
      and dataset.status = 'activating'
      and dataset.activated_rows = 1
      and dataset.source_fingerprint = v_fingerprint
      and dataset.source_fingerprint_verified_at = v_verified_at
  ) then
    raise exception 'existing_activation_was_not_adopted';
  end if;

  select off_catalog.prepare_initial_activation(
    '93000000-0000-4000-8000-000000000002'
  ) into v_activated_rows;
  if v_activated_rows <> 1 then
    raise exception 'adopted_activation_did_not_resume_from_checkpoint';
  end if;

  begin
    perform off_catalog.adopt_existing_verified_activation(
      '93000000-0000-4000-8000-000000000002',
      repeat('d', 64), v_fingerprint, 2
    );
    raise exception 'sealed_activation_was_readopted';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'activation_not_adoptable' then
        raise exception 'readoption_wrong_error: %', sqlerrm;
      end if;
  end;
end
$adopt_existing_activation$;

do $no_rehash_on_resume$
declare
  v_prepare_definition text;
  v_finalize_definition text;
  v_prepare_compact text;
begin
  select pg_get_functiondef(
    'off_catalog.prepare_initial_activation(uuid)'::regprocedure
  ) into v_prepare_definition;
  select pg_get_functiondef(
    'off_catalog.finalize_initial_activation(uuid)'::regprocedure
  ) into v_finalize_definition;
  v_prepare_compact := regexp_replace(lower(v_prepare_definition), '[[:space:]]+', '', 'g');

  if v_prepare_compact like '%count(*)%products_staging%' then
    raise exception 'prepare_rehashes_or_recounts_staging';
  end if;
  if v_finalize_definition ~* 'v_staging_fingerprint' then
    raise exception 'finalizer_rehashes_staging';
  end if;
  if v_finalize_definition !~* 'source_fingerprint' then
    raise exception 'finalizer_does_not_use_durable_seal';
  end if;
end
$no_rehash_on_resume$;

rollback;
