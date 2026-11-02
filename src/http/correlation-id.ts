import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newId } from '../domain/shared/id';

const HEADER = 'X-Correlation-Id';
const MAX_LENGTH = 128;

/**
 * Keeps the caller's X-Correlation-Id (or creates one) and echoes it back, so
 * a provider can match its request to our events and logs.
 */
export function correlationIdMiddleware(request: Request, response: Response, next: NextFunction): void {
  const received = request.header(HEADER);
  const correlationId = received && received.length <= MAX_LENGTH ? received : newId();
  response.locals['correlationId'] = correlationId;
  response.setHeader(HEADER, correlationId);
  next();
}

export const CorrelationId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const response = context.switchToHttp().getResponse<Response>();
  return response.locals['correlationId'] as string;
});
