import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Registry } from 'prom-client';
import { WageringMetrics } from '../infrastructure/observability/wagering-metrics';

/** Prometheus scrape endpoint. Like the health checks, it is meant for the internal network only. */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(WageringMetrics) private readonly metrics: WageringMetrics) {}

  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
