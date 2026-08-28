\set ON_ERROR_STOP on

begin;

do $privileges$
begin
  if has_function_privilege(
    'off_catalog_reader',
    'off_catalog.find_sealed_native_reconstruction(text,text,text,timestamptz,timestamptz,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'sealed_reconstruction_probe_exposed_to_reader';
  end if;
  if not has_function_privilege(
    'off_catalog_importer',
    'off_catalog.find_sealed_native_reconstruction(text,text,text,timestamptz,timestamptz,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'sealed_reconstruction_probe_missing_for_importer';
  end if;
end
$privileges$;

set local role off_catalog_importer;

select dataset_id as resume_dataset_id, job_id as resume_job_id
from off_catalog.begin_native_reconstruction(
  'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz',
  'catalog.tsv.gz',
  repeat('a', 64),
  '2026-08-11T00:00:00Z'::timestamptz,
  '2026-08-11T12:00:00Z'::timestamptz,
  'catalog-import/1',
  'off-projection/1',
  jsonb_build_object(
    'pipeline', 'notons-off-reconstruction/1',
    'mapper', 'open-food-facts',
    'scope', jsonb_build_object(
      'allCountries', true,
      'allCategories', true,
      'fullSnapshot', true
    ),
    'sourceHeader', jsonb_build_array('code', 'product_name'),
    'immutableCodeUrl',
      'https://code.example/notons/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'codeRevision', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ),
  false
)
\gset

do $copying_is_never_reused$
begin
  if exists (
    select 1
    from off_catalog.find_sealed_native_reconstruction(
      'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz',
      'catalog.tsv.gz', repeat('a', 64),
      '2026-08-11T00:00:00Z'::timestamptz,
      '2026-08-11T12:00:00Z'::timestamptz,
      'catalog-import/1', 'off-projection/1',
      'https://code.example/notons/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  ) then
    raise exception 'copying_reconstruction_was_reused';
  end if;
end
$copying_is_never_reused$;

select off_catalog.commit_native_reconstruction_batch(
  :'resume_dataset_id'::uuid,
  :'resume_job_id'::uuid,
  1,
  1,
  0,
  0,
  '[{"barcode":"3017620422003","canonical_gtin":"03017620422003","name":"Produit test","ingredients_text":"Sucre, noisettes, cacao"}]'::jsonb
);

do $ingredients_were_staged$
begin
  if (
    select ingredients_text
    from off_catalog.products_staging
    where dataset_id = (
      select id from off_catalog.datasets where source_sha256 = repeat('a', 64)
    )
      and canonical_gtin = '03017620422003'
  ) is distinct from 'Sucre, noisettes, cacao' then
    raise exception 'native_reconstruction_ingredients_not_staged';
  end if;
end
$ingredients_were_staged$;

select *
from off_catalog.seal_native_reconstruction(
  :'resume_dataset_id'::uuid,
  :'resume_job_id'::uuid,
  1,
  1,
  0,
  0
);

do $sealed_is_reused$
declare
  v_session record;
begin
  select * into v_session
  from off_catalog.find_sealed_native_reconstruction(
    'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz',
    'catalog.tsv.gz', repeat('a', 64),
    '2026-08-11T00:00:00Z'::timestamptz,
    '2026-08-11T12:00:00Z'::timestamptz,
    'catalog-import/1', 'off-projection/1',
    'https://code.example/notons/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  if v_session.status <> 'staged'
     or v_session.source_offset <> 1
     or v_session.processed_rows <> 1
     or v_session.staged_rows <> 1
     or v_session.source_fingerprint is null then
    raise exception 'sealed_reconstruction_probe_mismatch: %', row_to_json(v_session);
  end if;

  begin
    perform off_catalog.find_sealed_native_reconstruction(
      'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz',
      'catalog.tsv.gz', repeat('a', 64),
      '2026-08-11T00:00:00Z'::timestamptz,
      '2026-08-11T12:00:00Z'::timestamptz,
      'catalog-import/1', 'off-projection/changed',
      'https://code.example/notons/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    raise exception 'sealed_contract_mismatch_was_accepted';
  exception
    when sqlstate '22023' then null;
  end;
end
$sealed_is_reused$;

reset role;
rollback;
