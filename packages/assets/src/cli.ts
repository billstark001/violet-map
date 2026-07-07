#!/usr/bin/env node
import { assetsUsage, runAssetsCommand } from './commands/assets.js';
import { runBakeHeightmap } from './commands/bake.js';
import { runProfileMca } from './commands/profileMca.js';

function usage(): string {
  return `Violet Map CLI

Usage:
  vm-assets assets <list|extract|extract-all|generate-biomes|generate-dimensions> [...]
  vm-assets profile-mca <file.mca> [...]
  vm-assets bake-heightmap <world> [...]

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
    case 'bake-heightmap':
      await runBakeHeightmap(args);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((e) => {
  console.error('Error:', (e as Error).message);
  process.exit(1);
});
