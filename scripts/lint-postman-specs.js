#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_CONFIG_PATH = '.postman-sync.json';
const DEFAULT_LINT_FAIL_SEVERITY = 'error';
const POSTMAN_CLI_BIN = process.env.POSTMAN_CLI_BIN || 'postman';

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

const shouldLintSpec = (spec, changedFiles, configPath) => {
  if (!changedFiles) {
    return true;
  }

  const watchedPaths = [spec.path, ...(spec.watchPaths || []), configPath].map(
    toPosixPath,
  );

  return watchedPaths.some((watchedPath) => changedFiles.has(watchedPath));
};

const assertSpecConfig = (spec) => {
  if (!spec.path) {
    throw new Error('Spec config is missing required "path" value.');
  }
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

const main = async () => {
  const configPath = toPosixPath(
    process.env.POSTMAN_SYNC_CONFIG || DEFAULT_CONFIG_PATH,
  );
  const config = await readJson(resolveRepoPath(configPath));
  const changedFiles = getChangedFiles();
  const specs = config.specs || [];
  const specsToLint = specs.filter((spec) =>
    shouldLintSpec(spec, changedFiles, configPath),
  );

  if (specsToLint.length === 0) {
    console.log('No configured Postman specs changed. Nothing to lint.');
    return;
  }

  for (const spec of specsToLint) {
    assertSpecConfig(spec);

    lintSpecFile(resolveRepoPath(spec.path), {
      label: spec.name || spec.path,
      failSeverity:
        spec.lintFailSeverity || config.lintFailSeverity || DEFAULT_LINT_FAIL_SEVERITY,
      workspaceId:
        spec.postmanWorkspaceId ||
        config.postmanWorkspaceId ||
        process.env.POSTMAN_WORKSPACE_ID,
    });
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
