import type { Server } from 'node:http';

import type { Logger } from 'pino';

export interface ShutdownState {
  started: boolean;
}

interface GracefulShutdownDependencies {
  server: Server;
  state: ShutdownState;
  logger: Logger;
  timeoutMs: number;
  closeDependencies: () => Promise<void>;
}

export interface ShutdownResult {
  forced: boolean;
}

export interface GracefulShutdown {
  shutdown: (signal: NodeJS.Signals) => Promise<ShutdownResult>;
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });

export const createGracefulShutdown = (
  dependencies: GracefulShutdownDependencies,
): GracefulShutdown => {
  let shutdownPromise: Promise<ShutdownResult> | undefined;

  return {
    shutdown: (signal) => {
      if (shutdownPromise !== undefined) return shutdownPromise;

      dependencies.state.started = true;
      dependencies.logger.info({ signal }, 'Graceful shutdown started');

      shutdownPromise = (async () => {
        let forced = false;
        const timeout = setTimeout(() => {
          forced = true;
          dependencies.logger.error('Graceful shutdown timed out');
          dependencies.server.closeAllConnections();
        }, dependencies.timeoutMs);
        timeout.unref();

        try {
          await closeServer(dependencies.server);
          await dependencies.closeDependencies();
          dependencies.logger.info({ forced }, 'Graceful shutdown completed');
          return { forced };
        } finally {
          clearTimeout(timeout);
        }
      })();

      return shutdownPromise;
    },
  };
};
