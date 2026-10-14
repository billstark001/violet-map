#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// Both src/cli.ts and dist/cli.js resolve to this package's release metadata.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

async function usage(): Promise<string> {
  const { assetsUsage } = await import('./commands/assets.js');
  return `Violet Map CLI ${version}

Usage:
  vm-cli --version
  vm-cli assets <list|extract|extract-all|generate-biomes|generate-dimensions> [...]
  vm-cli profile-mca <file.mca> [...]
  vm-cli bake-topmap <world> [...]
  vm-cli world sync --from <local-world-dir> --world <world-name> --target <local|s3|server> [...]

${assetsUsage()}`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--version' || command === '-V') {
    console.log(version);
    return;
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(await usage());
    return;
  }
  switch (command) {
    case 'assets': {
      const { runAssetsCommand } = await import('./commands/assets.js');
      await runAssetsCommand(args);
      break;
    }
    case 'profile-mca': {
      const { runProfileMca } = await import('./commands/profileMca.js');
      await runProfileMca(args);
      break;
    }
    case 'bake-topmap': {
      const { runBakeTopMap } = await import('./commands/bake.js');
      await runBakeTopMap(args);
      break;
    }
    case 'world': {
      const { runWorldCommand } = await import('./commands/world.js');
      await runWorldCommand(args);
      break;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((e) => {
  console.error('Error:', (e as Error).message);
  process.exit(1);
});
