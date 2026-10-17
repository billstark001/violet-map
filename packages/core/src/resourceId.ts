/** Add the vanilla namespace when a resource location omits one. */
export function normalizeId(id: string): string {
  return id.includes(':') ? id : `minecraft:${id}`;
}
