const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*]/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

/** A portable directory component preserving Minecraft names and URL characters.
 * Separators, device names and trailing dots/spaces would escape or alias a mount on Windows. */
export function isWorldName(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 255 ||
    INVALID_FILENAME_CHARACTERS.test(value) ||
    /[. ]$/.test(value) ||
    WINDOWS_DEVICE_NAME.test(value)
  )
    return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export function assertWorldName(value: string): void {
  if (!isWorldName(value)) throw new Error('invalid world name');
}
