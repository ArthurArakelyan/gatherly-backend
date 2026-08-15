import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

const enabled = process.env['OTEL_SDK_DISABLED'] !== 'true';

const sdk = enabled
  ? new NodeSDK({
      serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'gatherly-api',
      traceExporter: new OTLPTraceExporter({
        url: process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ?? 'http://127.0.0.1:4318/v1/traces',
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingRequestHook: (request) =>
              request.url === '/health/live' || request.url === '/metrics',
          },
        }),
      ],
    })
  : undefined;

sdk?.start();

export const shutdownTelemetry = async (): Promise<void> => {
  await sdk?.shutdown();
};
