import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import type { RequestHandler } from 'express';

export const traceIdMiddleware: RequestHandler = (_request, response, next) => {
  const spanContext = trace.getSpan(context.active())?.spanContext();

  if (spanContext !== undefined && isSpanContextValid(spanContext)) {
    response.locals['traceId'] = spanContext.traceId;
    response.setHeader('x-trace-id', spanContext.traceId);
  }

  next();
};
