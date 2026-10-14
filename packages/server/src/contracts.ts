export const ALL_ROLES = ['guest', 'viewer', 'ci', 'admin', 'root'] as const;
export const CREATABLE_ROLES = ['viewer', 'ci', 'admin'] as const;
export type Role = (typeof ALL_ROLES)[number];
export type CreatableRole = (typeof CREATABLE_ROLES)[number];

export interface Principal {
  id: string;
  username: string;
  role: Role;
  source: 'credential' | 'root';
}

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  virtual?: boolean;
}

export interface IssuedCredential {
  token: string;
  expiresAt: string;
  user: PublicUser;
}
