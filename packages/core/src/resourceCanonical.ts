/** Canonical JSON for content keys. Only plain JSON values are accepted. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null) throw new TypeError('resource keys require finite JSON values');
    if (ancestors.has(item)) throw new TypeError('cyclic resource key');
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set))
        throw new TypeError('resource keys cannot contain accessors');
      if (Object.getOwnPropertySymbols(item).length) throw new TypeError('symbol resource key');
      if (Array.isArray(item)) {
        if (Object.keys(item).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
          throw new TypeError('extra resource array properties');
        for (let i = 0; i < item.length; i++) if (!(i in item)) throw new TypeError('sparse resource key array');
        return '[' + item.map(encode).join(',') + ']';
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new TypeError('resource keys require plain objects');
      return (
        '{' +
        Object.keys(item)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + encode((item as Record<string, unknown>)[key]))
          .join(',') +
        '}'
      );
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}
