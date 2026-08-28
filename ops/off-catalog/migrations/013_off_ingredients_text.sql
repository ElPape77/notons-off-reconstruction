-- Migration 012 is deliberately reserved by the public reconstruction
-- attestation contract. This additive migration extends the isolated OFF
-- projection without rewriting the existing multi-million-row generation.

alter table off_catalog.products_staging
  add column ingredients_text text;

alter table off_catalog.products_current
  add column ingredients_text text;

alter table off_catalog.products_staging
  add constraint products_staging_ingredients_text_length check (
    ingredients_text is null
    or char_length(trim(ingredients_text)) between 1 and 10000
  ) not valid;

alter table off_catalog.products_current
  add constraint products_current_ingredients_text_length check (
    ingredients_text is null
    or char_length(trim(ingredients_text)) between 1 and 10000
  ) not valid;

comment on column off_catalog.products_staging.ingredients_text is
  'Ingredient statement projected verbatim from the official OFF archive; nullable and bounded to the Notons product contract.';
comment on column off_catalog.products_current.ingredients_text is
  'Published OFF ingredient statement. Existing generations remain null until an explicitly requested reconstruction.';

-- CREATE OR REPLACE appends the new base-table column to the existing view
-- contract while preserving the active-dataset publication boundary.
create or replace view off_catalog.products_published
as
select product.*
from off_catalog.products_current product
join off_catalog.datasets dataset on dataset.id = product.dataset_id
where product.is_active
  and dataset.status = 'active';

alter view off_catalog.products_published reset (security_barrier);
revoke all on off_catalog.products_published from public, off_catalog_importer;
grant select on off_catalog.products_published to off_catalog_reader;
revoke all on off_catalog.products_current from off_catalog_reader;
revoke all on off_catalog.datasets from off_catalog_reader;

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
    dataset_id, barcode, canonical_gtin, name, generic_name, ingredients_text,
    brand, quantity, packaging, category_slug, source_product_id,
    source_updated_at, source_image_url, off_categories, off_category_tags,
    countries, country_tags, stores, purchase_places, nutriscore_grade,
    nutriscore_score, environmental_score_grade, environmental_score_score,
    serving_size, nutriments, energy_kj_100g, energy_kcal_100g, fat_100g,
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
    product.generic_name, product.ingredients_text, product.brand,
    product.quantity, product.packaging, product.category_slug,
    product.source_product_id, product.source_updated_at,
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
    barcode text, canonical_gtin text, name text, generic_name text,
    ingredients_text text, brand text, quantity text, packaging text,
    category_slug text, source_product_id text, source_updated_at timestamptz,
    source_image_url text, off_categories text[], off_category_tags text[],
    countries text[], country_tags text[], stores text[], purchase_places text[],
    nutriscore_grade text, nutriscore_score smallint,
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
    ingredients_text = excluded.ingredients_text,
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

  -- Omitting only a null newly-added key reproduces fingerprints sealed before
  -- this migration. Non-null ingredient statements remain integrity-covered.
  select count(*)::bigint,
         count(*)::text || '|' ||
         coalesce(sum(hashtextextended((case
           when staged.ingredients_text is null then
             to_jsonb(staged) - array['dataset_id','staged_at','ingredients_text']
           else to_jsonb(staged) - array['dataset_id','staged_at']
         end)::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((case
           when staged.ingredients_text is null then
             to_jsonb(staged) - array['dataset_id','staged_at','ingredients_text']
           else to_jsonb(staged) - array['dataset_id','staged_at']
         end)::text, 8675309)::numeric), 0)::text
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

create or replace function off_catalog.activate_initial_dataset_batch(
  p_dataset_id uuid,
  p_batch_size integer default 100000
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_batch_rows bigint;
  v_batch_cursor text;
begin
  if p_batch_size < 1 or p_batch_size > 100000 then
    raise exception using errcode = '22023', message = 'activation_batch_size_out_of_range';
  end if;

  select * into v_dataset
  from off_catalog.datasets dataset
  where dataset.id = p_dataset_id
  for update;
  if v_dataset.id is null then
    raise exception using errcode = 'P0002', message = 'dataset_not_found';
  end if;
  if v_dataset.status <> 'activating' then
    raise exception using errcode = '55000', message = 'dataset_not_activating';
  end if;
  if v_dataset.activated_rows > v_dataset.staged_rows
     or (v_dataset.activated_rows = 0 and v_dataset.activation_cursor is not null)
     or (
       v_dataset.activated_rows > 0
       and (
         v_dataset.activation_cursor is null
         or not exists (
           select 1
           from off_catalog.products_current product
           where product.canonical_gtin = v_dataset.activation_cursor
             and product.dataset_id = p_dataset_id
             and product.is_active
         )
         or not exists (
           select 1
           from off_catalog.products_staging staged
           where staged.dataset_id = p_dataset_id
             and staged.canonical_gtin = v_dataset.activation_cursor
         )
       )
     ) then
    raise exception using errcode = '55000', message = 'activation_checkpoint_mismatch';
  end if;

  with next_batch as materialized (
    select staged.*
    from off_catalog.products_staging staged
    where staged.dataset_id = p_dataset_id
      and (
        v_dataset.activation_cursor is null
        or staged.canonical_gtin > v_dataset.activation_cursor
      )
    order by staged.canonical_gtin
    limit p_batch_size
  ), inserted as (
    insert into off_catalog.products_current (
      canonical_gtin, dataset_id, barcode, name, generic_name, ingredients_text,
      brand, quantity, packaging, category_slug, source_product_id,
      source_updated_at, source_image_url, off_categories, off_category_tags,
      countries, country_tags, stores, purchase_places, nutriscore_grade,
      nutriscore_score, environmental_score_grade, environmental_score_score,
      serving_size, nutriments, energy_kj_100g, energy_kcal_100g, fat_100g,
      saturated_fat_100g, carbohydrates_100g, sugars_100g, fiber_100g,
      proteins_100g, salt_100g, sodium_100g, energy_kj_serving,
      energy_kcal_serving, fat_serving, saturated_fat_serving,
      carbohydrates_serving, sugars_serving, fiber_serving, proteins_serving,
      salt_serving, sodium_serving, open_food_facts_url,
      image_front_thumb_url, image_front_small_url, image_front_url,
      image_front_original_url, off_last_modified_at, off_last_updated_at,
      synced_at, is_active
    )
    select
      staged.canonical_gtin, staged.dataset_id, staged.barcode, staged.name,
      staged.generic_name, staged.ingredients_text, staged.brand,
      staged.quantity, staged.packaging, staged.category_slug,
      staged.source_product_id, staged.source_updated_at,
      staged.source_image_url, staged.off_categories, staged.off_category_tags,
      staged.countries, staged.country_tags, staged.stores,
      staged.purchase_places, staged.nutriscore_grade, staged.nutriscore_score,
      staged.environmental_score_grade, staged.environmental_score_score,
      staged.serving_size, staged.nutriments, staged.energy_kj_100g,
      staged.energy_kcal_100g, staged.fat_100g, staged.saturated_fat_100g,
      staged.carbohydrates_100g, staged.sugars_100g, staged.fiber_100g,
      staged.proteins_100g, staged.salt_100g, staged.sodium_100g,
      staged.energy_kj_serving, staged.energy_kcal_serving, staged.fat_serving,
      staged.saturated_fat_serving, staged.carbohydrates_serving,
      staged.sugars_serving, staged.fiber_serving, staged.proteins_serving,
      staged.salt_serving, staged.sodium_serving, staged.open_food_facts_url,
      staged.image_front_thumb_url, staged.image_front_small_url,
      staged.image_front_url, staged.image_front_original_url,
      staged.off_last_modified_at, staged.off_last_updated_at,
      clock_timestamp(), true
    from next_batch staged
    returning canonical_gtin
  )
  select count(*), max(canonical_gtin)
  into v_batch_rows, v_batch_cursor
  from inserted;

  if v_batch_rows > 0 then
    update off_catalog.datasets
    set activated_rows = activated_rows + v_batch_rows,
        activation_cursor = v_batch_cursor,
        updated_at = clock_timestamp()
    where id = p_dataset_id;
  end if;

  return v_dataset.activated_rows + v_batch_rows;
end;
$$;

create or replace function off_catalog.finalize_initial_activation(p_dataset_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_current_fingerprint text;
  v_current_fingerprint_with_nulls text;
  v_current_rows bigint;
  v_invalid_rows bigint;
  v_valid_indexes integer;
begin
  select * into v_dataset
  from off_catalog.datasets dataset
  where dataset.id = p_dataset_id
  for update;
  if v_dataset.id is null then
    raise exception using errcode = 'P0002', message = 'dataset_not_found';
  end if;
  if v_dataset.status <> 'activating' then
    raise exception using errcode = '55000', message = 'dataset_not_activating';
  end if;
  if v_dataset.source_fingerprint is null
     or v_dataset.source_fingerprint_verified_at is null
     or v_dataset.activated_rows = 0
     or v_dataset.activated_rows <> v_dataset.staged_rows
     or v_dataset.activation_cursor is distinct from (
       select staged.canonical_gtin
       from off_catalog.products_staging staged
       where staged.dataset_id = p_dataset_id
       order by staged.canonical_gtin desc
       limit 1
     ) then
    raise exception using errcode = '55000', message = 'activation_incomplete';
  end if;

  select
    (count(*) filter (where product.dataset_id = p_dataset_id))::text || '|' ||
    coalesce(sum(hashtextextended((case
      when product.ingredients_text is null then
        to_jsonb(product) - array[
          'dataset_id','synced_at','is_active','search_text','search_vector',
          'ingredients_text'
        ]
      else to_jsonb(product) - array[
        'dataset_id','synced_at','is_active','search_text','search_vector'
      ]
    end)::text, 0)::numeric) filter (where product.dataset_id = p_dataset_id), 0)::text || '|' ||
    coalesce(sum(hashtextextended((case
      when product.ingredients_text is null then
        to_jsonb(product) - array[
          'dataset_id','synced_at','is_active','search_text','search_vector',
          'ingredients_text'
        ]
      else to_jsonb(product) - array[
        'dataset_id','synced_at','is_active','search_text','search_vector'
      ]
    end)::text, 8675309)::numeric) filter (where product.dataset_id = p_dataset_id), 0)::text,
    (count(*) filter (where product.dataset_id = p_dataset_id))::text || '|' ||
    coalesce(sum(hashtextextended((to_jsonb(product) - array[
      'dataset_id','synced_at','is_active','search_text','search_vector'
    ])::text, 0)::numeric) filter (where product.dataset_id = p_dataset_id), 0)::text || '|' ||
    coalesce(sum(hashtextextended((to_jsonb(product) - array[
      'dataset_id','synced_at','is_active','search_text','search_vector'
    ])::text, 8675309)::numeric) filter (where product.dataset_id = p_dataset_id), 0)::text,
    count(*),
    count(*) filter (where product.dataset_id <> p_dataset_id or not product.is_active)
  into v_current_fingerprint, v_current_fingerprint_with_nulls,
       v_current_rows, v_invalid_rows
  from off_catalog.products_current product;

  if v_current_rows <> v_dataset.activated_rows
     or v_invalid_rows <> 0
     or (
       v_current_fingerprint <> v_dataset.source_fingerprint
       and v_current_fingerprint_with_nulls <> v_dataset.source_fingerprint
     ) then
    raise exception using errcode = '55000', message = 'activation_fingerprint_mismatch';
  end if;

  select count(*) into v_valid_indexes
  from pg_catalog.pg_class index_class
  join pg_catalog.pg_namespace namespace on namespace.oid = index_class.relnamespace
  join pg_catalog.pg_index index_state on index_state.indexrelid = index_class.oid
  where namespace.nspname = 'off_catalog'
    and index_state.indrelid = 'off_catalog.products_current'::regclass
    and index_class.relname in (
      'products_current_search_trgm_idx',
      'products_current_ranking_category_idx'
    )
    and index_state.indisready
    and index_state.indisvalid;
  if v_valid_indexes <> 2 then
    raise exception using errcode = '55000', message = 'runtime_indexes_not_ready';
  end if;

  update off_catalog.datasets
  set status = 'active', activated_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_dataset_id;
  update off_catalog.import_jobs
  set status = 'completed', copied_rows = v_dataset.activated_rows,
      completed_at = coalesce(completed_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where dataset_id = p_dataset_id;

  return v_dataset.activated_rows;
end;
$$;

revoke all on function off_catalog.commit_native_reconstruction_batch(
  uuid, uuid, bigint, bigint, bigint, bigint, jsonb
) from public, off_catalog_reader;
revoke all on function off_catalog.seal_native_reconstruction(
  uuid, uuid, bigint, bigint, bigint, bigint
) from public, off_catalog_reader;
revoke all on function off_catalog.activate_initial_dataset_batch(uuid, integer)
  from public, off_catalog_reader;
revoke all on function off_catalog.finalize_initial_activation(uuid)
  from public, off_catalog_reader;

grant execute on function off_catalog.commit_native_reconstruction_batch(
  uuid, uuid, bigint, bigint, bigint, bigint, jsonb
) to off_catalog_importer;
grant execute on function off_catalog.seal_native_reconstruction(
  uuid, uuid, bigint, bigint, bigint, bigint
) to off_catalog_importer;
grant execute on function off_catalog.activate_initial_dataset_batch(uuid, integer)
  to off_catalog_importer;
grant execute on function off_catalog.finalize_initial_activation(uuid)
  to off_catalog_importer;

comment on view off_catalog.products_published is
  'Indexable read-only view of the atomically published OFF generation, including optional ingredient statements. Partial activation batches remain invisible.';
comment on function off_catalog.commit_native_reconstruction_batch(
  uuid, uuid, bigint, bigint, bigint, bigint, jsonb
) is 'Atomically commits one transformed OFF-only batch, including ingredients_text, and its source checkpoint.';

do $ingredients_projection_checks$
declare
  v_public_select boolean;
  v_view_has_ingredients boolean;
begin
  select exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'off_catalog.products_published'::regclass
      and attribute.attname = 'ingredients_text'
      and attribute.attnum > 0
      and not attribute.attisdropped
  ) into v_view_has_ingredients;

  select exists (
    select 1
    from pg_catalog.aclexplode(
      coalesce(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) acl
    where acl.grantee = 0 and acl.privilege_type = 'SELECT'
  ) into v_public_select
  from pg_catalog.pg_class relation
  where relation.oid = 'off_catalog.products_published'::regclass;

  if not v_view_has_ingredients
     or not has_table_privilege(
       'off_catalog_reader', 'off_catalog.products_published', 'SELECT'
     )
     or has_table_privilege(
       'off_catalog_reader', 'off_catalog.products_current', 'SELECT'
     )
     or has_table_privilege(
       'off_catalog_importer', 'off_catalog.products_published', 'SELECT'
     )
     or coalesce(v_public_select, false) then
    raise exception 'off_ingredients_projection_contract_mismatch';
  end if;
end
$ingredients_projection_checks$;
