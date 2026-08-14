import { RowMappingError } from '../errors.js';
import { EMPTY_PRODUCT_NUTRITION } from '../types.js';
import type {
  CatalogMapper,
  MappedCatalogProduct,
  MappingResult,
  RawCatalogRow,
} from '../types.js';

export interface ColumnMapping {
  barcode: string;
  name: string;
  brand?: string;
  quantity?: string;
  packaging?: string;
  categorySlug?: string;
  sourceProductId?: string;
  sourceImageUrl?: string;
  imageStoragePath?: string;
  isDemo?: string;
}

const read = (row: RawCatalogRow, key: string | undefined): string | null => {
  if (!key) return null;
  const value = row[key];
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

/** Adapter for a new supplier whose columns map directly to the domain model. */
export class ColumnMapper implements CatalogMapper {
  readonly id: string;

  constructor(
    private readonly columns: ColumnMapping,
    options: { id?: string; delimiter?: string } = {},
  ) {
    this.id = options.id ?? 'columns';
    this.defaultDelimiter = options.delimiter;
  }

  readonly defaultDelimiter?: string;

  map(row: RawCatalogRow): MappingResult {
    const barcode = read(row, this.columns.barcode);
    if (!barcode)
      throw new RowMappingError('MISSING_BARCODE', "Aucun code-barres source n'est renseigné.");
    const name = read(row, this.columns.name);
    if (!name) throw new RowMappingError('MISSING_PRODUCT_NAME', 'Le nom du produit est absent.');

    const product: MappedCatalogProduct = {
      barcode,
      name,
      brand: read(row, this.columns.brand),
      quantity: read(row, this.columns.quantity),
      packaging: read(row, this.columns.packaging),
      categorySlug: read(row, this.columns.categorySlug),
      sourceProductId: read(row, this.columns.sourceProductId),
      sourceImageUrl: read(row, this.columns.sourceImageUrl),
      imageStoragePath: read(row, this.columns.imageStoragePath),
      genericName: null,
      offCategories: null,
      offCategoryTags: null,
      countries: null,
      countryTags: null,
      stores: null,
      purchasePlaces: null,
      nutriscoreGrade: null,
      nutriscoreScore: null,
      environmentalScoreGrade: null,
      environmentalScoreScore: null,
      servingSize: null,
      nutrition: { ...EMPTY_PRODUCT_NUTRITION },
      nutriments: null,
      openFoodFactsUrl: null,
      imageFrontThumbUrl: null,
      imageFrontSmallUrl: null,
      imageFrontUrl: null,
      imageFrontOriginalUrl: null,
      offLastModifiedAt: null,
      offLastUpdatedAt: null,
      isDemo: ['1', 'true', 'yes', 'oui'].includes(
        (read(row, this.columns.isDemo) ?? '').toLowerCase(),
      ),
    };
    return { kind: 'product', product };
  }
}
