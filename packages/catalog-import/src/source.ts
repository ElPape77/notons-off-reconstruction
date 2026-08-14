import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

import { parse, type CsvError, type Options } from 'csv-parse';
import unzipper from 'unzipper';

import type { CatalogImportError, DelimitedSourceOptions, RawCatalogRow } from './types.js';

// Some providers use `.json.gz` for compressed JSON Lines. Each decompressed
// line is still parsed as one complete JSON object.
const SUPPORTED_ENTRY = /\.(csv|tsv|json|jsonl|ndjson)(\.gz)?$/i;

// Capping the decompressed physical line prevents a corrupt or hostile archive
// from retaining an arbitrarily large buffer before the first newline.
export const JSON_LINE_MAX_BYTES = 4 * 1024 * 1024;

export type ParsedSourceRow =
  | { kind: 'row'; rowNumber: number; data: RawCatalogRow }
  | { kind: 'error'; error: CatalogImportError };

interface OpenedSource {
  stream: Readable;
  logicalName: string;
}

export interface ReadCatalogRowsOptions extends DelimitedSourceOptions {
  delimiter?: string;
  fallbackDelimiter?: string;
  onHeader?: (columns: readonly string[]) => void;
}

const SKIPPED_DELIMITED_ROW = Symbol('skipped-delimited-row');

interface SkippedDelimitedRow {
  [SKIPPED_DELIMITED_ROW]: CatalogImportError;
}

const isSkippedDelimitedRow = (value: unknown): value is SkippedDelimitedRow =>
  typeof value === 'object' && value !== null && SKIPPED_DELIMITED_ROW in value;

async function sniffDelimiter(
  stream: Readable,
  fallbackDelimiter = ',',
): Promise<{ delimiter: string; stream: Readable }> {
  const iterator = stream[Symbol.asyncIterator]();
  const buffered: Buffer[] = [];
  let size = 0;
  let header = '';

  while (!header.includes('\n') && size < 64 * 1024) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
    buffered.push(chunk);
    size += chunk.length;
    header = Buffer.concat(buffered).toString('utf8');
  }

  const firstLine = header.split(/\r?\n/, 1)[0] ?? '';
  const counts = new Map<string, number>([
    [',', 0],
    ['\t', 0],
    [';', 0],
  ]);
  let quoted = false;
  for (const character of firstLine) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && counts.has(character))
      counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  const detected = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  const delimiter = detected && detected[1] > 0 ? detected[0] : fallbackDelimiter;
  const replay = Readable.from(
    (async function* () {
      yield* buffered;
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
    })(),
  );
  return { delimiter, stream: replay };
}

export async function calculateFileChecksum(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function openZip(filePath: string): Promise<OpenedSource> {
  const archive = await unzipper.Open.file(filePath);
  const entries = archive.files
    .filter((entry) => entry.type === 'File' && SUPPORTED_ENTRY.test(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const entry = entries[0];
  if (!entry) {
    throw new Error(
      "L'archive ZIP ne contient aucun fichier CSV, TSV ou JSON Lines pris en charge.",
    );
  }

  let stream = entry.stream() as Readable;
  let logicalName = entry.path;
  if (/\.gz$/i.test(logicalName)) {
    stream = stream.pipe(createGunzip());
    logicalName = logicalName.replace(/\.gz$/i, '');
  }
  return { stream, logicalName };
}

export async function openCatalogSource(filePath: string): Promise<OpenedSource> {
  if (/\.zip$/i.test(filePath)) return openZip(filePath);

  let stream: Readable = createReadStream(filePath);
  let logicalName = basename(filePath);
  if (/\.gz$/i.test(logicalName)) {
    stream = stream.pipe(createGunzip());
    logicalName = logicalName.replace(/\.gz$/i, '');
  }
  if (!SUPPORTED_ENTRY.test(logicalName)) {
    throw new Error(`Format de catalogue non pris en charge : ${logicalName}`);
  }
  return { stream, logicalName };
}

async function* readBoundedJsonLines(stream: Readable): AsyncGenerator<Buffer> {
  let fragments: Buffer[] = [];
  let bufferedBytes = 0;
  let rowNumber = 1;

  const append = (fragment: Buffer): void => {
    if (bufferedBytes + fragment.length > JSON_LINE_MAX_BYTES) {
      throw new Error(
        `Ligne JSON ${rowNumber} trop volumineuse : maximum ${JSON_LINE_MAX_BYTES} octets decomprimes.`,
      );
    }
    if (fragment.length > 0) fragments.push(fragment);
    bufferedBytes += fragment.length;
  };

  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    let offset = 0;

    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      append(chunk.subarray(offset, end));

      if (newline === -1) break;

      yield fragments.length === 1
        ? (fragments[0] as Buffer)
        : Buffer.concat(fragments, bufferedBytes);
      fragments = [];
      bufferedBytes = 0;
      rowNumber += 1;
      offset = newline + 1;
    }
  }

  if (bufferedBytes > 0) {
    yield fragments.length === 1
      ? (fragments[0] as Buffer)
      : Buffer.concat(fragments, bufferedBytes);
  }
}

async function* parseJsonLines(stream: Readable): AsyncGenerator<ParsedSourceRow> {
  let rowNumber = 0;
  for await (const rawLine of readBoundedJsonLines(stream)) {
    rowNumber += 1;
    const line = rawLine.toString('utf8');
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('La ligne JSON doit être un objet.');
      }
      yield { kind: 'row', rowNumber, data: parsed as RawCatalogRow };
    } catch (error) {
      yield {
        kind: 'error',
        error: {
          rowNumber,
          rawBarcode: null,
          errorCode: 'INVALID_JSON_LINE',
          errorMessage: error instanceof Error ? error.message : 'Ligne JSON invalide.',
          rawData: { rawLine: line.slice(0, 2_000) },
        },
      };
    }
  }
}

async function* parseDelimited(
  stream: Readable,
  delimiter: string,
  sourceOptions: ReadCatalogRowsOptions,
): AsyncGenerator<ParsedSourceRow> {
  const parserOptions: Options = {
    bom: true,
    columns: (header) => {
      const columns = (header as string[]).map((column) => column.trim());
      sourceOptions.onHeader?.(columns);
      return columns;
    },
    delimiter,
    info: true,
    max_record_size: 1024 * 1024,
    ...(sourceOptions.quote === undefined ? {} : { quote: sourceOptions.quote }),
    relax_column_count: sourceOptions.relaxColumnCount ?? true,
    relax_quotes: sourceOptions.relaxQuotes ?? true,
    skip_empty_lines: true,
    skip_records_with_error: sourceOptions.skipRecordsWithError ?? true,
    trim: sourceOptions.trim ?? true,
  };
  const parser = parse(parserOptions);
  parser.on('skip', (error: CsvError | undefined, raw: string | undefined) => {
    // Put skipped rows on the same object stream as valid rows. This preserves
    // source order and lets stream backpressure bound memory during long runs
    // of malformed records instead of accumulating an unbounded side array.
    parser.push({
      [SKIPPED_DELIMITED_ROW]: {
        rowNumber: typeof error?.lines === 'number' ? error.lines : 0,
        rawBarcode: null,
        errorCode: error?.code ?? 'INVALID_DELIMITED_ROW',
        errorMessage: error?.message ?? 'Ligne délimitée invalide.',
        rawData: raw ? { rawLine: raw.slice(0, 2_000) } : null,
      },
    } satisfies SkippedDelimitedRow);
  });
  stream.pipe(parser);

  let rowNumber = 0;
  for await (const value of parser) {
    rowNumber += 1;
    if (isSkippedDelimitedRow(value)) {
      yield {
        kind: 'error',
        error: { ...value[SKIPPED_DELIMITED_ROW], rowNumber },
      };
      continue;
    }
    const parsed = value as { record: RawCatalogRow; info: { records: number; lines: number } };
    yield {
      kind: 'row',
      rowNumber,
      data: parsed.record,
    };
  }
}

export async function* readCatalogRows(
  filePath: string,
  options: ReadCatalogRowsOptions = {},
): AsyncGenerator<ParsedSourceRow> {
  let { stream, logicalName } = await openCatalogSource(filePath);
  if (/\.(json|jsonl|ndjson)$/i.test(logicalName)) {
    yield* parseJsonLines(stream);
    return;
  }

  let delimiter = options.delimiter;
  if (!delimiter) {
    if (/\.tsv$/i.test(logicalName)) delimiter = '\t';
    else {
      const sniffed = await sniffDelimiter(stream, options.fallbackDelimiter);
      delimiter = sniffed.delimiter;
      stream = sniffed.stream;
    }
  }
  if (delimiter.length !== 1)
    throw new Error('Le séparateur doit contenir exactement un caractère.');
  yield* parseDelimited(stream, delimiter, options);
}
