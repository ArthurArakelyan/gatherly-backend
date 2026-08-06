import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGracefulShutdown,
  type ShutdownState,
} from '../../src/infrastructure/http/graceful-shutdown.js';

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

describe('graceful HTTP shutdown', () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers) server.closeAllConnections();
    servers.length = 0;
  });

  it('stops admission, drains an active request, and closes dependencies once', async () => {
    const requestStarted = createDeferred();
    const releaseRequest = createDeferred();
    const app = express();
    app.get('/slow', async (_request, response) => {
      requestStarted.resolve();
      await releaseRequest.promise;
      response.json({ status: 'finished' });
    });

    const server = createServer(app);
    servers.push(server);
    const port = await listen(server);
    const state: ShutdownState = { started: false };
    const closeDependencies = vi.fn().mockResolvedValue(undefined);
    const shutdown = createGracefulShutdown({
      server,
      state,
      logger: pino({ enabled: false }),
      timeoutMs: 1_000,
      closeDependencies,
    });

    const responsePromise = fetch(`http://127.0.0.1:${String(port)}/slow`, {
      headers: { connection: 'close' },
    });
    await requestStarted.promise;

    const firstShutdown = shutdown.shutdown('SIGTERM');
    const repeatedShutdown = shutdown.shutdown('SIGINT');

    expect(state.started).toBe(true);
    expect(server.listening).toBe(false);
    expect(repeatedShutdown).toBe(firstShutdown);
    expect(closeDependencies).not.toHaveBeenCalled();

    releaseRequest.resolve();
    const response = await responsePromise;
    await expect(response.json()).resolves.toEqual({ status: 'finished' });
    await expect(firstShutdown).resolves.toEqual({ forced: false });
    expect(closeDependencies).toHaveBeenCalledOnce();
  });

  it('force-closes a request that exceeds the deadline', async () => {
    const requestStarted = createDeferred();
    const neverRelease = createDeferred();
    const app = express();
    app.get('/stuck', async (_request, response) => {
      requestStarted.resolve();
      await neverRelease.promise;
      response.end();
    });

    const server = createServer(app);
    servers.push(server);
    const port = await listen(server);
    const closeDependencies = vi.fn().mockResolvedValue(undefined);
    const shutdown = createGracefulShutdown({
      server,
      state: { started: false },
      logger: pino({ enabled: false }),
      timeoutMs: 25,
      closeDependencies,
    });

    const responsePromise = fetch(`http://127.0.0.1:${String(port)}/stuck`).then(
      () => undefined,
      (error: unknown) => error,
    );
    await requestStarted.promise;

    await expect(shutdown.shutdown('SIGTERM')).resolves.toEqual({ forced: true });
    await expect(responsePromise).resolves.toBeInstanceOf(Error);
    expect(closeDependencies).toHaveBeenCalledOnce();
  });
});
