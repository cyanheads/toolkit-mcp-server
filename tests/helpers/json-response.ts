/**
 * @fileoverview A Response-like object for stubbing `fetch`, carrying a JSON
 * body and status.
 * @module tests/helpers/json-response
 */

export const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;
