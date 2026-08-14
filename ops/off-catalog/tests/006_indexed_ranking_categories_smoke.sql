\set ON_ERROR_STOP on

begin;

do $projection_contract$
begin
  if off_catalog.ranking_category_slug(array['en:beverages'], null) <> 'boissons'
     or off_catalog.ranking_category_slug(
       array['en:plant-based-foods', 'en:beverages'], null
     ) <> 'boissons'
     or off_catalog.ranking_category_slug(array['EN:DAIRIES'], null) <> 'produits-laitiers'
     or off_catalog.ranking_category_slug(null, 'chips-nature') <> 'snacks-confiseries'
     or off_catalog.ranking_category_slug(array['en:unknown-food'], null) <> 'autres' then
    raise exception 'ranking_category_projection_mismatch';
  end if;
end
$projection_contract$;

-- The gateway's empty-query alternatives path must be able to stop in index
-- order.  Disabling sequential scans makes this deterministic on an empty
-- freshly provisioned database as well as on a populated reconstruction.
set local enable_seqscan = off;
set local role off_catalog_reader;
do $ranking_category_plan$
declare
  v_line record;
  v_plan text := '';
begin
  for v_line in execute $explain$
    explain (costs off)
    select p.canonical_gtin
    from off_catalog.products_published p
    where p.is_active
      and off_catalog.ranking_category_slug(
        p.off_category_tags,
        p.category_slug
      ) = 'boissons'
    order by p.canonical_gtin
    limit 30 offset 30
  $explain$
  loop
    v_plan := v_plan || E'\n' || v_line."QUERY PLAN";
  end loop;

  if v_plan not like '%products_current_ranking_category_idx%' then
    raise exception 'ranking_category_browse_does_not_use_index: %', v_plan;
  end if;
end
$ranking_category_plan$;
reset role;

rollback;
