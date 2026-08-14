-- The private gateway performs category matching with this bounded immutable
-- helper. Keep the reader out of the public schema: only the no-login catalogue
-- owner executes unaccent through this fixed, argument-only wrapper.

grant usage on schema public to off_catalog_owner;
grant execute on function public.unaccent(text) to off_catalog_owner;

create or replace function off_catalog.normalize_search_text(p_value text)
returns text
language sql
immutable
parallel safe
security definer
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

grant execute on function off_catalog.normalize_search_text(text)
  to off_catalog_reader;

revoke execute on function off_catalog.normalize_gtin(text)
  from off_catalog_reader;
revoke execute on function off_catalog.open_food_facts_url_is_valid(text)
  from off_catalog_reader;
