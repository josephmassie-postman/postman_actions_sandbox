#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_CONFIG_PATH = '.postman-sync.json';
const DEFAULT_API_BASE_URL = 'https://api.getpostman.com';
const DEFAULT_POLL_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 3000;

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const toPosixPath = (value) => value.split(path.sep).join('/');

const resolveRepoPath = (repoRelativePath) =>
  path.resolve(repoRoot, repoRelativePath);

const readJson = async (filePath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
};

const getChangedFiles = () => {
  if (process.env.POSTMAN_SYNC_ALL === 'true') {
    return null;
  }

  const baseSha = process.env.BASE_SHA;
  const headSha = process.env.HEAD_SHA || 'HEAD';

  if (!baseSha || /^0+$/.test(baseSha)) {
    return null;
  }

  const output = execFileSync('git', ['diff', '--name-only', baseSha, headSha], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return new Set(output.split('\n').filter(Boolean).map(toPosixPath));
};

const shouldSyncSpec = (spec, changedFiles, configPath) => {
  if (!changedFiles) {
    return true;
  }

  const watchedPaths = [spec.path, ...(spec.watchPaths || []), configPath].map(
    toPosixPath,
  );

  return watchedPaths.some((watchedPath) => changedFiles.has(watchedPath));
};

const encodePathParam = (value) =>
  value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createPostmanClient = (apiKey, apiBaseUrl) => {
  const request = async (method, endpoint, body) => {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${apiBaseUrl}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        'X-Api-Key': apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || text;
      throw new Error(`${method} ${url} failed (${response.status}): ${detail}`);
    }

    return payload;
  };

  return {
    updateSpecFile: ({ specId, filePath, content }) =>
      request('PATCH', `/specs/${specId}/files/${encodePathParam(filePath)}`, {
        content,
      }),

    getSpecCollections: async (specId) => {
      const collections = [];
      let cursor;

      do {
        const params = new URLSearchParams({
          limit: '100',
        });

        if (cursor) {
          params.set('cursor', cursor);
        }

        const payload = await request(
          'GET',
          `/specs/${specId}/generations/collection?${params.toString()}`,
        );

        collections.push(...extractCollections(payload));
        cursor =
          payload.nextCursor ||
          payload.cursor?.next ||
          payload.meta?.nextCursor ||
          payload.pagination?.nextCursor;
      } while (cursor);

      return collections;
    },

    syncCollectionWithSpec: ({ specId, collectionUid }) =>
      request(
        'PUT',
        `/specs/${specId}/synchronizations?collectionUid=${encodeURIComponent(
          collectionUid,
        )}`,
      ),

    getTaskStatus: (taskUrl) => request('GET', taskUrl),
  };
};

const extractCollections = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }

  for (const key of ['collections', 'data', 'elements', 'items']) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }

  return [];
};

const collectionUidFor = (collection) =>
  collection.uid ||
  collection.collectionUid ||
  collection.id ||
  collection.collection?.uid ||
  collection.collection?.id;

const assertSpecConfig = (spec) => {
  for (const key of ['path', 'postmanSpecId']) {
    if (!spec[key]) {
      throw new Error(`Spec config is missing required "${key}" value.`);
    }
  }
};

const resolvePostmanSpecFilePath = (spec, config) => {
  if (spec.postmanSpecFilePath) {
    return toPosixPath(spec.postmanSpecFilePath);
  }

  const specPath = toPosixPath(spec.path);
  const syncRoot = toPosixPath(spec.postmanSyncRoot || config.postmanSyncRoot || '');

  if (syncRoot === '.') {
    return specPath;
  }

  if (syncRoot) {
    const prefix = `${syncRoot}/`;

    if (specPath === syncRoot) {
      throw new Error(
        `Spec path "${spec.path}" cannot be the Postman sync root. Set postmanSpecFilePath explicitly.`,
      );
    }

    if (specPath.startsWith(prefix)) {
      return specPath.slice(prefix.length);
    }
  }

  throw new Error(
    `Could not derive postmanSpecFilePath for "${spec.path}". ` +
      'Set postmanSyncRoot in the manifest, or set postmanSpecFilePath on the spec entry.',
  );
};

const pollTask = async (client, task, label) => {
  if (!task?.url) {
    console.log(`No async task URL returned for ${label}; continuing.`);
    return;
  }

  const timeoutMs = Number(
    process.env.POSTMAN_SYNC_POLL_TIMEOUT_MS || DEFAULT_POLL_TIMEOUT_MS,
  );
  const intervalMs = Number(
    process.env.POSTMAN_SYNC_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS,
  );
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await client.getTaskStatus(task.url);
    const state = String(
      status.status || status.state || status.task?.status || '',
    ).toLowerCase();

    if (['success', 'successful', 'completed', 'complete'].includes(state)) {
      console.log(`Sync completed for ${label}.`);
      return;
    }

    if (['failed', 'failure', 'error'].includes(state)) {
      throw new Error(`Sync failed for ${label}: ${JSON.stringify(status)}`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for Postman sync task for ${label}.`);
};

const main = async () => {
  const configPath = toPosixPath(
    process.env.POSTMAN_SYNC_CONFIG || DEFAULT_CONFIG_PATH,
  );
  const config = await readJson(resolveRepoPath(configPath));
  const changedFiles = getChangedFiles();
  const specs = config.specs || [];
  const specsToSync = specs.filter((spec) =>
    shouldSyncSpec(spec, changedFiles, configPath),
  );

  if (specsToSync.length === 0) {
    console.log('No configured Postman specs changed. Nothing to sync.');
    return;
  }

  const apiKey = process.env.POSTMAN_API_KEY;

  if (!apiKey) {
    throw new Error('POSTMAN_API_KEY is required.');
  }

  const apiBaseUrl = config.apiBaseUrl || DEFAULT_API_BASE_URL;
  const client = createPostmanClient(apiKey, apiBaseUrl);

  for (const spec of specsToSync) {
    assertSpecConfig(spec);

    const specName = spec.name || spec.path;
    const specContent = await fs.readFile(resolveRepoPath(spec.path), 'utf8');
    const postmanSpecFilePath = resolvePostmanSpecFilePath(spec, config);

    console.log(
      `Updating Postman spec file for ${specName} at ${postmanSpecFilePath}...`,
    );
    await client.updateSpecFile({
      specId: spec.postmanSpecId,
      filePath: postmanSpecFilePath,
      content: specContent,
    });

    console.log(`Fetching generated collections for ${specName}...`);
    const collections = await client.getSpecCollections(spec.postmanSpecId);
    const collectionUids = collections.map(collectionUidFor).filter(Boolean);

    if (collectionUids.length === 0) {
      console.log(
        `No generated collections found for ${specName}; skipping collection sync.`,
      );
      continue;
    }

    for (const collectionUid of collectionUids) {
      const label = `${specName} -> ${collectionUid}`;
      console.log(`Syncing ${label}...`);
      const task = await client.syncCollectionWithSpec({
        specId: spec.postmanSpecId,
        collectionUid,
      });

      await pollTask(client, task, label);
    }
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
