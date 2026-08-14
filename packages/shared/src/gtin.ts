export const GTIN_FORMATS = ['EAN_8', 'UPC_A', 'EAN_13', 'GTIN_14'] as const;
export type GtinFormat = (typeof GTIN_FORMATS)[number];

export interface NormalizedGtin {
  original: string;
  canonicalGtin: string;
  format: GtinFormat;
}

export type GtinErrorCode =
  'EMPTY_GTIN' | 'NON_NUMERIC_GTIN' | 'INVALID_GTIN_LENGTH' | 'INVALID_GTIN_CHECK_DIGIT';

export class GtinValidationError extends Error {
  constructor(
    public readonly code: GtinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GtinValidationError';
  }
}

const FORMATS_BY_LENGTH: Readonly<Record<number, GtinFormat>> = {
  8: 'EAN_8',
  12: 'UPC_A',
  13: 'EAN_13',
  14: 'GTIN_14',
};

/** Removes common visual separators while rejecting ambiguous or alphabetic input. */
export function sanitizeGtin(input: string | number): string {
  const value = String(input).trim();
  if (!value) {
    throw new GtinValidationError('EMPTY_GTIN', 'Le code-barres est vide.');
  }

  const digits = value.replace(/[\s-]+/g, '');
  if (!/^\d+$/.test(digits)) {
    throw new GtinValidationError(
      'NON_NUMERIC_GTIN',
      'Le code-barres ne doit contenir que des chiffres.',
    );
  }
  return digits;
}

export function calculateGtinCheckDigit(payload: string): number {
  if (!/^\d+$/.test(payload)) {
    throw new GtinValidationError(
      'NON_NUMERIC_GTIN',
      'La charge GTIN ne doit contenir que des chiffres.',
    );
  }

  let sum = 0;
  for (let index = payload.length - 1, position = 0; index >= 0; index -= 1, position += 1) {
    const digit = Number(payload[index]);
    sum += digit * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(input: string | number): boolean {
  try {
    const digits = sanitizeGtin(input);
    if (!FORMATS_BY_LENGTH[digits.length]) return false;
    const payload = digits.slice(0, -1);
    return calculateGtinCheckDigit(payload) === Number(digits.at(-1));
  } catch {
    return false;
  }
}

export function normalizeGtin(input: string | number): NormalizedGtin {
  const original = sanitizeGtin(input);
  const format = FORMATS_BY_LENGTH[original.length];
  if (!format) {
    throw new GtinValidationError(
      'INVALID_GTIN_LENGTH',
      'Un GTIN doit contenir 8, 12, 13 ou 14 chiffres.',
    );
  }

  if (calculateGtinCheckDigit(original.slice(0, -1)) !== Number(original.at(-1))) {
    throw new GtinValidationError(
      'INVALID_GTIN_CHECK_DIGIT',
      'La clé de contrôle du GTIN est incorrecte.',
    );
  }

  return {
    original,
    canonicalGtin: original.padStart(14, '0'),
    format,
  };
}

export type ProductBarcodeSymbology =
  'ean13' | 'ean8' | 'upc_a' | 'upc_e' | 'itf14' | 'code128' | 'datamatrix' | 'qr';

const DIRECT_GTIN_LENGTHS: Partial<Record<ProductBarcodeSymbology, readonly number[]>> = {
  // iOS can report an UPC-A payload as ean13 after removing its leading zero.
  ean13: [12, 13],
  ean8: [8],
  upc_a: [12],
  itf14: [14],
  // A generic Code 128 can carry a bare, checksum-valid GTIN of any standard length.
  code128: [8, 12, 13, 14],
};

const GS1_SYMBOLOGY_PREFIX: Partial<Record<ProductBarcodeSymbology, string>> = {
  code128: ']C1',
  datamatrix: ']d2',
  qr: ']Q3',
};

function tryNormalizeGtin(value: string): NormalizedGtin | null {
  try {
    return normalizeGtin(value);
  } catch {
    return null;
  }
}

/** Expands the eight decoded UPC-E digits (number system + six data digits + check digit). */
export function expandUpceToUpca(input: string | number): NormalizedGtin | null {
  let upce: string;
  try {
    upce = sanitizeGtin(input);
  } catch {
    return null;
  }
  if (!/^\d{8}$/.test(upce)) return null;

  const [numberSystem, first, second, third, fourth, fifth, expansion, checkDigit] = upce;
  if (
    (numberSystem !== '0' && numberSystem !== '1') ||
    !first ||
    !second ||
    !third ||
    !fourth ||
    !fifth ||
    !expansion ||
    !checkDigit
  ) {
    return null;
  }

  let payload: string;
  if (expansion === '0' || expansion === '1' || expansion === '2') {
    payload = `${numberSystem}${first}${second}${expansion}0000${third}${fourth}${fifth}`;
  } else if (expansion === '3') {
    payload = `${numberSystem}${first}${second}${third}00000${fourth}${fifth}`;
  } else if (expansion === '4') {
    payload = `${numberSystem}${first}${second}${third}${fourth}00000${fifth}`;
  } else {
    payload = `${numberSystem}${first}${second}${third}${fourth}${fifth}0000${expansion}`;
  }

  const normalized = tryNormalizeGtin(`${payload}${checkDigit}`);
  return normalized?.format === 'UPC_A' ? normalized : null;
}

function extractGs1ElementStringGtin(
  raw: string,
  symbology: ProductBarcodeSymbology,
): NormalizedGtin | null {
  let payload = raw;
  let hasGs1Marker = false;
  const prefix = GS1_SYMBOLOGY_PREFIX[symbology];
  if (prefix && payload.startsWith(prefix)) {
    payload = payload.slice(prefix.length);
    hasGs1Marker = true;
  }
  if (payload.startsWith('\u001d')) {
    payload = payload.replace(/^\u001d+/, '');
    hasGs1Marker = true;
  }

  let candidate: string;
  if (payload.startsWith('(01)')) {
    candidate = payload.slice(4, 18);
    hasGs1Marker = true;
  } else if (payload.startsWith('01')) {
    candidate = payload.slice(2, 16);
    const remainder = payload.slice(16);
    const isBareProductAi = payload.length === 16;
    const isSeparatedGs1Payload = remainder.startsWith('\u001d');
    if (!hasGs1Marker && !isBareProductAi && !isSeparatedGs1Payload) return null;
  } else {
    return null;
  }

  if (!/^\d{14}$/.test(candidate)) return null;
  const normalized = tryNormalizeGtin(candidate);
  return normalized?.format === 'GTIN_14' ? normalized : null;
}

function extractGs1DigitalLinkGtin(raw: string): NormalizedGtin | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] !== '01') continue;
    const candidate = segments[index + 1];
    if (!candidate || !/^\d{14}$/.test(candidate)) return null;
    const normalized = tryNormalizeGtin(candidate);
    return normalized?.format === 'GTIN_14' ? normalized : null;
  }
  return null;
}

/**
 * Extracts only identifiers that can safely address a retail product. Linear retail symbols carry
 * a direct GTIN. Code 128, GS1 Data Matrix and GS1 QR may instead carry the fixed-length product AI
 * `01`; QR also supports an uncompressed GS1 Digital Link path. Lots, serials and ordinary URLs are
 * deliberately ignored.
 */
export function extractProductGtinFromBarcode(
  input: string | number,
  symbology: ProductBarcodeSymbology | string,
): NormalizedGtin | null {
  const raw = String(input).trim();
  if (!raw) return null;
  const normalizedSymbology = symbology.toLowerCase() as ProductBarcodeSymbology;

  if (normalizedSymbology === 'upc_e') return expandUpceToUpca(raw);

  const acceptedDirectLengths = DIRECT_GTIN_LENGTHS[normalizedSymbology];
  if (acceptedDirectLengths) {
    const direct = tryNormalizeGtin(raw);
    if (direct && acceptedDirectLengths.includes(direct.original.length)) return direct;
  }

  if (normalizedSymbology === 'qr') {
    const digitalLink = extractGs1DigitalLinkGtin(raw);
    if (digitalLink) return digitalLink;
  }

  if (normalizedSymbology in GS1_SYMBOLOGY_PREFIX) {
    return extractGs1ElementStringGtin(raw, normalizedSymbology);
  }
  return null;
}

export function extractProductGtinFromCode128(input: string | number): NormalizedGtin | null {
  return extractProductGtinFromBarcode(input, 'code128');
}

export function assertValidGtin(input: string | number): asserts input is string | number {
  normalizeGtin(input);
}
