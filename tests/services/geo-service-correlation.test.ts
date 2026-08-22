/**
 * @fileoverview Pins the request-correlation contract between GeoService and the
 * framework network utilities. `fetchWithTimeout` and `withRetry` are spied at the
 * module boundary so the context object handed to each is inspectable: both must
 * carry the handler request's identity (requestId, tenantId), and the retry
 * boundary must keep naming the sub-operation. These utilities take a
 * `RequestContext`, and the handler-facing `Context` is one — the correlation
 * fields must survive whichever object is passed.
 * @module tests/services/geo-service-correlation.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { getGeoService, initGeoService } from '@/services/geo/geo-service.js';

const { fetchSpy, retrySpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  retrySpy: vi.fn(),
}));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: fetchSpy, withRetry: retrySpy };
});

/** A minimal ip-api success envelope — this suite asserts on context, not payload. */
const PAYLOAD = { status: 'success', country: 'United States', countryCode: 'US' };

describe('GeoService request correlation', () => {
  beforeEach(() => {
    resetServerConfig();
    initGeoService();
    fetchSpy.mockReset();
    retrySpy.mockReset();
    fetchSpy.mockResolvedValue({ json: async () => PAYLOAD } as unknown as Response);
    // Run the wrapped operation for real so the fetch call actually happens.
    retrySpy.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  it('hands fetchWithTimeout a context carrying the handler request identity', async () => {
    const ctx = createMockContext({ requestId: 'req-geo-1', tenantId: 'tenant-a' });
    await getGeoService().lookup('8.8.8.8', ctx);

    const passedContext = fetchSpy.mock.calls[0]?.[2] as
      | { requestId?: string; tenantId?: string }
      | undefined;
    expect(passedContext?.requestId).toBe('req-geo-1');
    expect(passedContext?.tenantId).toBe('tenant-a');
  });

  it('forwards the caller AbortSignal to the provider fetch', async () => {
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });
    await getGeoService().lookup('8.8.8.8', ctx);

    const options = fetchSpy.mock.calls[0]?.[3] as { signal?: AbortSignal } | undefined;
    expect(options?.signal).toBe(controller.signal);
  });

  it('names the sub-operation and correlates the retry boundary', async () => {
    const ctx = createMockContext({ requestId: 'req-geo-2', tenantId: 'tenant-b' });
    await getGeoService().lookup('8.8.8.8', ctx);

    const options = retrySpy.mock.calls[0]?.[1] as
      | { operation?: string; context?: { requestId?: string; tenantId?: string } }
      | undefined;
    expect(options?.operation).toBe('GeoService.lookup');
    expect(options?.context?.requestId).toBe('req-geo-2');
    expect(options?.context?.tenantId).toBe('tenant-b');
  });

  it('wraps the whole fetch-and-parse pipeline in the retry boundary', async () => {
    // The retry boundary must cover parsing, not just the network call — a
    // provider that answers 200 with a malformed body is still retryable.
    const ctx = createMockContext();
    await getGeoService().lookup('8.8.8.8', ctx);

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // fetch ran inside the retried function, not before it.
    expect(retrySpy.mock.invocationCallOrder[0]).toBeLessThan(
      fetchSpy.mock.invocationCallOrder[0] as number,
    );
  });
});
