import type { RequestHandler } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface ApplicationMetrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status_class'>;
  httpDuration: Histogram<'method' | 'route' | 'status_class'>;
  httpInFlight: Gauge;
  reservationConflicts: Counter<'reason'>;
  waitlistPromotions: Counter<'result'>;
  idempotencyReplays: Counter<'operation'>;
  sseConnections: Gauge;
  websocketConnections: Gauge;
  outboxPublished: Counter<'result'>;
  outboxUnpublished: Gauge;
  outboxOldestAge: Gauge;
  projectionResults: Counter<'operation' | 'result'>;
  projectionLastSuccess: Gauge;
  reconciliationDrift: Gauge<'kind'>;
}

export const createApplicationMetrics = (): ApplicationMetrics => {
  const registry = new Registry();
  registry.setDefaultLabels({
    service: process.env['OTEL_SERVICE_NAME'] ?? 'gatherly-api',
    environment: process.env['DEPLOYMENT_ENVIRONMENT'] ?? 'development',
    slot: process.env['DEPLOYMENT_SLOT'] ?? 'local',
    version: process.env['APP_REVISION'] ?? 'development',
  });
  collectDefaultMetrics({ register: registry, prefix: 'gatherly_nodejs_' });

  const registers = [registry];
  return {
    registry,
    httpRequests: new Counter({
      name: 'gatherly_http_requests_total',
      help: 'Completed HTTP requests',
      labelNames: ['method', 'route', 'status_class'],
      registers,
    }),
    httpDuration: new Histogram({
      name: 'gatherly_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status_class'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    }),
    httpInFlight: new Gauge({
      name: 'gatherly_http_in_flight_requests',
      help: 'HTTP requests currently executing',
      registers,
    }),
    reservationConflicts: new Counter({
      name: 'gatherly_reservation_conflicts_total',
      help: 'Reservation conflicts by stable reason',
      labelNames: ['reason'],
      registers,
    }),
    waitlistPromotions: new Counter({
      name: 'gatherly_waitlist_promotions_total',
      help: 'Waitlist promotion outcomes',
      labelNames: ['result'],
      registers,
    }),
    idempotencyReplays: new Counter({
      name: 'gatherly_idempotency_replays_total',
      help: 'Idempotent mutation replays',
      labelNames: ['operation'],
      registers,
    }),
    sseConnections: new Gauge({
      name: 'gatherly_sse_connections',
      help: 'Open SSE connections',
      registers,
    }),
    websocketConnections: new Gauge({
      name: 'gatherly_websocket_connections',
      help: 'Open WebSocket connections',
      registers,
    }),
    outboxPublished: new Counter({
      name: 'gatherly_outbox_publish_total',
      help: 'Outbox publication outcomes',
      labelNames: ['result'],
      registers,
    }),
    outboxUnpublished: new Gauge({
      name: 'gatherly_outbox_unpublished',
      help: 'Current unpublished outbox rows',
      registers,
    }),
    outboxOldestAge: new Gauge({
      name: 'gatherly_outbox_oldest_unpublished_age_seconds',
      help: 'Age of the oldest unpublished outbox row',
      registers,
    }),
    projectionResults: new Counter({
      name: 'gatherly_search_projection_total',
      help: 'Search projection outcomes',
      labelNames: ['operation', 'result'],
      registers,
    }),
    projectionLastSuccess: new Gauge({
      name: 'gatherly_search_projection_last_success_timestamp_seconds',
      help: 'Unix time of the last successful search projection',
      registers,
    }),
    reconciliationDrift: new Gauge({
      name: 'gatherly_search_reconciliation_drift',
      help: 'Search reconciliation drift by kind',
      labelNames: ['kind'],
      registers,
    }),
  };
};

const routeTemplate = (request: Parameters<RequestHandler>[0]): string => {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? `${request.baseUrl}${route.path}` : 'unmatched';
};

export const createHttpMetricsMiddleware =
  (metrics: ApplicationMetrics): RequestHandler =>
  (request, response, next) => {
    if (request.path === '/metrics') {
      next();
      return;
    }

    metrics.httpInFlight.inc();
    const stopTimer = metrics.httpDuration.startTimer();
    response.once('finish', () => {
      const labels = {
        method: request.method,
        route: routeTemplate(request),
        status_class: `${String(Math.floor(response.statusCode / 100))}xx`,
      };
      metrics.httpInFlight.dec();
      metrics.httpRequests.inc(labels);
      stopTimer(labels);
    });
    next();
  };

export const createMetricsHandler =
  (metrics: ApplicationMetrics): RequestHandler =>
  (_request, response, next) => {
    void metrics.registry
      .metrics()
      .then((body) => {
        response.type(metrics.registry.contentType).send(body);
      })
      .catch(next);
  };
