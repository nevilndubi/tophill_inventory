import { pinoHttpOptions } from './pino.config';

describe('pino HTTP configuration', () => {
  it('redacts authorization, cookie and idempotency headers', () => {
    expect(pinoHttpOptions.redact).toEqual({
      censor: '[REDACTED]',
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.idempotency-key',
        'req.headers["idempotency-key"]',
      ],
    });
  });
});
