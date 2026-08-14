export class CatalogImportErrorBase extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class RowMappingError extends CatalogImportErrorBase {}

export class DuplicateImportError extends CatalogImportErrorBase {
  constructor(checksum: string) {
    super(
      'FILE_ALREADY_IMPORTED',
      `Le fichier ${checksum} a déjà été importé. Utilisez --force-reimport pour le retraiter.`,
    );
  }
}

export class ResumableImportExistsError extends CatalogImportErrorBase {
  constructor() {
    super(
      'RESUMABLE_IMPORT_EXISTS',
      'Un import interrompu existe pour ce fichier. Relancez la commande avec --resume.',
    );
  }
}

export class ImportContractMismatchError extends CatalogImportErrorBase {
  constructor() {
    super(
      'IMPORT_CONTRACT_MISMATCH',
      "Reprise refusee : la version de l'importeur, la projection ou les options ne correspondent pas au travail interrompu.",
    );
  }
}

export class ImportInterruptedError extends CatalogImportErrorBase {
  constructor() {
    super('IMPORT_INTERRUPTED', 'Import interrompu ; sa progression a été enregistrée.');
  }
}
