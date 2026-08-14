# Méthode reproductible de la base dérivée Open Food Facts

Ce document décrit la méthode complète appliquée par Notons au catalogue Open
Food Facts. Il constitue la voie prévue à la section 4.6(b) de l’ODbL 1.0 : la
méthode et les algorithmes d’altération sont publiés, mais aucune copie de la
base et aucune donnée Notons ne sont proposées au téléchargement.

La méthode publique doit toujours être accompagnée du
`reconstruction-manifest.json` généré pour la génération réellement utilisée.
Ce manifeste identifie l’archive source par URL, date, taille et SHA-256, ainsi
que la révision immuable et le SHA-256 de chaque fichier de transformation.
L’URL HTTPS du code doit contenir cette révision hexadécimale exacte : un lien
de branche, de tag mutable ou de page « latest » est refusé.

## Entrée et portée

- Source complète : export officiel alimentaire Open Food Facts TSV compressé
  avec gzip.
- Délimiteur : tabulation physique. Les guillemets sont des caractères de
  données et non des délimiteurs CSV.
- Chaque ligne doit avoir exactement le nombre de colonnes du header.
- Le snapshot complet utilise tous les pays et toutes les catégories, sans
  `limit` et sans filtrage métier Notons.
- Une ligne sans code-barres ou sans nom utilisable est rejetée et comptabilisée.
- Cette version publique reconstruit une génération complète. Une future méthode
  de mise à jour différentielle devra être publiée et manifestée séparément avant
  d’être utilisée pour produire une génération publique.

La base produite contient exclusivement la projection OFF dans
`notons_off_catalog.off_catalog`. Les comptes, profils, avis, notes, favoris,
scans, signalements, décisions de modération, propositions et photos privées
Notons n’entrent jamais dans ce pipeline.

## Normalisations

1. Le code source est choisi dans `code`, `barcode`, puis `gtin`. Il est
   normalisé par `packages/shared/src/gtin.ts` et stocké comme texte afin de
   conserver les zéros initiaux. Une valeur non conforme est rejetée.
2. Les chaînes sont nettoyées aux extrémités. Une chaîne vide devient `NULL` ;
   une absence ne devient jamais zéro ni une mauvaise note implicite.
3. Les listes acceptent une liste JSON ou une chaîne séparée par des virgules.
   Elles sont nettoyées, dédupliquées sans tenir compte de la casse et bornées
   en nombre d’éléments et en octets. Les tags sont mis en minuscules.
4. Les nombres acceptent le point ou la virgule décimale, ainsi que les préfixes
   indicatifs `<` et `~`. Une valeur non finie ou hors plage devient `NULL`.
5. Les dates Unix en secondes ou millisecondes et les dates ISO valides sont
   converties en UTC ISO-8601.
6. À GTIN identique, la dernière occurrence valide dans l’archive gagne. L’ordre
   de lecture est donc normatif et rejouer la même archive est idempotent.

## Projection des champs

| Champ produit dérivé                  | Champs OFF consultés et règle                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `barcode`, `canonical_gtin`           | `code`, `barcode`, `gtin`, puis normalisation GTIN                                                                                          |
| `name`                                | premier de `product_name_fr`, `product_name`, `generic_name_fr`, `generic_name`                                                             |
| `generic_name`                        | `generic_name_fr`, puis `generic_name`                                                                                                      |
| `brand`                               | `brands`, puis `brand`                                                                                                                      |
| `quantity`                            | `quantity`                                                                                                                                  |
| `packaging`                           | `packaging_text_fr`, `packaging_text`, puis `packaging`                                                                                     |
| `off_categories`, `off_category_tags` | `categories_fr`/`categories` et `categories_tags`                                                                                           |
| `category_slug`                       | compatibilité historique : première règle ordonnée correspondant à six sous-familles de snacks ; ce champ ne filtre jamais l’import général |
| `countries`, `country_tags`           | `countries_fr`/`countries` et `countries_tags`                                                                                              |
| `stores`, `purchase_places`           | champs homonymes ; ce sont des signalements, jamais une disponibilité temps réel                                                            |
| `nutriscore_grade`                    | `a` à `e` uniquement                                                                                                                        |
| `nutriscore_score`                    | entier entre -100 et 100                                                                                                                    |
| `environmental_score_grade`           | `environmental_score_grade`, repli `ecoscore_grade` ; valeurs `a-plus`, `a` à `f`                                                           |
| `environmental_score_score`           | champ `environmental_score_score`, repli `ecoscore_score` ; entier de 0 à 100                                                               |
| `serving_size`                        | `serving_size`                                                                                                                              |
| nutrition structurée                  | énergie kJ/kcal, lipides, saturés, glucides, sucres, fibres, protéines, sel et sodium, pour 100 g et par portion                            |
| `nutriments`                          | autres nutriments scalaires, maximum 400 clés ; les 20 valeurs structurées ne sont pas dupliquées                                           |
| `open_food_facts_url`                 | URL OFF fournie ou URL produit reconstruite à partir du code                                                                                |
| images de face                        | champs `image_front_*`, `image_url`, `image_small_url`, avec replis documentés dans le mapper                                               |
| dates OFF                             | `last_modified_t`/`last_modified_datetime` et `last_updated_t`/`last_updated_datetime`                                                      |

Une URL distante est convertie de HTTP vers HTTPS, puis conservée uniquement si
son hôte est `openfoodfacts.org`, `openfoodfacts.net` ou un de leurs
sous-domaines, sans identifiant incorporé. Les octets des images ne font pas
partie de la base dérivée ; seules les URL sont stockées.

Les limites exactes, l’ordre des replis, les règles de catégories et les champs
nutritionnels sont normatifs dans
`packages/catalog-import/src/mappers/open-food-facts.ts`. Le manifeste public
en fixe le contenu par SHA-256 et par révision immuable.

## Construction reproductible

Sur une machine disposant de Node.js 22+ et PostgreSQL 17, dans la révision
indiquée par le manifeste :

1. télécharger l’URL source du manifeste et vérifier sa taille et son SHA-256 ;
2. récupérer la révision immuable indiquée par `immutableCodeUrl` ;
3. vérifier que `git rev-parse HEAD` correspond exactement à cette révision et
   que le checkout ne contient aucune modification suivie ou non suivie ; les
   commandes de reconstruction et de manifeste appliquent elles-mêmes ces
   contrôles. Pour chaque fichier normatif, elles comparent aussi directement
   les octets du fichier au blob `HEAD`, sans faire confiance aux seuls index et
   statut Git ; les drapeaux locaux `assume-unchanged` et `skip-worktree` ne
   peuvent donc pas masquer une modification ;
4. vérifier les SHA-256 de tous les fichiers listés dans le manifeste ;
5. créer une base PostgreSQL vide nommée exactement `notons_off_catalog` ;
6. fournir temporairement son URL administrative dans
   `OFF_CATALOG_ADMIN_DATABASE_URL`, puis exécuter
   `npm run catalog:off-init` : cette commande crée uniquement les rôles, le
   schéma et les extensions OFF, puis applique dans l’ordre les migrations de
   `ops/off-catalog/migrations` avec contrôle de leurs SHA-256. Elle refuse une
   relation de données hors du schéma OFF et refuse aussi un schéma OFF déjà
   rempli qui ne possède pas son registre de migrations ;
7. fournir une URL de cette même base dans `OFF_CATALOG_DATABASE_URL`, puis
   exécuter l’entrée `npm run catalog:off-reconstruct --` avec tous les arguments
   exacts du tableau `transformation.fullSnapshotArguments` du manifeste. Sur
   une machine indépendante, l’URL administrative peut être réutilisée ; en
   production, elle est remplacée par un identifiant LOGIN membre uniquement de
   `off_catalog_importer`, créé hors du dépôt par le gestionnaire de secrets.
   Avant toute recherche de génération existante, lecture de l’archive ou
   écriture, l’importeur calcule le SHA-256 des migrations normatives 001 à 012
   du commit courant et appelle une primitive `SECURITY DEFINER`. Celle-ci
   atteste une égalité exacte avec `off_catalog.schema_migrations` : tout nom ou
   SHA différent, toute migration manquante ou supplémentaire arrête la
   reconstruction. Le rôle importeur ne reçoit aucun droit de lecture directe
   sur ce registre ;
8. conserver le fichier donné à `--result`, normalement
   `dist/reconstruction-result.json`. Il ne contient aucune ligne produit,
   mais le SHA de l’archive, les versions du code, les compteurs et l’empreinte de
   projection vérifiée ;
9. générer le manifeste public à partir de ce résultat avec
   `npm run catalog:off-manifest -- --archive ... --result dist/reconstruction-result.json --output dist/reconstruction-manifest.json`.
   Le générateur refuse un résultat non activé ou incohérent avec l’archive, le
   commit Git public courant ou un dépôt contenant des modifications locales.
   `dist/` est ignoré afin que ces deux artefacts metadata-only ne rendent pas le
   checkout impur ; aucun fichier normatif n’est ignoré ni exempté du contrôle
   Git.

Le lecteur runtime suit un contrat différent de l’importeur. L’initialiseur
force d’abord `off_catalog_owner`, `off_catalog_importer` et
`off_catalog_reader` à `NOLOGIN`, y compris si ces rôles existaient déjà. Après
la fin de l’initialisation, le gestionnaire de secrets active `LOGIN` avec un mot
de passe SCRAM directement sur le rôle stable exact `off_catalog_reader` ; le
service de lecture ouvre ses nouvelles connexions avec ce nom d’utilisateur.
Il ne faut pas créer un autre LOGIN membre du rôle lecteur ni compter sur
`SET ROLE` : PostgreSQL charge les paramètres `ALTER ROLE ... IN DATABASE`
(`statement_timeout`, `lock_timeout`, délais de transaction et lecture seule)
pour le rôle de connexion lors de l’ouverture de session, pas lors d’un
changement de rôle. Une réinitialisation remet volontairement le lecteur à
`NOLOGIN` et refuse toute appartenance entrante ou sortante de ce rôle ; le
gestionnaire de secrets doit alors réactiver et faire tourner son mot de passe
avant de redémarrer le service runtime.

Exemple de commande d’import (les valeurs entre chevrons viennent du manifeste) :

```text
npm run catalog:off-reconstruct -- \
  --file <archive-officielle.tsv.gz> \
  --source-sha256 <sha256> \
  --source-url <url-officielle-https> \
  --source-published-at <date-utc> \
  --source-retrieved-at <date-utc> \
  --code-url <url-revision-immuable> \
  --code-revision <revision-40-ou-64-hex> \
  --batch-size 500 \
  --activation-batch-size 100000 \
  --activate \
  --result dist/reconstruction-result.json
```

L’importeur dédié ne lit jamais `DATABASE_URL`. Il accepte uniquement
`OFF_CATALOG_DATABASE_URL` (ou son équivalent `*_FILE`) et refuse une URL dont
le nom de base n’est pas exactement `notons_off_catalog`. Les identifiants de
connexion ne figurent ni dans le résultat ni dans le manifeste public.

Lorsqu’une passe source est nécessaire, l’archive compressée est d’abord copiée
octet par octet vers un répertoire temporaire privé créé par le système. Le
répertoire est limité au processus (`0700` sur POSIX) et le fichier y est créé de
façon exclusive avec le mode `0600`. Le SHA-256 est calculé sur le flux compressé
exact écrit dans ce snapshot ; un écart arrête l’opération avant le parsing,
l’ouverture d’une session ou toute écriture catalogue. La projection lit ensuite
uniquement ce fichier vérifié, jamais une seconde ouverture du chemin source
mutable. Le snapshot est supprimé dans tous les cas après fermeture du lecteur,
y compris en cas d’erreur, d’interruption ou d’échec d’activation. Son nom
temporaire n’entre pas dans les métadonnées : `archiveFilename` reste le nom de
l’archive officielle d’origine.

Cette garantie exige temporairement un espace disque libre au moins égal à la
taille de l’archive compressée, en plus du fichier source. Le staging confirme un
offset source dans la même transaction que chaque lot de 500 lignes (1 000 au
maximum). Une reprise encore au statut `copying` crée et vérifie un nouveau
snapshot privé, puis reparcourt son flux gzip non indexé jusqu’à cet offset ; les
lignes confirmées ne sont toutefois ni remappées ni réécrites en base. Cette
relecture reste nécessaire car gzip ne fournit aucun point de reprise
authentifié et qu’un cache local mutable ne peut pas remplacer une vérification
cryptographique.

Après l’attestation du registre de migrations, `--resume` peut interroger le
contrat immuable et l’empreinte de projection conservés dans PostgreSQL. Une
génération `staged`, `activating` ou `active` dont l’URL, le SHA-256, les dates,
les versions et la révision de code correspondent exactement peut donc reprendre
l’activation sans lire à nouveau l’archive locale et sans créer de snapshot. Une
génération `copying` n’est jamais renvoyée par ce raccourci.
Ce raccourci ne s’applique pas au générateur du manifeste public : celui-ci exige
toujours une archive locale régulière, refuse les liens symboliques et recalcule
indépendamment son SHA-256 et sa taille.
Il n’y a aucune nouvelle copie complète ni recalcul de staging à chaque lot. La
copie du staging vers `off_catalog.products_current` utilise ensuite des lots
transactionnels de 100 000 produits au maximum. La relation runtime
`off_catalog.products_published` reste vide jusqu’à la vérification de
l’empreinte complète, la construction des index et l’activation atomique de la
génération. Aucun service Notons n’est nécessaire, aucune table Core ne figure
dans le contrat du dépôt et aucune connexion à `notons_core` n’est autorisée.

Deux index secondaires seulement sont reconstruits : GIN trigramme sur
`search_text` et B-tree d’expression sur la catégorie générale de classement
dérivée de `off_category_tags`, puis `canonical_gtin`. La taxonomie générale
ordonnée (boissons, fruits et légumes, produits laitiers, etc.) est fixée par la
migration normative `010_indexed_ranking_categories.sql`; les catégories OFF
complètes restent stockées sans limiter le catalogue aux snacks. La clé primaire
de `canonical_gtin` couvre déjà les scans, détails et hydratations de
classements. `ANALYZE` reste obligatoire pour fournir au planificateur les
statistiques de la nouvelle génération ; ce n’est pas une seconde empreinte du
catalogue.

## Notice et licences

La base source Open Food Facts est sous ODbL 1.0, ses contenus individuels sous
DbCL 1.0 et ses images sous CC BY-SA. La méthode doit être publiée à côté de la
notice d’attribution et rester au moins aussi accessible que le produit public
qui utilise la base dérivée.

Références :

- <https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/license-be-on-the-legal-side/>
- <https://opendatacommons.org/licenses/odbl/1-0/>
- <https://opendatacommons.org/licenses/dbcl/1-0/>
- <https://creativecommons.org/licenses/by-sa/3.0/>

Ce document est une mesure technique de conformité et non un avis juridique.
