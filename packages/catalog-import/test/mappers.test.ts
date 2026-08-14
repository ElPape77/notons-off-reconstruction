import { describe, expect, it } from 'vitest';

import { ColumnMapper, OpenFoodFactsMapper, RowMappingError } from '../src/index.js';

describe('mapping fournisseur isolé', () => {
  it('transforme une ligne Open Food Facts française de snacks', () => {
    const mapper = new OpenFoodFactsMapper();
    expect(
      mapper.map({
        code: '4006381333931',
        product_name_fr: 'Chips au paprika',
        brands: 'Exemple',
        quantity: '125 g',
        packaging_text_fr: 'Sachet',
        countries_tags: 'en:france,en:belgium',
        categories_tags: 'en:salty-snacks,en:flavoured-potato-crisps',
        image_front_url: 'https://images.openfoodfacts.org/product.jpg',
      }),
    ).toMatchObject({
      kind: 'product',
      product: {
        barcode: '4006381333931',
        name: 'Chips au paprika',
        brand: 'Exemple',
        quantity: '125 g',
        packaging: 'Sachet',
        categorySlug: 'chips-aromatisees',
        sourceProductId: '4006381333931',
        sourceImageUrl: 'https://images.openfoodfacts.org/product.jpg',
        imageFrontUrl: 'https://images.openfoodfacts.org/product.jpg',
        openFoodFactsUrl: 'https://world.openfoodfacts.org/product/4006381333931',
        offCategoryTags: ['en:salty-snacks', 'en:flavoured-potato-crisps'],
        countryTags: ['en:france', 'en:belgium'],
        imageStoragePath: null,
        isDemo: false,
      },
    });
  });

  it("mappe les colonnes d'image présentes dans l'export OFF réel", () => {
    const mapper = new OpenFoodFactsMapper();
    const result = mapper.map({
      code: '4006381333931',
      product_name: 'Produit export',
      image_url: 'http://images.openfoodfacts.org/images/products/front.400.jpg',
      image_small_url: 'https://images.openfoodfacts.org/images/products/front.200.jpg',
    });

    expect(result).toMatchObject({
      kind: 'product',
      product: {
        sourceImageUrl: 'https://images.openfoodfacts.org/images/products/front.400.jpg',
        imageFrontThumbUrl: 'https://images.openfoodfacts.org/images/products/front.200.jpg',
        imageFrontSmallUrl: 'https://images.openfoodfacts.org/images/products/front.200.jpg',
        imageFrontUrl: 'https://images.openfoodfacts.org/images/products/front.400.jpg',
        imageFrontOriginalUrl: 'https://images.openfoodfacts.org/images/products/front.400.jpg',
      },
    });
  });

  it("réutilise l'unique variante OFF sûre comme repli pour toutes les tailles", () => {
    const result = new OpenFoodFactsMapper().map({
      code: '4006381333931',
      product_name: 'Produit export',
      image_small_url: 'https://images.openfoodfacts.org/images/products/front.200.jpg',
    });

    expect(result).toMatchObject({
      product: {
        sourceImageUrl: 'https://images.openfoodfacts.org/images/products/front.200.jpg',
        imageFrontThumbUrl: 'https://images.openfoodfacts.org/images/products/front.200.jpg',
        imageFrontSmallUrl: 'https://images.openfoodfacts.org/images/products/front.200.jpg',
        imageFrontUrl: 'https://images.openfoodfacts.org/images/products/front.200.jpg',
        imageFrontOriginalUrl: 'https://images.openfoodfacts.org/images/products/front.200.jpg',
      },
    });
  });

  it('filtre hors France et hors périmètre sans créer de fausse erreur', () => {
    const mapper = new OpenFoodFactsMapper({ requireCountry: true, requireCategory: true });
    expect(
      mapper.map({
        code: '4006381333931',
        product_name: 'Crisps',
        countries_tags: 'en:united-kingdom',
        categories_tags: 'en:salty-snacks',
      }),
    ).toEqual({ kind: 'filtered', reason: 'country' });
    expect(
      mapper.map({
        code: '4006381333931',
        product_name: 'Chocolate',
        countries_tags: 'en:france',
        categories_tags: 'en:chocolates',
      }),
    ).toEqual({ kind: 'filtered', reason: 'category' });
  });

  it("permet d'ajouter un fournisseur par configuration de colonnes", () => {
    const mapper = new ColumnMapper({ barcode: 'ean', name: 'label', brand: 'maker' });
    expect(mapper.map({ ean: '96385074', label: 'Snack test', maker: 'Démo' })).toMatchObject({
      kind: 'product',
      product: { barcode: '96385074', name: 'Snack test', brand: 'Démo' },
    });
    expect(() => mapper.map({ label: 'Sans code' })).toThrow(RowMappingError);
  });

  it("distingue un chemin d'image interne d'une URL de provenance", () => {
    const mapper = new OpenFoodFactsMapper();
    const base = {
      code: '4006381333931',
      product_name_fr: 'Chips test',
      countries_tags: 'en:france',
      categories_tags: 'en:salty-snacks',
    };
    expect(mapper.map({ ...base, image_path: 'catalog/40/front.webp' })).toMatchObject({
      product: { imageStoragePath: 'catalog/40/front.webp', sourceImageUrl: null },
    });
    expect(
      mapper.map({ ...base, image_path: 'https://images.openfoodfacts.org/front.jpg' }),
    ).toMatchObject({
      product: {
        imageStoragePath: null,
        sourceImageUrl: 'https://images.openfoodfacts.org/front.jpg',
      },
    });
  });

  it('refuse une URL image tierce dans une ligne Open Food Facts', () => {
    expect(
      new OpenFoodFactsMapper().map({
        code: '4006381333931',
        product_name: 'Produit',
        image_front_url: 'https://tracker.example/front.jpg',
        image_url: 'https://tracker.example/export.jpg',
        image_small_url: 'https://tracker.example/export-small.jpg',
        url: 'https://tracker.example/product',
      }),
    ).toMatchObject({
      product: {
        sourceImageUrl: null,
        imageFrontThumbUrl: null,
        imageFrontSmallUrl: null,
        imageFrontUrl: null,
        imageFrontOriginalUrl: null,
        openFoodFactsUrl: 'https://world.openfoodfacts.org/product/4006381333931',
      },
    });
  });

  it('importe par defaut tous les aliments, tous pays et toutes categories', () => {
    const result = new OpenFoodFactsMapper().map({
      code: '4006381333931',
      product_name: 'Chocolate',
      countries_tags: 'en:united-kingdom',
      categories_tags: 'en:chocolates',
    });
    expect(result).toMatchObject({
      kind: 'product',
      product: { name: 'Chocolate', categorySlug: null, countryTags: ['en:united-kingdom'] },
    });
  });

  it('mappe les champs legers OFF et le tableau nutritionnel CSV', () => {
    const result = new OpenFoodFactsMapper().map({
      code: '3017620422003',
      product_name_fr: 'Produit francais',
      generic_name_fr: 'Pate a tartiner',
      brands: 'Exemple,Marque',
      quantity: '400 g',
      categories: 'Pates a tartiner,Produits sucres',
      categories_tags: 'en:spreads,en:sweet-spreads',
      countries: 'France,Belgique',
      countries_tags: 'en:france,en:belgium',
      stores: 'Magasin A,Magasin B',
      purchase_places: 'Paris,Lyon',
      nutriscore_grade: 'E',
      nutriscore_score: '26',
      ecoscore_grade: 'c',
      ecoscore_score: '42',
      serving_size: '15 g',
      'energy-kj_100g': '2252',
      'energy-kcal_100g': '539',
      fat_100g: '30.9',
      'saturated-fat_100g': '10.6',
      carbohydrates_100g: '57.5',
      sugars_100g: '56.3',
      proteins_100g: '6.3',
      salt_100g: '0.107',
      sodium_100g: '0.0428',
      'energy-kcal_serving': '80.85',
      'vitamin-c_100g': '0.001',
      image_front_thumb_url: 'http://images.openfoodfacts.org/front.100.jpg',
      image_front_small_url: 'https://images.openfoodfacts.org/front.200.jpg',
      image_small_url: 'https://images.openfoodfacts.org/export.200.jpg',
      image_front_url: 'https://images.openfoodfacts.org/front.400.jpg',
      image_url: 'https://images.openfoodfacts.org/front.full.jpg',
      url: 'http://world.openfoodfacts.org/product/3017620422003/example',
      last_modified_t: '1786365296',
      last_updated_datetime: '2026-08-11T10:00:00Z',
    });

    expect(result).toMatchObject({
      kind: 'product',
      product: {
        genericName: 'Pate a tartiner',
        offCategories: ['Pates a tartiner', 'Produits sucres'],
        offCategoryTags: ['en:spreads', 'en:sweet-spreads'],
        countries: ['France', 'Belgique'],
        countryTags: ['en:france', 'en:belgium'],
        stores: ['Magasin A', 'Magasin B'],
        purchasePlaces: ['Paris', 'Lyon'],
        nutriscoreGrade: 'e',
        nutriscoreScore: 26,
        environmentalScoreGrade: 'c',
        environmentalScoreScore: 42,
        servingSize: '15 g',
        nutrition: {
          energyKj100g: 2252,
          energyKcal100g: 539,
          fat100g: 30.9,
          saturatedFat100g: 10.6,
          carbohydrates100g: 57.5,
          sugars100g: 56.3,
          fiber100g: null,
          proteins100g: 6.3,
          salt100g: 0.107,
          sodium100g: 0.0428,
          energyKcalServing: 80.85,
        },
        nutriments: { 'vitamin-c_100g': '0.001' },
        openFoodFactsUrl: 'https://world.openfoodfacts.org/product/3017620422003/example',
        imageFrontThumbUrl: 'https://images.openfoodfacts.org/front.100.jpg',
        imageFrontSmallUrl: 'https://images.openfoodfacts.org/front.200.jpg',
        imageFrontUrl: 'https://images.openfoodfacts.org/front.400.jpg',
        imageFrontOriginalUrl: 'https://images.openfoodfacts.org/front.full.jpg',
        offLastUpdatedAt: '2026-08-11T10:00:00.000Z',
      },
    });
  });

  it('lit le JSONL OFF, privilegie le Green-Score actuel et garde les inconnues a null', () => {
    const result = new OpenFoodFactsMapper().map({
      code: '4006381333931',
      product_name: 'JSON product',
      environmental_score_grade: 'a-plus',
      environmental_score_score: 73,
      ecoscore_grade: 'd',
      ecoscore_score: 30,
      nutriscore_grade: 'unknown',
      nutriments: {
        'energy-kcal_100g': 123,
        fiber_100g: null,
        'vitamin-c_unit': 'mg',
      },
    });
    expect(result).toMatchObject({
      product: {
        environmentalScoreGrade: 'a-plus',
        environmentalScoreScore: 73,
        nutriscoreGrade: null,
        nutriscoreScore: null,
        nutrition: { energyKcal100g: 123, fiber100g: null },
        nutriments: { 'vitamin-c_unit': 'mg' },
      },
    });
  });

  it('omet les nutriments vides et les champs deja projetes dans les colonnes standard', () => {
    const result = new OpenFoodFactsMapper().map({
      code: '4006381333931',
      product_name: 'Produit nutrition',
      fat_100g: '12',
      'vitamin-c_100g': '   ',
      'vitamin-b12_unit': '\t ',
      magnesium_100g: ' 0.042 ',
      nutriments: {
        sugars_serving: '4',
        proteins_unit: 'g',
        'vitamin-d_100g': '',
        zinc_unit: ' mg ',
      },
    });
    expect(result.kind).toBe('product');
    if (result.kind === 'product') {
      expect(result.product.nutriments).toEqual({
        zinc_unit: 'mg',
        magnesium_100g: '0.042',
      });
    }
  });

  it("valide les colonnes requises d'un snapshot OFF avant tout mapping", () => {
    const mapper = new OpenFoodFactsMapper();
    expect(() =>
      mapper.validateFullSnapshotHeader(['code', 'product_name', 'brands']),
    ).not.toThrow();
    expect(() => mapper.validateFullSnapshotHeader(['code;product_name;brands'])).toThrow(
      /En-tete Open Food Facts invalide/,
    );
    expect(() => mapper.validateFullSnapshotHeader(['code', 'brands'])).toThrow(/product_name/);
  });
});
