\set ON_ERROR_STOP on

-- Exercise the complete bounded allergen projection without retaining fixture
-- rows. This covers JSON batch decoding, staging, fingerprinting, activation,
-- publication and the reader/importer privilege boundary.
begin;

do $projection_contract$
declare
  v_column_count integer;
begin
  select count(*) into v_column_count
  from pg_catalog.pg_attribute attribute
  where attribute.attrelid in (
      'off_catalog.products_staging'::regclass,
      'off_catalog.products_current'::regclass,
      'off_catalog.products_published'::regclass
    )
    and attribute.attname = 'allergens'
    and attribute.atttypid = 'text[]'::regtype
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if v_column_count <> 3 then
    raise exception 'off_allergens_columns_missing: %', v_column_count;
  end if;
  if has_table_privilege(
       'off_catalog_reader', 'off_catalog.products_current', 'SELECT'
     )
     or not has_table_privilege(
       'off_catalog_reader', 'off_catalog.products_published', 'SELECT'
     )
     or has_table_privilege(
       'off_catalog_importer', 'off_catalog.products_published', 'SELECT'
     ) then
    raise exception 'off_allergens_acl_mismatch';
  end if;
  if not has_function_privilege(
    'off_catalog_importer',
    'off_catalog.commit_native_reconstruction_batch(uuid,uuid,bigint,bigint,bigint,bigint,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'off_catalog_reader',
    'off_catalog.commit_native_reconstruction_batch(uuid,uuid,bigint,bigint,bigint,bigint,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'off_allergens_function_acl_mismatch';
  end if;
end
$projection_contract$;

set local role off_catalog_importer;

select dataset_id as allergens_dataset_id, job_id as allergens_job_id
from off_catalog.begin_native_reconstruction(
  'https://static.openfoodfacts.org/data/notons-allergens-smoke.csv.gz',
  'notons-allergens-smoke.csv.gz',
  repeat('e', 64),
  '2026-08-28T00:00:00Z'::timestamptz,
  '2026-08-28T01:00:00Z'::timestamptz,
  'catalog-import/allergens-smoke',
  'off-projection/allergens-smoke',
  jsonb_build_object(
    'pipeline', 'notons-off-reconstruction/1',
    'mapper', 'open-food-facts',
    'scope', jsonb_build_object(
      'allCountries', true,
      'allCategories', true,
      'fullSnapshot', true
    ),
    'sourceHeader', jsonb_build_array(
      'code', 'product_name', 'ingredients_text', 'allergens'
    ),
    'immutableCodeUrl',
      'https://code.example/notons/tree/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'codeRevision', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  ),
  false
)
\gset

do $allergens_bounds$
declare
  v_dataset_id uuid;
  v_job_id uuid;
begin
  select dataset.id, job.id into v_dataset_id, v_job_id
  from off_catalog.datasets dataset
  join off_catalog.import_jobs job on job.dataset_id = dataset.id
  where dataset.source_sha256 = repeat('e', 64);

  begin
    perform off_catalog.commit_native_reconstruction_batch(
      v_dataset_id,
      v_job_id,
      1, 1, 0, 0,
      jsonb_build_array(jsonb_build_object(
        'barcode', '3017620422003',
        'canonical_gtin', '03017620422003',
        'name', 'Produit allergenes invalide',
        'allergens', to_jsonb(array(
          select 'Allergene ' || value::text from generate_series(1, 65) value
        ))
      ))
    );
    raise exception 'off_allergens_bound_not_enforced';
  exception
    when check_violation then null;
  end;
end
$allergens_bounds$;

select off_catalog.commit_native_reconstruction_batch(
  :'allergens_dataset_id'::uuid,
  :'allergens_job_id'::uuid,
  1, 1, 0, 0,
  '[{"barcode":"3017620422003","canonical_gtin":"03017620422003","name":"Produit allergenes","ingredients_text":"Lait, noisettes","allergens":["Lait","Noisettes"]}]'::jsonb
);

do $allergens_staged$
declare
  v_dataset_id uuid;
begin
  select id into v_dataset_id
  from off_catalog.datasets
  where source_sha256 = repeat('e', 64);

  if (
    select allergens
    from off_catalog.products_staging
    where dataset_id = v_dataset_id
      and canonical_gtin = '03017620422003'
  ) is distinct from array['Lait', 'Noisettes']::text[] then
    raise exception 'off_allergens_staging_mismatch';
  end if;
end
$allergens_staged$;

select *
from off_catalog.seal_native_reconstruction(
  :'allergens_dataset_id'::uuid,
  :'allergens_job_id'::uuid,
  1, 1, 0, 0
);

select off_catalog.begin_native_reconstruction_activation(
  :'allergens_dataset_id'::uuid
);
select off_catalog.activate_initial_dataset_batch(
  :'allergens_dataset_id'::uuid, 100000
);
select off_catalog.finalize_native_reconstruction(
  :'allergens_dataset_id'::uuid
);

reset role;
set local role off_catalog_reader;

do $allergens_published$
begin
  if (
    select allergens
    from off_catalog.products_published
    where canonical_gtin = '03017620422003'
  ) is distinct from array['Lait', 'Noisettes']::text[] then
    raise exception 'off_allergens_publication_mismatch';
  end if;
end
$allergens_published$;

reset role;
rollback;
