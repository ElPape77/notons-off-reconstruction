-- Keep only indexes backed by an actual catalogue-gateway query. The GTIN
-- primary key already serves barcode/detail/ranking hydration. Text search
-- uses normalized search_text with pg_trgm, while empty-query category
-- browsing uses (category_slug, canonical_gtin) in index order.

drop index if exists off_catalog.products_current_search_vector_idx;
drop index if exists off_catalog.products_current_brand_idx;
drop index if exists off_catalog.products_current_updated_idx;

-- Migration 005 deliberately reduced final publication to one physical
-- fingerprint read. Preserve that integrity check, but require only the two
-- secondary indexes used by the runtime queries.
create or replace function off_catalog.finalize_initial_activation(p_dataset_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_current_fingerprint text;
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
    coalesce(sum(hashtextextended((to_jsonb(product) - array[
      'dataset_id','synced_at','is_active','search_text','search_vector'
    ])::text, 0)::numeric) filter (where product.dataset_id = p_dataset_id), 0)::text || '|' ||
    coalesce(sum(hashtextextended((to_jsonb(product) - array[
      'dataset_id','synced_at','is_active','search_text','search_vector'
    ])::text, 8675309)::numeric) filter (where product.dataset_id = p_dataset_id), 0)::text,
    count(*),
    count(*) filter (where product.dataset_id <> p_dataset_id or not product.is_active)
  into v_current_fingerprint, v_current_rows, v_invalid_rows
  from off_catalog.products_current product;

  if v_current_rows <> v_dataset.activated_rows
     or v_invalid_rows <> 0
     or v_current_fingerprint <> v_dataset.source_fingerprint then
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
      'products_current_category_idx'
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

revoke all on function off_catalog.finalize_initial_activation(uuid)
  from public, off_catalog_reader;
grant execute on function off_catalog.finalize_initial_activation(uuid)
  to off_catalog_importer;

-- Do not CREATE the two required indexes here: this migration may be applied
-- while a resumable initial activation is only partially populated. Migration
-- 002 already created them on a fresh database; migrate-legacy-staging.sh
-- deliberately rebuilds them only after the final batch on a live recovery.
