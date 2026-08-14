-- Runtime indexes are isolated from the schema migration so a legacy bulk
-- transfer can explicitly drop/rebuild them around the one-time activation.
-- Normal provisioning still applies this migration immediately on an empty
-- table, which is cheap.

create index if not exists products_current_search_vector_idx
  on off_catalog.products_current using gin (search_vector);
create index if not exists products_current_search_trgm_idx
  on off_catalog.products_current using gin (search_text gin_trgm_ops);
create index if not exists products_current_brand_idx
  on off_catalog.products_current (lower(brand)) where brand is not null and is_active;
create index if not exists products_current_category_idx
  on off_catalog.products_current (category_slug, canonical_gtin) where is_active;
create index if not exists products_current_updated_idx
  on off_catalog.products_current (off_last_updated_at desc) where off_last_updated_at is not null;
