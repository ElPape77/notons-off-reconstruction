-- Reader runtime safety is configured by the administrative bootstrap before
-- migrations are applied as off_catalog_owner. ALTER ROLE IN DATABASE applies
-- only when off_catalog_reader is the exact login role of a new connection;
-- SET ROLE cannot exercise those session defaults. At initialisation this
-- migration therefore verifies the persisted defaults and mandatory NOLOGIN
-- state. The authenticated exact-login contract is covered by the smoke runner.

create or replace function off_catalog.escape_like_pattern(p_value text)
returns text
language sql
immutable
parallel safe
security definer
set search_path = ''
as $$
  select replace(
    replace(
      replace(coalesce(p_value, ''), E'\\', E'\\\\'),
      '%', E'\\%'
    ),
    '_', E'\\_'
  );
$$;

revoke all on function off_catalog.escape_like_pattern(text)
  from public, off_catalog_importer;
grant execute on function off_catalog.escape_like_pattern(text) to off_catalog_reader;

comment on function off_catalog.escape_like_pattern(text) is
  'Escapes LIKE metacharacters after normalize_search_text so user input cannot widen a bounded catalogue search.';

do $reader_runtime_checks$
declare
  v_database oid := (
    select database.oid
    from pg_catalog.pg_database database
    where database.datname = current_database()
  );
  v_role oid;
  v_role_can_login boolean;
  v_settings text[];
begin
  select role.oid, role.rolcanlogin
  into v_role, v_role_can_login
  from pg_catalog.pg_roles role
  where role.rolname = 'off_catalog_reader';

  if v_role is null then
    raise exception 'off_catalog_reader_role_missing';
  end if;
  if v_role_can_login is distinct from false then
    raise exception 'off_catalog_reader_must_start_nologin';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = v_role
       or membership.member = v_role
  ) then
    raise exception 'off_catalog_reader_role_membership_forbidden';
  end if;

  select coalesce((
    select settings.setconfig
    from pg_catalog.pg_db_role_setting settings
    where settings.setdatabase = v_database
      and settings.setrole = v_role
  ), array[]::text[])
  into v_settings;

  if not v_settings @> array[
    'statement_timeout=5s',
    'lock_timeout=1s',
    'idle_in_transaction_session_timeout=5s',
    'transaction_timeout=8s',
    'default_transaction_read_only=on'
  ] then
    raise exception 'off_catalog_reader_runtime_limits_missing: %', v_settings;
  end if;
  if not has_function_privilege(
    'off_catalog_reader',
    'off_catalog.escape_like_pattern(text)',
    'EXECUTE'
  ) then
    raise exception 'off_catalog_reader_like_escape_missing';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) privilege
    where procedure.oid = 'off_catalog.escape_like_pattern(text)'::regprocedure
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ) or has_function_privilege(
    'off_catalog_importer',
    'off_catalog.escape_like_pattern(text)',
    'EXECUTE'
  ) then
    raise exception 'off_catalog_like_escape_acl_too_wide';
  end if;
end
$reader_runtime_checks$;
