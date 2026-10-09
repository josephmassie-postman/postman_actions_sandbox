#!/usr/bin/env node

/**
 * Lint OpenAPI specs listed in .postman/resources.yaml via Postman CLI.
 *
 * Environment variables:
 *   POSTMAN_API_KEY          (required) Postman API key for CLI authentication
 *   POSTMAN_REGION           (optional) Set to "eu" for EU data residency
 *   POSTMAN_FAIL_SEVERITY    (optional) error | warning | info | hint (default: error)
 *   POSTMAN_WORKSPACE_ID     (optional) Override workspace.id from resources.yaml
 *   POSTMAN_RESOURCES_FILE   (optional) Path to resources.yaml (default: .postman/resources.yaml)
 *
 * GitHub Actions example:
 *   - uses: actions/setup-node@v4
 *     with:
 *       node-version: "20"
 *       cache: npm
 *   - uses: postmanlabs/postman-cli-action@v1
 *     with:
 *       command: "--version"
 *       api-key: ${{ secrets.POSTMAN_API_KEY }}
 *   - run: npm ci && npm run lint:specs
 *     env:
 *       POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
 */

import { spawnSync } from 'node:child_process';
import {
  loadLocalSpecPaths,
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

function lintSpecs({ workspaceId, specPaths }) {
  const failSeverity = (
    process.env.POSTMAN_FAIL_SEVERITY ?? 'error'
  ).toLowerCase();

  let failed = false;

  for (const specPath of specPaths) {
    const lintArgs = ['spec', 'lint', specPath, '--fail-severity', failSeverity, '--report-events'];

    if (workspaceId) {
      lintArgs.push('--workspace-id', workspaceId);
    }

    console.log(`\nLinting ${specPath}...`);
    const exitCode = runPostman(lintArgs, {
      label: `postman spec lint ${specPath}`,
    });

    if (exitCode !== 0) {
      failed = true;
    }
  }

  if (failed) {
    console.error('\nOne or more OpenAPI specs failed linting.');
    process.exit(1);
  }

  console.log(`\nAll ${specPaths.length} OpenAPI spec(s) passed linting.`);
}

function main() {
  if (spawnSync('postman', ['--version'], { encoding: 'utf8' }).error) {
    fail(
      'Postman CLI was not found on PATH. Install it from https://learning.postman.com/docs/postman-cli/postman-cli-overview/',
    );
  }

  authenticate();

  let specContext;
  try {
    specContext = loadLocalSpecPaths();
  } catch (error) {
    fail(error.message);
  }

  const { workspaceId, specPaths } = specContext;

  if (workspaceId) {
    console.log(`Using workspace governance rules: ${workspaceId}`);
  } else {
    console.warn(
      'Warning: workspace.id is not set in resources.yaml; using default governance rules.',
    );
  }

  lintSpecs({ workspaceId, specPaths });
}

main();
