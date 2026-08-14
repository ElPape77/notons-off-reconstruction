-- A sealed generation already proves both the immutable source contract and
-- the complete projection fingerprint.  Resume/activation retries can reuse
-- that database-owned proof without reopening a multi-gigabyte local archive.
-- Copying generations are deliberately never returned: they must still hash
-- and stream the official archive before another checkpoint is accepted.

create function off_catalog.find_sealed_native_reconstruction(
  p_source_url text,
  p_source_filename text,
  p_source_sha256 text,
  p_source_published_at timestamptz,
  p_source_retrieved_at timestamptz,
  p_importer_version text,
  p_projection_version text,
  p_immutable_code_url text,
  p_code_revision text
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
stable
security definer
set search_path = ''
set statement_timeout = '5s'
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
     or char_length(trim(coalesce(p_importer_version, ''))) not between 1 and 120
     or char_length(trim(coalesce(p_projection_version, ''))) not between 1 and 120
     or coalesce(p_code_revision, '') !~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
     or coalesce(p_immutable_code_url, '') !~ '^https://'
     or lower(p_immutable_code_url) !~ (
       '(^|[^0-9a-f])' || p_code_revision || '([^0-9a-f]|$)'
     ) then
    raise exception using
      errcode = '22023', message = 'sealed_native_reconstruction_metadata_invalid';
  end if;

  select dataset.* into v_dataset
  from off_catalog.datasets dataset
  where dataset.source_sha256 = p_source_sha256;
  if v_dataset.id is null then
    return;
  end if;

  -- The SHA alone is not enough: accepting a changed date, URL, transformer or
  -- scope here would let a result claim metadata that was never verified.
  if v_dataset.provider_key <> 'open_food_facts'
     or v_dataset.source_name <> 'Open Food Facts'
     or v_dataset.source_url <> p_source_url
     or v_dataset.source_filename <> trim(p_source_filename)
     or v_dataset.source_published_at is distinct from p_source_published_at
     or v_dataset.source_retrieved_at is distinct from p_source_retrieved_at
     or v_dataset.importer_version <> trim(p_importer_version)
     or v_dataset.projection_version <> trim(p_projection_version)
     or v_dataset.license_name <> 'ODbL 1.0'
     or v_dataset.license_url
          <> 'https://opendatacommons.org/licenses/odbl/1-0/'
     or v_dataset.import_contract ->> 'pipeline'
          is distinct from 'notons-off-reconstruction/1'
     or v_dataset.import_contract ->> 'mapper' is distinct from 'open-food-facts'
     or v_dataset.import_contract #>> '{scope,allCountries}' is distinct from 'true'
     or v_dataset.import_contract #>> '{scope,allCategories}' is distinct from 'true'
     or v_dataset.import_contract #>> '{scope,fullSnapshot}' is distinct from 'true'
     or (
       case
         when jsonb_typeof(v_dataset.import_contract -> 'sourceHeader') = 'array'
           then jsonb_array_length(v_dataset.import_contract -> 'sourceHeader')
                not between 2 and 1000
         else true
       end
     )
     or exists (
       select 1
       from jsonb_array_elements_text(
         case
           when jsonb_typeof(v_dataset.import_contract -> 'sourceHeader') = 'array'
             then v_dataset.import_contract -> 'sourceHeader'
           else '[]'::jsonb
         end
       ) as header(column_name)
       where char_length(header.column_name) not between 1 and 200
     )
     or (
       select count(*) <> count(distinct lower(header.column_name))
              or coalesce(sum(octet_length(header.column_name)), 0) > 131072
       from jsonb_array_elements_text(
         case
           when jsonb_typeof(v_dataset.import_contract -> 'sourceHeader') = 'array'
             then v_dataset.import_contract -> 'sourceHeader'
           else '[]'::jsonb
         end
       ) as header(column_name)
     )
     or v_dataset.import_contract ->> 'immutableCodeUrl'
          is distinct from p_immutable_code_url
     or v_dataset.import_contract ->> 'codeRevision' is distinct from p_code_revision then
    raise exception using
      errcode = '22023', message = 'sealed_native_reconstruction_contract_mismatch';
  end if;

  -- No shortcut is safe before seal_native_reconstruction has computed and
  -- stored the full staging fingerprint.
  if v_dataset.status = 'copying' then
    return;
  end if;
  if v_dataset.status not in ('staged', 'activating', 'active')
     or v_dataset.source_fingerprint is null
     or v_dataset.source_fingerprint_verified_at is null
     or v_dataset.staged_rows < 1
     or split_part(v_dataset.source_fingerprint, '|', 1)::bigint
          <> v_dataset.staged_rows then
    raise exception using
      errcode = '55000', message = 'sealed_native_reconstruction_state_invalid';
  end if;

  select job.* into v_job
  from off_catalog.import_jobs job
  where job.dataset_id = v_dataset.id
    and job.worker_key = 'native_archive_v1';
  if v_job.id is null
     or v_job.source_offset < 1
     or v_job.processed_rows < 1
     or v_job.processed_rows < v_job.rejected_rows + v_job.filtered_rows
     or v_dataset.staged_rows
          > v_job.processed_rows - v_job.rejected_rows - v_job.filtered_rows then
    raise exception using
      errcode = '55000', message = 'sealed_native_reconstruction_job_invalid';
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

revoke all on function off_catalog.find_sealed_native_reconstruction(
  text, text, text, timestamptz, timestamptz, text, text, text, text
) from public, off_catalog_reader;

grant execute on function off_catalog.find_sealed_native_reconstruction(
  text, text, text, timestamptz, timestamptz, text, text, text, text
) to off_catalog_importer;

comment on function off_catalog.find_sealed_native_reconstruction(
  text, text, text, timestamptz, timestamptz, text, text, text, text
) is 'Returns an exact sealed native reconstruction so resume retries can skip the local archive safely; copying generations are never returned.';
