#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_LINT_FAIL_SEVERITY = 'error';
const POSTMAN_CLI_BIN = process.env.POSTMAN_CLI_BIN || 'postman';
const DEFAULT_SPECS_ROOT = 'postman/specs';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const toPosixPath = (value) => value.split(path.sep).join('/');

const resolveRepoPath = (repoRelativePath) =>
  path.resolve(repoRoot, repoRelativePath);

const getChangedFiles = () => {
  if (
    process.env.POSTMAN_LINT_ALL === 'true' ||
    process.env.POSTMAN_SYNC_ALL === 'true'
  ) {
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

const shouldLintSpec = (specPath, changedFiles) => {
  if (!changedFiles) {
    return true;
  }

  return changedFiles.has(toPosixPath(specPath));
};

const ensurePostmanCliAvailable = () => {
  try {
    execFileSync(POSTMAN_CLI_BIN, ['--version'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      `Postman CLI not found (${POSTMAN_CLI_BIN}). Install it with "npm install -g postman-cli" ` +
        'or set POSTMAN_CLI_BIN to the CLI executable path.',
    );
  }
};

const lintSpecFile = (specAbsolutePath, options = {}) => {
  ensurePostmanCliAvailable();

  const args = [
    'spec',
    'lint',
    specAbsolutePath,
    '--fail-severity',
    options.failSeverity || DEFAULT_LINT_FAIL_SEVERITY,
  ];

  if (options.workspaceId) {
    args.push('--workspace-id', options.workspaceId);
  }

  const label = options.label || specAbsolutePath;
  console.log(`Linting ${label}...`);

  try {
    execFileSync(POSTMAN_CLI_BIN, args, {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  } catch {
    throw new Error(`Spec lint failed for ${label}.`);
  }

  console.log(`Spec lint passed for ${label}.`);
};

const collectLocalSpecPaths = async (specsRoot) => {
  const rootAbsolutePath = resolveRepoPath(specsRoot);
  const entries = await fs.readdir(rootAbsolutePath, { withFileTypes: true });
  const specPaths = [];

  const walk = async (dirAbsolutePath) => {
    const dirEntries = await fs.readdir(dirAbsolutePath, { withFileTypes: true });
    for (const entry of dirEntries) {
      const entryAbsolutePath = path.join(dirAbsolutePath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryAbsolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        specPaths.push(toPosixPath(path.relative(repoRoot, entryAbsolutePath)));
      }
    }
  };

  for (const entry of entries) {
    const entryAbsolutePath = path.join(rootAbsolutePath, entry.name);
    if (entry.isDirectory()) {
      await walk(entryAbsolutePath);
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      specPaths.push(toPosixPath(path.relative(repoRoot, entryAbsolutePath)));
    }
  }

  return specPaths.sort();
};

const main = async () => {
  const specsRoot = toPosixPath(process.env.POSTMAN_SPECS_ROOT || DEFAULT_SPECS_ROOT);
  const changedFiles = getChangedFiles();
  const allSpecs = await collectLocalSpecPaths(specsRoot);
  const specsToLint = allSpecs.filter((specPath) =>
    shouldLintSpec(specPath, changedFiles),
  );

  if (allSpecs.length === 0) {
    throw new Error(`No local OpenAPI spec files found under "${specsRoot}".`);
  }

  if (specsToLint.length === 0) {
    console.log('No local OpenAPI spec changes detected. Nothing to lint.');
    return;
  }

  for (const specPath of specsToLint) {
    lintSpecFile(resolveRepoPath(specPath), {
      label: specPath,
      failSeverity: DEFAULT_LINT_FAIL_SEVERITY,
      workspaceId: process.env.POSTMAN_WORKSPACE_ID,
    });
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
