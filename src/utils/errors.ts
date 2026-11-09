import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, ZodTypeAny, z } from 'zod';

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public fieldErrors?: Record<string, string[] | undefined>) {
    super(message);
  }
}
export const badRequest = (m: string, code = 'BAD_REQUEST') => new AppError(400, code, m);
export const unauthorized = (m = 'Please sign in to continue') => new AppError(401, 'UNAUTHORIZED', m);
export const forbidden = (m = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', m);
export const notFound = (m = 'Not found') => new AppError(404, 'NOT_FOUND', m);
export const conflict = (m: string) => new AppError(409, 'CONFLICT', m);

export const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields', r.error.flatten().fieldErrors as Record<string, string[]>);
  return r.data;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as any).requestId;
  if (err instanceof AppError) {
    return res.status(err.status).json({ code: err.code, message: err.message, fieldErrors: err.fieldErrors, requestId });
  }
  if (err instanceof ZodError) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'Invalid input', fieldErrors: err.flatten().fieldErrors, requestId });
  }
  if ((err as any)?.code === 11000) {
    return res.status(409).json({ code: 'DUPLICATE', message: 'This record already exists', requestId });
  }
  console.error('[unhandled]', requestId, err);
  res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId });
}
