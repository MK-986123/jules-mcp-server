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
    public response?: unknown
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
   * Validates a session ID before using it in a URL path.
   * @param sessionId - Opaque session identifier returned by Jules.
   * @returns Encoded identifier safe to append as one path segment.
   */
  private sessionPathId(sessionId: string): string {
    if (!/^[\w-]+$/.test(sessionId)) throw new Error('Invalid session ID');
    return encodeURIComponent(sessionId);
  }

  /**
   * Generic HTTP request handler with authentication and error handling.
   * @param endpoint - The API endpoint to call (relative to the base URL).
   * @param options - The fetch options (method, headers, body, etc.).
   * @param timeoutMs - Optional total budget including retries and response parsing.
   * @returns A promise that resolves with the parsed JSON response.
   * @throws JulesAPIError if the API returns an error or a network error occurs.
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    timeoutMs?: number
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    // A lost response to a mutation does not prove that the mutation failed.
    // Jules exposes no idempotency key, so only replay read requests.
    const retries = (options.method ?? 'GET') === 'GET' ? this.maxRetries : 0;
    const headers = {
      'X-Goog-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= retries) {
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new JulesAPIError('Jules API request deadline exceeded');
      }
      if (attempt > 0) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        const remaining = deadline === undefined ? delay : Math.max(0, deadline - Date.now());
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new JulesAPIError('Jules API request deadline exceeded');
        }
      }

      const controller = new AbortController();
      const attemptTimeout = deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, Math.max(1, deadline - Date.now()));
      const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);
      try {
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          const rawErrorBody = await response.text();
          // SECURE: Truncate error body to prevent log flooding or PII leakage
          const errorBody =
            rawErrorBody.length > 500
              ? rawErrorBody.substring(0, 500) + '... [truncated]'
              : rawErrorBody;

          // Retry on transient 5xx
          if (response.status >= 500 && attempt < retries) {
            attempt++;
            lastError = new JulesAPIError(
              `Jules API error: ${response.statusText}`,
              response.status,
              errorBody
            );
            continue;
          }
          throw new JulesAPIError(
            `Jules API error: ${response.statusText}`,
            response.status,
            errorBody
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        clearTimeout(timeoutId);

        // Rethrow 4xx JulesAPIErrors immediately — do not retry client errors
        if (error instanceof JulesAPIError) {
          throw error;
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new JulesAPIError('Jules API request deadline exceeded');
        }

        const isAbort =
          error instanceof Error && error.name === 'AbortError';
        if ((isAbort || error instanceof Error) && attempt < retries) {
          attempt++;
          lastError = error;
          continue;
        }
        throw new JulesAPIError(
          `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Exhausted retries
    throw new JulesAPIError(
      `Network error after ${this.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : 'Unknown error'
      }`
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
    const retries = (options.method ?? 'GET') === 'GET' ? this.maxRetries : 0;
    const headers = {
      'X-Goog-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= retries) {
      if (attempt > 0) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, { ...options, headers, signal: controller.signal });
        if (!response.ok) {
          const rawErrorBody = await response.text();
          // SECURE: Truncate error body to prevent log flooding or PII leakage
          const errorBody =
            rawErrorBody.length > 500
              ? rawErrorBody.substring(0, 500) + '... [truncated]'
              : rawErrorBody;

          // Retry on transient 5xx
          if (response.status >= 500 && attempt < retries) {
            attempt++;
            lastError = new JulesAPIError(
              `Jules API error: ${response.statusText}`,
              response.status,
              errorBody
            );
            continue;
          }
          throw new JulesAPIError(
            `Jules API error: ${response.statusText}`,
            response.status,
            errorBody
          );
        }
        // Body may be empty (204 No Content) — return {} rather than trying to parse JSON
        const text = await response.text();
        return text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (error) {
        clearTimeout(timeoutId);

        // Rethrow 4xx JulesAPIErrors immediately — do not retry client errors
        if (error instanceof JulesAPIError) {
          throw error;
        }

        const isAbort = error instanceof Error && error.name === 'AbortError';
        if ((isAbort || error instanceof Error) && attempt < retries) {
          attempt++;
          lastError = error;
          continue;
        }
        throw new JulesAPIError(
          `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Exhausted retries
    throw new JulesAPIError(
      `Network error after ${this.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : 'Unknown error'
      }`
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
    const segments = sourceName.split('/');
    if (segments[0] !== 'sources' || segments.length < 2 ||
      segments.some((segment) => !/^[\w.-]+$/.test(segment) || segment === '.' || segment === '..')) {
      throw new Error('Invalid source resource name');
    }
    return this.request<Source>(`/${sourceName.split('/').map(encodeURIComponent).join('/')}`);
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
   * @param timeoutMs - Optional total request budget, including retries and response parsing.
   * @returns A promise that resolves with the session details.
   */
  async getSession(sessionId: string, timeoutMs?: number): Promise<Session> {
    return this.request<Session>(`/sessions/${this.sessionPathId(sessionId)}`, {}, timeoutMs);
  }

  /**
   * Approve the plan for a session in AWAITING_PLAN_APPROVAL state.
   * POST /v1alpha/sessions/{id}:approvePlan
   * @param sessionId - The ID of the session to approve the plan for.
   * @returns An empty success response; fetch the session separately for its state.
   */
  async approvePlan(sessionId: string): Promise<Partial<Session>> {
    return this.requestEmpty(`/sessions/${this.sessionPathId(sessionId)}:approvePlan`, {
      method: 'POST',
      body: '{}',
    });
  }

  /**
   * Send feedback message to an active session.
   * POST /v1alpha/sessions/{id}:sendMessage
   * @param sessionId - The ID of the session to send the message to.
   * @param request - The request body containing the message prompt.
   * @returns An empty success response; fetch the session separately for its state.
   */
  async sendMessage(
    sessionId: string,
    request: SendMessageRequest
  ): Promise<Partial<Session>> {
    return this.requestEmpty(`/sessions/${this.sessionPathId(sessionId)}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
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
      `/sessions/${this.sessionPathId(sessionId)}/activities${this.buildQuery({
        pageSize,
        pageToken,
      })}`
    );
  }

  /**
   * List activities for a session created after a given timestamp.
   * Filters one API page locally because the API does not document a time filter.
   * @param sessionId - The ID of the session to list activities for.
   * @param since - ISO timestamp boundary.
   * @param pageSize - The maximum number of activities to return.
   * @param pageToken - Cursor for the next API page, if any.
   * @returns A promise that resolves with the filtered activities.
   */
  async listActivitiesSince(
    sessionId: string,
    since: string,
    pageSize = 50,
    pageToken?: string
  ): Promise<ListActivitiesResponse> {
    const boundary = Date.parse(since);
    if (!Number.isFinite(boundary)) {
      throw new Error('since must be a valid timestamp');
    }
    const response = await this.listActivities(sessionId, pageSize, pageToken);
    return {
      ...response,
      activities: (response.activities ?? []).filter((activity) => {
        const timestamp = activity.createTime ?? activity.timestamp;
        // Keep activities without a parseable date rather than silently losing evidence.
        const created = timestamp ? Date.parse(timestamp) : NaN;
        return !Number.isFinite(created) || created > boundary;
      }),
    };
  }

  /**
   * Delete or cancel a session.
   * DELETE /v1alpha/sessions/{id}
   * @param sessionId - The ID of the session to delete.
   * @returns A promise that resolves with the empty response.
   */
  async deleteSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.requestEmpty(`/sessions/${this.sessionPathId(sessionId)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Reject the currently proposed plan for a session.
   * DELETE /v1alpha/sessions/{id}
   * @param sessionId - The ID of the session whose plan should be rejected.
   * @returns A promise that resolves with the empty response.
   */
  async rejectPlan(sessionId: string): Promise<Record<string, unknown>> {
    return this.requestEmpty(`/sessions/${this.sessionPathId(sessionId)}`, {
      method: 'DELETE',
    });
  }
}
