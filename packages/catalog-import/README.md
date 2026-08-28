# Import du catalogue Open Food Facts

## Pipeline actif : base OFF isolée

La reconstruction utilisée par l’application publique ne passe plus par les
tables catalogue de Notons Core. À partir d’une base PostgreSQL vide nommée
exactement `notons_off_catalog`, elle s’exécute ainsi :

```powershell
$offDatabaseUrl = 'postgresql://admin:secret@localhost/notons_off_catalog'
$env:OFF_CATALOG_ADMIN_DATABASE_URL = $offDatabaseUrl
npm run catalog:off-init
Remove-Item Env:OFF_CATALOG_ADMIN_DATABASE_URL

$env:OFF_CATALOG_DATABASE_URL = $offDatabaseUrl
npm run catalog:off-reconstruct -- --file ./data/catalog/catalog.tsv.gz --source-sha256 <SHA256> --source-url <URL_OFFICIELLE_HTTPS> --source-published-at <DATE_UTC> --source-retrieved-at <DATE_UTC> --code-url <REVISION_IMMUABLE_HTTPS> --code-revision <REVISION_HEX> --activate --result dist/reconstruction-result.json
Remove-Item Env:OFF_CATALOG_DATABASE_URL
$offDatabaseUrl = $null
```

Dans une reconstruction indépendante sur base vide, la même connexion
administrative peut être réutilisée par les deux commandes. En production, une
connexion LOGIN appartenant uniquement au rôle `off_catalog_importer` doit être
créée par le gestionnaire de secrets de l’hébergeur et utilisée pour la seconde
commande. L’initialiseur ne crée volontairement aucun mot de passe. Toute URL
est refusée si elle ne vise pas exactement la base OFF. Aucun secret ne doit être
placé dans l’application, Git ou le manifeste public. `--resume` reprend au
dernier offset source confirmé sans remapper ni réécrire les lignes déjà
engagées. Avant toute reconstruction, le rôle importeur fait attester, sans
pouvoir le lire directement, que le registre PostgreSQL contient exactement les
noms et SHA-256 des migrations 001 à 014 du commit public courant. La commande
et son contrat exact sont détaillés dans
`docs/open-food-facts-reconstruction-method.md`.

Cette appartenance à un rôle concerne uniquement l’importeur. Pour la lecture
runtime, le gestionnaire de secrets doit activer le LOGIN et le mot de passe
SCRAM sur le rôle exact `off_catalog_reader` après l’initialisation, puis le
service doit se connecter directement sous ce nom. Un LOGIN membre et
`SET ROLE off_catalog_reader` ne chargent pas les limites `ALTER ROLE ... IN
DATABASE`. L’initialiseur remet volontairement tous les rôles OFF à `NOLOGIN`
avant les migrations et refuse toute appartenance de rôle impliquant le lecteur,
afin qu’une ancienne configuration ne puisse pas rester ouverte par accident.

Si une passe de projection est nécessaire, l’archive compressée est copiée tout
en étant hashée dans un snapshot temporaire privé et créé de façon exclusive.
Seul ce snapshot vérifié est parsé, puis il est supprimé même en cas d’erreur ou
d’interruption. Il faut donc prévoir temporairement l’espace disque correspondant
à une copie supplémentaire de l’archive compressée.

Après activation, `npm run catalog:off-manifest --` produit le manifeste public
metadata-only sans dépendre de Bash ni de Python ; `npm run manifest:verify --`
le contrôle avant toute publication.

La seule commande générique conservée, `catalog:check`, transforme une archive
dans un repository en mémoire et ne charge aucun secret PostgreSQL. L’ancien
`catalog:import`, son repository Core et le pipeline delta ne sont plus exposés :
aucune commande de ce package ne peut réinjecter le catalogue OFF dans Core.

L'importeur lit les exports CSV/TSV ou JSON Lines en streaming, y compris les
fichiers `.gz` et `.zip`. Il ne charge jamais le fichier complet en mémoire et
n'enregistre pas les octets des images.

Les fichiers `.json.gz` sont traités comme du JSON Lines compressé : chaque
ligne décompressée est un objet JSON complet. Ce lecteur générique fonctionne
en streaming, sans matérialiser le fichier décompressé.

Le contrat Open Food Facts lit l'export officiel comme un TSV physique : les
guillemets doubles sont des caractères de données, pas des délimiteurs CSV, et
chaque ligne doit contenir exactement le nombre de colonnes du header. Une ligne
de largeur invalide est rejetée sans désynchroniser la suivante. Les lecteurs
CSV/TSV génériques conservent, eux, leur prise en charge habituelle des champs
quotés et multilignes.

L'archive officielle mesurée le 11 août 2026 contient 4 535 553 produits,
211 colonnes par ligne et 13 042 211 705 octets après décompression.

## Projection conservée

La projection Notons contient le GTIN, les noms, marque, quantité, catégories,
pays de vente déclarés, enseignes et lieux d'achat déclarés, Nutri-Score,
Green-Score (avec compatibilité des anciens champs `ecoscore_*`), portion,
valeurs nutritionnelles pour 100 g et par portion, nutriments supplémentaires,
la liste d'ingrédients, les allergènes déclarés, les liens et images de face
Open Food Facts, ainsi que les dates source.
Les 20 mesures nutritionnelles structurées ne sont pas dupliquées dans le
champ flexible, et les valeurs vides y sont omises.

Pour les images, la projection accepte les champs API `image_front_*` et les
colonnes réellement présentes dans l'export, `image_url` et `image_small_url`.
Toutes les tailles utilisent un repli disponible lorsque nécessaire, après
validation stricte d'une URL HTTPS appartenant à Open Food Facts.

Les tableaux participatifs `countries`, `stores` et `purchase_places` ne
constituent pas une information de stock en temps réel. Une valeur absente reste
`NULL` et n'est jamais remplacée par zéro.

## Validation sans écriture

Pour mesurer et valider 100 000 lignes sans créer de génération, utiliser :

```powershell
npm run catalog:check -- --file ./data/catalog/catalog.csv.gz --limit 100000
```

Des filtres peuvent être testés explicitement sans modifier une base :

```powershell
npm run catalog:check -- --file ./data/catalog/catalog.csv.gz --filter-countries --country-tags en:france
npm run catalog:check -- --file ./data/catalog/catalog.csv.gz --filter-categories --category-tags en:salty-snacks,en:potato-chips
```

La reconstruction réelle et reprenable utilise exclusivement
`catalog:off-reconstruct`, une URL visant exactement `notons_off_catalog` et
les métadonnées d’attestation décrites au début de ce document.
