import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import { runWithRequestContext } from './request-context.js';

const trustedRequestId =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export const requestIdMiddleware: RequestHandler = (request, response, next) => {
  const forwarded = request.get('x-request-id');
  const requestId =
    forwarded !== undefined && trustedRequestId.test(forwarded) ? forwarded : randomUUID();

  response.locals['requestId'] = requestId;
  response.setHeader('x-request-id', requestId);
  runWithRequestContext({ requestId }, next);
};
