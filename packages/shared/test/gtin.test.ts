import { describe, expect, it } from 'vitest';

import {
  GtinValidationError,
  calculateGtinCheckDigit,
  expandUpceToUpca,
  extractProductGtinFromBarcode,
  extractProductGtinFromCode128,
  isValidGtin,
  normalizeGtin,
} from '../src';

describe('GTIN', () => {
  it.each([
    ['96385074', 'EAN_8', '00000096385074'],
    ['036000291452', 'UPC_A', '00036000291452'],
    ['4006381333931', 'EAN_13', '04006381333931'],
    ['10012345000017', 'GTIN_14', '10012345000017'],
  ] as const)('valide et normalise %s', (value, format, canonicalGtin) => {
    expect(normalizeGtin(value)).toEqual({ original: value, format, canonicalGtin });
    expect(isValidGtin(value)).toBe(true);
  });

  it('nettoie les séparateurs visuels sans perdre les zéros', () => {
    expect(normalizeGtin('  0360-0029 1452 ').original).toBe('036000291452');
  });

  it('rejette une clé de contrôle incorrecte avec un code exploitable', () => {
    expect(() => normalizeGtin('4006381333932')).toThrowError(GtinValidationError);
    try {
      normalizeGtin('4006381333932');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_GTIN_CHECK_DIGIT' });
    }
    expect(isValidGtin('4006381333932')).toBe(false);
  });

  it('rejette les longueurs et caractères ambigus', () => {
    expect(() => normalizeGtin('12345')).toThrow(/8, 12, 13 ou 14/);
    expect(() => normalizeGtin('400638O333931')).toThrow(/chiffres/);
  });

  it('calcule une clé de contrôle', () => {
    expect(calculateGtinCheckDigit('400638133393')).toBe(1);
  });

  it.each([
    ['ean13', '4006381333931', '04006381333931'],
    ['ean8', '96385074', '00000096385074'],
    ['upc_a', '036000291452', '00036000291452'],
    ['upc_e', '04252614', '00042100005264'],
    ['itf14', '10012345000017', '10012345000017'],
    ['code128', '4006381333931', '04006381333931'],
  ] as const)('extrait un GTIN direct depuis %s', (symbology, value, canonicalGtin) => {
    expect(extractProductGtinFromBarcode(value, symbology)?.canonicalGtin).toBe(canonicalGtin);
  });

  it('normalise un UPC-A que ML Kit annonce parfois comme EAN-13', () => {
    expect(extractProductGtinFromBarcode('036000291452', 'ean13')?.original).toBe('036000291452');
  });

  it.each([
    ['ean8', '4006381333931'],
    ['ean13', '96385074'],
    ['upc_a', '96385074'],
    ['itf14', '4006381333931'],
  ] as const)(
    'rejette une longueur GTIN incompatible avec la symbologie %s',
    (symbology, value) => {
      expect(extractProductGtinFromBarcode(value, symbology)).toBeNull();
    },
  );

  it.each([
    ['04252614', '042100005264'],
    ['01234531', '012300000451'],
    ['01234543', '012340000053'],
    ['01234558', '012345000058'],
    ['11234555', '112345000055'],
  ])('développe UPC-E %s en GTIN-12', (upce, upca) => {
    expect(expandUpceToUpca(upce)?.original).toBe(upca);
  });

  it('ne confond pas UPC-E et EAN-8', () => {
    expect(extractProductGtinFromBarcode('96385074', 'upc_e')).toBeNull();
    expect(extractProductGtinFromBarcode('96385074', 'ean8')?.original).toBe('96385074');
  });

  it.each([
    [']C10110012345000017', 'code128'],
    ['(01)10012345000017', 'code128'],
    ['0110012345000017', 'code128'],
    [`\u001d0110012345000017\u001d10LOT42`, 'code128'],
    [']d20110012345000017\u001d10LOT42', 'datamatrix'],
    ['(01)10012345000017(21)SERIAL', 'datamatrix'],
    [']Q30110012345000017\u001d21SERIAL', 'qr'],
    ['(01)10012345000017(10)LOT42', 'qr'],
  ] as const)('extrait le produit AI (01) de %s', (value, symbology) => {
    expect(extractProductGtinFromBarcode(value, symbology)?.original).toBe('10012345000017');
  });

  it.each([
    'https://id.gs1.org/01/10012345000017',
    'https://produits.example/01/10012345000017/21/SERIAL',
  ])('extrait un GTIN-14 depuis un GS1 Digital Link', (value) => {
    expect(extractProductGtinFromBarcode(value, 'qr')?.original).toBe('10012345000017');
  });

  it.each([
    ['code128', ']C110LOT42'],
    ['code128', '(21)SERIAL42'],
    ['code128', '0110012345000017INTERNAL'],
    ['code128', ']C10110012345000018'],
    ['datamatrix', ']d210LOT42\u001d21SERIAL'],
    ['datamatrix', '10012345000017'],
    ['qr', 'https://promo.example/jeu?gtin=10012345000017'],
    ['qr', 'https://promo.example/produit/10012345000017'],
    ['qr', 'https://id.gs1.org/01/4006381333931'],
    ['qr', 'https://id.gs1.org/01/%E0%A4%A'],
    ['qr', ']Q310LOT42\u001d21SERIAL'],
    ['qr', '10012345000017'],
    ['code39', '10012345000017'],
  ] as const)('rejette %s sans identifiant produit GS1 sûr', (symbology, value) => {
    expect(extractProductGtinFromBarcode(value, symbology)).toBeNull();
  });

  it('conserve le raccourci Code 128', () => {
    expect(extractProductGtinFromCode128(']C10110012345000017')?.original).toBe('10012345000017');
  });
});
