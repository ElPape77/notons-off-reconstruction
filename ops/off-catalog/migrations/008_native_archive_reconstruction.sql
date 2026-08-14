-- Native, resumable reconstruction from an official OFF archive directly into
-- the isolated catalogue. No function in this migration can address Notons
-- Core, and the runtime view stays empty until the final fingerprint check.

alter table off_catalog.import_jobs
  add column source_offset bigint not null default 0,
  add column processed_rows bigint not null default 0,
  add column filtered_rows bigint not null default 0;

alter table off_catalog.import_jobs
  add constraint import_jobs_native_counters_nonnegative check (
    source_offset >= 0 and processed_rows >= 0 and filtered_rows >= 0
  ),
  add constraint import_jobs_native_counter_order check (
    processed_rows >= rejected_rows + filtered_rows
  );

create unique index import_jobs_one_native_reconstruction_idx
  on off_catalog.import_jobs (dataset_id)
  where worker_key = 'native_archive_v1';

create or replace function off_catalog.begin_native_reconstruction(
  p_source_url text,
  p_source_filename text,
  p_source_sha256 text,
  p_source_published_at timestamptz,
  p_source_retrieved_at timestamptz,
  p_importer_version text,
  p_projection_version text,
  p_import_contract jsonb,
  p_resume boolean
)
returns table (
  dataset_id uuid,
  job_id uuid,
  status text,
  source_offset bigint,
  processed_rows bigint,
  staged_rows bigint,
  rejected_rows bigint,
  filtered_rows bigint,
  source_fingerprint text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_job off_catalog.import_jobs;
begin
  if p_source_url is null
     or p_source_url !~ '^https://(static|world)\.openfoodfacts\.org/'
     or p_source_filename is null
     or char_length(trim(p_source_filename)) not between 1 and 255
     or p_source_filename ~ '[\\/]'
     or p_source_sha256 is null
     or p_source_sha256 !~ '^[0-9a-f]{64}$'
     or p_source_published_at is null
     or p_source_retrieved_at is null
     or p_source_retrieved_at < p_source_published_at
     or p_importer_version is null
     or char_length(trim(p_importer_version)) not between 1 and 120
     or p_projection_version is null
     or char_length(trim(p_projection_version)) not between 1 and 120
     or p_import_contract is null
     or jsonb_typeof(p_import_contract) is distinct from 'object'
     or p_import_contract ->> 'pipeline' is distinct from 'notons-off-reconstruction/1'
     or p_import_contract ->> 'mapper' is distinct from 'open-food-facts'
     -- PL/pgSQL reads an IF expression up to the first top-level THEN. Keep
     -- this SQL CASE below a parenthesis level so its THEN cannot terminate
     -- the surrounding IF expression during function compilation.
     or (
       case
         when jsonb_typeof(p_import_contract -> 'sourceHeader') = 'array'
           then jsonb_array_length(p_import_contract -> 'sourceHeader') not between 2 and 1000
         else true
       end
     )
     or exists (
       select 1
       from jsonb_array_elements_text(
         case
           when jsonb_typeof(p_import_contract -> 'sourceHeader') = 'array'
             then p_import_contract -> 'sourceHeader'
           else '[]'::jsonb
         end
       ) as header(column_name)
       where char_length(header.column_name) not between 1 and 200
     )
     or (
       select coalesce(sum(octet_length(header.column_name)), 0) > 131072
       from jsonb_array_elements_text(
         case
           when jsonb_typeof(p_import_contract -> 'sourceHeader') = 'array'
             then p_import_contract -> 'sourceHeader'
           else '[]'::jsonb
         end
       ) as header(column_name)
     )
     or (
       select count(*) <> count(distinct lower(header.column_name))
       from jsonb_array_elements_text(
         case
           when jsonb_typeof(p_import_contract -> 'sourceHeader') = 'array'
             then p_import_contract -> 'sourceHeader'
           else '[]'::jsonb
         end
       ) as header(column_name)
     )
     or coalesce(p_import_contract ->> 'codeRevision', '') !~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
     or coalesce(p_import_contract ->> 'immutableCodeUrl', '') !~ '^https://'
     or lower(p_import_contract ->> 'immutableCodeUrl') !~ (
       '(^|[^0-9a-f])' || (p_import_contract ->> 'codeRevision') || '([^0-9a-f]|$)'
     )
     or p_import_contract #>> '{scope,allCountries}' is distinct from 'true'
     or p_import_contract #>> '{scope,allCategories}' is distinct from 'true'
     or p_import_contract #>> '{scope,fullSnapshot}' is distinct from 'true' then
    raise exception using errcode = '22023', message = 'native_reconstruction_metadata_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('off_catalog.native_archive_reconstruction', 0)
  );
  select dataset.* into v_dataset
  from off_catalog.datasets dataset
  where dataset.source_sha256 = p_source_sha256
  for update;

  if v_dataset.id is null then
    insert into off_catalog.datasets (
      provider_key, source_name, source_url, source_filename, source_sha256,
      source_published_at, source_retrieved_at, license_name, license_url,
      importer_version, projection_version, import_contract, status
    ) values (
      'open_food_facts', 'Open Food Facts', p_source_url, trim(p_source_filename),
      p_source_sha256, p_source_published_at, p_source_retrieved_at, 'ODbL 1.0',
      'https://opendatacommons.org/licenses/odbl/1-0/', trim(p_importer_version),
      trim(p_projection_version), p_import_contract, 'copying'
    ) returning * into v_dataset;

    insert into off_catalog.import_jobs (
      dataset_id, worker_key, status, started_at
    ) values (
      v_dataset.id, 'native_archive_v1', 'running', clock_timestamp()
    ) returning * into v_job;
  else
    if v_dataset.provider_key <> 'open_food_facts'
       or v_dataset.source_url <> p_source_url
       or v_dataset.source_filename <> trim(p_source_filename)
       or v_dataset.source_published_at is distinct from p_source_published_at
       or v_dataset.source_retrieved_at is distinct from p_source_retrieved_at
       or v_dataset.importer_version <> trim(p_importer_version)
       or v_dataset.projection_version <> trim(p_projection_version)
       or v_dataset.import_contract <> p_import_contract then
      raise exception using errcode = '22023', message = 'native_reconstruction_contract_mismatch';
    end if;

    select job.* into v_job
    from off_catalog.import_jobs job
    where job.dataset_id = v_dataset.id
      and job.worker_key = 'native_archive_v1'
    for update;
    if v_job.id is null then
      raise exception using errcode = '55000', message = 'native_reconstruction_job_missing';
    end if;
    if v_dataset.status not in ('copying', 'staged', 'activating', 'active') then
      raise exception using errcode = '55000', message = 'native_reconstruction_status_invalid';
    end if;
    if not p_resume
       and v_dataset.status <> 'active'
       and (v_job.source_offset > 0 or v_dataset.status <> 'copying') then
      raise exception using errcode = '55000', message = 'native_reconstruction_resume_required';
    end if;
    if p_resume and v_dataset.status = 'copying' then
      update off_catalog.import_jobs
      set status = 'running', error_message = null, updated_at = clock_timestamp()
      where id = v_job.id
      returning * into v_job;
    end if;
  end if;

  return query select
    v_dataset.id,
    v_job.id,
    v_dataset.status,
    v_job.source_offset,
    v_job.processed_rows,
    v_dataset.staged_rows,
    v_job.rejected_rows,
    v_job.filtered_rows,
    v_dataset.source_fingerprint;
end;
$$;

create or replace function off_catalog.commit_native_reconstruction_batch(
  p_dataset_id uuid,
  p_job_id uuid,
  p_source_offset bigint,
  p_processed_rows bigint,
  p_rejected_rows bigint,
  p_filtered_rows bigint,
  p_products jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_job off_catalog.import_jobs;
  v_product_count integer;
  v_valid_occurrences bigint;
begin
  if jsonb_typeof(p_products) <> 'array'
     or p_source_offset < 1
     or p_processed_rows < 1
     or p_rejected_rows < 0
     or p_filtered_rows < 0
     or p_processed_rows < p_rejected_rows + p_filtered_rows then
    raise exception using errcode = '22023', message = 'native_reconstruction_checkpoint_invalid';
  end if;
  v_product_count := jsonb_array_length(p_products);
  if v_product_count > 1000 then
    raise exception using errcode = '22023', message = 'native_reconstruction_batch_too_large';
  end if;

  select dataset.* into v_dataset
  from off_catalog.datasets dataset
  where dataset.id = p_dataset_id
  for update;
  select job.* into v_job
  from off_catalog.import_jobs job
  where job.id = p_job_id and job.dataset_id = p_dataset_id
  for update;
  if v_dataset.id is null or v_job.id is null then
    raise exception using errcode = 'P0002', message = 'native_reconstruction_session_not_found';
  end if;
  if v_dataset.status <> 'copying'
     or v_dataset.source_fingerprint is not null
     or v_job.worker_key <> 'native_archive_v1'
     or v_job.status <> 'running'
     or p_source_offset <= v_job.source_offset
     or p_processed_rows <= v_job.processed_rows
     or p_rejected_rows < v_job.rejected_rows
     or p_filtered_rows < v_job.filtered_rows then
    raise exception using errcode = '55000', message = 'native_reconstruction_checkpoint_not_monotonic';
  end if;

  insert into off_catalog.products_staging as staged (
    dataset_id, barcode, canonical_gtin, name, generic_name, brand, quantity,
    packaging, category_slug, source_product_id, source_updated_at,
    source_image_url, off_categories, off_category_tags, countries,
    country_tags, stores, purchase_places, nutriscore_grade, nutriscore_score,
    environmental_score_grade, environmental_score_score, serving_size,
    nutriments, energy_kj_100g, energy_kcal_100g, fat_100g,
    saturated_fat_100g, carbohydrates_100g, sugars_100g, fiber_100g,
    proteins_100g, salt_100g, sodium_100g, energy_kj_serving,
    energy_kcal_serving, fat_serving, saturated_fat_serving,
    carbohydrates_serving, sugars_serving, fiber_serving, proteins_serving,
    salt_serving, sodium_serving, open_food_facts_url,
    image_front_thumb_url, image_front_small_url, image_front_url,
    image_front_original_url, off_last_modified_at, off_last_updated_at
  )
  select
    p_dataset_id, product.barcode, product.canonical_gtin, product.name,
    product.generic_name, product.brand, product.quantity, product.packaging,
    product.category_slug, product.source_product_id, product.source_updated_at,
    product.source_image_url, product.off_categories, product.off_category_tags,
    product.countries, product.country_tags, product.stores,
    product.purchase_places, product.nutriscore_grade, product.nutriscore_score,
    product.environmental_score_grade, product.environmental_score_score,
    product.serving_size, product.nutriments, product.energy_kj_100g,
    product.energy_kcal_100g, product.fat_100g, product.saturated_fat_100g,
    product.carbohydrates_100g, product.sugars_100g, product.fiber_100g,
    product.proteins_100g, product.salt_100g, product.sodium_100g,
    product.energy_kj_serving, product.energy_kcal_serving, product.fat_serving,
    product.saturated_fat_serving, product.carbohydrates_serving,
    product.sugars_serving, product.fiber_serving, product.proteins_serving,
    product.salt_serving, product.sodium_serving, product.open_food_facts_url,
    product.image_front_thumb_url, product.image_front_small_url,
    product.image_front_url, product.image_front_original_url,
    product.off_last_modified_at, product.off_last_updated_at
  from jsonb_to_recordset(p_products) as product (
    barcode text, canonical_gtin text, name text, generic_name text, brand text,
    quantity text, packaging text, category_slug text, source_product_id text,
    source_updated_at timestamptz, source_image_url text, off_categories text[],
    off_category_tags text[], countries text[], country_tags text[], stores text[],
    purchase_places text[], nutriscore_grade text, nutriscore_score smallint,
    environmental_score_grade text, environmental_score_score smallint,
    serving_size text, nutriments jsonb, energy_kj_100g numeric,
    energy_kcal_100g numeric, fat_100g numeric, saturated_fat_100g numeric,
    carbohydrates_100g numeric, sugars_100g numeric, fiber_100g numeric,
    proteins_100g numeric, salt_100g numeric, sodium_100g numeric,
    energy_kj_serving numeric, energy_kcal_serving numeric, fat_serving numeric,
    saturated_fat_serving numeric, carbohydrates_serving numeric,
    sugars_serving numeric, fiber_serving numeric, proteins_serving numeric,
    salt_serving numeric, sodium_serving numeric, open_food_facts_url text,
    image_front_thumb_url text, image_front_small_url text, image_front_url text,
    image_front_original_url text, off_last_modified_at timestamptz,
    off_last_updated_at timestamptz
  )
  on conflict (dataset_id, canonical_gtin) do update set
    barcode = excluded.barcode,
    name = excluded.name,
    generic_name = excluded.generic_name,
    brand = excluded.brand,
    quantity = excluded.quantity,
    packaging = excluded.packaging,
    category_slug = excluded.category_slug,
    source_product_id = excluded.source_product_id,
    source_updated_at = excluded.source_updated_at,
    source_image_url = excluded.source_image_url,
    off_categories = excluded.off_categories,
    off_category_tags = excluded.off_category_tags,
    countries = excluded.countries,
    country_tags = excluded.country_tags,
    stores = excluded.stores,
    purchase_places = excluded.purchase_places,
    nutriscore_grade = excluded.nutriscore_grade,
    nutriscore_score = excluded.nutriscore_score,
    environmental_score_grade = excluded.environmental_score_grade,
    environmental_score_score = excluded.environmental_score_score,
    serving_size = excluded.serving_size,
    nutriments = excluded.nutriments,
    energy_kj_100g = excluded.energy_kj_100g,
    energy_kcal_100g = excluded.energy_kcal_100g,
    fat_100g = excluded.fat_100g,
    saturated_fat_100g = excluded.saturated_fat_100g,
    carbohydrates_100g = excluded.carbohydrates_100g,
    sugars_100g = excluded.sugars_100g,
    fiber_100g = excluded.fiber_100g,
    proteins_100g = excluded.proteins_100g,
    salt_100g = excluded.salt_100g,
    sodium_100g = excluded.sodium_100g,
    energy_kj_serving = excluded.energy_kj_serving,
    energy_kcal_serving = excluded.energy_kcal_serving,
    fat_serving = excluded.fat_serving,
    saturated_fat_serving = excluded.saturated_fat_serving,
    carbohydrates_serving = excluded.carbohydrates_serving,
    sugars_serving = excluded.sugars_serving,
    fiber_serving = excluded.fiber_serving,
    proteins_serving = excluded.proteins_serving,
    salt_serving = excluded.salt_serving,
    sodium_serving = excluded.sodium_serving,
    open_food_facts_url = excluded.open_food_facts_url,
    image_front_thumb_url = excluded.image_front_thumb_url,
    image_front_small_url = excluded.image_front_small_url,
    image_front_url = excluded.image_front_url,
    image_front_original_url = excluded.image_front_original_url,
    off_last_modified_at = excluded.off_last_modified_at,
    off_last_updated_at = excluded.off_last_updated_at,
    staged_at = clock_timestamp();

  v_valid_occurrences := p_processed_rows - p_rejected_rows - p_filtered_rows;
  update off_catalog.import_jobs
  set source_offset = p_source_offset,
      processed_rows = p_processed_rows,
      copied_rows = v_valid_occurrences,
      rejected_rows = p_rejected_rows,
      filtered_rows = p_filtered_rows,
      updated_at = clock_timestamp()
  where id = p_job_id;
  update off_catalog.datasets
  set rejected_rows = p_rejected_rows, updated_at = clock_timestamp()
  where id = p_dataset_id;
  return v_valid_occurrences;
end;
$$;

create or replace function off_catalog.seal_native_reconstruction(
  p_dataset_id uuid,
  p_job_id uuid,
  p_source_offset bigint,
  p_processed_rows bigint,
  p_rejected_rows bigint,
  p_filtered_rows bigint
)
returns table (staged_rows bigint, source_fingerprint text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_job off_catalog.import_jobs;
  v_staged_rows bigint;
  v_fingerprint text;
begin
  select dataset.* into v_dataset
  from off_catalog.datasets dataset where dataset.id = p_dataset_id for update;
  -- Keep the global lock order identical to batch commits (dataset row, then
  -- staging relation) so sealing cannot deadlock a concurrent final batch.
  lock table off_catalog.products_staging in share mode;
  select job.* into v_job
  from off_catalog.import_jobs job
  where job.id = p_job_id and job.dataset_id = p_dataset_id for update;
  if v_dataset.id is null or v_job.id is null then
    raise exception using errcode = 'P0002', message = 'native_reconstruction_session_not_found';
  end if;
  if v_dataset.source_fingerprint is not null then
    if v_dataset.status not in ('staged', 'activating', 'active') then
      raise exception using errcode = '55000', message = 'native_reconstruction_seal_status_invalid';
    end if;
    return query select v_dataset.staged_rows, v_dataset.source_fingerprint;
    return;
  end if;
  if v_dataset.status <> 'copying'
     or v_job.worker_key <> 'native_archive_v1'
     or v_job.source_offset <> p_source_offset
     or v_job.processed_rows <> p_processed_rows
     or v_job.rejected_rows <> p_rejected_rows
     or v_job.filtered_rows <> p_filtered_rows
     or p_processed_rows < 1
     or p_processed_rows < p_rejected_rows + p_filtered_rows then
    raise exception using errcode = '55000', message = 'native_reconstruction_final_checkpoint_mismatch';
  end if;
  if p_rejected_rows::numeric / p_processed_rows::numeric > 0.20 then
    raise exception using errcode = '22023', message = 'native_reconstruction_rejection_ratio_too_high';
  end if;

  select count(*)::bigint,
         count(*)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 8675309)::numeric), 0)::text
  into v_staged_rows, v_fingerprint
  from off_catalog.products_staging staged
  where staged.dataset_id = p_dataset_id;
  if v_staged_rows < 1
     or v_staged_rows > p_processed_rows - p_rejected_rows - p_filtered_rows then
    raise exception using errcode = '22023', message = 'native_reconstruction_row_count_invalid';
  end if;

  update off_catalog.datasets
  set expected_rows = v_staged_rows,
      staged_rows = v_staged_rows,
      rejected_rows = p_rejected_rows,
      status = 'staged',
      source_fingerprint = v_fingerprint,
      source_fingerprint_verified_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = p_dataset_id;
  update off_catalog.import_jobs
  set copied_rows = v_staged_rows,
      status = 'paused',
      updated_at = clock_timestamp()
  where id = p_job_id;
  return query select v_staged_rows, v_fingerprint;
end;
$$;

create or replace function off_catalog.begin_native_reconstruction_activation(p_dataset_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_activated bigint;
begin
  select dataset.* into v_dataset
  from off_catalog.datasets dataset where dataset.id = p_dataset_id for update;
  if v_dataset.id is null then
    raise exception using errcode = 'P0002', message = 'dataset_not_found';
  end if;
  if v_dataset.status = 'active' then
    return v_dataset.activated_rows;
  end if;
  if v_dataset.status = 'staged' then
    execute 'drop index if exists off_catalog.products_current_search_trgm_idx';
    execute 'drop index if exists off_catalog.products_current_category_idx';
  elsif v_dataset.status <> 'activating' then
    raise exception using errcode = '55000', message = 'native_reconstruction_not_ready';
  end if;
  select off_catalog.prepare_initial_activation(p_dataset_id) into v_activated;
  return v_activated;
end;
$$;

create or replace function off_catalog.finalize_native_reconstruction(p_dataset_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_published bigint;
begin
  select dataset.* into v_dataset
  from off_catalog.datasets dataset where dataset.id = p_dataset_id;
  if v_dataset.id is null then
    raise exception using errcode = 'P0002', message = 'dataset_not_found';
  end if;
  if v_dataset.status = 'active' then
    return v_dataset.activated_rows;
  end if;
  if v_dataset.status <> 'activating'
     or v_dataset.activated_rows <> v_dataset.staged_rows then
    raise exception using errcode = '55000', message = 'native_reconstruction_activation_incomplete';
  end if;

  execute 'create index if not exists products_current_search_trgm_idx on off_catalog.products_current using gin (search_text public.gin_trgm_ops)';
  execute 'create index if not exists products_current_category_idx on off_catalog.products_current (category_slug, canonical_gtin) where is_active';
  execute 'analyze off_catalog.products_current';
  select off_catalog.finalize_initial_activation(p_dataset_id) into v_published;
  return v_published;
end;
$$;

revoke all on function off_catalog.begin_native_reconstruction(
  text, text, text, timestamptz, timestamptz, text, text, jsonb, boolean
) from public, off_catalog_reader;
revoke all on function off_catalog.commit_native_reconstruction_batch(
  uuid, uuid, bigint, bigint, bigint, bigint, jsonb
) from public, off_catalog_reader;
revoke all on function off_catalog.seal_native_reconstruction(
  uuid, uuid, bigint, bigint, bigint, bigint
) from public, off_catalog_reader;
revoke all on function off_catalog.begin_native_reconstruction_activation(uuid)
  from public, off_catalog_reader;
revoke all on function off_catalog.finalize_native_reconstruction(uuid)
  from public, off_catalog_reader;

grant execute on function off_catalog.begin_native_reconstruction(
  text, text, text, timestamptz, timestamptz, text, text, jsonb, boolean
) to off_catalog_importer;
grant execute on function off_catalog.commit_native_reconstruction_batch(
  uuid, uuid, bigint, bigint, bigint, bigint, jsonb
) to off_catalog_importer;
grant execute on function off_catalog.seal_native_reconstruction(
  uuid, uuid, bigint, bigint, bigint, bigint
) to off_catalog_importer;
grant execute on function off_catalog.begin_native_reconstruction_activation(uuid)
  to off_catalog_importer;
grant execute on function off_catalog.finalize_native_reconstruction(uuid)
  to off_catalog_importer;

comment on function off_catalog.begin_native_reconstruction(
  text, text, text, timestamptz, timestamptz, text, text, jsonb, boolean
) is 'Starts or resumes the metadata-only, OFF-native archive reconstruction contract.';
comment on function off_catalog.commit_native_reconstruction_batch(
  uuid, uuid, bigint, bigint, bigint, bigint, jsonb
) is 'Atomically commits one transformed OFF-only batch and its source checkpoint.';
