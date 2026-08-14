begin;

create extension if not exists pgtap;
set local search_path = off_catalog, public;

select plan(47);

select has_table('off_catalog', 'datasets', 'OFF dataset metadata exists');
select has_table('off_catalog', 'import_jobs', 'OFF import jobs exist');
select has_table('off_catalog', 'products_staging', 'OFF staging exists');
select has_table('off_catalog', 'products_current', 'OFF runtime table exists');
select has_table('off_catalog', 'delta_state', 'OFF delta cursor exists');
select has_view('off_catalog', 'products_published', 'OFF publication boundary exists');
select ok(
  to_regclass('off_catalog.products_current_search_trgm_idx') is not null,
  'normalized text-search index exists'
);
select ok(
  to_regclass('off_catalog.products_current_ranking_category_idx') is not null,
  'ranking-category browse index exists'
);
select ok(
  to_regclass('off_catalog.products_current_search_vector_idx') is null,
  'unused full-text index is absent'
);
select ok(
  to_regclass('off_catalog.products_current_brand_idx') is null,
  'unused standalone brand index is absent'
);
select ok(
  to_regclass('off_catalog.products_current_updated_idx') is null,
  'unused source-update index is absent'
);

select ok(
  not exists (
    select 1
    from information_schema.tables table_info
    where table_info.table_schema = 'off_catalog'
      and table_info.table_name in (
        'profiles', 'reviews', 'favorites', 'scans', 'reports',
        'moderation_actions', 'product_submissions', 'product_rating_aggregates'
      )
  ),
  'OFF database has no Notons private or community tables'
);
select ok(
  not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'off_catalog'
      and column_info.table_name in ('products_current', 'products_staging')
      and column_info.column_name in (
        'product_id', 'user_id', 'profile_id', 'review_id', 'submitted_by',
        'average_overall_5', 'review_count', 'would_buy_again_percentage'
      )
  ),
  'OFF product projection has no Notons identity or aggregate column'
);

select ok(has_schema_privilege('off_catalog_reader', 'off_catalog', 'USAGE'), 'reader can use OFF schema');
select ok(has_table_privilege('off_catalog_reader', 'off_catalog.products_published', 'SELECT'), 'reader sees published projection');
select ok(not has_table_privilege('off_catalog_reader', 'off_catalog.products_current', 'SELECT'), 'reader cannot bypass publication boundary');
select ok(not has_table_privilege('off_catalog_reader', 'off_catalog.products_current', 'INSERT'), 'reader cannot mutate runtime projection');
select ok(not has_table_privilege('off_catalog_reader', 'off_catalog.products_staging', 'SELECT'), 'reader cannot inspect staging');
select ok(has_table_privilege('off_catalog_importer', 'off_catalog.products_staging', 'INSERT'), 'importer can stage OFF rows');
select ok(not has_table_privilege('off_catalog_importer', 'off_catalog.products_current', 'SELECT'), 'importer cannot list runtime projection');
select ok(not has_table_privilege('public', 'off_catalog.products_current', 'SELECT'), 'PUBLIC cannot list OFF catalogue');
select ok(
  has_function_privilege('off_catalog_reader', 'off_catalog.normalize_search_text(text)', 'EXECUTE'),
  'reader may execute the bounded search normalizer'
);
select lives_ok(
  $$set local role off_catalog_reader;
    select off_catalog.normalize_search_text('Chips barbecue');
    reset role$$,
  'the real reader role can normalize a catalogue search'
);
select ok(
  has_function_privilege('off_catalog_importer', 'off_catalog.prepare_initial_activation(uuid)', 'EXECUTE'),
  'importer may prepare resumable activation'
);
select ok(
  has_function_privilege('off_catalog_importer', 'off_catalog.activate_initial_dataset_batch(uuid,integer)', 'EXECUTE'),
  'importer may commit one activation batch'
);
select ok(
  has_function_privilege('off_catalog_importer', 'off_catalog.finalize_initial_activation(uuid)', 'EXECUTE'),
  'importer may finalize verified activation'
);
select ok(
  not has_function_privilege('off_catalog_reader', 'off_catalog.prepare_initial_activation(uuid)', 'EXECUTE'),
  'reader cannot prepare activation'
);
select ok(
  not has_function_privilege('off_catalog_reader', 'off_catalog.activate_initial_dataset_batch(uuid,integer)', 'EXECUTE'),
  'reader cannot run activation batches'
);
select ok(
  not has_function_privilege('off_catalog_reader', 'off_catalog.finalize_initial_activation(uuid)', 'EXECUTE'),
  'reader cannot finalize activation'
);
select ok(
  not has_function_privilege('public', 'off_catalog.prepare_initial_activation(uuid)', 'EXECUTE'),
  'PUBLIC cannot prepare activation'
);
select ok(
  not has_function_privilege('public', 'off_catalog.activate_initial_dataset_batch(uuid,integer)', 'EXECUTE'),
  'PUBLIC cannot run activation batches'
);
select ok(
  not has_function_privilege('public', 'off_catalog.finalize_initial_activation(uuid)', 'EXECUTE'),
  'PUBLIC cannot finalize activation'
);

insert into off_catalog.datasets (
  id, source_url, source_filename, source_sha256,
  importer_version, projection_version, import_contract,
  staged_rows, status
) values (
  '90000000-0000-4000-8000-000000000001',
  'https://static.openfoodfacts.org/data/test.csv.gz',
  'test.csv.gz', repeat('a', 64), 'test-v1', 'test-v1', '{}'::jsonb,
  2, 'copying'
);
insert into off_catalog.products_staging (
  dataset_id, barcode, canonical_gtin, name, brand,
  open_food_facts_url, image_front_url
) values (
  '90000000-0000-4000-8000-000000000001',
  '4006381333931', off_catalog.normalize_gtin('4006381333931'),
  'Produit OFF test', 'Marque OFF',
  'https://world.openfoodfacts.org/product/4006381333931',
  'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_fr.400.jpg'
), (
  '90000000-0000-4000-8000-000000000001',
  '3017620422003', off_catalog.normalize_gtin('3017620422003'),
  'Deuxième produit OFF', 'Deuxième marque',
  'https://world.openfoodfacts.org/product/3017620422003',
  'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_fr.400.jpg'
);

select throws_ok(
  $$insert into off_catalog.products_staging (
      dataset_id, barcode, canonical_gtin, name, open_food_facts_url
    ) values (
      '90000000-0000-4000-8000-000000000001',
      '036000291452', off_catalog.normalize_gtin('036000291452'),
      'Mauvaise URL', 'https://example.com/not-off'
    )$$,
  '23514',
  null,
  'non-OFF external URL is rejected'
);

update off_catalog.datasets
set status = 'staged'
where id = '90000000-0000-4000-8000-000000000001';
do $seal_fixture$
declare
  v_fingerprint text;
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
  where dataset_id = '90000000-0000-4000-8000-000000000001';
  perform off_catalog.seal_staged_dataset(
    '90000000-0000-4000-8000-000000000001',
    v_fingerprint, 2
  );
end
$seal_fixture$;

select is((select count(*) from off_catalog.products_published), 0::bigint, 'staged rows are unpublished');
select is(
  off_catalog.prepare_initial_activation('90000000-0000-4000-8000-000000000001'),
  0::bigint,
  'initial activation starts at an empty checkpoint'
);
select is(
  (select status from off_catalog.datasets where id = '90000000-0000-4000-8000-000000000001'),
  'activating',
  'dataset enters activating state'
);
select is(
  off_catalog.activate_initial_dataset_batch('90000000-0000-4000-8000-000000000001', 1),
  1::bigint,
  'first activation batch commits one row'
);
select is((select count(*) from off_catalog.products_published), 0::bigint, 'partial activation stays unpublished');
-- Simulate an owner-side storage inconsistency without weakening the sealed
-- dataset guard that correctly rejects direct importer/admin mutations.
set local role off_catalog_owner;
update off_catalog.datasets
set activation_cursor = off_catalog.normalize_gtin('4006381333931')
where id = '90000000-0000-4000-8000-000000000001';
reset role;
select throws_ok(
  $$select off_catalog.activate_initial_dataset_batch('90000000-0000-4000-8000-000000000001', 1)$$,
  '55000', 'activation_checkpoint_mismatch',
  'batch rejects a missing indexed runtime checkpoint without publishing'
);
set local role off_catalog_owner;
update off_catalog.datasets
set activation_cursor = (
  select max(canonical_gtin) from off_catalog.products_current
  where dataset_id = '90000000-0000-4000-8000-000000000001'
)
where id = '90000000-0000-4000-8000-000000000001';
reset role;
select is(
  off_catalog.activate_initial_dataset_batch('90000000-0000-4000-8000-000000000001', 1),
  2::bigint,
  'second activation batch resumes after the checkpoint'
);
select is(
  off_catalog.finalize_initial_activation('90000000-0000-4000-8000-000000000001'),
  2::bigint,
  'final fingerprint publishes the complete dataset'
);
select is((select count(*) from off_catalog.products_current), 2::bigint, 'physical projection contains both OFF rows');
select is((select count(*) from off_catalog.products_published), 2::bigint, 'publication boundary exposes the complete generation');
select is(
  (select name from off_catalog.products_published where canonical_gtin = off_catalog.normalize_gtin('4006381333931')),
  'Produit OFF test',
  'published projection contains the OFF product'
);
select is(
  (select status from off_catalog.datasets where id = '90000000-0000-4000-8000-000000000001'),
  'active',
  'dataset becomes active atomically'
);
select throws_ok(
  $$select off_catalog.activate_dataset('90000000-0000-4000-8000-000000000001')$$,
  '0A000', 'use_resumable_initial_activation',
  'monolithic activation is disabled'
);
select throws_ok(
  $$select off_catalog.finalize_initial_activation('90000000-0000-4000-8000-000000000001')$$,
  '55000', 'dataset_not_activating',
  'published dataset cannot be finalized twice'
);

-- Make plain psql + ON_ERROR_STOP a real gate: pgTAP otherwise prints
-- `not ok` while still returning a successful process exit code.
select * from finish(true);
rollback;
