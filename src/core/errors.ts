export type DocStoreErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_id'
  | 'invalid_content'
  | 'exists';

export class DocStoreError extends Error {
  readonly code: DocStoreErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: DocStoreErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DocStoreError';
    this.code = code;
    this.detail = detail;
  }
}

export function isDocStoreError(error: unknown): error is DocStoreError {
  return error instanceof DocStoreError;
}
