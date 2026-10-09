#!/usr/bin/env node

/**
 * Generate or sync Postman collections for workspace specs via the Postman API.
 *
 * Intended to run after local changes have been pushed to Postman Cloud
 * (e.g. via postman workspace push in a separate CI workflow).
 *
 * Environment variables:
 *   POSTMAN_API_KEY          (required) Postman API key
 *   POSTMAN_REGION           (optional) Set to "eu" for EU data residency
 *   POSTMAN_WORKSPACE_ID     (optional) Override workspace.id from resources.yaml
 *   POSTMAN_RESOURCES_FILE   (optional) Path to resources.yaml
 *   POSTMAN_API_BASE_URL     (optional) Override API base URL
 *
 * Flags:
 *   --dry-run                List actions without calling generate/sync
 *   --spec-id <id>           Process a single workspace spec by ID
 */

import {
  findWorkspaceSpecForLocalEntry,
  loadLocalSpecEntries,
  loadResources,
  resolveCollectionName,
  specIdsMatch,
} from './lib/postman-resources.js';
import {
  createPostmanClient,
  DEFAULT_GENERATION_OPTIONS,
} from './lib/postman-api.js';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { dryRun: false, specId: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--spec-id') {
      options.specId = argv[index + 1];
      if (!options.specId) {
        fail('--spec-id requires a value.');
      }
      index += 1;
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

async function processSpec(api, spec, { localSpec, dryRun }) {
  const specId = spec.id;
  const collections = await api.listGeneratedCollections(specId);
  const outOfSync = collections.filter(
    (collection) => collection.state === 'out-of-sync',
  );

  if (collections.length === 0) {
    const { name, source, localPath } = resolveCollectionName({ localSpec });

    console.log(
      `\nSpec ${specId} (${spec.name}): no generated collections - will generate "${name}" from ${localPath} (from ${source}).`,
    );

    if (dryRun) {
      return { generated: 1, synced: 0, skipped: 0 };
    }

    const { data } = await api.generateCollection(specId, {
      name,
      options: DEFAULT_GENERATION_OPTIONS,
    });

    await api.pollTask(data.url, {
      label: `Generate collection for spec ${specId}`,
    });

    console.log(`Generated collection "${name}" for spec ${specId}.`);
    return { generated: 1, synced: 0, skipped: 0 };
  }

  if (outOfSync.length === 0) {
    console.log(
      `\nSpec ${specId} (${spec.name}): ${collections.length} collection(s), all in-sync - skipping.`,
    );
    return { generated: 0, synced: 0, skipped: collections.length };
  }

  console.log(
    `\nSpec ${specId} (${spec.name}): syncing ${outOfSync.length} out-of-sync collection(s).`,
  );

  let synced = 0;

  for (const collection of outOfSync) {
    const collectionUid = await api.resolveCollectionUid(collection.id);

    console.log(
      `  - ${collection.name} (${collectionUid}) [${collection.state}]`,
    );

    if (dryRun) {
      synced += 1;
      continue;
    }

    const { data } = await api.syncCollectionWithSpec(collectionUid, specId);

    if (data?.url) {
      await api.pollTask(data.url, {
        label: `Sync collection ${collectionUid} with spec ${specId}`,
      });
    } else if (data?.taskId) {
      await api.pollCollectionUpdateTask(data.taskId, {
        label: `Sync collection ${collectionUid} with spec ${specId}`,
      });
    } else {
      throw new Error(
        `Sync response for collection ${collectionUid} did not include a task URL or taskId.`,
      );
    }

    synced += 1;
    console.log(`  Synced ${collection.name}.`);
  }

  const skipped = collections.length - outOfSync.length;
  if (skipped > 0) {
    console.log(`  Skipped ${skipped} in-sync collection(s).`);
  }

  return { generated: 0, synced, skipped };
}

async function main() {
  const { dryRun, specId: onlySpecId } = parseArgs(process.argv.slice(2));

  let resourcesContext;
  try {
    resourcesContext = loadResources();
  } catch (error) {
    fail(error.message);
  }

  const { workspaceId, resources, resourcesDir } = resourcesContext;
  const localSpecs = loadLocalSpecEntries(resources, resourcesDir);
  const api = createPostmanClient();

  console.log(`Using Postman API: ${api.baseUrl}`);
  console.log(`Workspace: ${workspaceId}`);
  console.log(
    `Loaded ${localSpecs.length} local spec(s) from localResources.specs`,
  );
  if (dryRun) {
    console.log('Dry run - no generate or sync requests will be sent.');
  }

  const workspaceSpecs = await api.listWorkspaceSpecs(workspaceId);

  if (workspaceSpecs.length === 0) {
    console.log('No specs found in workspace.');
    return;
  }

  const totals = { generated: 0, synced: 0, skipped: 0 };
  let failed = false;

  for (const localSpec of localSpecs) {
    const workspaceSpec = findWorkspaceSpecForLocalEntry({
      localSpec,
      workspaceSpecs,
    });

    if (!workspaceSpec) {
      console.log(
        `\nLocal spec ${localSpec.relativePath} (${localSpec.title}): no matching workspace spec found - skipping.`,
      );
      continue;
    }

    if (onlySpecId && !specIdsMatch(workspaceSpec.id, onlySpecId)) {
      continue;
    }

    try {
      const result = await processSpec(api, workspaceSpec, {
        localSpec,
        dryRun,
      });
      totals.generated += result.generated;
      totals.synced += result.synced;
      totals.skipped += result.skipped;
    } catch (error) {
      failed = true;
      console.error(
        `\nFailed to process local spec ${localSpec.relativePath} / workspace spec ${workspaceSpec.id} (${workspaceSpec.name}): ${error.message}`,
      );
    }
  }

  if (onlySpecId) {
    const matchedAny = localSpecs.some((localSpec) => {
      const workspaceSpec = findWorkspaceSpecForLocalEntry({
        localSpec,
        workspaceSpecs,
      });
      return workspaceSpec && specIdsMatch(workspaceSpec.id, onlySpecId);
    });

    if (!matchedAny) {
      fail(`Spec ${onlySpecId} was not found in workspace ${workspaceId}.`);
    }
  }

  console.log(
    `\nDone. Generated: ${totals.generated}, synced: ${totals.synced}, skipped (in-sync): ${totals.skipped}.`,
  );

  if (failed) {
    process.exit(1);
  }
}

main().catch((error) => {
  fail(error.message);
});
