export type AdminErrorCode = 'INVALID_INPUT' | 'USER_NOT_FOUND' | 'USER_EXISTS' | 'FORBIDDEN';

export class AdminError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}
