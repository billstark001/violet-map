import type { Role } from '@violet-map/core/contracts';
export interface Principal {
  id: string;
  username: string;
  role: Role;
  source: 'credential' | 'root' | 'static';
}
