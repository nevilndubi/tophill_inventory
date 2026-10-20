import { Injectable } from '@nestjs/common';

type LivenessStatus = {
  status: 'ok';
  timestamp: string;
};

type ReadinessStatus = LivenessStatus & {
  checks: {
    database: 'not_configured';
    redis: 'not_configured';
  };
};

@Injectable()
export class HealthService {
  getLiveness(): LivenessStatus {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  getReadiness(): ReadinessStatus {
    return {
      ...this.getLiveness(),
      checks: {
        database: 'not_configured',
        redis: 'not_configured',
      },
    };
  }
}
