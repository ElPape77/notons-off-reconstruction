\set ON_ERROR_STOP on

begin;

-- ALTER ROLE IN DATABASE settings apply only when off_catalog_reader is the
-- exact login role of a new connection. Verify the persisted defaults and the
-- initial NOLOGIN state here. SET ROLE below deliberately tests only the
-- reader's ACL and pure helpers; the smoke runner tests the authenticated GUCs.
do $reader_runtime_contract$
declare
  v_reader_role oid;
  v_reader_can_login boolean;
  v_settings text[];
begin
  select role.oid, role.rolcanlogin
  into v_reader_role, v_reader_can_login
  from pg_catalog.pg_roles role
  where role.rolname = 'off_catalog_reader';

  if v_reader_role is null then
    raise exception 'reader_role_missing';
  end if;
  if v_reader_can_login is distinct from false then
    raise exception 'reader_role_not_nologin';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = v_reader_role
       or membership.member = v_reader_role
  ) then
    raise exception 'reader_role_membership_forbidden';
  end if;

  select coalesce((
    select settings.setconfig
    from pg_catalog.pg_db_role_setting settings
    where settings.setdatabase = (
        select database.oid
        from pg_catalog.pg_database database
        where database.datname = current_database()
      )
      and settings.setrole = v_reader_role
  ), array[]::text[])
  into v_settings;

  if not v_settings @> array[
    'statement_timeout=5s',
    'lock_timeout=1s',
    'idle_in_transaction_session_timeout=5s',
    'transaction_timeout=8s',
    'default_transaction_read_only=on'
  ] then
    raise exception 'reader_runtime_limits_missing: %', v_settings;
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
    'off_catalog_importer', 'off_catalog.escape_like_pattern(text)', 'EXECUTE'
  ) or not has_function_privilege(
    'off_catalog_reader', 'off_catalog.escape_like_pattern(text)', 'EXECUTE'
  ) then
    raise exception 'reader_like_escape_acl_mismatch';
  end if;
end
$reader_runtime_contract$;

set local role off_catalog_reader;

do $like_contract$
begin
  if off_catalog.escape_like_pattern('100%_bio\test') <> E'100\\%\\_bio\\\\test' then
    raise exception 'like_escape_contract_mismatch';
  end if;
  if off_catalog.normalize_search_text('100%_bio') <> '100 bio' then
    raise exception 'search_normalization_contract_mismatch';
  end if;
end
$like_contract$;

reset role;
rollback;
