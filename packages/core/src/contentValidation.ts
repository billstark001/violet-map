export class ContentValidationError extends Error {
  readonly code: 'INVALID_CONTENT' | 'UNSUPPORTED_FORMAT';
  constructor(message: string, code: 'INVALID_CONTENT' | 'UNSUPPORTED_FORMAT' = 'INVALID_CONTENT') {
    super(message);
    this.name = 'ContentValidationError';
    this.code = code;
  }
}
