import { readFile, readdir, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const number = '(0|[1-9]\\d*)';
const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][\\dA-Za-z-]*)';
const semver = new RegExp(
  `^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*)?$`,
);

function parseVersion(version, label) {
  const match = typeof version === 'string' && semver.exec(version);
  if (!match || match[0] !== version)
    throw new Error(`${label}: expected a semantic version, received ${JSON.stringify(version)}`);
  return { major: match[1], minor: match[2] };
}

async function manifests() {
  const files = ['package.json'];
  // Mirrors the packages/* workspace declared in package.json and pnpm-workspace.yaml.
  for (const entry of await readdir(new URL('packages/', root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = `packages/${entry.name}/package.json`;
    try {
      await readFile(new URL(file, root), 'utf8');
      files.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return Promise.all(
    files.sort().map(async (file) => ({
      file,
      data: JSON.parse(await readFile(new URL(file, root), 'utf8')),
    })),
  );
}

function validateVersions(packages) {
  const workspace = packages.find(({ file }) => file === 'package.json');
  const shared = parseVersion(workspace.data.version, workspace.file);
  for (const { file, data } of packages) {
    const version = parseVersion(data.version, file);
    if (version.major !== shared.major || (shared.major === '0' && version.minor !== shared.minor))
      throw new Error(`${file}: ${data.version} does not share the workspace release line ${workspace.data.version}`);
  }
}

function options(args) {
  if (!args.length) return {};
  const usage = 'Usage: node scripts/version.mjs [--set <version> [--package <package-name>]]';
  if (args[0] !== '--set') throw new Error(usage);
  let version;
  let packageName;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--package' && packageName === undefined) {
      packageName = args[++index];
      if (!packageName || packageName.startsWith('-')) throw new Error(usage);
    } else if (!arg.startsWith('-') && version === undefined) {
      version = arg;
    } else {
      throw new Error(usage);
    }
  }
  parseVersion(version, '--set');
  return { version, packageName };
}

async function main() {
  const { version, packageName } = options(process.argv.slice(2));
  const packages = await manifests();
  const targets = packageName ? packages.filter(({ data }) => data.name === packageName) : packages;
  if (packageName && targets.length !== 1) throw new Error(`Expected one workspace package named ${packageName}`);

  const changes = [];
  if (version !== undefined) {
    for (const manifest of targets) {
      if (manifest.data.version === version) continue;
      manifest.data = { ...manifest.data, version };
      changes.push(manifest);
    }
  }

  // Check the entire proposed workspace before writing any manifests.
  validateVersions(packages);
  for (const { file, data } of changes) await writeFile(new URL(file, root), `${JSON.stringify(data, null, 2)}\n`);
  for (const { data } of packages) console.log(`${data.name}: ${data.version}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
