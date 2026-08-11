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

  it('closes a live SSE response before waiting for HTTP drain and dependencies', async () => {
    const streamStarted = createDeferred();
    let closeStream!: () => void;
    const app = express();
    app.get('/stream', (_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.flushHeaders();
      closeStream = () => response.end('event: stream.closed\ndata: {}\n\n');
      streamStarted.resolve();
    });

    const server = createServer(app);
    servers.push(server);
    const port = await listen(server);
    const responsePromise = fetch(`http://127.0.0.1:${String(port)}/stream`);
    await streamStarted.promise;
    const response = await responsePromise;
    const bodyPromise = response.text();
    const closeLongLivedConnections = vi.fn(() => {
      closeStream();
    });
    const closeDependencies = vi.fn().mockResolvedValue(undefined);
    const shutdown = createGracefulShutdown({
      server,
      state: { started: false },
      logger: pino({ enabled: false }),
      timeoutMs: 1_000,
      closeLongLivedConnections,
      closeDependencies,
    });

    const firstShutdown = shutdown.shutdown('SIGTERM');
    const repeatedShutdown = shutdown.shutdown('SIGINT');

    await expect(bodyPromise).resolves.toContain('event: stream.closed');
    await expect(firstShutdown).resolves.toEqual({ forced: false });
    expect(repeatedShutdown).toBe(firstShutdown);
    expect(closeLongLivedConnections).toHaveBeenCalledOnce();
    expect(closeDependencies).toHaveBeenCalledOnce();
    expect(closeLongLivedConnections.mock.invocationCallOrder[0]).toBeLessThan(
      closeDependencies.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });
});
