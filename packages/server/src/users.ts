import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt } from 'drizzle-orm';
import { config } from './config.js';
import { getDatabase } from './db/index.js';
import { credentials, users } from './db/schema.js';

const scrypt = promisify(scryptCallback);

export const ALL_ROLES = ['guest', 'viewer', 'ci', 'admin', 'root'] as const;
export const CREATABLE_ROLES = ['viewer', 'ci', 'admin'] as const;
export type Role = typeof ALL_ROLES[number];
export type CreatableRole = typeof CREATABLE_ROLES[number];

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

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,62}[A-Za-z0-9]$/;

export function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new Error('username must be 3-64 characters: letters, numbers, dot, dash, or underscore');
  return username;
}

function asRole(value: unknown): Role | undefined { return ALL_ROLES.includes(value as Role) ? value as Role : undefined; }
export function asCreatableRole(value: unknown): CreatableRole | undefined { return CREATABLE_ROLES.includes(value as CreatableRole) ? value as CreatableRole : undefined; }
function asDate(value: Date | string | null | undefined): string | undefined { return value ? new Date(value).toISOString() : undefined; }

function publicUser(row: { id: string; username: string; role: string; enabled: boolean; createdAt?: Date | string; updatedAt?: Date | string }): PublicUser {
  const role = asRole(row.role);
  if (!role) throw new Error(`invalid role in user database: ${row.role}`);
  return { id: row.id, username: row.username, role, enabled: row.enabled, createdAt: asDate(row.createdAt), updatedAt: asDate(row.updatedAt) };
}

function configuredRoot(): { username: string; password: string } | undefined {
  if (!config.rootUsername || !config.rootPassword) return undefined;
  try { return { username: normalizeUsername(config.rootUsername), password: config.rootPassword }; } catch { return undefined; }
}

export function rootUser(): PublicUser | undefined {
  const root = configuredRoot();
  return root ? { id: 'root', username: root.username, role: 'root', enabled: true, virtual: true } : undefined;
}

function passwordError(password: string): void {
  if (password.length < 10) throw new Error('password must be at least 10 characters');
}
async function hashPassword(password: string): Promise<string> {
  passwordError(password);
  const salt = randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${derived.toString('base64url')}`;
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, value] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !value) return false;
  const expected = Buffer.from(value, 'base64url');
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export async function listUsers(): Promise<PublicUser[]> {
  const { db } = await getDatabase();
  const rows = await db.select().from(users).orderBy(users.username);
  const root = rootUser();
  return root ? [root, ...rows.map(publicUser)] : rows.map(publicUser);
}

export async function findUser(username: string): Promise<PublicUser | undefined> {
  const normalized = normalizeUsername(username);
  const root = rootUser();
  if (root?.username === normalized) return root;
  const { db } = await getDatabase();
  const rows = await db.select().from(users).where(eq(users.username, normalized)).limit(1);
  return rows[0] ? publicUser(rows[0]) : undefined;
}

export async function createUser(input: { username: string; password: string; role: CreatableRole }): Promise<PublicUser> {
  const username = normalizeUsername(input.username);
  if (!asCreatableRole(input.role)) throw new Error('root and guest are reserved roles and cannot be assigned to users');
  if (rootUser()?.username === username) throw new Error('username is reserved by the configured root user');
  const now = new Date();
  const row = { id: randomUUID(), username, passwordHash: await hashPassword(input.password), role: input.role, enabled: true, createdAt: now, updatedAt: now };
  const { db } = await getDatabase();
  try {
    const inserted = await db.insert(users).values(row).returning();
    return publicUser(inserted[0]);
  } catch (error) {
    if (String(error).includes('unique')) throw new Error('username already exists');
    throw error;
  }
}

export async function updateUser(username: string, input: { password?: string; role?: CreatableRole; enabled?: boolean }): Promise<PublicUser> {
  const normalized = normalizeUsername(username);
  if (rootUser()?.username === normalized) throw new Error('the environment-managed root user cannot be changed');
  if (input.role !== undefined && !asCreatableRole(input.role)) throw new Error('root and guest are reserved roles and cannot be assigned to users');
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (input.password !== undefined) values.passwordHash = await hashPassword(input.password);
  if (input.role !== undefined) values.role = input.role;
  if (input.enabled !== undefined) values.enabled = input.enabled;
  const { db } = await getDatabase();
  const changed = await db.update(users).set(values).where(eq(users.username, normalized)).returning();
  if (!changed[0]) throw new Error('user not found');
  if (input.password !== undefined || input.enabled === false) await db.delete(credentials).where(eq(credentials.userId, changed[0].id));
  return publicUser(changed[0]);
}

export async function deleteUser(username: string): Promise<void> {
  const normalized = normalizeUsername(username);
  if (rootUser()?.username === normalized) throw new Error('the environment-managed root user cannot be deleted');
  const { db } = await getDatabase();
  const found = await db.select({ id: users.id }).from(users).where(eq(users.username, normalized)).limit(1);
  if (!found[0]) throw new Error('user not found');
  await db.delete(credentials).where(eq(credentials.userId, found[0].id));
  await db.delete(users).where(eq(users.id, found[0].id));
}

async function credentialFor(principal: Principal, expiresAt: Date, issuedBy: string): Promise<IssuedCredential> {
  const token = `vm_${randomBytes(32).toString('base64url')}`;
  const { db } = await getDatabase();
  await db.insert(credentials).values({
    id: randomUUID(), tokenHash: tokenHash(token), userId: principal.id, username: principal.username,
    role: principal.role, issuedBy, expiresAt, createdAt: new Date(),
  });
  return { token, expiresAt: expiresAt.toISOString(), user: { id: principal.id, username: principal.username, role: principal.role, enabled: true, virtual: principal.source === 'root' } };
}

/** Root/admin can issue a credential that is bound to one enabled non-special user. */
export async function issueCredential(username: string, expiresInSeconds: number, issuedBy: Principal): Promise<IssuedCredential> {
  const user = await findUser(username);
  if (!user || user.virtual) throw new Error('user not found');
  if (!user.enabled) throw new Error('user is disabled');
  const seconds = Math.floor(expiresInSeconds);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 31_536_000) throw new Error('expiresInSeconds must be between 60 seconds and 365 days');
  return credentialFor({ id: user.id, username: user.username, role: user.role, source: 'credential' }, new Date(Date.now() + seconds * 1000), issuedBy.username);
}

/** Password login returns a short-lived bearer credential; the password is never used as an API token. */
export async function login(username: string, password: string): Promise<IssuedCredential | undefined> {
  let normalized: string;
  try { normalized = normalizeUsername(username); } catch { return undefined; }
  const root = configuredRoot();
  if (root?.username === normalized && sameText(root.password, password)) {
    return credentialFor({ id: 'root', username: root.username, role: 'root', source: 'root' }, new Date(Date.now() + 12 * 60 * 60 * 1000), 'root');
  }
  const { db } = await getDatabase();
  const rows = await db.select().from(users).where(eq(users.username, normalized)).limit(1);
  const row = rows[0];
  if (!row || !row.enabled || !await verifyPassword(password, row.passwordHash)) return undefined;
  const user = publicUser(row);
  return credentialFor({ id: user.id, username: user.username, role: user.role, source: 'credential' }, new Date(Date.now() + 12 * 60 * 60 * 1000), user.username);
}

export async function authenticateCredential(token: string): Promise<Principal | undefined> {
  if (!token) return undefined;
  const { db } = await getDatabase();
  const rows = await db.select().from(credentials).where(and(eq(credentials.tokenHash, tokenHash(token)), gt(credentials.expiresAt, new Date()))).limit(1);
  const credential = rows[0];
  if (!credential) return undefined;
  if (credential.userId === 'root') {
    const root = rootUser();
    if (!root || root.username !== credential.username) return undefined;
    return { id: root.id, username: root.username, role: 'root', source: 'root' };
  }
  const usersFound = await db.select().from(users).where(eq(users.id, credential.userId)).limit(1);
  const user = usersFound[0];
  if (!user || !user.enabled) return undefined;
  const role = asRole(user.role);
  return role ? { id: user.id, username: user.username, role, source: 'credential' } : undefined;
}
