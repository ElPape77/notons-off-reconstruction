/** Synchronisation state used by the catalogue importer contract. */
export type CatalogSyncStatus = 'not_synced' | 'pending' | 'synced' | 'stale' | 'failed';

/**
 * Nutrition values explicitly projected from Open Food Facts. Unknown values
 * remain null and must never be interpreted as zero.
 */
export interface ProductNutrition {
  energyKj100g: number | null;
  energyKcal100g: number | null;
  fat100g: number | null;
  saturatedFat100g: number | null;
  carbohydrates100g: number | null;
  sugars100g: number | null;
  fiber100g: number | null;
  proteins100g: number | null;
  salt100g: number | null;
  sodium100g: number | null;
  energyKjServing: number | null;
  energyKcalServing: number | null;
  fatServing: number | null;
  saturatedFatServing: number | null;
  carbohydratesServing: number | null;
  sugarsServing: number | null;
  fiberServing: number | null;
  proteinsServing: number | null;
  saltServing: number | null;
  sodiumServing: number | null;
}

/** Additional scalar OFF nutrients retained without one database column each. */
export type ProductNutriments = Record<string, string | number | null>;
