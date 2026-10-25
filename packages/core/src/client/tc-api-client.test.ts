import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TcApiClient, TcApiError } from './tc-api-client.js';

describe('TcApiClient', () => {
  let client: TcApiClient;

  beforeEach(() => {
    client = new TcApiClient({
      baseUrl: 'https://tc.example.com',
      apiKey: 'test-key',
      maxRetries: 1,
      timeout: 5000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call heartbeat endpoint', async () => {
    const mockResponse = {
      status: 'ok',
      server_time: '2024-01-01T00:00:00Z',
      api_version: '1.0',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 })
    );

    const result = await client.heartbeat();
    expect(result.status).toBe('ok');
    expect(result.server_time).toBe('2024-01-01T00:00:00Z');
    expect(fetch).toHaveBeenCalledWith(
      'https://tc.example.com/api/v1/bot/heartbeat',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-key',
        }),
      })
    );
  });

  it('should call getPlans endpoint', async () => {
    const mockPlans = [{
      id: 'plan-1',
      symbol: 'BTCUSDT',
      status: 'planned',
    }];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', plans: mockPlans }), { status: 200 })
    );

    const plans = await client.getPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0]!.id).toBe('plan-1');
  });

  it('should throw TcApiError on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized', { status: 401 })
    );

    await expect(client.heartbeat()).rejects.toThrow(TcApiError);
    await expect(client.heartbeat()).rejects.toThrow('Authentication failed');
  });

  it('should throw TcApiError on 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Forbidden', { status: 403 })
    );

    await expect(client.heartbeat()).rejects.toThrow(TcApiError);
  });

  it('should not retry on 401/403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized', { status: 401 })
    );

    await expect(client.heartbeat()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on server error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Error', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok', server_time: '', api_version: '1.0' }), { status: 200 })
      );

    const result = await client.heartbeat();
    expect(result.status).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // Der Bot meldet nichts an das Journal zurueck. Diese Pruefung haelt das
  // fest: Wer versehentlich eine schreibende Methode ergaenzt, faellt hier
  // auf — die Ausfuehrungsdaten holt sich das Journal bei der Boerse.
  it('bietet keinen schreibenden Zugang', () => {
    const schreibendeMethoden = ['reportExecution', 'postReport', 'updatePlan', 'setStatus'];
    for (const name of schreibendeMethoden) {
      expect((client as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  it('spricht das Journal ausschliesslich mit GET an', async () => {
    // Je Aufruf eine frische Response: Ein Body laesst sich nur einmal lesen.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ status: 'ok', plans: [], data: {} }), { status: 200 })
    );

    await client.getPlans();
    await client.heartbeat();
    await client.getIndicatorsCatalog();

    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
    }
  });
});
