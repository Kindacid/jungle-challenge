import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller.ts';
import { MetricsPort } from './metrics-port.ts';
import { MetricsController } from './metrics.controller.ts';
import { PrometheusMetrics } from './prometheus-metrics.ts';

/** Metrics port (Prometheus) and the health/metrics endpoints. */
@Global()
@Module({
  controllers: [HealthController, MetricsController],
  providers: [PrometheusMetrics, { provide: MetricsPort, useExisting: PrometheusMetrics }],
  exports: [MetricsPort, PrometheusMetrics],
})
export class ObservabilityModule {}
