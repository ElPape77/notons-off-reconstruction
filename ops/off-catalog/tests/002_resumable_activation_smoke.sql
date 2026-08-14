\set ON_ERROR_STOP on

begin;

do $acl_checks$
begin
  if not has_schema_privilege('off_catalog_reader', 'off_catalog', 'USAGE') then
    raise exception 'smoke_acl_reader_schema_missing';
  end if;
  if not has_table_privilege(
    'off_catalog_reader', 'off_catalog.products_published', 'SELECT'
  ) then
    raise exception 'smoke_acl_reader_publication_missing';
  end if;
  if has_table_privilege(
    'off_catalog_reader', 'off_catalog.products_current', 'SELECT'
  ) then
    raise exception 'smoke_acl_reader_bypasses_publication';
  end if;
  if has_table_privilege(
    'off_catalog_reader', 'off_catalog.products_staging', 'SELECT'
  ) then
    raise exception 'smoke_acl_reader_sees_staging';
  end if;
  if not has_function_privilege(
    'off_catalog_importer',
    'off_catalog.prepare_initial_activation(uuid)',
    'EXECUTE'
  ) or not has_function_privilege(
    'off_catalog_importer',
    'off_catalog.activate_initial_dataset_batch(uuid,integer)',
    'EXECUTE'
  ) or not has_function_privilege(
    'off_catalog_importer',
    'off_catalog.finalize_initial_activation(uuid)',
    'EXECUTE'
  ) then
    raise exception 'smoke_acl_importer_activation_missing';
  end if;
  if has_function_privilege(
    'off_catalog_importer', 'off_catalog.activate_dataset(uuid)', 'EXECUTE'
  ) then
    raise exception 'smoke_acl_monolithic_activation_available';
  end if;
  if has_function_privilege(
    'off_catalog_reader',
    'off_catalog.prepare_initial_activation(uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'off_catalog_reader',
    'off_catalog.activate_initial_dataset_batch(uuid,integer)',
    'EXECUTE'
  ) or has_function_privilege(
    'off_catalog_reader',
    'off_catalog.finalize_initial_activation(uuid)',
    'EXECUTE'
  ) then
    raise exception 'smoke_acl_reader_can_activate';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) privilege
    where procedure.oid in (
      'off_catalog.prepare_initial_activation(uuid)'::regprocedure,
      'off_catalog.activate_initial_dataset_batch(uuid,integer)'::regprocedure,
      'off_catalog.finalize_initial_activation(uuid)'::regprocedure
    )
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ) then
    raise exception 'smoke_acl_public_can_activate';
  end if;
end
$acl_checks$;

insert into off_catalog.datasets (
  id, source_url, source_filename, source_sha256,
  importer_version, projection_version, import_contract,
  staged_rows, status
) values (
  '92000000-0000-4000-8000-000000000001',
  'https://static.openfoodfacts.org/data/notons-native-smoke.csv.gz',
  'notons-native-smoke.csv.gz', repeat('b', 64),
  'native-smoke-v1', 'native-smoke-v1', '{}'::jsonb,
  2, 'copying'
);

insert into off_catalog.products_staging (
  dataset_id, barcode, canonical_gtin, name, brand,
  open_food_facts_url, image_front_url
) values (
  '92000000-0000-4000-8000-000000000001',
  '3017620422003', off_catalog.normalize_gtin('3017620422003'),
  'Produit OFF smoke un', 'Marque OFF',
  'https://world.openfoodfacts.org/product/3017620422003',
  'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_fr.400.jpg'
), (
  '92000000-0000-4000-8000-000000000001',
  '4006381333931', off_catalog.normalize_gtin('4006381333931'),
  'Produit OFF smoke deux', 'Marque OFF',
  'https://world.openfoodfacts.org/product/4006381333931',
  'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_fr.400.jpg'
);

update off_catalog.datasets
set status = 'staged'
where id = '92000000-0000-4000-8000-000000000001';
with fingerprint as (
  select count(*)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 8675309)::numeric), 0)::text as value
  from off_catalog.products_staging staged
  where dataset_id = '92000000-0000-4000-8000-000000000001'
)
select off_catalog.seal_staged_dataset(
  '92000000-0000-4000-8000-000000000001', value, 2
)
from fingerprint;

set local role off_catalog_importer;
do $prepare_and_first_batch$
declare
  v_count bigint;
begin
  select off_catalog.prepare_initial_activation(
    '92000000-0000-4000-8000-000000000001'
  ) into v_count;
  if v_count <> 0 then
    raise exception 'smoke_prepare_checkpoint_mismatch: %', v_count;
  end if;

  select off_catalog.activate_initial_dataset_batch(
    '92000000-0000-4000-8000-000000000001', 1
  ) into v_count;
  if v_count <> 1 then
    raise exception 'smoke_first_batch_checkpoint_mismatch: %', v_count;
  end if;
end
$prepare_and_first_batch$;
reset role;

set local role off_catalog_reader;
do $partial_invisible$
declare
  v_count bigint;
begin
  select count(*) into v_count from off_catalog.products_published;
  if v_count <> 0 then
    raise exception 'smoke_partial_dataset_was_published: %', v_count;
  end if;
end
$partial_invisible$;
reset role;

set local role off_catalog_importer;
do $resume_second_batch$
declare
  v_count bigint;
begin
  select off_catalog.prepare_initial_activation(
    '92000000-0000-4000-8000-000000000001'
  ) into v_count;
  if v_count <> 1 then
    raise exception 'smoke_resume_checkpoint_mismatch: %', v_count;
  end if;

  select off_catalog.activate_initial_dataset_batch(
    '92000000-0000-4000-8000-000000000001', 1
  ) into v_count;
  if v_count <> 2 then
    raise exception 'smoke_second_batch_checkpoint_mismatch: %', v_count;
  end if;
end
$resume_second_batch$;
reset role;

-- A schema-only recovery can deliberately omit the post-load runtime indexes.
-- Build both query-backed indexes inside this rollback-only transaction so the finalizer guard
-- is tested without depending on the state of the database used for the smoke.
create index if not exists products_current_search_trgm_idx
  on off_catalog.products_current using gin (search_text gin_trgm_ops);
create index if not exists products_current_ranking_category_idx
  on off_catalog.products_current (
    off_catalog.ranking_category_slug(off_category_tags, category_slug),
    canonical_gtin
  ) where is_active;

set local role off_catalog_importer;
do $finalize_after_indexes$
declare
  v_count bigint;
begin
  select off_catalog.finalize_initial_activation(
    '92000000-0000-4000-8000-000000000001'
  ) into v_count;
  if v_count <> 2 then
    raise exception 'smoke_finalize_count_mismatch: %', v_count;
  end if;
end
$finalize_after_indexes$;
reset role;

set local role off_catalog_reader;
do $published_complete$
declare
  v_count bigint;
begin
  select count(*) into v_count from off_catalog.products_published;
  if v_count <> 2 then
    raise exception 'smoke_published_count_mismatch: %', v_count;
  end if;
end
$published_complete$;
reset role;

do $monolithic_disabled$
begin
  begin
    perform off_catalog.activate_dataset(
      '92000000-0000-4000-8000-000000000001'
    );
    raise exception 'smoke_monolithic_activation_did_not_fail';
  exception
    when sqlstate '0A000' then
      if sqlerrm <> 'use_resumable_initial_activation' then
        raise exception 'smoke_monolithic_activation_wrong_error: %', sqlerrm;
      end if;
  end;
end
$monolithic_disabled$;

rollback;
