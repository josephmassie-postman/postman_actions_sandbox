import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '../..');

export function getResourcesFile() {
  return resolve(
    repoRoot,
    process.env.POSTMAN_RESOURCES_FILE ?? '.postman/resources.yaml',
  );
}

export function parseResourcesFile() {
  const resourcesFile = getResourcesFile();

  if (!existsSync(resourcesFile)) {
    throw new Error(`Resources file not found: ${resourcesFile}`);
  }

  const resources = parseYaml(readFileSync(resourcesFile, 'utf8'), {
    prettyErrors: true,
  });

  const resourcesDir = dirname(resourcesFile);

  return { resources, resourcesDir, resourcesFile };
}

export function getWorkspaceId(resources) {
  return process.env.POSTMAN_WORKSPACE_ID?.trim() || resources?.workspace?.id || null;
}

export function loadResources() {
  const { resources, resourcesDir, resourcesFile } = parseResourcesFile();
  const workspaceId = getWorkspaceId(resources);

  if (!workspaceId) {
    throw new Error(
      'workspace.id is not set in resources.yaml and POSTMAN_WORKSPACE_ID is not defined.',
    );
  }

  return { resources, resourcesDir, resourcesFile, workspaceId };
}

/**
 * Resolves local OpenAPI spec paths listed under localResources.specs.
 */
export function loadLocalSpecPaths() {
  const { resources, resourcesDir, resourcesFile } = parseResourcesFile();
  const specs = resources?.localResources?.specs;

  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error(
      `No specs listed under localResources.specs in ${resourcesFile}`,
    );
  }

  const specPaths = specs.map((specPath) =>
    resolveResourcePath(resourcesDir, specPath),
  );

  for (const specPath of specPaths) {
    if (!existsSync(specPath)) {
      throw new Error(`Spec file not found: ${specPath}`);
    }
  }

  return {
    workspaceId: getWorkspaceId(resources),
    specPaths,
    resourcesFile,
  };
}

export function resolveResourcePath(resourcesDir, relativePath) {
  return resolve(resourcesDir, relativePath);
}

/**
 * Discovers local collection folders under a directory (e.g. postman/collections).
 * Each immediate subdirectory is treated as one git-native (v3) collection.
 */
export function loadLocalCollectionPaths(
  collectionsDir = resolve(repoRoot, 'postman/collections'),
) {
  if (!existsSync(collectionsDir)) {
    throw new Error(`Collections directory not found: ${collectionsDir}`);
  }

  const collections = readdirSync(collectionsDir)
    .filter((entry) => statSync(join(collectionsDir, entry)).isDirectory())
    .sort()
    .map((entry) => ({
      name: entry,
      localPath: join(collectionsDir, entry),
    }));

  if (collections.length === 0) {
    throw new Error(`No collection folders found in ${collectionsDir}`);
  }

  return { collections, collectionsDir };
}

/**
 * Finds the local environment file matching a given environment name (e.g. DEV)
 * under a directory (e.g. postman/environments).
 */
export function loadLocalEnvironment(
  environmentName = 'DEV',
  environmentsDir = resolve(repoRoot, 'postman/environments'),
) {
  if (!existsSync(environmentsDir)) {
    throw new Error(`Environments directory not found: ${environmentsDir}`);
  }

  const environmentFiles = readdirSync(environmentsDir).filter((entry) =>
    entry.endsWith('.environment.yaml'),
  );

  for (const entry of environmentFiles) {
    const localPath = join(environmentsDir, entry);
    const document = parseYaml(readFileSync(localPath, 'utf8'), {
      prettyErrors: true,
    });

    if (document?.name === environmentName) {
      return { name: environmentName, localPath };
    }
  }

  throw new Error(
    `Environment "${environmentName}" not found in ${environmentsDir}`,
  );
}

/**
 * Normalizes values used to match local spec files to workspace spec names.
 */
function normalizeSpecMatchValue(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^(\.\.\/)+/, '');
}

/**
 * Normalizes Postman spec IDs so owner-prefixed and bare UUID forms match.
 */
export function normalizeSpecId(specId) {
  const value = String(specId ?? '').trim();
  const match = value.match(
    /^(?:\d+-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );

  return match ? match[1].toLowerCase() : value.toLowerCase();
}

export function specIdsMatch(left, right) {
  return (
    String(left ?? '') === String(right ?? '') ||
    normalizeSpecId(left) === normalizeSpecId(right)
  );
}

/**
 * Candidate strings for matching a local spec file to a workspace spec name.
 */
export function getLocalSpecMatchCandidates(entry) {
  const relativeWithoutParent = entry.relativePath.replace(/^(\.\.\/)+/, '');

  return [
    entry.title,
    entry.fileBasename,
    `${entry.fileBasename}.yaml`,
    `${entry.fileBasename}.yml`,
    entry.relativePath,
    relativeWithoutParent,
    basename(entry.relativePath),
    basename(entry.localPath),
  ]
    .map(normalizeSpecMatchValue)
    .filter(Boolean);
}

function specNamesMatch(specName, localSpec) {
  const normalizedSpecName = normalizeSpecMatchValue(specName);
  if (!normalizedSpecName) {
    return false;
  }

  const candidates = getLocalSpecMatchCandidates(localSpec);
  if (candidates.includes(normalizedSpecName)) {
    return true;
  }

  return candidates.some((candidate) => {
    if (candidate === normalizedSpecName) {
      return true;
    }

    return (
      normalizedSpecName.endsWith(`/${candidate}`) ||
      candidate.endsWith(`/${normalizedSpecName}`) ||
      (candidate.length > 3 && normalizedSpecName.endsWith(candidate)) ||
      (normalizedSpecName.length > 3 && candidate.endsWith(normalizedSpecName))
    );
  });
}

/**
 * Finds a workspace spec that corresponds to a localResources.specs entry.
 */
export function findWorkspaceSpecForLocalEntry({ localSpec, workspaceSpecs }) {
  if (!localSpec || !Array.isArray(workspaceSpecs)) {
    return null;
  }

  return (
    workspaceSpecs.find((spec) => specNamesMatch(spec.name, localSpec)) ?? null
  );
}

/**
 * Loads local OpenAPI spec entries from localResources.specs.
 */
export function loadLocalSpecEntries(resources, resourcesDir) {
  const specs = resources?.localResources?.specs;
  const resourcesFile = getResourcesFile();

  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error(
      `No specs listed under localResources.specs in ${resourcesFile}`,
    );
  }

  const entries = [];

  for (const relativePath of specs) {
    const localPath = resolveResourcePath(resourcesDir, relativePath);

    if (!existsSync(localPath)) {
      throw new Error(`Spec file not found: ${localPath}`);
    }

    let title = null;
    try {
      title = readOpenApiTitle(localPath);
    } catch (error) {
      throw new Error(
        `Could not read OpenAPI title from ${localPath}: ${error.message}`,
      );
    }

    entries.push({
      relativePath,
      localPath,
      title,
      fileBasename: basename(localPath, extname(localPath)),
    });
  }

  return entries;
}

/**
 * Finds a local spec entry that corresponds to a workspace spec name.
 */
export function findLocalSpecEntry({ specName, localSpecs }) {
  if (!Array.isArray(localSpecs)) {
    return null;
  }

  return localSpecs.find((entry) => specNamesMatch(specName, entry)) ?? null;
}

function readOpenApiTitle(specPath) {
  const content = readFileSync(specPath, 'utf8');
  const extension = extname(specPath).toLowerCase();

  if (extension === '.json') {
    const document = JSON.parse(content);
    return document?.info?.title?.trim() || null;
  }

  const document = parseYaml(content);
  return document?.info?.title?.trim() || null;
}

/**
 * Resolves a collection name for generate from a localResources.specs entry.
 */
export function resolveCollectionName({ localSpec, specName, localSpecs }) {
  const entry =
    localSpec ?? findLocalSpecEntry({ specName, localSpecs: localSpecs ?? [] });

  if (entry) {
    if (entry.title) {
      return {
        name: entry.title,
        source: 'local-title',
        localPath: entry.localPath,
      };
    }

    return {
      name: entry.fileBasename,
      source: 'local-filename',
      localPath: entry.localPath,
    };
  }

  console.warn(
    `Warning: No local spec in localResources.specs matches "${specName}"; using cloud spec name.`,
  );

  if (specName?.trim()) {
    return { name: specName.trim(), source: 'cloud-name' };
  }

  return { name: 'unknown', source: 'cloud-name' };
}
