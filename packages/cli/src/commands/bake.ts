import { bakeOptions, type BakeInput } from './bakeInput.js';
import { loadCapability } from '../capabilities.js';

export async function runBakeTopMap(input: BakeInput) {
  bakeOptions(input);
  await loadCapability('@violet-map/render');
  return (await import('./bakeImplementation.js')).runBakeTopMap(input);
}
