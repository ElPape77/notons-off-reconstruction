import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  JSON_LINE_MAX_BYTES,
  OPEN_FOOD_FACTS_DELIMITED_SOURCE_OPTIONS,
  calculateFileChecksum,
  readCatalogRows,
} from '../src/index.js';

const crc32 = (data: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const singleFileZip = (filename: string, content: string): Buffer => {
  const name = Buffer.from(filename, 'utf8');
  const data = Buffer.from(content, 'utf8');
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
};

describe('lecteurs streaming', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'notons-source-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('auto-détecte CSV et TSV', async () => {
    const csv = join(directory, 'products.csv');
    const tsv = join(directory, 'products.tsv');
    await writeFile(csv, 'code,name\n96385074,CSV\n');
    await writeFile(tsv, 'code\tname\n96385074\tTSV\n');

    const csvRows = [];
    for await (const row of readCatalogRows(csv)) csvRows.push(row);
    const tsvRows = [];
    for await (const row of readCatalogRows(tsv)) tsvRows.push(row);
    expect(csvRows[0]).toMatchObject({ kind: 'row', data: { name: 'CSV' } });
    expect(tsvRows[0]).toMatchObject({ kind: 'row', data: { name: 'TSV' } });
  });

  it('traite les guillemets du TSV Open Food Facts comme du texte littéral', async () => {
    const path = join(directory, 'open-food-facts.csv');
    await writeFile(
      path,
      [
        'code\tproduct_name\tbrands',
        '0015418011043\t  "mezzelune" semi circular stuffed pasta, ravioli\tDemo',
        '4006381333931\t  "nom sans fermeture\tDemo',
        '96385074\tProduit suivant\tDemo',
        '',
      ].join('\n'),
    );

    const rows = [];
    for await (const row of readCatalogRows(path, {
      ...OPEN_FOOD_FACTS_DELIMITED_SOURCE_OPTIONS,
    }))
      rows.push(row);

    expect(rows).toHaveLength(3);
    expect(rows).toMatchObject([
      {
        kind: 'row',
        rowNumber: 1,
        data: { product_name: '  "mezzelune" semi circular stuffed pasta, ravioli' },
      },
      {
        kind: 'row',
        rowNumber: 2,
        data: { product_name: '  "nom sans fermeture' },
      },
      { kind: 'row', rowNumber: 3, data: { product_name: 'Produit suivant' } },
    ]);
  });

  it('rejette une ligne OFF de largeur incorrecte puis reprend à la ligne suivante', async () => {
    const path = join(directory, 'open-food-facts-width.csv');
    await writeFile(
      path,
      [
        'code\tproduct_name\tbrands',
        '0015418011043\tProduit valide\tDemo',
        '4006381333931\tColonne manquante',
        '96385074\tProduit suivant\tDemo',
        '',
      ].join('\n'),
    );

    const rows = [];
    for await (const row of readCatalogRows(path, {
      ...OPEN_FOOD_FACTS_DELIMITED_SOURCE_OPTIONS,
    }))
      rows.push(row);

    expect(rows.map((row) => row.kind)).toEqual(['row', 'error', 'row']);
    expect(rows[1]).toMatchObject({
      kind: 'error',
      error: { rowNumber: 2, errorCode: 'CSV_RECORD_INCONSISTENT_COLUMNS' },
    });
    expect(rows[2]).toMatchObject({
      kind: 'row',
      rowNumber: 3,
      data: { code: '96385074', product_name: 'Produit suivant' },
    });
  });

  it('conserve les champs multilignes quotés pour le lecteur TSV générique', async () => {
    const path = join(directory, 'generic.tsv');
    await writeFile(path, 'code\tname\n96385074\t"Première ligne\nDeuxième ligne"\n');

    const rows = [];
    for await (const row of readCatalogRows(path)) rows.push(row);

    expect(rows).toEqual([
      {
        kind: 'row',
        rowNumber: 1,
        data: { code: '96385074', name: 'Première ligne\nDeuxième ligne' },
      },
    ]);
  });

  it('lit CSV.gz et JSONL.gz sans décompression en mémoire', async () => {
    const csv = join(directory, 'products.csv.gz');
    const jsonl = join(directory, 'products.jsonl.gz');
    await writeFile(csv, gzipSync('code,name\n96385074,Gzip CSV\n'));
    await writeFile(jsonl, gzipSync('{"code":"96385074","name":"Gzip JSONL"}\n'));

    const csvRows = [];
    for await (const row of readCatalogRows(csv)) csvRows.push(row);
    const jsonRows = [];
    for await (const row of readCatalogRows(jsonl)) jsonRows.push(row);
    expect(csvRows[0]).toMatchObject({ kind: 'row', data: { name: 'Gzip CSV' } });
    expect(jsonRows[0]).toMatchObject({ kind: 'row', data: { name: 'Gzip JSONL' } });
  });

  it('lit un fichier .json.gz comme des objets complets JSON Lines', async () => {
    const path = join(directory, 'products.json.gz');
    await writeFile(
      path,
      gzipSync(
        [
          JSON.stringify({
            code: '96385074',
            product_name: 'Produit imbrique',
            nutriments: { sugars_100g: 12.5 },
          }),
          '{invalide',
          JSON.stringify({ code: '4006381333931', product_name: 'Produit suivant' }),
          '',
        ].join('\n'),
      ),
    );
    const rows = [];
    for await (const row of readCatalogRows(path)) rows.push(row);
    expect(rows.map((row) => row.kind)).toEqual(['row', 'error', 'row']);
    expect(rows[0]).toMatchObject({
      kind: 'row',
      data: { nutriments: { sugars_100g: 12.5 } },
    });
  });

  it('continue après une ligne JSON invalide', async () => {
    const path = join(directory, 'products.jsonl');
    await writeFile(path, '{"code":"96385074"}\nnot-json\n{"code":"4006381333931"}\n');
    const rows = [];
    for await (const row of readCatalogRows(path)) rows.push(row);
    expect(rows.map((row) => row.kind)).toEqual(['row', 'error', 'row']);
  });

  it.each([
    ['JSON', 'products.json', false],
    ['JSON.gz', 'products.json.gz', true],
  ])('lit une ligne %s valide en streaming', async (_label, filename, compressed) => {
    const path = join(directory, filename);
    const content = `${JSON.stringify({ code: '96385074', product_name: 'Produit valide' })}\n`;
    await writeFile(path, compressed ? gzipSync(content) : content);

    const rows = [];
    for await (const row of readCatalogRows(path)) rows.push(row);

    expect(rows).toEqual([
      {
        kind: 'row',
        rowNumber: 1,
        data: { code: '96385074', product_name: 'Produit valide' },
      },
    ]);
  });

  it.each([
    ['JSON', 'oversized.json', false],
    ['JSON.gz', 'oversized.json.gz', true],
  ])(
    "interrompt la lecture d'une ligne %s dépassant la limite décompressée",
    async (_label, filename, compressed) => {
      const path = join(directory, filename);
      const content = `${JSON.stringify({ payload: 'x'.repeat(JSON_LINE_MAX_BYTES) })}\n`;
      await writeFile(path, compressed ? gzipSync(content) : content);

      const consume = async (): Promise<void> => {
        for await (const _row of readCatalogRows(path)) {
          // The oversized physical line must fail before yielding a partial row.
        }
      };

      await expect(consume()).rejects.toThrow(`maximum ${JSON_LINE_MAX_BYTES} octets decomprimes`);
    },
  );

  it('sélectionne et lit une entrée catalogue dans un ZIP', async () => {
    const path = join(directory, 'catalog.zip');
    await writeFile(path, singleFileZip('products.csv', 'code,name\n96385074,ZIP\n'));
    const rows = [];
    for await (const row of readCatalogRows(path)) rows.push(row);
    expect(rows[0]).toMatchObject({ kind: 'row', data: { code: '96385074', name: 'ZIP' } });
  });

  it('calcule le SHA-256 déterministe du fichier compressé', async () => {
    const path = join(directory, 'products.csv');
    await writeFile(path, 'abc', 'utf8');
    expect(await calculateFileChecksum(path)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
