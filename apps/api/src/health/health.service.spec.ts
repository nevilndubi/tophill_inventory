import { HealthService } from './health.service';

describe('HealthService', () => {
  const service = new HealthService();

  it('returns an ok liveness result with an ISO timestamp', () => {
    const result = service.getLiveness();

    expect(result.status).toBe('ok');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('marks future database and Redis checks as not configured', () => {
    expect(service.getReadiness()).toMatchObject({
      checks: {
        database: 'not_configured',
        redis: 'not_configured',
      },
      status: 'ok',
    });
  });
});
