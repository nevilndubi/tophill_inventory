import type { Options } from 'pino-http';
import { getOrCreateRequestId, REQUEST_ID_HEADER } from '../common/http/request-id';

export const pinoHttpOptions: Options = {
  customProps: (request) => ({
    requestId: getOrCreateRequestId(request),
  }),
  genReqId: (request, response) => {
    const requestId = getOrCreateRequestId(request);
    request.id = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    return requestId;
  },
  redact: {
    censor: '[REDACTED]',
    paths: ['req.headers.authorization', 'req.headers.cookie'],
  },
};
