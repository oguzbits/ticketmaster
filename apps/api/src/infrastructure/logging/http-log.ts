import type { StdSerializedResults } from 'pino-http';

import { requestId } from './request-id.js';

/**
 * Options of the HTTP request log. The default serializers write every header and the client
 * address (also behind the proxy's `X-Forwarded-For`), which is personal data; a request line
 * carries only what identifies it.
 */
export const httpLogOptions = {
  genReqId: requestId,
  serializers: {
    req: ({ id, method, url }: StdSerializedResults['req']) => ({ id, method, url }),
    res: ({ statusCode }: StdSerializedResults['res']) => ({ statusCode }),
  },
};
