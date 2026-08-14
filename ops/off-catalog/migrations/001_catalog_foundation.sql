-- Dedicated Open Food Facts catalogue database.
-- This file is applied as off_catalog_owner by provision-off-catalog.sh.
-- No Notons account, review, rating, scan, favourite or moderation identifier
-- is allowed in this schema.

create or replace function off_catalog.normalize_search_text(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select trim(
    regexp_replace(
      lower(public.unaccent(coalesce(p_value, ''))),
      '[^a-z0-9]+',
      ' ',
      'g'
    )
  );
$$;

create or replace function off_catalog.normalize_gtin(p_value text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_code text := regexp_replace(trim(coalesce(p_value, '')), '[[:space:]-]+', '', 'g');
  v_sum integer := 0;
  v_index integer;
  v_from_right integer;
  v_expected integer;
begin
  if v_code !~ '^[0-9]+$' or length(v_code) not in (8, 12, 13, 14) then
    return null;
  end if;
  for v_index in reverse length(v_code) - 1..1 loop
    v_from_right := length(v_code) - v_index;
    v_sum := v_sum
      + substring(v_code from v_index for 1)::integer
        * case when v_from_right % 2 = 1 then 3 else 1 end;
  end loop;
  v_expected := (10 - (v_sum % 10)) % 10;
  if v_expected <> right(v_code, 1)::integer then
    return null;
  end if;
  return lpad(v_code, 14, '0');
end;
$$;

create or replace function off_catalog.open_food_facts_url_is_valid(p_url text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    p_url ~* '^https://([a-z0-9-]+\.)*openfoodfacts\.(org|net)(:[0-9]+)?(/|$)',
    false
  );
$$;

create table off_catalog.datasets (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null default 'open_food_facts',
  source_name text not null default 'Open Food Facts',
  source_url text not null,
  source_filename text not null,
  source_sha256 text not null unique,
  source_published_at timestamptz,
  source_retrieved_at timestamptz,
  license_name text not null default 'ODbL 1.0',
  license_url text not null default 'https://opendatacommons.org/licenses/odbl/1-0/',
  importer_version text not null,
  projection_version text not null,
  import_contract jsonb not null,
  expected_rows bigint,
  staged_rows bigint not null default 0,
  rejected_rows bigint not null default 0,
  status text not null default 'pending',
  activated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint datasets_provider_key check (provider_key = 'open_food_facts'),
  constraint datasets_source_url_https check (source_url ~* '^https://'),
  constraint datasets_sha256 check (source_sha256 ~ '^[0-9a-f]{64}$'),
  constraint datasets_contract_object check (jsonb_typeof(import_contract) = 'object'),
  constraint datasets_counts_nonnegative check (
    expected_rows is null or expected_rows >= 0
  ),
  constraint datasets_staged_nonnegative check (staged_rows >= 0 and rejected_rows >= 0),
  constraint datasets_status check (
    status in ('pending', 'copying', 'staged', 'activating', 'active', 'failed', 'superseded')
  )
);

create unique index datasets_one_active_idx
  on off_catalog.datasets ((provider_key)) where status = 'active';

create table off_catalog.import_jobs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references off_catalog.datasets(id) on delete restrict,
  legacy_job_id uuid,
  worker_key text,
  status text not null default 'pending',
  copied_rows bigint not null default 0,
  rejected_rows bigint not null default 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint import_jobs_counts_nonnegative check (copied_rows >= 0 and rejected_rows >= 0),
  constraint import_jobs_status check (
    status in ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')
  )
);

create unique index import_jobs_legacy_unique_idx
  on off_catalog.import_jobs (legacy_job_id) where legacy_job_id is not null;

-- Staging is deliberately heap-like: only the primary identity needed for
-- idempotent COPY is indexed. Runtime search indexes are built/maintained on
-- products_current, never once per staged row through triggers.
create table off_catalog.products_staging (
  dataset_id uuid not null references off_catalog.datasets(id) on delete cascade,
  barcode text not null,
  canonical_gtin text not null,
  name text not null,
  generic_name text,
  brand text,
  quantity text,
  packaging text,
  category_slug text,
  source_product_id text,
  source_updated_at timestamptz,
  source_image_url text,
  off_categories text[],
  off_category_tags text[],
  countries text[],
  country_tags text[],
  stores text[],
  purchase_places text[],
  nutriscore_grade text,
  nutriscore_score smallint,
  environmental_score_grade text,
  environmental_score_score smallint,
  serving_size text,
  nutriments jsonb,
  energy_kj_100g numeric,
  energy_kcal_100g numeric,
  fat_100g numeric,
  saturated_fat_100g numeric,
  carbohydrates_100g numeric,
  sugars_100g numeric,
  fiber_100g numeric,
  proteins_100g numeric,
  salt_100g numeric,
  sodium_100g numeric,
  energy_kj_serving numeric,
  energy_kcal_serving numeric,
  fat_serving numeric,
  saturated_fat_serving numeric,
  carbohydrates_serving numeric,
  sugars_serving numeric,
  fiber_serving numeric,
  proteins_serving numeric,
  salt_serving numeric,
  sodium_serving numeric,
  open_food_facts_url text,
  image_front_thumb_url text,
  image_front_small_url text,
  image_front_url text,
  image_front_original_url text,
  off_last_modified_at timestamptz,
  off_last_updated_at timestamptz,
  staged_at timestamptz not null default clock_timestamp(),
  primary key (dataset_id, canonical_gtin),
  constraint products_staging_gtin check (
    canonical_gtin = off_catalog.normalize_gtin(canonical_gtin)
  ),
  constraint products_staging_name check (char_length(trim(name)) between 2 and 160),
  constraint products_staging_nutriments check (
    nutriments is null or (
      jsonb_typeof(nutriments) = 'object'
      and octet_length(nutriments::text) <= 262144
    )
  ),
  constraint products_staging_source_urls check (
    (source_image_url is null or off_catalog.open_food_facts_url_is_valid(source_image_url))
    and (open_food_facts_url is null or off_catalog.open_food_facts_url_is_valid(open_food_facts_url))
    and (image_front_thumb_url is null or off_catalog.open_food_facts_url_is_valid(image_front_thumb_url))
    and (image_front_small_url is null or off_catalog.open_food_facts_url_is_valid(image_front_small_url))
    and (image_front_url is null or off_catalog.open_food_facts_url_is_valid(image_front_url))
    and (image_front_original_url is null or off_catalog.open_food_facts_url_is_valid(image_front_original_url))
  )
);

create table off_catalog.products_current (
  canonical_gtin text primary key,
  dataset_id uuid not null references off_catalog.datasets(id) on delete restrict,
  barcode text not null,
  name text not null,
  generic_name text,
  brand text,
  quantity text,
  packaging text,
  category_slug text,
  source_product_id text,
  source_updated_at timestamptz,
  source_image_url text,
  off_categories text[],
  off_category_tags text[],
  countries text[],
  country_tags text[],
  stores text[],
  purchase_places text[],
  nutriscore_grade text,
  nutriscore_score smallint,
  environmental_score_grade text,
  environmental_score_score smallint,
  serving_size text,
  nutriments jsonb,
  energy_kj_100g numeric,
  energy_kcal_100g numeric,
  fat_100g numeric,
  saturated_fat_100g numeric,
  carbohydrates_100g numeric,
  sugars_100g numeric,
  fiber_100g numeric,
  proteins_100g numeric,
  salt_100g numeric,
  sodium_100g numeric,
  energy_kj_serving numeric,
  energy_kcal_serving numeric,
  fat_serving numeric,
  saturated_fat_serving numeric,
  carbohydrates_serving numeric,
  sugars_serving numeric,
  fiber_serving numeric,
  proteins_serving numeric,
  salt_serving numeric,
  sodium_serving numeric,
  open_food_facts_url text,
  image_front_thumb_url text,
  image_front_small_url text,
  image_front_url text,
  image_front_original_url text,
  off_last_modified_at timestamptz,
  off_last_updated_at timestamptz,
  synced_at timestamptz not null default clock_timestamp(),
  is_active boolean not null default true,
  search_text text generated always as (
    off_catalog.normalize_search_text(
      coalesce(name, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(quantity, '')
    )
  ) stored,
  search_vector tsvector generated always as (
    to_tsvector(
      'simple',
      off_catalog.normalize_search_text(
        coalesce(name, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(quantity, '')
      )
    )
  ) stored,
  constraint products_current_gtin check (
    canonical_gtin = off_catalog.normalize_gtin(canonical_gtin)
  ),
  constraint products_current_name check (char_length(trim(name)) between 2 and 160),
  constraint products_current_nutriscore check (
    nutriscore_grade is null or nutriscore_grade in ('a', 'b', 'c', 'd', 'e')
  ),
  constraint products_current_environmental_score check (
    environmental_score_grade is null
    or environmental_score_grade in ('a-plus', 'a', 'b', 'c', 'd', 'e', 'f')
  ),
  constraint products_current_source_urls check (
    (source_image_url is null or off_catalog.open_food_facts_url_is_valid(source_image_url))
    and (open_food_facts_url is null or off_catalog.open_food_facts_url_is_valid(open_food_facts_url))
    and (image_front_thumb_url is null or off_catalog.open_food_facts_url_is_valid(image_front_thumb_url))
    and (image_front_small_url is null or off_catalog.open_food_facts_url_is_valid(image_front_small_url))
    and (image_front_url is null or off_catalog.open_food_facts_url_is_valid(image_front_url))
    and (image_front_original_url is null or off_catalog.open_food_facts_url_is_valid(image_front_original_url))
  )
);

create table off_catalog.delta_state (
  provider_key text primary key default 'open_food_facts',
  cursor_end_t bigint,
  last_archive_sha256 text,
  last_applied_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint delta_state_provider check (provider_key = 'open_food_facts'),
  constraint delta_state_cursor check (cursor_end_t is null or cursor_end_t >= 0),
  constraint delta_state_sha check (
    last_archive_sha256 is null or last_archive_sha256 ~ '^[0-9a-f]{64}$'
  )
);

-- Activation is set-based. It avoids row triggers, source-provenance probes and
-- per-row GIN maintenance on staging. It can be run once after COPY and then
-- staging is kept until the gateway cutover has been accepted.
create or replace function off_catalog.activate_dataset(p_dataset_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count bigint;
  v_dataset off_catalog.datasets;
begin
  select * into v_dataset
  from off_catalog.datasets dataset
  where dataset.id = p_dataset_id
  for update;
  if v_dataset.id is null then
    raise exception using errcode = 'P0002', message = 'dataset_not_found';
  end if;
  if v_dataset.status not in ('staged', 'failed') then
    raise exception using errcode = '55000', message = 'dataset_not_ready';
  end if;

  select count(*) into v_count
  from off_catalog.products_staging staged
  where staged.dataset_id = p_dataset_id;
  if v_count = 0 or v_count <> v_dataset.staged_rows then
    raise exception using errcode = '22023', message = 'dataset_row_count_mismatch';
  end if;

  update off_catalog.datasets set status = 'activating', updated_at = clock_timestamp()
  where id = p_dataset_id;

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
  from off_catalog.products_staging staged
  where staged.dataset_id = p_dataset_id
  on conflict (canonical_gtin) do update set
    dataset_id = excluded.dataset_id,
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
    synced_at = excluded.synced_at,
    is_active = true;

  update off_catalog.products_current current_product
  set is_active = false, synced_at = clock_timestamp()
  where current_product.dataset_id <> p_dataset_id
    and not exists (
      select 1
      from off_catalog.products_staging staged
      where staged.dataset_id = p_dataset_id
        and staged.canonical_gtin = current_product.canonical_gtin
    );

  update off_catalog.datasets
  set status = 'superseded', updated_at = clock_timestamp()
  where provider_key = v_dataset.provider_key
    and status = 'active'
    and id <> p_dataset_id;
  update off_catalog.datasets
  set status = 'active', staged_rows = v_count,
    activated_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_dataset_id;

  return v_count;
end;
$$;

revoke all on all tables in schema off_catalog from public;
revoke execute on all functions in schema off_catalog from public;
grant usage on schema off_catalog to off_catalog_reader, off_catalog_importer;
grant select on off_catalog.products_current to off_catalog_reader;
grant select, insert, update, delete on off_catalog.datasets,
  off_catalog.import_jobs, off_catalog.products_staging,
  off_catalog.delta_state to off_catalog_importer;
grant execute on function off_catalog.activate_dataset(uuid) to off_catalog_importer;

alter default privileges for role off_catalog_owner in schema off_catalog
  revoke all on tables from public;
alter default privileges for role off_catalog_owner in schema off_catalog
  revoke execute on functions from public;

comment on table off_catalog.products_current is
  'Private ODbL-derived OFF projection. It contains no Notons UGC or account identifier.';
comment on table off_catalog.products_staging is
  'Private OFF-only staging. Transfer queries must never include a Notons UUID other than dataset_id generated in this database.';
