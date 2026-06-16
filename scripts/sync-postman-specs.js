#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const main = async () => {
  const apiKey = process.env.POSTMAN_API_KEY;
  const apiBaseUrl = 'https://api.getpostman.com';
  const timeoutMs = Number(process.env.POSTMAN_SYNC_POLL_TIMEOUT_MS || 120000);
  const intervalMs = Number(process.env.POSTMAN_SYNC_POLL_INTERVAL_MS || 3000);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const request = async (method, endpoint, body) => {
    const url = endpoint.startsWith('http') ? endpoint : `${apiBaseUrl}${endpoint}`;
    const response = await fetch(url, {
      method,
      headers: {
        'X-Api-Key': apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || text;
      throw new Error(`${method} ${url} failed (${response.status}): ${detail}`);
    }
    return { payload, response };
  };

  const isAlreadyInSyncError = (error) => {
    if (!error || !error.message) return false;
    return (
      error.message.includes('failed (400)') &&
      error.message.toLowerCase().includes('already in sync')
    );
  };

  const extractCollections = (payload) => {
    if (Array.isArray(payload)) return payload;
    for (const key of ['collections', 'data', 'elements', 'items', 'generations']) {
      if (Array.isArray(payload?.[key])) return payload[key];
    }
    if (Array.isArray(payload?.spec?.collections)) return payload.spec.collections;
    if (payload?.collection || payload?.collectionUid || payload?.uid) return [payload];
    return [];
  };

  const collectionUidFor = (collection) =>
    collection.uid ||
    collection.collectionUid ||
    collection.collectionUID ||
    collection.entityUid ||
    collection.entityUID ||
    collection.id ||
    collection.collection?.uid ||
    collection.collection?.collectionUid ||
    collection.collection?.id ||
    collection.output?.collectionUid ||
    collection.result?.collectionUid;

  const uniqueCollectionUids = (input) => [...new Set(input.filter(Boolean))];

  const buildSpecIdToPathMap = (resourcesYaml) => {
    const lines = resourcesYaml.split(/\r?\n/);
    const map = new Map();
    let inCloudResources = false;
    let inCloudSpecs = false;

    for (const line of lines) {
      if (/^\s*cloudResources:\s*$/.test(line)) {
        inCloudResources = true;
        inCloudSpecs = false;
        continue;
      }

      if (!inCloudResources) continue;

      if (/^\s{2}\S/.test(line) && !/^\s{2}specs:\s*$/.test(line)) {
        inCloudSpecs = false;
      }

      if (/^\s{2}specs:\s*$/.test(line)) {
        inCloudSpecs = true;
        continue;
      }

      if (!inCloudSpecs) continue;

      const match = line.match(/^\s{4}(.+?):\s*([0-9a-fA-F-]+)\s*$/);
      if (!match) continue;

      const [, specPathRaw, specId] = match;
      const specPath = specPathRaw.trim().replace(/^['"]|['"]$/g, '');
      map.set(specId, specPath);
    }

    return map;
  };

  const readSpecTitleFromPath = (specPath) => {
    try {
      const resolvedSpecPath = path.resolve('.postman', specPath);
      const content = fs.readFileSync(resolvedSpecPath, 'utf8');
      const lines = content.split(/\r?\n/);
      let inInfoBlock = false;
      let infoIndent = 0;

      for (const line of lines) {
        const infoMatch = line.match(/^(\s*)info:\s*$/);
        if (!inInfoBlock && infoMatch) {
          inInfoBlock = true;
          infoIndent = infoMatch[1].length;
          continue;
        }

        if (!inInfoBlock) continue;

        const currentIndent = (line.match(/^(\s*)/) || [''])[0].length;
        if (line.trim() && currentIndent <= infoIndent) {
          break;
        }

        const titleMatch = line.match(/^\s*title:\s*(.+)\s*$/);
        if (!titleMatch) continue;

        const titleValue = titleMatch[1].trim().replace(/^['"]|['"]$/g, '');
        return titleValue || null;
      }

      return null;
    } catch {
      return null;
    }
  };

  const pollTask = async (task, label) => {
    const taskUrl =
      task?.url ||
      task?.task?.url ||
      task?.taskUrl ||
      task?.meta?.task?.url ||
      task?.data?.url;

    if (!taskUrl) {
      throw new Error(`No async task URL returned for ${label}: ${JSON.stringify(task)}`);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { payload: status } = await request('GET', taskUrl);
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

    throw new Error(`Timed out waiting for sync task for ${label}.`);
  };

  const raw = fs.readFileSync('postman-specs.json', 'utf8');
  const payload = raw ? JSON.parse(raw) : {};
  const specs = payload.specs || payload.data || [];
  if (!Array.isArray(specs)) {
    throw new Error('Unexpected response shape in postman-specs.json');
  }

  const resourcesYaml = fs.readFileSync('.postman/resources.yaml', 'utf8');
  const specIdToPath = buildSpecIdToPathMap(resourcesYaml);

  const listGeneratedCollectionUids = async (specId) => {
    const { payload: collectionsPayload } = await request(
      'GET',
      `/specs/${specId}/generations/collection?limit=100`,
    );

    return uniqueCollectionUids(
      extractCollections(collectionsPayload).map(collectionUidFor),
    );
  };

  for (const spec of specs) {
    const specId = spec.id || spec.specId || spec.uid;
    const specName = spec.name || specId;
    const specPath = specIdToPath.get(specId);
    const specTitle = specPath ? readSpecTitleFromPath(specPath) : null;
    const targetCollectionName = specTitle || specName;
    if (!specId) continue;

    let collectionUids = await listGeneratedCollectionUids(specId);

    if (collectionUids.length === 0) {
      console.log(`No generated collections for ${specName}; creating one.`);

      const { payload: generationPayload, response } = await request(
        'POST',
        `/specs/${specId}/generations/collection`,
        {
          name: targetCollectionName,
          options: {
            requestNameSource: 'Fallback',
            indentCharacter: 'Space',
            folderStrategy: 'Paths',
            includeAuthInfoInExample: true,
            enableOptionalParameters: true,
            keepImplicitHeaders: false,
            includeDeprecated: true,
            alwaysInheritAuthentication: false,
            nestedFolderHierarchy: false,
          },
        },
      );

      const generationTask = {
        ...generationPayload,
        url:
          generationPayload?.url ||
          generationPayload?.task?.url ||
          generationPayload?.taskUrl ||
          generationPayload?.meta?.task?.url ||
          generationPayload?.data?.url ||
          response.headers.get('location') ||
          response.headers.get('content-location'),
      };

      if (generationTask.url) {
        await pollTask(generationTask, `${specName} collection generation`);
      }

      collectionUids = await listGeneratedCollectionUids(specId);
      if (collectionUids.length === 0) {
        throw new Error(
          `Collection generation succeeded but no collections were found for ${specName}.`,
        );
      }
    } else {
      for (const collectionUid of collectionUids) {
        const label = `${specName} -> ${collectionUid}`;
        console.log(`Syncing ${label}...`);
        let syncResponse;
        try {
          syncResponse = await request(
            'PUT',
            `/collections/${encodeURIComponent(collectionUid)}/synchronizations?specId=${encodeURIComponent(specId)}`,
          );
        } catch (error) {
          if (isAlreadyInSyncError(error)) {
            console.log(`Collection already in sync for ${label}; continuing.`);
            continue;
          }

          throw error;
        }
        const { payload: taskPayload, response } = syncResponse;

        const task = {
          ...taskPayload,
          url:
            taskPayload?.url ||
            taskPayload?.task?.url ||
            taskPayload?.taskUrl ||
            taskPayload?.meta?.task?.url ||
            taskPayload?.data?.url ||
            response.headers.get('location') ||
            response.headers.get('content-location'),
        };

        await pollTask(task, label);
      }
    }
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
