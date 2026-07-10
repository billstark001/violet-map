#!/usr/bin/env node
import { assetsUsage, runAssetsCommand } from './commands/assets.js';
import { runBakeTopMap } from './commands/bake.js';
import { runProfileMca } from './commands/profileMca.js';
import { runWorldCommand } from './commands/world.js';

function usage(): string {
  return `Violet Map CLI

Usage:
  vm-assets assets <list|extract|extract-all|generate-biomes|generate-dimensions> [...]
  vm-assets profile-mca <file.mca> [...]
  vm-assets bake-topmap <world> [...]
  vm-assets world sync --from <local-world-dir> --world <world-name> --target <local|s3|server> [...]

${assetsUsage()}`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  switch (command) {
    case 'assets':
      await runAssetsCommand(args);
      break;
    case 'profile-mca':
      await runProfileMca(args);
      break;
    case 'bake-topmap':
      await runBakeTopMap(args);
      break;
    case 'world':
      await runWorldCommand(args);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((e) => {
  console.error('Error:', (e as Error).message);
  process.exit(1);
});
