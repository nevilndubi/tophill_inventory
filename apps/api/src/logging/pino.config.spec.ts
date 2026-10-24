import { pinoHttpOptions } from './pino.config';

describe('pino HTTP configuration', () => {
  it('redacts authorization and cookie headers', () => {
    expect(pinoHttpOptions.redact).toEqual({
      censor: '[REDACTED]',
      paths: ['req.headers.authorization', 'req.headers.cookie'],
    });
  });
});
