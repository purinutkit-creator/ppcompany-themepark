export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Unauthorized') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (code = 'FORBIDDEN', message = 'Forbidden') => new AppError(403, code, message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message?: string, details?: unknown) => new AppError(409, code, message, details);
