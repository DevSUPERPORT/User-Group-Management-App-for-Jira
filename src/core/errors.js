// Errors carry a stable code; the frontend maps codes to localized messages.
export class AppError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.code = code;
    this.details = details;
  }
}

export const ErrorCodes = {
  FORBIDDEN: 'FORBIDDEN',
  NOT_ADMIN: 'NOT_ADMIN',
  NOT_AUDITOR: 'NOT_AUDITOR',
  PROJECT_NOT_ALLOWED: 'PROJECT_NOT_ALLOWED',
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  GROUP_NOT_IN_PROJECT: 'GROUP_NOT_IN_PROJECT',
  GROUP_BLOCKED: 'GROUP_BLOCKED',
  GROUP_READ_ONLY: 'GROUP_READ_ONLY',
  NAME_INVALID: 'NAME_INVALID',
  NAME_TAKEN: 'NAME_TAKEN',
  LICENSE_INACTIVE: 'LICENSE_INACTIVE',
  JIRA_ERROR: 'JIRA_ERROR',
  ORG_API_NOT_CONFIGURED: 'ORG_API_NOT_CONFIGURED',
  ORG_API_UNAUTHORIZED: 'ORG_API_UNAUTHORIZED',
  ORG_API_ERROR: 'ORG_API_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  GROUP_USED_ELSEWHERE: 'GROUP_USED_ELSEWHERE',
};

/** Wraps a resolver so every error reaches the UI as { error: { code, message, details } }. */
export function toErrorPayload(err) {
  if (err instanceof AppError) {
    return { error: { code: err.code, message: err.message, details: err.details ?? null } };
  }
  console.error('Unexpected error', err);
  return { error: { code: ErrorCodes.JIRA_ERROR, message: String(err?.message ?? err), details: null } };
}
