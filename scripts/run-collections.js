#!/usr/bin/env node

/**
 * Run Postman collections in postman/collections/ against a local environment
 * from postman/environments/, via Postman CLI.
 *
 * Environment variables:
 *   POSTMAN_API_KEY          (required) Postman API key for CLI authentication
 *   POSTMAN_REGION           (optional) Set to "eu" for EU data residency
 *   POSTMAN_TEST_ENVIRONMENT (optional) Environment name to use (default: DEV)
 */

import { spawnSync } from 'node:child_process';
import {
  loadLocalCollectionPaths,
  loadLocalEnvironment,
  repoRoot,
} from './lib/postman-resources.js';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function runPostman(args, { label }) {
  const result = spawnSync('postman', args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      fail(
        'Postman CLI was not found on PATH. Install it from https://learning.postman.com/docs/postman-cli/postman-cli-overview/',
      );
    }

    fail(`${label} failed: ${result.error.message}`);
  }

  return result.status ?? 1;
}

function authenticate() {
  const apiKey = process.env.POSTMAN_API_KEY;
  if (!apiKey) {
    fail('POSTMAN_API_KEY environment variable is required.');
  }

  const loginArgs = ['login', '--with-api-key', apiKey];
  const region = process.env.POSTMAN_REGION?.trim();

  if (region) {
    loginArgs.push('--region', region);
  }

  console.log('Authenticating with Postman CLI using POSTMAN_API_KEY...');
  const exitCode = runPostman(loginArgs, { label: 'postman login' });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

function runCollections({ environmentPath, collections }) {
  let failed = false;

  for (const { name, localPath } of collections) {
    console.log(`\nRunning collection ${name} (${localPath})`);
    const exitCode = runPostman(
      ['collection', 'run', localPath, '-e', environmentPath, '--report-events'],
      { label: `postman collection run ${name}` },
    );

    if (exitCode !== 0) {
      failed = true;
    }
  }

  if (failed) {
    console.error('\nOne or more collection runs failed.');
    process.exit(1);
  }

  console.log(`\nAll ${collections.length} collection(s) passed.`);
}

function main() {
  if (spawnSync('postman', ['--version'], { encoding: 'utf8' }).error) {
    fail(
      'Postman CLI was not found on PATH. Install it from https://learning.postman.com/docs/postman-cli/postman-cli-overview/',
    );
  }

  authenticate();

  const environmentName = (
    process.env.POSTMAN_TEST_ENVIRONMENT ?? 'DEV'
  ).trim();

  let collectionContext;
  let environmentContext;

  try {
    collectionContext = loadLocalCollectionPaths();
    environmentContext = loadLocalEnvironment(environmentName);
  } catch (error) {
    fail(error.message);
  }

  const { collections, collectionsDir } = collectionContext;
  const { localPath: environmentPath } = environmentContext;

  console.log(`Using environment ${environmentName} (${environmentPath})`);
  console.log(`Found ${collections.length} collection(s) in ${collectionsDir}`);

  runCollections({ environmentPath, collections });
}

main();
