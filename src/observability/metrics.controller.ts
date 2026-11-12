import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrometheusMetrics } from './prometheus-metrics.ts';

/** Prometheus scrape endpoint. Not authenticated. */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType());
    res.send(await this.metrics.render());
  }
}
