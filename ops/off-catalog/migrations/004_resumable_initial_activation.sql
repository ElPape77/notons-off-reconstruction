-- Publish the initial multi-million-row snapshot in resumable transactions.
-- Rows copied into products_current stay invisible until the dataset metadata
-- is flipped to active after the last batch, index build and full fingerprint.

alter table off_catalog.datasets
  add column activation_cursor text,
  add column activated_rows bigint not null default 0;

alter table off_catalog.datasets
  add constraint datasets_activated_rows_nonnegative check (activated_rows >= 0),
  add constraint datasets_activation_cursor_gtin check (
    activation_cursor is null
    or activation_cursor = off_catalog.normalize_gtin(activation_cursor)
  );

create view off_catalog.products_published
with (security_barrier = true)
as
select product.*
from off_catalog.products_current product
join off_catalog.datasets dataset on dataset.id = product.dataset_id
where product.is_active
  and dataset.status = 'active';

revoke all on off_catalog.products_current from off_catalog_reader;
revoke all on off_catalog.products_published from public, off_catalog_importer;
grant select on off_catalog.products_published to off_catalog_reader;

create or replace function off_catalog.prepare_initial_activation(p_dataset_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_staged_rows bigint;
  v_current_rows bigint;
begin
  select * into v_dataset
  from off_catalog.datasets dataset
  where dataset.id = p_dataset_id
  for update;

  if v_dataset.id is null then
    raise exception using errcode = 'P0002', message = 'dataset_not_found';
  end if;
  if v_dataset.status not in ('staged', 'activating') then
    raise exception using errcode = '55000', message = 'dataset_not_ready';
  end if;
  if exists (
    select 1 from off_catalog.datasets dataset
    where dataset.provider_key = v_dataset.provider_key
      and dataset.status = 'active'
  ) then
    raise exception using errcode = '55000', message = 'initial_activation_requires_no_active_dataset';
  end if;

  select count(*) into v_staged_rows
  from off_catalog.products_staging staged
  where staged.dataset_id = p_dataset_id;
  if v_staged_rows = 0 or v_staged_rows <> v_dataset.staged_rows then
    raise exception using errcode = '22023', message = 'dataset_row_count_mismatch';
  end if;

  select count(*) into v_current_rows from off_catalog.products_current;
  if v_dataset.status = 'staged' then
    if v_current_rows <> 0 then
      raise exception using errcode = '55000', message = 'initial_activation_requires_empty_runtime';
    end if;
    update off_catalog.datasets
    set status = 'activating', activation_cursor = null, activated_rows = 0,
        updated_at = clock_timestamp()
    where id = p_dataset_id;
    return 0;
  end if;

  if v_current_rows <> v_dataset.activated_rows
     or exists (
       select 1 from off_catalog.products_current product
       where product.dataset_id <> p_dataset_id
     )
     or (v_current_rows = 0 and v_dataset.activation_cursor is not null)
     or (v_current_rows > 0 and v_dataset.activation_cursor is distinct from (
       select max(product.canonical_gtin)
       from off_catalog.products_current product
       where product.dataset_id = p_dataset_id
     )) then
    raise exception using errcode = '55000', message = 'activation_checkpoint_mismatch';
  end if;

  return v_current_rows;
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
  -- The dataset row lock serializes workers. The importer cannot write
  -- products_current directly, so an indexed cursor existence check is enough
  -- between batches; prepare/finalize retain the full-table integrity scans.
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
      canonical_gtin, dataset_id, barcode, name, generic_name, brand, quantity,
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
      image_front_original_url, off_last_modified_at, off_last_updated_at,
      synced_at, is_active
    )
    select
      staged.canonical_gtin, staged.dataset_id, staged.barcode, staged.name,
      staged.generic_name, staged.brand, staged.quantity, staged.packaging,
      staged.category_slug, staged.source_product_id, staged.source_updated_at,
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
  v_staging_fingerprint text;
  v_current_fingerprint text;
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
  if v_dataset.activated_rows = 0
     or v_dataset.activated_rows <> v_dataset.staged_rows
     or v_dataset.activation_cursor is distinct from (
       select max(staged.canonical_gtin)
       from off_catalog.products_staging staged
       where staged.dataset_id = p_dataset_id
     )
     or (select count(*) from off_catalog.products_current) <> v_dataset.activated_rows
     or exists (
       select 1 from off_catalog.products_current product
       where product.dataset_id <> p_dataset_id or not product.is_active
     ) then
    raise exception using errcode = '55000', message = 'activation_incomplete';
  end if;

  select count(*)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 8675309)::numeric), 0)::text
  into v_staging_fingerprint
  from off_catalog.products_staging staged
  where staged.dataset_id = p_dataset_id;

  select count(*)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(product) - array[
           'dataset_id','synced_at','is_active','search_text','search_vector'
         ])::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(product) - array[
           'dataset_id','synced_at','is_active','search_text','search_vector'
         ])::text, 8675309)::numeric), 0)::text
  into v_current_fingerprint
  from off_catalog.products_current product
  where product.dataset_id = p_dataset_id;

  if v_staging_fingerprint <> v_current_fingerprint then
    raise exception using errcode = '55000', message = 'activation_fingerprint_mismatch';
  end if;

  select count(*) into v_valid_indexes
  from pg_catalog.pg_class index_class
  join pg_catalog.pg_namespace namespace on namespace.oid = index_class.relnamespace
  join pg_catalog.pg_index index_state on index_state.indexrelid = index_class.oid
  where namespace.nspname = 'off_catalog'
    and index_class.relname in (
      'products_current_search_vector_idx',
      'products_current_search_trgm_idx',
      'products_current_brand_idx',
      'products_current_category_idx',
      'products_current_updated_idx'
    )
    and index_state.indisready
    and index_state.indisvalid;
  if v_valid_indexes <> 5 then
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

create or replace function off_catalog.activate_dataset(p_dataset_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = '0A000', message = 'use_resumable_initial_activation';
end;
$$;

revoke all on function off_catalog.prepare_initial_activation(uuid)
  from public, off_catalog_reader;
revoke all on function off_catalog.activate_initial_dataset_batch(uuid, integer)
  from public, off_catalog_reader;
revoke all on function off_catalog.finalize_initial_activation(uuid)
  from public, off_catalog_reader;
revoke execute on function off_catalog.activate_dataset(uuid) from off_catalog_importer;
grant execute on function off_catalog.prepare_initial_activation(uuid) to off_catalog_importer;
grant execute on function off_catalog.activate_initial_dataset_batch(uuid, integer)
  to off_catalog_importer;
grant execute on function off_catalog.finalize_initial_activation(uuid) to off_catalog_importer;

comment on view off_catalog.products_published is
  'Only rows belonging to the atomically published OFF generation. Partial activation batches remain invisible.';
