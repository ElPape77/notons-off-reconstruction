-- Seal a verified staging generation once, then make it immutable. Resumable
-- activation can trust this durable checkpoint instead of hashing both
-- multi-million-row staging tables again after every interruption.

alter table off_catalog.datasets
  add column source_fingerprint text,
  add column source_fingerprint_verified_at timestamptz;

alter table off_catalog.datasets
  add constraint datasets_source_fingerprint_format check (
    source_fingerprint is null
    or source_fingerprint ~ '^[0-9]+\|-?[0-9]+\|-?[0-9]+$'
  ),
  add constraint datasets_source_fingerprint_pair check (
    (source_fingerprint is null) = (source_fingerprint_verified_at is null)
  ),
  add constraint datasets_activation_requires_verified_source check (
    status not in ('activating', 'active') or source_fingerprint is not null
  ) not valid;

create or replace function off_catalog.guard_dataset_verification_seal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.source_fingerprint is not null then
    if new.source_fingerprint is distinct from old.source_fingerprint
       or new.source_fingerprint_verified_at is distinct from old.source_fingerprint_verified_at then
      raise exception using
        errcode = '55000', message = 'dataset_verification_seal_is_immutable';
    end if;
    if current_user <> 'off_catalog_owner' then
      raise exception using
        errcode = '42501', message = 'verified_dataset_update_requires_owner';
    end if;
  end if;

  if old.source_fingerprint is null and new.source_fingerprint is not null then
    -- Only an owner-only SECURITY DEFINER verification path may create the
    -- seal. The importer keeps ordinary metadata UPDATE rights but cannot
    -- forge it.
    if current_user <> 'off_catalog_owner' then
      raise exception using
        errcode = '42501', message = 'dataset_verification_seal_requires_owner';
    end if;
    -- A normal first activation is sealed while staged. The only supported
    -- exception is the owner-only recovery function below, which adopts an
    -- activation already started by migration 004 after independently
    -- rechecking staging and the partial runtime projection.
    if new.status not in ('staged', 'activating') then
      raise exception using
        errcode = '55000', message = 'dataset_must_be_staged_before_sealing';
    end if;
  end if;

  return new;
end;
$$;

create trigger datasets_guard_verification_seal
before update
on off_catalog.datasets
for each row execute function off_catalog.guard_dataset_verification_seal();

create or replace function off_catalog.assert_staging_datasets_mutable(p_dataset_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Take a lock once per touched dataset, not once per product. This keeps
  -- 100,000-row COPY batches fast and serializes their statement-end check
  -- against seal_staged_dataset()'s FOR UPDATE lock.
  perform 1
  from off_catalog.datasets dataset
  where dataset.id = any(p_dataset_ids)
  for key share;

  if exists (
    select 1
    from off_catalog.datasets dataset
    where dataset.id = any(p_dataset_ids)
      and (
        dataset.source_fingerprint is not null
        or dataset.status in ('activating', 'active', 'superseded')
      )
  ) then
    raise exception using
      errcode = '55000', message = 'verified_staging_is_immutable';
  end if;
end;
$$;

create or replace function off_catalog.guard_verified_staging_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform off_catalog.assert_staging_datasets_mutable(array(
    select distinct staged.dataset_id from staging_new staged
  ));
  return null;
end;
$$;

create or replace function off_catalog.guard_verified_staging_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform off_catalog.assert_staging_datasets_mutable(array(
    select staged.dataset_id from staging_old staged
    union
    select staged.dataset_id from staging_new staged
  ));
  return null;
end;
$$;

create or replace function off_catalog.guard_verified_staging_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform off_catalog.assert_staging_datasets_mutable(array(
    select distinct staged.dataset_id from staging_old staged
  ));
  return null;
end;
$$;

create trigger products_staging_guard_verified_insert
after insert on off_catalog.products_staging
referencing new table as staging_new
for each statement execute function off_catalog.guard_verified_staging_insert();

create trigger products_staging_guard_verified_update
after update on off_catalog.products_staging
referencing old table as staging_old new table as staging_new
for each statement execute function off_catalog.guard_verified_staging_update();

create trigger products_staging_guard_verified_delete
after delete on off_catalog.products_staging
referencing old table as staging_old
for each statement execute function off_catalog.guard_verified_staging_delete();

revoke update, delete on off_catalog.products_staging from off_catalog_importer;
revoke delete on off_catalog.datasets from off_catalog_importer;

-- PostgreSQL evaluates table CHECK constraints as the calling role. COPY into
-- staging therefore needs these two deterministic validators, but no runtime
-- catalogue read or mutation capability is delegated with them.
revoke execute on function off_catalog.normalize_gtin(text)
  from public, off_catalog_reader;
revoke execute on function off_catalog.open_food_facts_url_is_valid(text)
  from public, off_catalog_reader;
grant execute on function off_catalog.normalize_gtin(text)
  to off_catalog_importer;
grant execute on function off_catalog.open_food_facts_url_is_valid(text)
  to off_catalog_importer;

create or replace function off_catalog.seal_staged_dataset(
  p_dataset_id uuid,
  p_source_fingerprint text,
  p_expected_rows bigint
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_destination_fingerprint text;
  v_verified_at timestamptz;
begin
  -- Writers acquire ROW EXCLUSIVE before their statement trigger takes the
  -- dataset KEY SHARE lock. Acquire the table lock first to keep this order
  -- deadlock-free, drain earlier writers, and prevent new mutations while the
  -- one-time destination fingerprint is computed.
  lock table off_catalog.products_staging in share mode;

  select * into v_dataset
  from off_catalog.datasets dataset
  where dataset.id = p_dataset_id
  for update;

  if v_dataset.id is null then
    raise exception using errcode = 'P0002', message = 'dataset_not_found';
  end if;
  if v_dataset.status not in ('copying', 'staged') then
    raise exception using errcode = '55000', message = 'dataset_not_ready_for_seal';
  end if;
  if p_source_fingerprint is null
     or p_source_fingerprint !~ '^[0-9]+\|-?[0-9]+\|-?[0-9]+$' then
    raise exception using errcode = '22023', message = 'verification_fingerprint_invalid';
  end if;
  if p_expected_rows is null
     or p_expected_rows <= 0
     or split_part(p_source_fingerprint, '|', 1)::bigint <> p_expected_rows
     or v_dataset.staged_rows <> p_expected_rows
     or (v_dataset.expected_rows is not null and v_dataset.expected_rows <> p_expected_rows) then
    raise exception using errcode = '22023', message = 'verification_row_count_mismatch';
  end if;

  if v_dataset.source_fingerprint is not null then
    if v_dataset.source_fingerprint <> p_source_fingerprint then
      raise exception using errcode = '55000', message = 'dataset_verification_seal_is_immutable';
    end if;
    return v_dataset.source_fingerprint_verified_at;
  end if;

  -- SHARE excludes staging writers until the seal commits, so this one-time
  -- fingerprint is a stable physical proof of the isolated projection.
  select count(*)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 8675309)::numeric), 0)::text
  into v_destination_fingerprint
  from off_catalog.products_staging staged
  where staged.dataset_id = p_dataset_id;

  if v_destination_fingerprint <> p_source_fingerprint then
    raise exception using errcode = '22023', message = 'verification_fingerprint_mismatch';
  end if;

  v_verified_at := clock_timestamp();
  update off_catalog.datasets
  set status = 'staged',
      source_fingerprint = p_source_fingerprint,
      source_fingerprint_verified_at = v_verified_at,
      updated_at = v_verified_at
  where id = p_dataset_id;

  return v_verified_at;
end;
$$;

-- Recovery-only bridge for an activation that began under migration 004,
-- after its source/staging fingerprints had already been compared but before
-- migration 005 could persist the seal. It validates only durable metadata and
-- indexed activation checkpoints; the operator must supply the fingerprint
-- printed by that successful comparison. This function cannot start a new
-- activation and cannot change an existing seal.
create or replace function off_catalog.adopt_existing_verified_activation(
  p_dataset_id uuid,
  p_source_sha256 text,
  p_source_fingerprint text,
  p_expected_rows bigint
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
  v_destination_fingerprint text;
  v_current_rows bigint;
  v_invalid_rows bigint;
  v_verified_at timestamptz;
begin
  -- Match seal_staged_dataset()'s lock order: table first, dataset row second.
  -- This drains older staging writers and prevents a new writer from racing
  -- the recovery proof below.
  lock table off_catalog.products_staging in share mode;

  select * into v_dataset
  from off_catalog.datasets dataset
  where dataset.id = p_dataset_id
  for update;

  if v_dataset.id is null then
    raise exception using errcode = 'P0002', message = 'dataset_not_found';
  end if;
  if v_dataset.status <> 'activating'
     or v_dataset.source_fingerprint is not null
     or v_dataset.source_fingerprint_verified_at is not null then
    raise exception using errcode = '55000', message = 'activation_not_adoptable';
  end if;
  if p_source_sha256 is null
     or p_source_sha256 !~ '^[0-9a-f]{64}$'
     or p_source_sha256 <> v_dataset.source_sha256 then
    raise exception using errcode = '22023', message = 'source_sha256_mismatch';
  end if;
  if p_source_fingerprint is null
     or p_source_fingerprint !~ '^[0-9]+\|-?[0-9]+\|-?[0-9]+$'
     or p_expected_rows is null
     or p_expected_rows <= 0
     or split_part(p_source_fingerprint, '|', 1)::bigint <> p_expected_rows
     or v_dataset.expected_rows <> p_expected_rows
     or v_dataset.staged_rows <> p_expected_rows then
    raise exception using errcode = '22023', message = 'verification_row_count_mismatch';
  end if;
  if v_dataset.activated_rows <= 0
     or v_dataset.activated_rows >= v_dataset.staged_rows
     or v_dataset.activation_cursor is null
     or not exists (
       select 1
       from off_catalog.products_staging staged
       where staged.dataset_id = p_dataset_id
         and staged.canonical_gtin = v_dataset.activation_cursor
     )
     or not exists (
       select 1
       from off_catalog.products_current product
       where product.canonical_gtin = v_dataset.activation_cursor
         and product.dataset_id = p_dataset_id
         and product.is_active
     ) then
    raise exception using errcode = '55000', message = 'activation_checkpoint_mismatch';
  end if;

  -- This is a one-time recovery path: prove that isolated staging still
  -- matches the operator-supplied source fingerprint.
  select count(*)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 0)::numeric), 0)::text || '|' ||
         coalesce(sum(hashtextextended((to_jsonb(staged) - array[
           'dataset_id','staged_at'
         ])::text, 8675309)::numeric), 0)::text
  into v_destination_fingerprint
  from off_catalog.products_staging staged
  where staged.dataset_id = p_dataset_id;
  if v_destination_fingerprint <> p_source_fingerprint then
    raise exception using errcode = '22023', message = 'verification_fingerprint_mismatch';
  end if;

  -- One recovery scan of the partial runtime projection prevents adoption of
  -- a forged activated_rows counter or rows from another generation.
  select count(*), count(*) filter (
    where product.dataset_id <> p_dataset_id or not product.is_active
  )
  into v_current_rows, v_invalid_rows
  from off_catalog.products_current product;
  if v_current_rows <> v_dataset.activated_rows or v_invalid_rows <> 0 then
    raise exception using errcode = '55000', message = 'activation_checkpoint_mismatch';
  end if;

  v_verified_at := clock_timestamp();
  update off_catalog.datasets
  set source_fingerprint = p_source_fingerprint,
      source_fingerprint_verified_at = v_verified_at,
      updated_at = v_verified_at
  where id = p_dataset_id;

  return v_verified_at;
end;
$$;

-- Preparing or resuming activation now validates only durable metadata and
-- indexed cursor rows. The one-time source/destination fingerprint comparison
-- performed before sealing is not repeated.
create or replace function off_catalog.prepare_initial_activation(p_dataset_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset off_catalog.datasets;
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
  if v_dataset.source_fingerprint is null
     or v_dataset.source_fingerprint_verified_at is null
     or split_part(v_dataset.source_fingerprint, '|', 1)::bigint <> v_dataset.staged_rows then
    raise exception using errcode = '55000', message = 'dataset_not_verified';
  end if;
  if exists (
    select 1 from off_catalog.datasets dataset
    where dataset.provider_key = v_dataset.provider_key
      and dataset.status = 'active'
  ) then
    raise exception using errcode = '55000', message = 'initial_activation_requires_no_active_dataset';
  end if;

  if v_dataset.status = 'staged' then
    if v_dataset.activated_rows <> 0
       or v_dataset.activation_cursor is not null
       or exists (select 1 from off_catalog.products_current) then
      raise exception using errcode = '55000', message = 'initial_activation_requires_empty_runtime';
    end if;
    update off_catalog.datasets
    set status = 'activating', updated_at = clock_timestamp()
    where id = p_dataset_id;
    return 0;
  end if;

  if v_dataset.activated_rows > v_dataset.staged_rows
     or (v_dataset.activated_rows = 0 and v_dataset.activation_cursor is not null)
     or (
       v_dataset.activated_rows > 0
       and (
         v_dataset.activation_cursor is null
         or not exists (
           select 1 from off_catalog.products_current product
           where product.canonical_gtin = v_dataset.activation_cursor
             and product.dataset_id = p_dataset_id
             and product.is_active
         )
         or not exists (
           select 1 from off_catalog.products_staging staged
           where staged.dataset_id = p_dataset_id
             and staged.canonical_gtin = v_dataset.activation_cursor
         )
       )
     ) then
    raise exception using errcode = '55000', message = 'activation_checkpoint_mismatch';
  end if;

  return v_dataset.activated_rows;
end;
$$;

-- Final publication performs one unavoidable physical read of products_current
-- and compares it to the durable source seal. It no longer re-hashes staging.
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

revoke all on function off_catalog.guard_dataset_verification_seal() from public;
revoke all on function off_catalog.assert_staging_datasets_mutable(uuid[]) from public;
revoke all on function off_catalog.guard_verified_staging_insert() from public;
revoke all on function off_catalog.guard_verified_staging_update() from public;
revoke all on function off_catalog.guard_verified_staging_delete() from public;
revoke all on function off_catalog.seal_staged_dataset(uuid, text, bigint)
  from public, off_catalog_reader, off_catalog_importer;
revoke all on function off_catalog.adopt_existing_verified_activation(uuid, text, text, bigint)
  from public, off_catalog_reader, off_catalog_importer;

comment on column off_catalog.datasets.source_fingerprint is
  'Durable count and dual-hash seal of the validated OFF projection: count|hash(seed 0)|hash(seed 8675309).';
comment on column off_catalog.datasets.source_fingerprint_verified_at is
  'Time at which independent source and isolated-staging fingerprints were proven equal.';
