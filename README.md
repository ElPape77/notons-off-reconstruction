# Notons — Open Food Facts reconstruction

[Français](#français) · [English](#english)

## Français

Ce dépôt public contient la méthode complète et reproductible utilisée par
Notons pour projeter un export officiel Open Food Facts dans une base PostgreSQL
isolée. Il permet l'option de conformité décrite à la section 4.6(b) de l'ODbL
1.0 : publier la méthode de transformation au lieu de publier la base dérivée.

Ce dépôt ne contient aucun dump Open Food Facts, aucune ligne de la base
dérivée, aucun avis et aucune donnée personnelle Notons. Un manifeste public
metadata-only identifie chaque reconstruction réellement utilisée par son
archive source, son SHA-256 et une révision Git immuable.

Avant toute lecture de l’archive ou écriture de catalogue, l’importeur exige
aussi que PostgreSQL atteste l’égalité exacte entre son registre de migrations
et les noms plus SHA-256 des migrations du commit public courant.
Lorsqu’un parsing est nécessaire, les octets compressés sont copiés et hashés
dans un snapshot temporaire privé et exclusif. La projection lit uniquement ce
snapshot exact vérifié, supprimé quelle que soit l’issue de l’opération.
Le service de lecture doit se connecter directement avec le rôle PostgreSQL
stable `off_catalog_reader` provisionné par le gestionnaire de secrets ; un
LOGIN membre ou un simple `SET ROLE` ne reçoit pas ses limites de session.

### Prérequis et vérification

- Node.js 22.13 ou ultérieur ;
- Git, avec un checkout propre du commit public déclaré ;
- PostgreSQL 17 pour une reconstruction complète ;
- une base vide nommée exactement `notons_off_catalog` ;
- l'export TSV gzip officiel Open Food Facts, vérifié par SHA-256.

```text
npm ci
npm test
npm run lint
npm run typecheck
npm run format:check
```

Les commandes de reconstruction, les variables dédiées et les garanties de
séparation sont documentées dans
[`docs/open-food-facts-reconstruction-method.md`](docs/open-food-facts-reconstruction-method.md).
Les licences et attributions sont séparées dans [`DATA-LICENSE.md`](DATA-LICENSE.md)
et [`NOTICE.md`](NOTICE.md).

## English

This public repository contains the complete, reproducible method used by
Notons to project an official Open Food Facts export into an isolated PostgreSQL
database. It supports the compliance route described by ODbL 1.0 section
4.6(b): publishing the transformation method instead of distributing the
derived database.

This repository contains no Open Food Facts dump, no derived database rows, no
Notons reviews and no personal data. A metadata-only public manifest identifies
each reconstruction actually used through its upstream archive, SHA-256 and an
immutable Git revision.

Before reading the archive or writing catalogue data, the importer also
requires PostgreSQL to attest an exact match between its migration ledger and
the migration names and SHA-256 values from the current public commit.
Whenever source parsing is needed, the compressed bytes are copied and hashed
into a private, exclusive temporary snapshot; projection reads only that exact
verified snapshot, which is removed on every exit path.
The runtime reader must connect directly as the stable PostgreSQL role
`off_catalog_reader`, provisioned by the secret manager; a member login or
`SET ROLE` does not receive its per-session limits.

### Requirements and checks

- Node.js 22.13 or later;
- Git, with a clean checkout of the declared public commit;
- PostgreSQL 17 for a complete reconstruction;
- an empty database named exactly `notons_off_catalog`;
- the official Open Food Facts gzip TSV export, verified by SHA-256.

```text
npm ci
npm test
npm run lint
npm run typecheck
npm run format:check
```

See
[`docs/open-food-facts-reconstruction-method.md`](docs/open-food-facts-reconstruction-method.md)
for the full method and [`DATA-LICENSE.md`](DATA-LICENSE.md) for the licence
boundary. This material is provided for technical transparency and is not legal
advice.
