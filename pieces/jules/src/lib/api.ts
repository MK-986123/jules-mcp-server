/**
 * Lightweight HTTP client for Jules API calls within Activepieces Piece actions.
 * Mirrors the patterns from the MCP server's JulesClient but uses
 * the Activepieces runtime fetch (no external dependencies).
 */

import { httpClient, HttpMethod, type HttpRequest } from '@activepieces/pieces-common';
import type { JulesAuthValue } from './auth';

/**
 * Base URL for the Jules v1alpha API.
 */
const BASE_URL = 'https://jules.googleapis.com/v1alpha';

/**
 * Internal helper to make an authenticated request to the Jules API.
 * 
 * @template T - The expected JSON response type.
 * @param auth - Authentication value containing the API key.
 * @param endpoint - API endpoint path (including leading slash).
 * @param method - HTTP method for the request.
 * @param body - Optional JSON body for the request.
 * @returns {Promise<T>} A promise resolving to the parsed JSON response body.
 */
async function request<T>(
  auth: JulesAuthValue,
  endpoint: string,
  method: HttpMethod = HttpMethod.GET,
  body?: any
): Promise<T> {
  const requestConfig: HttpRequest = {
    method,
    url: `${BASE_URL}${endpoint}`,
    headers: {
      'X-Goog-Api-Key': auth.apiKey,
    },
    body,
  };

  const response = await httpClient.sendRequest<T>(requestConfig);
  return response.body;
}

/**
 * Sends a mutation whose success response may have no body.
 * @param auth - Authentication value containing the API key.
 * @param endpoint - API endpoint path.
 * @param body - Optional JSON body for the request.
 * @returns Promise resolving when Jules accepts the request.
 */
async function requestNoContent(
  auth: JulesAuthValue,
  endpoint: string,
  body?: unknown
): Promise<void> {
  const response = await httpClient.sendRequest<unknown>({
    method: HttpMethod.POST,
    url: `${BASE_URL}${endpoint}`,
    headers: { 'X-Goog-Api-Key': auth.apiKey },
    body,
  });
  void response;
}

/** GitHub repository metadata exposed by a Jules source. */
export interface GitHubRepo {
  owner: string;
  repo: string;
  htmlUrl?: string;
  defaultBranch?: { displayName: string };
  branches?: { displayName: string }[];
  isPrivate?: boolean;
}

/** Jules source returned by `sources.list`. */
export interface Source {
  /** Opaque Jules resource name; use the returned value without rewriting it. */
  name: string;
  githubRepo?: GitHubRepo;
}

/** Result of listing Jules sources. */
export interface ListSourcesResponse {
  sources: Source[];
  nextPageToken?: string;
}

/**
 * Configuration for a repository source.
 */
export interface SourceContext {
  /** Opaque Jules source resource name, returned by `sources.list`. */
  source: string;
  /** Optional GitHub-specific context */
  githubRepoContext?: { 
    /** The branch name to target */
    startingBranch: string 
  };
}

/**
 * Automation modes for a session.
 */
export type AutomationMode = 'AUTO_CREATE_PR' | 'AUTOMATION_MODE_UNSPECIFIED';

/**
 * Possible states for a Jules session.
 */
export type SessionState =
  | 'SESSION_STATE_UNSPECIFIED'
  | 'QUEUED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'AWAITING_USER_FEEDBACK'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | (string & {});

/**
 * Represents a Jules coding session.
 */
export interface Session {
  /** Resource name format: sessions/{id} */
  name: string;
  /** Unique session ID */
  id: string;
  /** Optional human-readable title */
  title?: string;
  /** Public monitor URL */
  url?: string;
  /** Source repository context */
  sourceContext?: SourceContext;
  /** The natural language prompt */
  prompt: string;
  /** Current state of the session */
  state?: SessionState;
  /** Automation configuration */
  automationMode?: AutomationMode;
  /** Whether plan approval is required before execution */
  requirePlanApproval?: boolean;
  /** ISO timestamp when created */
  createTime?: string;
  /** ISO timestamp when last updated */
  updateTime?: string;
  /** Outputs from the session (e.g., Pull Requests) */
  outputs?: Array<{
    /** Generated pull request metadata */
    pullRequest?: { 
      /** URL of the pull request */
      url: string; 
      /** Pull request title */
      title?: string; 
      /** Pull request description */
      description?: string 
    };
  }>;
}

/**
 * Represents an entry in the session activity log.
 */
export interface Activity {
  /** Resource name of the activity */
  name: string;
  createTime?: string;
  originator?: string | Record<string, unknown>;
  description?: string;
  artifacts?: {
    changeSet?: {
      gitPatch?: {
        baseCommitId?: string;
        unidiffPatch?: string;
        suggestedCommitMessage?: string;
      };
    };
    [key: string]: unknown;
  }[];
  planGenerated?: Record<string, unknown>;
  planApproved?: Record<string, unknown>;
  userMessaged?: Record<string, unknown>;
  agentMessaged?: Record<string, unknown>;
  progressUpdated?: Record<string, unknown>;
  sessionCompleted?: Record<string, unknown>;
  sessionFailed?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Creates a new Jules coding session.
 * 
 * @param auth - Authentication value.
 * @param body - Session creation parameters (prompt, source, etc).
 * @returns {Promise<Session>} The created session object.
 */
export async function createSession(
  auth: JulesAuthValue,
  body: {
    prompt: string;
    sourceContext?: SourceContext;
    title?: string;
    automationMode?: AutomationMode;
    requirePlanApproval?: boolean;
  }
): Promise<Session> {
  return request<Session>(auth, '/sessions', HttpMethod.POST, body);
}

/**
 * Lists a page of Jules-connected sources.
 * @param auth - Authentication value.
 * @param pageSize - Maximum number of sources in the page.
 * @param pageToken - Optional token for the next page.
 * @returns Sources and an optional continuation token.
 */
export async function listSources(
  auth: JulesAuthValue,
  pageSize = 100,
  pageToken?: string
): Promise<ListSourcesResponse> {
  const params = new URLSearchParams({ pageSize: String(pageSize) });
  if (pageToken) params.set('pageToken', pageToken);
  return request(auth, `/sources?${params.toString()}`);
}

/**
 * Retrieves a Jules source by its exact resource name.
 * @param auth - Authentication value.
 * @param sourceName - Opaque Jules source resource name.
 * @returns The source metadata.
 */
export async function getSource(
  auth: JulesAuthValue,
  sourceName: string
): Promise<Source> {
  return request(auth, `/${sourceName}`);
}

/**
 * Resolves a source name or legacy owner/repository identifier to Jules metadata.
 * @param auth - Authentication value.
 * @param sourceIdentifier - Exact Jules name or legacy `owner/repo` value.
 * @returns The matching source returned by Jules.
 * @throws Error when no matching connected source is found.
 */
export async function resolveSource(
  auth: JulesAuthValue,
  sourceIdentifier: string
): Promise<Source> {
  if (sourceIdentifier.startsWith('sources/')) {
    return getSource(auth, sourceIdentifier);
  }

  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const response = await listSources(auth, 100, pageToken);
    const match = response.sources.find((source) => {
      const githubRepo = source.githubRepo;
      return githubRepo && `${githubRepo.owner}/${githubRepo.repo}` === sourceIdentifier;
    });
    if (match) return match;
    pageToken = response.nextPageToken;
    if (!pageToken || seenTokens.has(pageToken)) break;
    seenTokens.add(pageToken);
  } while (pageToken);

  throw new Error(
    `No Jules source matches "${sourceIdentifier}". Use the exact source name returned by the list sources action.`
  );
}

/**
 * Retrieves the status and details of a specific session.
 * 
 * @param auth - Authentication value.
 * @param sessionId - Unique session identifier.
 * @returns {Promise<Session>} The session object.
 */
export async function getSession(
  auth: JulesAuthValue,
  sessionId: string
): Promise<Session> {
  return request<Session>(auth, `/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * Lists sessions with optional pagination.
 * 
 * @param auth - Authentication value.
 * @param pageSize - Number of sessions to return.
 * @param pageToken - Token for the next page of results.
 * @returns {Promise<{ sessions: Session[]; nextPageToken?: string }>} List of sessions and pagination token.
 */
export async function listSessions(
  auth: JulesAuthValue,
  pageSize = 20,
  pageToken?: string
): Promise<{ sessions: Session[]; nextPageToken?: string }> {
  const params = new URLSearchParams({ pageSize: String(pageSize) });
  if (pageToken) params.set('pageToken', pageToken);
  return request(auth, `/sessions?${params.toString()}`);
}

/**
 * Approves the generated plan for a session in AWAITING_PLAN_APPROVAL state.
 * 
 * @param auth - Authentication value.
 * @param sessionId - Unique session identifier.
 * @returns {Promise<Session>} The session state after approval.
 */
export async function approvePlan(
  auth: JulesAuthValue,
  sessionId: string
): Promise<Session> {
  await requestNoContent(
    auth,
    `/sessions/${encodeURIComponent(sessionId)}:approvePlan`,
    {}
  );
  return getSession(auth, sessionId);
}

/**
 * Sends a message/feedback to an active Jules session.
 * 
 * @param auth - Authentication value.
 * @param sessionId - Unique session identifier.
 * @param prompt - The message content.
 * @returns {Promise<Session>} The session state after sending.
 */
export async function sendMessage(
  auth: JulesAuthValue,
  sessionId: string,
  prompt: string
): Promise<Session> {
  await requestNoContent(
    auth,
    `/sessions/${encodeURIComponent(sessionId)}:sendMessage`,
    { prompt }
  );
  return getSession(auth, sessionId);
}

/**
 * Retrieves the activity log for a specific session.
 * 
 * @param auth - Authentication value.
 * @param sessionId - Unique session identifier.
 * @param pageSize - Maximum number of activities to return.
 * @returns {Promise<{ activities: Activity[]; nextPageToken?: string }>} List of activities.
 */
export async function listActivities(
  auth: JulesAuthValue,
  sessionId: string,
  pageSize = 50
): Promise<{ activities: Activity[]; nextPageToken?: string }> {
  const params = new URLSearchParams({ pageSize: String(pageSize) });
  return request(
    auth,
    `/sessions/${encodeURIComponent(sessionId)}/activities?${params.toString()}`
  );
}
