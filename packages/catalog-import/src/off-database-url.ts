import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const validateOffCatalogUrl = (value: string, variableName: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} n’est pas une URL PostgreSQL valide.`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${variableName} doit utiliser le protocole PostgreSQL.`);
  }
  if (decodeURIComponent(parsed.pathname) !== '/notons_off_catalog') {
    throw new Error('La reconstruction refuse toute base autre que notons_off_catalog.');
  }
  return value;
};

const loadSecret = async (
  invocationDirectory: string,
  environment: NodeJS.ProcessEnv,
  variableName: string,
): Promise<string | null> => {
  const secretFile = environment[`${variableName}_FILE`];
  const value = secretFile
    ? (await readFile(resolve(invocationDirectory, secretFile), 'utf8')).trim()
    : environment[variableName]?.trim() || null;
  if (secretFile && !value) throw new Error(`Le fichier ${variableName}_FILE est vide.`);
  if (!value) return null;
  return validateOffCatalogUrl(value, variableName);
};

/** Loads only the isolated catalogue credential and rejects a Core-looking URL. */
export const loadOffCatalogDatabaseUrl = (
  invocationDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> =>
  loadSecret(invocationDirectory, environment, 'OFF_CATALOG_DATABASE_URL');

/** Administrative credential used only to initialise an empty isolated database. */
export const loadOffCatalogAdminDatabaseUrl = (
  invocationDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> =>
  loadSecret(invocationDirectory, environment, 'OFF_CATALOG_ADMIN_DATABASE_URL');
