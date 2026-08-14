\set ON_ERROR_STOP on

begin;

do $view_contract$
declare
  v_definition text;
  v_options text[];
  v_public_select boolean;
begin
  select pg_catalog.pg_get_viewdef('off_catalog.products_published'::regclass, true)
  into v_definition;
  select
    relation.reloptions,
    exists (
      select 1
      from pg_catalog.aclexplode(
        coalesce(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) acl
      where acl.grantee = 0
        and acl.privilege_type = 'SELECT'
    )
  into v_options, v_public_select
  from pg_catalog.pg_class relation
  where relation.oid = 'off_catalog.products_published'::regclass;

  if v_definition !~* 'dataset.status = ''active''' or
     v_definition !~* 'product.is_active' then
    raise exception 'published_view_lost_atomic_visibility_predicates';
  end if;
  if coalesce(v_options, array[]::text[]) && array['security_barrier=true'] then
    raise exception 'published_view_still_blocks_index_pushdown';
  end if;
  if not has_table_privilege(
    'off_catalog_reader', 'off_catalog.products_published', 'SELECT'
  ) or has_table_privilege(
    'off_catalog_reader', 'off_catalog.products_current', 'SELECT'
  ) or has_table_privilege(
    'off_catalog_reader', 'off_catalog.datasets', 'SELECT'
  ) or has_table_privilege(
    'off_catalog_importer', 'off_catalog.products_published', 'SELECT'
  ) or v_public_select then
    raise exception 'published_view_acl_mismatch';
  end if;
end
$view_contract$;

-- Isolate the text-search access path from the unrelated partial ranking
-- index. On a tiny fixture PostgreSQL may rationally scan that smaller B-tree
-- and filter search_text, which says nothing about LIKE pushdown. The drop is
-- transactional and the final rollback restores the production index.
set local role off_catalog_owner;
drop index off_catalog.products_current_ranking_category_idx;
reset role;

-- GIN is consumed through a bitmap scan. Disable sequential and ordinary
-- B-tree index scans so neither the table nor its primary key can become a
-- size-dependent fallback; keep the intended bitmap access path explicit.
set local enable_seqscan = off;
set local enable_indexscan = off;
set local enable_indexonlyscan = off;
set local enable_bitmapscan = on;
set local role off_catalog_reader;
do $trigram_plan$
declare
  v_line record;
  v_plan text := '';
begin
  for v_line in execute $explain$
    explain (costs off)
    select p.canonical_gtin
    from off_catalog.products_published p
    where p.is_active
      and p.search_text like
        ('%' || off_catalog.normalize_search_text('nutella') || '%')
    limit 30
  $explain$
  loop
    v_plan := v_plan || E'\n' || v_line."QUERY PLAN";
  end loop;

  if v_plan not like '%products_current_search_trgm_idx%' then
    raise exception 'published_text_search_does_not_use_trigram_index: %', v_plan;
  end if;
end
$trigram_plan$;
reset role;

rollback;
