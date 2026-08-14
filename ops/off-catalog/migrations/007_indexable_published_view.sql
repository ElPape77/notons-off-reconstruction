-- `security_barrier` prevents PostgreSQL from pushing the gateway's trigram
-- predicate through the publication view.  The barrier is unnecessary here:
-- the reader has SELECT only on this view and no privilege on either base
-- table.  Removing it preserves the active-dataset publication boundary while
-- allowing the runtime indexes to serve the bounded gateway queries.

alter view off_catalog.products_published reset (security_barrier);

-- Keep the least-privilege boundary explicit even though ALTER VIEW preserves
-- the existing ACL.
revoke all on off_catalog.products_published from public, off_catalog_importer;
grant select on off_catalog.products_published to off_catalog_reader;
revoke all on off_catalog.products_current from off_catalog_reader;
revoke all on off_catalog.datasets from off_catalog_reader;

comment on view off_catalog.products_published is
  'Indexable read-only view of the atomically published OFF generation. Partial activation batches remain invisible.';

do $migration_checks$
declare
  v_options text[];
  v_public_select boolean;
begin
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
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'off_catalog'
    and relation.relname = 'products_published';

  if coalesce(v_options, array[]::text[]) && array['security_barrier=true'] then
    raise exception 'products_published_security_barrier_still_enabled';
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
    raise exception 'products_published_acl_mismatch';
  end if;
end
$migration_checks$;
