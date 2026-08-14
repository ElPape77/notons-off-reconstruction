import type { ProductNutriments, ProductNutrition } from '@notons/shared';
import { Buffer } from 'node:buffer';

import { RowMappingError } from '../errors.js';
import { EMPTY_PRODUCT_NUTRITION } from '../types.js';
import type {
  CatalogMapper,
  DelimitedSourceOptions,
  MappedCatalogProduct,
  MappingResult,
  RawCatalogRow,
} from '../types.js';

const DEFAULT_COUNTRY_TAGS = ['en:france'];
const DEFAULT_CATEGORY_TAGS = [
  'en:salty-snacks',
  'en:potato-chips',
  'en:chips-and-fries',
  'en:tortilla-chips',
  'en:puffed-snacks',
  'en:vegetable-chips',
];
const MAX_LIST_ITEMS = 256;
const MAX_NUTRIMENT_FIELDS = 400;
const BARCODE_COLUMNS = ['code', 'barcode', 'gtin'];
const PRODUCT_NAME_COLUMNS = ['product_name_fr', 'product_name', 'generic_name_fr', 'generic_name'];
const STRUCTURED_NUTRIMENT_BASES = new Set([
  'energy',
  'energy-kj',
  'energy-kcal',
  'fat',
  'saturated-fat',
  'carbohydrates',
  'sugars',
  'fiber',
  'fibre',
  'proteins',
  'salt',
  'sodium',
]);

export const OPEN_FOOD_FACTS_DELIMITED_SOURCE_OPTIONS: Readonly<DelimitedSourceOptions> =
  Object.freeze({
    // The official export is a physical-line TSV. Quotes occur literally in
    // values (including at the start of a field) and are not CSV delimiters.
    quote: false,
    relaxColumnCount: false,
    relaxQuotes: false,
    skipRecordsWithError: true,
    trim: false,
  });

const CATEGORY_RULES: ReadonlyArray<{ slug: string; tags: readonly string[] }> = [
  {
    slug: 'chips-legumes',
    tags: ['en:vegetable-chips', 'fr:chips-de-legumes', 'en:vegetable-crisps'],
  },
  {
    slug: 'tortillas',
    tags: ['en:tortilla-chips', 'en:corn-chips', 'fr:tortillas-chips'],
  },
  {
    slug: 'snacks-souffles',
    tags: ['en:puffed-snacks', 'en:cheese-puffs', 'fr:snacks-souffles'],
  },
  {
    slug: 'chips-aromatisees',
    tags: ['en:flavoured-potato-crisps', 'en:flavored-potato-chips', 'fr:chips-aromatisees'],
  },
  {
    slug: 'chips-nature',
    tags: ['en:plain-potato-chips', 'en:plain-crisps', 'fr:chips-nature'],
  },
  {
    slug: 'snacks-aperitifs',
    tags: ['en:salty-snacks', 'en:potato-chips', 'en:chips-and-fries'],
  },
];

export interface OpenFoodFactsMapperOptions {
  countryTags?: readonly string[];
  categoryTags?: readonly string[];
  /** Scope filters are opt-in: the default imports the complete food export. */
  requireCountry?: boolean;
  requireCategory?: boolean;
}

const cleanScalarString = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

const firstString = (row: RawCatalogRow, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const scalar = cleanScalarString(row[key]);
    if (scalar) return scalar;
    const value = row[key];
    if (Array.isArray(value) && value.length > 0) {
      const joined = value.map(cleanScalarString).filter(Boolean).join(',').trim();
      if (joined) return joined;
    }
  }
  return null;
};

const listValue = (
  value: unknown,
  normalizeTags = false,
  maximumItems = MAX_LIST_ITEMS,
  maximumBytes = 32_768,
): string[] | null => {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  let usedBytes = 0;
  for (const candidate of candidates) {
    const scalar = cleanScalarString(candidate)?.slice(0, 120);
    if (!scalar) continue;
    const item = normalizeTags ? scalar.toLocaleLowerCase('en') : scalar;
    const identity = item.toLocaleLowerCase('en');
    if (seen.has(identity)) continue;
    seen.add(identity);
    const addedBytes = Buffer.byteLength(item, 'utf8') + (result.length > 0 ? 1 : 0);
    if (usedBytes + addedBytes > maximumBytes) break;
    result.push(item);
    usedBytes += addedBytes;
    if (result.length >= maximumItems) break;
  }
  return result.length > 0 ? result : null;
};

const firstList = (
  row: RawCatalogRow,
  keys: readonly string[],
  normalizeTags = false,
  maximumItems = MAX_LIST_ITEMS,
  maximumBytes = 32_768,
): string[] | null => {
  for (const key of keys) {
    const parsed = listValue(row[key], normalizeTags, maximumItems, maximumBytes);
    if (parsed) return parsed;
  }
  return null;
};

const hasAny = (tags: readonly string[] | null, expected: readonly string[]): boolean => {
  if (!tags) return false;
  const actual = new Set(tags.map((tag) => tag.toLocaleLowerCase('en')));
  return expected.some((tag) => actual.has(tag.toLocaleLowerCase('en')));
};

const inferCategorySlug = (tags: readonly string[] | null): string | null => {
  for (const rule of CATEGORY_RULES) {
    if (hasAny(tags, rule.tags)) return rule.slug;
  }
  return null;
};

const booleanValue = (value: unknown): boolean =>
  value === true ||
  (typeof value === 'string' && ['1', 'true', 'yes', 'oui'].includes(value.trim().toLowerCase()));

const recordValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const numericValue = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .replace(/^(?:<|~)\s*/, '')
    .replace(',', '.');
  if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstNumber = (
  row: RawCatalogRow,
  nutriments: Record<string, unknown> | null,
  keys: readonly string[],
): number | null => {
  for (const key of keys) {
    const direct = numericValue(row[key]);
    if (direct !== null) return direct;
    const nested = numericValue(nutriments?.[key]);
    if (nested !== null) return nested;
  }
  return null;
};

const scoreValue = (
  row: RawCatalogRow,
  keys: readonly string[],
  minimum: number,
  maximum: number,
): number | null => {
  const value = firstNumber(row, null, keys);
  if (value === null || !Number.isInteger(value) || value < minimum || value > maximum) return null;
  return value;
};

const gradeValue = (
  row: RawCatalogRow,
  keys: readonly string[],
  allowed: readonly string[],
): string | null => {
  const value = firstString(row, keys)?.toLocaleLowerCase('en').slice(0, 32) ?? null;
  return value && allowed.includes(value) ? value : null;
};

const nutritionValues = (row: RawCatalogRow): ProductNutrition => {
  const nutriments = recordValue(row.nutriments);
  const read = (...keys: string[]): number | null => firstNumber(row, nutriments, keys);
  return {
    energyKj100g: read('energy-kj_100g', 'energy_kj_100g', 'energy_100g'),
    energyKcal100g: read('energy-kcal_100g', 'energy_kcal_100g'),
    fat100g: read('fat_100g'),
    saturatedFat100g: read('saturated-fat_100g', 'saturated_fat_100g'),
    carbohydrates100g: read('carbohydrates_100g'),
    sugars100g: read('sugars_100g'),
    fiber100g: read('fiber_100g', 'fibre_100g'),
    proteins100g: read('proteins_100g'),
    salt100g: read('salt_100g'),
    sodium100g: read('sodium_100g'),
    energyKjServing: read('energy-kj_serving', 'energy_kj_serving', 'energy_serving'),
    energyKcalServing: read('energy-kcal_serving', 'energy_kcal_serving'),
    fatServing: read('fat_serving'),
    saturatedFatServing: read('saturated-fat_serving', 'saturated_fat_serving'),
    carbohydratesServing: read('carbohydrates_serving'),
    sugarsServing: read('sugars_serving'),
    fiberServing: read('fiber_serving', 'fibre_serving'),
    proteinsServing: read('proteins_serving'),
    saltServing: read('salt_serving'),
    sodiumServing: read('sodium_serving'),
  };
};

const nutrimentScalar = (value: unknown): string | number | null | undefined => {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? normalized.slice(0, 500) : undefined;
  }
  return undefined;
};

const extractNutriments = (row: RawCatalogRow): ProductNutriments | null => {
  const result: ProductNutriments = {};
  let fieldCount = 0;
  const add = (key: string, value: unknown): void => {
    if (fieldCount >= MAX_NUTRIMENT_FIELDS) return;
    const normalizedKey = key.trim().slice(0, 100);
    if (!normalizedKey || Object.hasOwn(result, normalizedKey)) return;
    const nutrientBase = normalizedKey
      .toLocaleLowerCase('en')
      .replace(/_(?:100g|serving|unit|value)$/i, '')
      .replaceAll('_', '-');
    if (STRUCTURED_NUTRIMENT_BASES.has(nutrientBase)) return;
    const scalar = nutrimentScalar(value);
    if (scalar !== undefined) {
      result[normalizedKey] = scalar;
      fieldCount += 1;
    }
  };

  const nested = recordValue(row.nutriments);
  if (nested) {
    for (const [key, value] of Object.entries(nested)) add(key, value);
  }
  for (const [key, value] of Object.entries(row)) {
    if (/_(?:100g|serving|unit|value)$/i.test(key)) add(key, value);
  }
  return fieldCount > 0 ? result : null;
};

const httpsUrl = (value: string | null): string | null => {
  if (!value) return null;
  const candidate = value.startsWith('http://') ? `https://${value.slice(7)}` : value;
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLocaleLowerCase('en');
    const isOpenFoodFacts =
      hostname === 'openfoodfacts.org' ||
      hostname.endsWith('.openfoodfacts.org') ||
      hostname === 'openfoodfacts.net' ||
      hostname.endsWith('.openfoodfacts.net');
    return parsed.protocol === 'https:' && isOpenFoodFacts && !parsed.username && !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
};

const firstHttpsUrl = (row: RawCatalogRow, keys: readonly string[]): string | null =>
  httpsUrl(firstString(row, keys));

const timestampValue = (row: RawCatalogRow, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    let date: Date | null = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      date = new Date(value < 10_000_000_000 ? value * 1_000 : value);
    } else if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const numeric = Number(trimmed);
        date = new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
      } else {
        date = new Date(trimmed);
      }
    }
    if (date && Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
};

export class OpenFoodFactsMapper implements CatalogMapper {
  readonly id = 'open-food-facts';
  readonly defaultDelimiter = '\t';
  readonly delimitedSourceOptions = OPEN_FOOD_FACTS_DELIMITED_SOURCE_OPTIONS;
  private readonly countryTags: readonly string[];
  private readonly categoryTags: readonly string[];
  private readonly requireCountry: boolean;
  private readonly requireCategory: boolean;

  constructor(options: OpenFoodFactsMapperOptions = {}) {
    this.countryTags = options.countryTags ?? DEFAULT_COUNTRY_TAGS;
    this.categoryTags = options.categoryTags ?? DEFAULT_CATEGORY_TAGS;
    this.requireCountry = options.requireCountry ?? false;
    this.requireCategory = options.requireCategory ?? false;
  }

  validateFullSnapshotHeader(columns: readonly string[]): void {
    const available = new Set(
      columns.map((column) =>
        column
          .replace(/^\ufeff/, '')
          .trim()
          .toLocaleLowerCase('en'),
      ),
    );
    const hasBarcode = BARCODE_COLUMNS.some((column) => available.has(column));
    const hasProductName = PRODUCT_NAME_COLUMNS.some((column) => available.has(column));
    if (!hasBarcode || !hasProductName) {
      const missing = [
        ...(hasBarcode ? [] : ['code']),
        ...(hasProductName ? [] : ['product_name']),
      ].join(', ');
      throw new RowMappingError(
        'INVALID_FULL_SNAPSHOT_HEADER',
        `En-tete Open Food Facts invalide : colonne(s) requise(s) absente(s) : ${missing}.`,
      );
    }
  }

  map(row: RawCatalogRow): MappingResult {
    const countryTags = firstList(row, ['countries_tags'], true, 128, 16_384);
    if (this.requireCountry && !hasAny(countryTags, this.countryTags)) {
      return { kind: 'filtered', reason: 'country' };
    }

    const offCategoryTags = firstList(row, ['categories_tags'], true);
    if (this.requireCategory && !hasAny(offCategoryTags, this.categoryTags)) {
      return { kind: 'filtered', reason: 'category' };
    }

    const barcode = firstString(row, ['code', 'barcode', 'gtin']);
    if (!barcode) {
      throw new RowMappingError('MISSING_BARCODE', "Aucun code-barres source n'est renseigne.");
    }

    const name = firstString(row, [...PRODUCT_NAME_COLUMNS]);
    if (!name) throw new RowMappingError('MISSING_PRODUCT_NAME', 'Le nom du produit est absent.');

    const imagePath = firstString(row, ['image_path']);
    const explicitStoragePath = firstString(row, ['image_storage_path']);
    const pathIsRemote = imagePath ? /^https?:\/\//i.test(imagePath) : false;
    const explicitFrontThumbUrl = firstHttpsUrl(row, ['image_front_thumb_url']);
    const explicitFrontSmallUrl = firstHttpsUrl(row, ['image_front_small_url']);
    const exportImageSmallUrl = firstHttpsUrl(row, ['image_small_url']);
    const explicitFrontUrl = firstHttpsUrl(row, ['image_front_url']);
    const exportImageUrl = firstHttpsUrl(row, ['image_url']);
    const imagePathUrl = pathIsRemote ? httpsUrl(imagePath) : null;
    const explicitFrontOriginalUrl = firstHttpsUrl(row, ['image_front_original_url']);

    // CSV exports expose image_url/image_small_url, while API payloads may use
    // image_front_* fields. Keep every consumer usable when only one safe OFF
    // image variant exists, without ever accepting a third-party host.
    const preferredFrontUrl = explicitFrontUrl ?? exportImageUrl ?? imagePathUrl;
    const preferredOriginalUrl = explicitFrontOriginalUrl ?? exportImageUrl;
    const preferredSmallUrl = explicitFrontSmallUrl ?? exportImageSmallUrl;
    const imageFrontUrl =
      preferredFrontUrl ?? preferredOriginalUrl ?? preferredSmallUrl ?? explicitFrontThumbUrl;
    const imageFrontOriginalUrl =
      preferredOriginalUrl ?? preferredFrontUrl ?? preferredSmallUrl ?? explicitFrontThumbUrl;
    const imageFrontSmallUrl =
      preferredSmallUrl ?? explicitFrontThumbUrl ?? preferredFrontUrl ?? preferredOriginalUrl;
    const imageFrontThumbUrl =
      explicitFrontThumbUrl ?? preferredSmallUrl ?? preferredFrontUrl ?? preferredOriginalUrl;
    const explicitOffUrl = firstHttpsUrl(row, ['url', 'open_food_facts_url']);
    const openFoodFactsUrl =
      explicitOffUrl ??
      httpsUrl(`https://world.openfoodfacts.org/product/${encodeURIComponent(barcode)}`);

    const product: MappedCatalogProduct = {
      barcode,
      name,
      brand: firstString(row, ['brands', 'brand']),
      quantity: firstString(row, ['quantity']),
      packaging: firstString(row, ['packaging_text_fr', 'packaging_text', 'packaging']),
      categorySlug: inferCategorySlug(offCategoryTags),
      sourceProductId: firstString(row, ['_id', 'id', 'source_product_id', 'code']),
      sourceImageUrl: imageFrontUrl ?? imageFrontOriginalUrl,
      imageStoragePath: explicitStoragePath ?? (pathIsRemote ? null : imagePath),
      genericName: firstString(row, ['generic_name_fr', 'generic_name']),
      offCategories: firstList(row, ['categories_fr', 'categories']),
      offCategoryTags,
      countries: firstList(row, ['countries_fr', 'countries'], false, 128, 16_384),
      countryTags,
      stores: firstList(row, ['stores'], false, 128, 16_384),
      purchasePlaces: firstList(row, ['purchase_places'], false, 128, 16_384),
      nutriscoreGrade: gradeValue(row, ['nutriscore_grade'], ['a', 'b', 'c', 'd', 'e']),
      nutriscoreScore: scoreValue(row, ['nutriscore_score'], -100, 100),
      environmentalScoreGrade: gradeValue(
        row,
        ['environmental_score_grade', 'ecoscore_grade'],
        ['a-plus', 'a', 'b', 'c', 'd', 'e', 'f'],
      ),
      environmentalScoreScore: scoreValue(
        row,
        ['environmental_score_score', 'ecoscore_score'],
        0,
        100,
      ),
      servingSize: firstString(row, ['serving_size']),
      nutrition: nutritionValues(row),
      nutriments: extractNutriments(row),
      openFoodFactsUrl,
      imageFrontThumbUrl,
      imageFrontSmallUrl,
      imageFrontUrl,
      imageFrontOriginalUrl,
      offLastModifiedAt: timestampValue(row, ['last_modified_t', 'last_modified_datetime']),
      offLastUpdatedAt: timestampValue(row, ['last_updated_t', 'last_updated_datetime']),
      isDemo: booleanValue(row.is_demo),
    };

    return { kind: 'product', product };
  }
}

export const OPEN_FOOD_FACTS_DEFAULT_COUNTRY_TAGS = DEFAULT_COUNTRY_TAGS;
export const OPEN_FOOD_FACTS_DEFAULT_CATEGORY_TAGS = DEFAULT_CATEGORY_TAGS;
export const OPEN_FOOD_FACTS_MAX_NUTRIMENT_FIELDS = MAX_NUTRIMENT_FIELDS;
export const OPEN_FOOD_FACTS_PROJECTION_VERSION = 'open-food-facts-lite/2026-08-11.3';
