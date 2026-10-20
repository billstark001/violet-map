import { ALL_ROLES, type PublicUser, type ServiceCapabilities } from '@violet-map/core/contracts';

type Identity = Pick<PublicUser, 'id' | 'username' | 'role'>;

export interface SessionState {
  token: string;
  user: Identity | null;
  busy: boolean;
  error: string | null;
  publication?: { state: 'pending' | 'failed'; revision: string | null };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Merge any HeadersInit representation without dropping caller headers. */
export function authHeaders(token: string, initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return headers;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }
  if (body === null) throw new Error('server returned an invalid JSON response');
  return body as T;
}

function identity(value: unknown): Identity {
  if (!value || typeof value !== 'object') throw new Error('server returned an invalid identity');
  const user = value as Identity;
  if (typeof user.id !== 'string' || typeof user.username !== 'string' || !ALL_ROLES.includes(user.role))
    throw new Error('server returned an invalid identity');
  return { id: user.id, username: user.username, role: user.role };
}

/** API-scoped session state. Generations prevent late login/identity/logout
 * responses from changing a credential the user has already replaced. */
export class AdminSession {
  private state: SessionState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private abort: AbortController | null = null;
  constructor(
    private readonly options: {
      mode: ServiceCapabilities['authMode'];
      fetch: (path: string, init?: RequestInit) => Promise<Response>;
      storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
      key: string;
    },
  ) {
    let token = '';
    try {
      token = options.storage?.getItem(options.key) ?? '';
    } catch {
      /* restricted storage */
    }
    this.state = { token, user: null, busy: false, error: null };
  }
  getSnapshot = (): SessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  cancelPending(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    if (this.state.busy) this.update({ busy: false });
  }
  setToken = (token: string): void => {
    this.cancelPending();
    try {
      if (token) this.options.storage?.setItem(this.options.key, token);
      else this.options.storage?.removeItem(this.options.key);
    } catch {
      /* restricted storage */
    }
    this.update({ token, user: null, busy: false, error: null });
  };
  private begin(): { generation: number; signal: AbortSignal } {
    this.cancelPending();
    this.abort = new AbortController();
    this.update({ busy: true, error: null });
    return { generation: this.generation, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) };
  }
  private failed(error: unknown, generation: number): void {
    if (generation === this.generation)
      this.update({ error: error instanceof Error ? error.message : String(error), busy: false });
  }
  refresh = async (): Promise<void> => {
    const token = this.state.token;
    if (!token || this.state.busy || this.options.mode !== 'users') return;
    const { generation, signal } = this.begin();
    try {
      const user = identity(
        await jsonResponse(await this.options.fetch('api/auth/me', { headers: authHeaders(token), signal })),
      );
      if (generation === this.generation) this.update({ user, busy: false });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof ApiError && error.status === 401) this.setToken('');
      this.failed(error, this.generation);
    }
  };
  signIn = async (username: string, password: string): Promise<boolean> => {
    if (this.state.busy) return false;
    const { generation, signal } = this.begin();
    try {
      const data = await jsonResponse<{ token: string; user: unknown }>(
        await this.options.fetch('api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal,
          body: JSON.stringify({ username, password }),
        }),
      );
      const user = identity(data.user);
      if (typeof data.token !== 'string' || !data.token) throw new Error('server returned an invalid credential');
      if (generation !== this.generation) return false;
      this.setToken(data.token);
      this.update({ user });
      return true;
    } catch (error) {
      this.failed(error, generation);
      return false;
    }
  };
  signOut = async (): Promise<void> => {
    const token = this.state.token;
    this.setToken('');
    if (!token || this.options.mode !== 'users') return;
    const { generation, signal } = this.begin();
    try {
      const response = await this.options.fetch('api/auth/logout', {
        method: 'POST',
        headers: authHeaders(token),
        signal,
      });
      if (response.status !== 401) await jsonResponse(response);
      if (generation === this.generation) this.update({ busy: false });
    } catch (error) {
      this.failed(
        new Error(
          `Local credential cleared; server revocation failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        generation,
      );
    }
  };
  /** Authenticated operations expire only the credential that received a 401. */
  request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const token = this.state.token;
    const generation = this.generation;
    try {
      const response = await this.options.fetch(path, { ...init, headers: authHeaders(token, init?.headers) });
      const result = await jsonResponse<T>(response);
      const publication = response.headers.get('resource-publication-state');
      if (generation === this.generation && ['pending', 'failed', 'ready'].includes(publication ?? ''))
        this.update({
          publication:
            publication === 'ready'
              ? undefined
              : {
                  state: publication as 'pending' | 'failed',
                  revision: response.headers.get('resource-publication-revision'),
                },
        });
      return result;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        this.state.token === token &&
        generation === this.generation &&
        !init?.signal?.aborted
      ) {
        this.setToken('');
        this.update({ error: 'Credential expired or rejected' });
      }
      throw error;
    }
  };
}
