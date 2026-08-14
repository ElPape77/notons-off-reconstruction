# Security policy

Please report a suspected vulnerability privately through GitHub's security
advisory feature for this repository. Do not open a public issue containing a
secret, connection string, exploit or personal data.

This repository must never contain a production database URL, password, API
key, database dump, Open Food Facts archive or Notons user data. The importer
only accepts the dedicated `OFF_CATALOG_DATABASE_URL` and
`OFF_CATALOG_ADMIN_DATABASE_URL` variables (or their `*_FILE` equivalents) and
refuses a database whose name is not exactly `notons_off_catalog`.
