\set ON_ERROR_STOP on

-- Exercise the exact activation wrappers used by the native reconstruction
-- command. Everything is rolled back so CI never retains fixture rows or DDL.
begin;

insert into off_catalog.datasets (
  id, source_url, source_filename, source_sha256,
  importer_version, projection_version, import_contract,
  staged_rows, status
) values (
  '98000000-0000-4000-8000-000000000001',
  'https://static.openfoodfacts.org/data/notons-native-wrapper-smoke.csv.gz',
  'notons-native-wrapper-smoke.csv.gz', repeat('8', 64),
  'native-wrapper-smoke-v1', 'native-wrapper-smoke-v1', '{}'::jsonb,
  2, 'copying'
);

insert into off_catalog.products_staging (
  dataset_id, barcode, canonical_gtin, name, brand, ingredients_text,
  off_category_tags, open_food_facts_url
) values (
  '98000000-0000-4000-8000-000000000001',
  '3017620422003', off_catalog.normalize_gtin('3017620422003'),
  'Produit wrapper boisson', 'Marque smoke', 'Eau, sucre, citron', array['en:beverages'],
  'https://world.openfoodfacts.org/product/3017620422003'
), (
  '98000000-0000-4000-8000-000000000001',
  '4006381333931', off_catalog.normalize_gtin('4006381333931'),
  'Produit wrapper laitier', 'Marque smoke', null, array['en:dairies'],
  'https://world.openfoodfacts.org/product/4006381333931'
);

update off_catalog.datasets
set status = 'staged'
where id = '98000000-0000-4000-8000-000000000001';

with fingerprint as (
  select count(*)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 8675309)::numeric), 0)::text as value
  from off_catalog.products_staging staged
  where dataset_id = '98000000-0000-4000-8000-000000000001'
)
select off_catalog.seal_staged_dataset(
  '98000000-0000-4000-8000-000000000001', value, 2
)
from fingerprint;

set local role off_catalog_importer;
do $native_wrapper_activation$
declare
  v_count bigint;
begin
  select off_catalog.begin_native_reconstruction_activation(
    '98000000-0000-4000-8000-000000000001'
  ) into v_count;
  if v_count <> 0 then
    raise exception 'native_wrapper_begin_checkpoint_mismatch: %', v_count;
  end if;

  select off_catalog.activate_initial_dataset_batch(
    '98000000-0000-4000-8000-000000000001', 100000
  ) into v_count;
  if v_count <> 2 then
    raise exception 'native_wrapper_batch_checkpoint_mismatch: %', v_count;
  end if;

  select off_catalog.finalize_native_reconstruction(
    '98000000-0000-4000-8000-000000000001'
  ) into v_count;
  if v_count <> 2 then
    raise exception 'native_wrapper_finalize_count_mismatch: %', v_count;
  end if;
end
$native_wrapper_activation$;
reset role;

set local role off_catalog_reader;
do $native_wrapper_publication$
declare
  v_count bigint;
begin
  select count(*) into v_count
  from off_catalog.products_published
  where canonical_gtin in (
    '03017620422003',
    '04006381333931'
  );
  if v_count <> 2 then
    raise exception 'native_wrapper_publication_mismatch: %', v_count;
  end if;
  if (
    select ingredients_text
    from off_catalog.products_published
    where canonical_gtin = '03017620422003'
  ) is distinct from 'Eau, sucre, citron' then
    raise exception 'native_wrapper_ingredients_publication_mismatch';
  end if;
end
$native_wrapper_publication$;
reset role;

rollback;
