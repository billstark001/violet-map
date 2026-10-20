import { canonicalJson } from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';

export interface Dependency {
  role: string;
  digest: string;
}

export interface ActionInput {
  generator: string;
  version: number;
  format: string;
  params: unknown;
  dependencies: readonly Dependency[];
}

export function actionKey(input: ActionInput): string {
  if (!input.generator || !Number.isSafeInteger(input.version) || input.version < 1 || !input.format)
    throw new TypeError('invalid generator identity');
  const deps = [...input.dependencies].sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
  const roles = new Set<string>();
  for (const dep of deps) {
    if (!dep.role || roles.has(dep.role) || !/^[a-f0-9]{64}$/.test(dep.digest))
      throw new TypeError('invalid action dependency');
    roles.add(dep.role);
  }
  return sha256(
    canonicalJson({
      schema: 1,
      generator: input.generator,
      version: input.version,
      format: input.format,
      params: input.params,
      deps,
    }),
  );
}
