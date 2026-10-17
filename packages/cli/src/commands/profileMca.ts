import { profileOptions, type ProfileInput } from './profileMcaInput.js';
import { loadCapability } from '../capabilities.js';

export async function runProfileMca(input: ProfileInput) {
  profileOptions(input);
  await loadCapability('@violet-map/render');
  return (await import('./profileMcaImplementation.js')).runProfileMca(input);
}
