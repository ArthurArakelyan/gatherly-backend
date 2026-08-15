import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(requestContext: RequestContext, callback: () => T): T =>
  requestContextStorage.run(requestContext, callback);

export const getRequestContext = (): RequestContext | undefined => requestContextStorage.getStore();
