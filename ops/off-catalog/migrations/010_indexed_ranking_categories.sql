-- Rank/search categories are a Notons presentation projection over the OFF
-- taxonomy.  The historical category_slug column only describes the former
-- chips-only importer and therefore cannot serve the general-food UI.
--
-- Keep the projection immutable and indexed instead of expanding/filtering
-- off_category_tags after pagination.  Building this replacement index reads
-- products_current once; it does not rewrite the four-million-row table.

create or replace function off_catalog.ranking_category_slug(
  p_off_category_tags text[],
  p_legacy_category_slug text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  with normalized as (
    select coalesce(
      pg_catalog.array_agg(pg_catalog.lower(pg_catalog.btrim(item.tag))),
      '{}'::text[]
    ) as tags
    from pg_catalog.unnest(
      coalesce(p_off_category_tags, '{}'::text[])
    ) as item(tag)
    where item.tag is not null
  )
  select case
    when normalized.tags && array[
      'en:beverages', 'fr:boissons'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = 'boissons'
      then 'boissons'
    when normalized.tags && array[
      'en:fruits',
      'en:vegetables',
      'en:fruits-and-vegetables-based-foods',
      'fr:fruits',
      'fr:legumes'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = 'fruits-legumes'
      then 'fruits-legumes'
    when normalized.tags && array[
      'en:dairies', 'en:dairy-products', 'fr:produits-laitiers'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = 'produits-laitiers'
      then 'produits-laitiers'
    when normalized.tags && array[
      'en:meats',
      'en:meat-based-products',
      'en:seafood',
      'en:fishes',
      'en:fish-and-seafood',
      'en:eggs',
      'fr:viandes',
      'fr:poissons',
      'fr:oeufs'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = 'viandes-poissons-oeufs'
      then 'viandes-poissons-oeufs'
    when normalized.tags && array[
      'en:meals', 'en:prepared-meals', 'fr:plats-prepares'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = 'plats-prepares'
      then 'plats-prepares'
    when normalized.tags && array[
      'en:breads',
      'en:cereals-and-potatoes',
      'en:breakfast-cereals',
      'fr:pains',
      'fr:cereales'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = 'pains-cereales'
      then 'pains-cereales'
    when normalized.tags && array[
      'en:snacks',
      'en:salty-snacks',
      'en:sweet-snacks',
      'en:confectioneries',
      'fr:snacks',
      'fr:confiseries'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = any (array[
        'snacks-aperitifs',
        'snacks-confiseries',
        'chips-nature',
        'chips-aromatisees',
        'tortillas',
        'snacks-souffles',
        'chips-legumes'
      ]::text[])
      then 'snacks-confiseries'
    when normalized.tags && array[
      'en:sauces', 'en:condiments', 'fr:sauces', 'fr:condiments'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = 'sauces-condiments'
      then 'sauces-condiments'
    when normalized.tags && array[
      'en:frozen-foods', 'fr:produits-surgeles'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = 'produits-surgeles'
      then 'produits-surgeles'
    when normalized.tags && array[
      'en:plant-based-foods-and-beverages',
      'en:plant-based-foods',
      'fr:aliments-vegetaux'
    ]::text[]
      or pg_catalog.lower(pg_catalog.btrim(p_legacy_category_slug)) = 'alimentation-vegetale'
      then 'alimentation-vegetale'
    else 'autres'
  end
  from normalized;
$$;

revoke all on function off_catalog.ranking_category_slug(text[], text)
  from public, off_catalog_importer;
grant execute on function off_catalog.ranking_category_slug(text[], text)
  to off_catalog_reader;

comment on function off_catalog.ranking_category_slug(text[], text) is
  'Immutable, ordered Notons ranking category over OFF taxonomy tags; safe for the reader expression index.';

create index if not exists products_current_ranking_category_idx
  on off_catalog.products_current (
    off_catalog.ranking_category_slug(off_category_tags, category_slug),
    canonical_gtin
  ) where is_active;

-- No runtime query uses the narrow legacy chips category after this migration.
drop index if exists off_catalog.products_current_category_idx;

-- Publication must fail closed when either query-backed secondary index is
-- absent.  This is migration 006's single-pass integrity finalizer with the
-- obsolete category index replaced by the ranking-category expression index.
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

revoke all on function off_catalog.finalize_initial_activation(uuid)
  from public, off_catalog_reader;
grant execute on function off_catalog.finalize_initial_activation(uuid)
  to off_catalog_importer;

-- Native reconstruction intentionally removes query indexes before the
-- 100,000-row activation batches, then builds each once before publication.
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
    execute 'drop index if exists off_catalog.products_current_ranking_category_idx';
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
  from off_catalog.datasets dataset where dataset.id = p_dataset_id for update;
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
  execute 'create index if not exists products_current_ranking_category_idx on off_catalog.products_current (off_catalog.ranking_category_slug(off_category_tags, category_slug), canonical_gtin) where is_active';
  execute 'analyze off_catalog.products_current';
  select off_catalog.finalize_initial_activation(p_dataset_id) into v_published;
  return v_published;
end;
$$;

revoke all on function off_catalog.begin_native_reconstruction_activation(uuid)
  from public, off_catalog_reader;
revoke all on function off_catalog.finalize_native_reconstruction(uuid)
  from public, off_catalog_reader;
grant execute on function off_catalog.begin_native_reconstruction_activation(uuid)
  to off_catalog_importer;
grant execute on function off_catalog.finalize_native_reconstruction(uuid)
  to off_catalog_importer;

do $ranking_category_checks$
declare
  v_index_valid boolean;
  v_function_immutable boolean;
  v_public_execute boolean;
begin
  if off_catalog.ranking_category_slug(array['EN:BEVERAGES'], null) <> 'boissons'
     or off_catalog.ranking_category_slug(
       array['en:plant-based-foods', 'en:beverages'], null
     ) <> 'boissons'
     or off_catalog.ranking_category_slug(null, 'CHIPS-NATURE') <> 'snacks-confiseries'
     or off_catalog.ranking_category_slug(array['en:unknown-food'], null) <> 'autres' then
    raise exception 'ranking_category_projection_mismatch';
  end if;

  select index_state.indisready and index_state.indisvalid
  into v_index_valid
  from pg_catalog.pg_class index_class
  join pg_catalog.pg_namespace namespace on namespace.oid = index_class.relnamespace
  join pg_catalog.pg_index index_state on index_state.indexrelid = index_class.oid
  where namespace.nspname = 'off_catalog'
    and index_class.relname = 'products_current_ranking_category_idx'
    and index_state.indrelid = 'off_catalog.products_current'::regclass;

  select procedure.provolatile = 'i' and procedure.proparallel = 's', exists (
    select 1
    from pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) privilege
    where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
  )
  into v_function_immutable, v_public_execute
  from pg_catalog.pg_proc procedure
  where procedure.oid = 'off_catalog.ranking_category_slug(text[],text)'::regprocedure;

  if not coalesce(v_index_valid, false)
     or to_regclass('off_catalog.products_current_category_idx') is not null
     or not coalesce(v_function_immutable, false)
     or v_public_execute
     or not has_function_privilege(
       'off_catalog_reader',
       'off_catalog.ranking_category_slug(text[],text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'off_catalog_importer',
       'off_catalog.ranking_category_slug(text[],text)',
       'EXECUTE'
     ) then
    raise exception 'ranking_category_runtime_contract_mismatch';
  end if;
end
$ranking_category_checks$;
