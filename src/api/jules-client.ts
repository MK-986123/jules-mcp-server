/**
 * Jules API Client - Abstraction layer for Google Jules REST API
 * Handles authentication, rate limiting, and type-safe API calls
 */

import type {
  Source,
  ListSourcesResponse,
  Session,
  CreateSessionRequest,
  ListSessionsResponse,
  ListActivitiesResponse,
  SendMessageRequest,
} from '../types/jules-api.js';

/**
 * Custom error class for Jules API interactions.
 */
export class JulesAPIError extends Error {
  /**
   * Creates an instance of JulesAPIError.
   * @param message - The error message.
   * @param statusCode - The HTTP status code returned by the API (optional).
   * @param response - The response body returned by the API (optional).
   */
  constructor(
    message: string,
    public statusCode?: number,
    public response?: unknown,
    public operation?: string,
    public retryable = false
  ) {
    super(message);
    this.name = 'JulesAPIError';
  }
}

/**
 * Client for interacting with the Google Jules REST API.
 */
export class JulesClient {
  private readonly baseURL = 'https://jules.googleapis.com/v1alpha';
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  /**
   * Creates an instance of JulesClient.
   * @param apiKey - The API key for authentication. If not provided, it falls back to the JULES_API_KEY environment variable.
   * @throws Error if no API key is provided or found in environment variables.
   */
  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.JULES_API_KEY || '';
    if (!this.apiKey) {
      throw new Error(
        'JULES_API_KEY environment variable is required. ' +
          'Generate a key at https://jules.google/settings'
      );
    }
    this.timeoutMs = Number(process.env.JULES_API_TIMEOUT_MS || 15000);
    this.maxRetries = Number(process.env.JULES_API_MAX_RETRIES || 2);
  }

  /**
   * Builds a URL query string while omitting undefined values.
   * @param params - Query parameters to encode.
   * @returns Encoded query string, including the leading `?` when needed.
   */
  private buildQuery(params: Record<string, string | number | undefined>): string {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.set(key, String(value));
      }
    }

    const query = searchParams.toString();
    return query ? `?${query}` : '';
  }

  /**
   * Calculates a bounded retry delay, honoring a valid Retry-After header.
   * @param attempt - Zero-based retry attempt.
   * @param retryAfter - Optional Retry-After response header.
   * @returns Delay in milliseconds, capped at 30 seconds.
   */
  private retryDelay(attempt: number, retryAfter?: string | null): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const retryAt = Date.parse(retryAfter);
      const requested = Number.isFinite(seconds)
        ? seconds * 1000
        : Number.isFinite(retryAt)
          ? Math.max(0, retryAt - Date.now())
          : NaN;
      if (Number.isFinite(requested)) return Math.min(requested, 30000);
    }
    return Math.min(Math.pow(2, attempt) * 1000, 30000);
  }

  /**
   * Extracts and sanitizes a bounded API error message.
   * @param body - Raw response text.
   * @returns A redacted error detail suitable for agent output.
   */
  private sanitizeErrorBody(body: string): string {
    let detail = body;
    try {
      const parsed = JSON.parse(body) as {
        message?: unknown;
        error?: { message?: unknown } | string;
      };
      if (typeof parsed.message === 'string') {
        detail = parsed.message;
      } else if (typeof parsed.error === 'string') {
        detail = parsed.error;
      } else if (
        parsed.error &&
        typeof parsed.error === 'object' &&
        typeof parsed.error.message === 'string'
      ) {
        detail = parsed.error.message;
      }
    } catch {
      // Plain-text Jules errors are still useful after redaction and truncation.
    }

    const sanitized = detail
      .replaceAll(this.apiKey, '[REDACTED]')
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
    return sanitized.length > 500
      ? `${sanitized.slice(0, 500)}... [truncated]`
      : sanitized;
  }

  /**
   * Generic HTTP request handler with authentication and error handling.
   * @param endpoint - The API endpoint to call (relative to the base URL).
   * @param options - The fetch options (method, headers, body, etc.).
   * @returns A promise that resolves with the parsed JSON response.
   * @throws JulesAPIError if the API returns an error or a network error occurs.
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    const headers = {
      'X-Goog-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let attempt = 0;
    let lastError: unknown;
    let nextDelayMs: number | undefined;
    const method = (options.method || 'GET').toUpperCase();
    const mayRetryNetwork = ['GET', 'HEAD', 'OPTIONS'].includes(method);

    while (attempt <= this.maxRetries) {
      if (attempt > 0) {
        const delay = nextDelayMs ?? this.retryDelay(attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = this.sanitizeErrorBody(await response.text());

          // Retry safe requests on transient errors and any request rejected with 429.
          if (
            (response.status === 429 ||
              (response.status >= 500 && mayRetryNetwork)) &&
            attempt < this.maxRetries
          ) {
            nextDelayMs = this.retryDelay(
              attempt,
              response.headers?.get?.('Retry-After')
            );
            attempt++;
            lastError = new JulesAPIError(
              `Jules API ${method} request failed with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`,
              response.status,
              errorBody,
              `${method} ${endpoint}`,
              true
            );
            continue;
          }
          throw new JulesAPIError(
            `Jules API ${method} request failed with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`,
            response.status,
            errorBody,
            `${method} ${endpoint}`,
            response.status === 429 || response.status >= 500
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        clearTimeout(timeoutId);

        // Rethrow 4xx JulesAPIErrors immediately — do not retry client errors
        if (error instanceof JulesAPIError) {
          throw error;
        }

        const isAbort =
          error instanceof Error && error.name === 'AbortError';
        if (
          mayRetryNetwork &&
          (isAbort || error instanceof Error) &&
          attempt < this.maxRetries
        ) {
          attempt++;
          lastError = error;
          continue;
        }
        throw new JulesAPIError(
          `Network error: ${(error instanceof Error ? error.message : 'Unknown error').replaceAll(this.apiKey, '[REDACTED]')}`,
          undefined,
          undefined,
          `${method} ${endpoint}`,
          mayRetryNetwork
        );
      }
    }

    // Exhausted retries
    throw new JulesAPIError(
      `Network error after ${this.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : 'Unknown error'
      }`.replaceAll(this.apiKey, '[REDACTED]'),
      undefined,
      undefined,
      `${method} ${endpoint}`,
      true
    );
  }

  /**
   * Generic HTTP request handler for endpoints that return an empty body (e.g. 204 No Content).
   * @param endpoint - The API endpoint.
   * @param options - Fetch options (method, headers, body, etc.).
   * @returns A promise resolving to an empty object.
   */
  private async requestEmpty(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseURL}${endpoint}`;
    const headers = {
      'X-Goog-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let attempt = 0;
    let lastError: unknown;
    let nextDelayMs: number | undefined;
    const method = (options.method || 'GET').toUpperCase();
    const mayRetryNetwork = ['GET', 'HEAD', 'OPTIONS'].includes(method);

    while (attempt <= this.maxRetries) {
      if (attempt > 0) {
        const delay = nextDelayMs ?? this.retryDelay(attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, { ...options, headers, signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) {
          const errorBody = this.sanitizeErrorBody(await response.text());

          // A confirmed 429 may be retried; ambiguous writes are never replayed.
          if (
            (response.status === 429 ||
              (response.status >= 500 && mayRetryNetwork)) &&
            attempt < this.maxRetries
          ) {
            nextDelayMs = this.retryDelay(
              attempt,
              response.headers?.get?.('Retry-After')
            );
            attempt++;
            lastError = new JulesAPIError(
              `Jules API ${method} request failed with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`,
              response.status,
              errorBody,
              `${method} ${endpoint}`,
              true
            );
            continue;
          }
          throw new JulesAPIError(
            `Jules API ${method} request failed with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`,
            response.status,
            errorBody,
            `${method} ${endpoint}`,
            response.status === 429 || response.status >= 500
          );
        }
        // Successful mutation endpoints may return no content; callers must not
        // infer failure from an empty or non-JSON response body.
        return {};
      } catch (error) {
        clearTimeout(timeoutId);

        // Rethrow 4xx JulesAPIErrors immediately — do not retry client errors
        if (error instanceof JulesAPIError) {
          throw error;
        }

        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (
          mayRetryNetwork &&
          (isAbort || error instanceof Error) &&
          attempt < this.maxRetries
        ) {
          attempt++;
          lastError = error;
          continue;
        }
        throw new JulesAPIError(
          `Network error: ${(error instanceof Error ? error.message : 'Unknown error').replaceAll(this.apiKey, '[REDACTED]')}`,
          undefined,
          undefined,
          `${method} ${endpoint}`,
          mayRetryNetwork
        );
      }
    }

    // Exhausted retries
    throw new JulesAPIError(
      `Network error after ${this.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : 'Unknown error'
      }`.replaceAll(this.apiKey, '[REDACTED]'),
      undefined,
      undefined,
      `${method} ${endpoint}`,
      true
    );
  }

  /**
   * List all connected GitHub repositories.
   * GET /v1alpha/sources
   * @param pageSize - The maximum number of sources to return (default: 100).
   * @returns A promise that resolves with the list of sources.
   */
  async listSources(
    pageSize = 100,
    pageToken?: string
  ): Promise<ListSourcesResponse> {
    return this.request<ListSourcesResponse>(
      `/sources${this.buildQuery({ pageSize, pageToken })}`
    );
  }

  /**
   * Get details for a specific source.
   * GET /v1alpha/sources/{name}
   * @param sourceName - The resource name of the source to retrieve.
   * @returns A promise that resolves with the source details.
   */
  async getSource(sourceName: string): Promise<Source> {
    return this.request<Source>(`/${sourceName}`);
  }

  /**
   * Create a new coding session.
   * POST /v1alpha/sessions
   * @param request - The request body for creating a session.
   * @returns A promise that resolves with the created session.
   */
  async createSession(request: CreateSessionRequest): Promise<Session> {
    return this.request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * List all sessions with pagination.
   * GET /v1alpha/sessions
   * @param pageSize - The maximum number of sessions to return (default: 20).
   * @returns A promise that resolves with the list of sessions.
   */
  async listSessions(
    pageSize = 20,
    pageToken?: string
  ): Promise<ListSessionsResponse> {
    return this.request<ListSessionsResponse>(
      `/sessions${this.buildQuery({ pageSize, pageToken })}`
    );
  }

  /**
   * Get details for a specific session.
   * GET /v1alpha/sessions/{id}
   * @param sessionId - The ID of the session to retrieve.
   * @returns A promise that resolves with the session details.
   */
  async getSession(sessionId: string): Promise<Session> {
    return this.request<Session>(`/sessions/${sessionId}`);
  }

  /**
   * Approve the plan for a session in AWAITING_PLAN_APPROVAL state.
   * POST /v1alpha/sessions/{id}:approvePlan
   * @param sessionId - The ID of the session to approve the plan for.
   * @returns A promise that resolves with the session state after approval.
   */
  async approvePlan(sessionId: string): Promise<Session> {
    await this.requestEmpty(`/sessions/${encodeURIComponent(sessionId)}:approvePlan`, {
      method: 'POST',
      body: '{}',
    });
    return this.getSession(sessionId);
  }

  /**
   * Send feedback message to an active session.
   * POST /v1alpha/sessions/{id}:sendMessage
   * @param sessionId - The ID of the session to send the message to.
   * @param request - The request body containing the message prompt.
   * @returns A promise that resolves with the session state after sending.
   */
  async sendMessage(
    sessionId: string,
    request: SendMessageRequest
  ): Promise<Session> {
    await this.requestEmpty(`/sessions/${encodeURIComponent(sessionId)}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return this.getSession(sessionId);
  }

  /**
   * List activities for a session (the event stream/log).
   * GET /v1alpha/sessions/{id}/activities
   * @param sessionId - The ID of the session to list activities for.
   * @param pageSize - The maximum number of activities to return (default: 50).
   * @returns A promise that resolves with the list of activities.
   */
  async listActivities(
    sessionId: string,
    pageSize = 50,
    pageToken?: string
  ): Promise<ListActivitiesResponse> {
    return this.request<ListActivitiesResponse>(
      `/sessions/${sessionId}/activities${this.buildQuery({
        pageSize,
        pageToken,
      })}`
    );
  }

  /**
   * List activities for a session created after a given timestamp.
   * GET /v1alpha/sessions/{id}/activities?createTime={since}
   * @param sessionId - The ID of the session to list activities for.
   * @param since - ISO timestamp boundary.
   * @param pageSize - The maximum number of activities to return.
   * @returns A promise that resolves with the filtered activities.
   */
  async listActivitiesSince(
    sessionId: string,
    since: string,
    pageSize = 50
  ): Promise<ListActivitiesResponse> {
    return this.request<ListActivitiesResponse>(
      `/sessions/${sessionId}/activities${this.buildQuery({
        pageSize,
        createTime: since,
      })}`
    );
  }

  /**
   * Delete or cancel a session.
   * DELETE /v1alpha/sessions/{id}
   * @param sessionId - The ID of the session to delete.
   * @returns A promise that resolves with the empty response.
   */
  async deleteSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.requestEmpty(`/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  }

}
