import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JulesClient, JulesAPIError } from '../api/jules-client.js';

describe('JulesClient Resiliency', () => {
  let client: JulesClient;

  beforeEach(() => {
    vi.stubEnv('JULES_API_KEY', 'test-key');
    vi.stubEnv('JULES_API_TIMEOUT_MS', '500');
    vi.stubEnv('JULES_API_MAX_RETRIES', '2');
    client = new JulesClient();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('constructor throws if no API key', () => {
    vi.stubEnv('JULES_API_KEY', '');
    expect(() => new JulesClient()).toThrow(/JULES_API_KEY/);
  });

  it('should retry on transient 5xx errors and eventually succeed', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue('Server is busy'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ sources: [] }),
      });

    const response = await client.listSources();
    expect(response).toEqual({ sources: [] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should retry on AbortError (timeout) and eventually succeed', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ sources: [] }),
      });

    const response = await client.listSources();
    expect(response).toEqual({ sources: [] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should throw after max retries are exceeded', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: vi.fn().mockResolvedValue('Offline'),
    });

    await expect(client.listSources()).rejects.toThrow(JulesAPIError);
    // 1 initial attempt + 2 retries = 3 total
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should not retry on 4xx errors', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: vi.fn().mockResolvedValue('Invalid prompt'),
    });

    await expect(client.listSources()).rejects.toThrow(JulesAPIError);
    // Should fail immediately without retrying
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should truncate long error bodies', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    const longError = 'A'.repeat(1000);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: vi.fn().mockResolvedValue(longError),
    });

    try {
      await client.listSources();
    } catch (e) {
      expect(e).toBeInstanceOf(JulesAPIError);
      const apiError = e as JulesAPIError;
      expect(apiError.response as string).toContain('... [truncated]');
      expect((apiError.response as string).length).toBeLessThan(600); // 500 + length of '... [truncated]'
    }
  });

  it('should throw immediately if error is an instance of JulesAPIError and not retry', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    // Throwing JulesAPIError directly will trigger the early re-throw in catch block
    mockFetch.mockRejectedValueOnce(new JulesAPIError('Direct API Error', 400));

    await expect(client.listSources()).rejects.toThrow(JulesAPIError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should throw generic network error if unknown error is thrown and max retries exceeded', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockRejectedValue(new Error('Unknown generic error'));

    await expect(client.listSources()).rejects.toThrow('Network error: Unknown generic error');
    // 1 initial + max retries
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it.each(['network', 'server'])('does not replay create after an uncertain %s failure', async (failure) => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    if (failure === 'network') mockFetch.mockRejectedValue(new Error('connection lost'));
    else mockFetch.mockResolvedValue({
      ok: false, status: 503, statusText: 'Unavailable', text: vi.fn().mockResolvedValue(''),
    });
    await expect(client.createSession({ prompt: 'Change one file' })).rejects.toThrow(JulesAPIError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not replay sendMessage or delete after an uncertain failure', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockRejectedValue(new Error('connection lost'));
    await expect(client.sendMessage('session-1', { prompt: 'Please revise' })).rejects.toThrow(JulesAPIError);
    await expect(client.deleteSession('session-1')).rejects.toThrow(JulesAPIError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('budgets retry backoff within the total session request deadline', async () => {
    vi.useFakeTimers();
    try {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockRejectedValue(new Error('Temporary connection error'));
      const pending = expect(client.getSession('1', 100)).rejects.toThrow('deadline exceeded');
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a session response body when the total deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const mockFetch = vi.mocked(global.fetch);
      mockFetch.mockImplementation((_url, options = {}) => Promise.resolve({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      } as Response));
      const pending = expect(client.getSession('1', 100)).rejects.toThrow('deadline exceeded');
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('JulesClient Methods', () => {
  let client: JulesClient;

  beforeEach(() => {
    vi.stubEnv('JULES_API_KEY', 'test-key');
    client = new JulesClient();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const mockSuccess = (data: unknown = {}) => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(data),
      text: vi.fn().mockResolvedValue(JSON.stringify(data))
    });
  };

  it('getSource', async () => {
    mockSuccess({ name: 'test' });
    await expect(client.getSource('sources/test')).resolves.toEqual({ name: 'test' });
  });

  it('rejects traversal and extra path syntax before sending credentials', async () => {
    await expect(client.getSource('sources/../sessions')).rejects.toThrow('Invalid source');
    await expect(client.getSession('../sources')).rejects.toThrow('Invalid session');
    await expect(client.deleteSession('..')).rejects.toThrow('Invalid session');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('createSession', async () => {
    mockSuccess({ id: '1' });
    await expect(client.createSession({ prompt: 'test' })).resolves.toEqual({ id: '1' });
  });

  it('listSessions', async () => {
    mockSuccess({ sessions: [] });
    await expect(client.listSessions(10, 'token')).resolves.toEqual({ sessions: [] });
  });

  it('getSession', async () => {
    mockSuccess({ id: '1' });
    await expect(client.getSession('1')).resolves.toEqual({ id: '1' });
  });

  it('approvePlan', async () => {
    mockSuccess({ id: '1', state: 'IN_PROGRESS' });
    await expect(client.approvePlan('1')).resolves.toEqual({ id: '1', state: 'IN_PROGRESS' });
  });

  it('accepts documented empty approval and sendMessage responses', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, text: vi.fn().mockResolvedValue(''),
    });
    await expect(client.approvePlan('1')).resolves.toEqual({});
    await expect(client.sendMessage('1', { prompt: 'hello' })).resolves.toEqual({});
  });

  it('sendMessage', async () => {
    mockSuccess({ id: '1' });
    await expect(client.sendMessage('1', { prompt: 'hello' })).resolves.toEqual({ id: '1' });
  });

  it('listActivities', async () => {
    mockSuccess({ activities: [] });
    await expect(client.listActivities('1', 10, 'token')).resolves.toEqual({ activities: [] });
  });

  it('listActivitiesSince', async () => {
    mockSuccess({ activities: [] });
    await expect(client.listActivitiesSince('1', '2025-01-01', 10)).resolves.toEqual({ activities: [] });
  });

  it('filters activity pages locally by createTime and preserves continuation', async () => {
    mockSuccess({ activities: [
      { id: 'old', createTime: '2026-01-01T00:00:00Z' },
      { id: 'equal', createTime: '2026-01-02T00:00:00Z' },
      { id: 'new', createTime: '2026-01-03T00:00:00Z' },
    ], nextPageToken: 'next' });
    const result = await client.listActivitiesSince('1', '2026-01-02T00:00:00Z', 10, 'cursor');
    expect(result.activities.map((activity) => activity.id)).toEqual(['new']);
    expect(result.nextPageToken).toBe('next');
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(new URL(url).searchParams.get('pageToken')).toBe('cursor');
    expect(new URL(url).searchParams.has('filter')).toBe(false);
  });

  it('deleteSession', async () => {
    mockSuccess();
    await expect(client.deleteSession('1')).resolves.toEqual({});
  });

  it('rejectPlan', async () => {
    mockSuccess();
    await expect(client.rejectPlan('1')).resolves.toEqual({});
  });
});

