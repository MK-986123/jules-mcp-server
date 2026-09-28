/**
 * Type definitions for Google Jules v1alpha REST API
 * Based on: https://jules.google/docs/api/reference/
 */

/**
 * Represents a source repository for Jules.
 */
export interface Source {
  /** Opaque Jules resource name matching sources/{source}. */
  name: string;
  /** GitHub repository details */
  githubRepo?: {
    /** The owner of the GitHub repository. */
    owner: string;
    /** The name of the GitHub repository. */
    repo: string;
    /** The HTML URL of the GitHub repository. */
    htmlUrl: string;
    /** The default branch of the GitHub repository. */
    defaultBranch?: {
      /** Display name of the branch. */
      displayName: string;
    };
    /** Available branches on the GitHub repository. */
    branches?: { displayName: string }[];
    /** Whether the GitHub repository is private. */
    isPrivate?: boolean;
  };
}

/**
 * Response object for listing sources.
 */
export interface ListSourcesResponse {
  /** A list of source repositories. */
  sources: Source[];
  /** A token for the next page of results. */
  nextPageToken?: string;
}

/**
 * Context for a GitHub repository.
 */
interface GitHubRepoContext {
  /** Branch to base changes on */
  startingBranch: string;
}

/**
 * Context for a source repository.
 */
export interface SourceContext {
  /** Resource name of the source */
  source: string;
  /** GitHub repository context details. */
  githubRepoContext?: GitHubRepoContext;
}

/**
 * Automation mode for a session.
 * - `AUTO_CREATE_PR`: Automatically create a pull request.
 * - `AUTOMATION_MODE_UNSPECIFIED`: Unspecified automation mode.
 */
export type AutomationMode =
  | 'AUTO_CREATE_PR'
  | 'AUTOMATION_MODE_UNSPECIFIED';

/**
 * State of a session.
 * - `SESSION_STATE_UNSPECIFIED`: Unspecified state.
 * - `QUEUED`: Session is queued.
 * - `PLANNING`: Session is planning the changes.
 * - `AWAITING_PLAN_APPROVAL`: Session is waiting for plan approval.
 * - `IN_PROGRESS`: Session is in progress.
 * - `COMPLETED`: Session has completed.
 * - `FAILED`: Session has failed.
 * - `CANCELED`: Session was canceled.
 */
export type KnownSessionState =
  | 'SESSION_STATE_UNSPECIFIED'
  | 'QUEUED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'AWAITING_USER_FEEDBACK'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED';

/** Session state returned by Jules, including future alpha values. */
export type SessionState = KnownSessionState | (string & {});

/**
 * Represents a Jules session.
 */
export interface Session {
  /** Resource name format: sessions/{id} */
  name: string;
  /** Unique session identifier */
  id: string;
  /** Optional human-readable title */
  title?: string;
  /** Optional monitor URL returned by the Jules API */
  url?: string;
  /** Source context for the session */
  sourceContext?: SourceContext;
  /** Natural language task prompt */
  prompt: string;
  /** Current session state */
  state?: SessionState;
  /** Automation configuration */
  automationMode?: AutomationMode;
  /** Whether plan approval is required */
  requirePlanApproval?: boolean;
  /** Timestamp when created */
  createTime?: string;
  /** Timestamp when last updated */
  updateTime?: string;
  /** Session outputs such as generated pull requests */
  outputs?: {
    /** Pull request created by the session, if available */
    pullRequest?: {
      /** Pull request URL */
      url: string;
      /** Optional pull request title */
      title?: string;
      /** Optional pull request description */
      description?: string;
    };
  }[];
}

/**
 * Request object for creating a new session.
 */
export interface CreateSessionRequest {
  /** Natural language task prompt */
  prompt: string;
  /** Source context for the session */
  sourceContext?: SourceContext;
  /** Optional human-readable title */
  title?: string;
  /** Automation configuration */
  automationMode?: AutomationMode;
  /** Whether plan approval is required */
  requirePlanApproval?: boolean;
}

/**
 * Response object for listing sessions.
 */
export interface ListSessionsResponse {
  /** A list of sessions. */
  sessions: Session[];
  /** A token for the next page of results. */
  nextPageToken?: string;
}

/**
 * Git patch attached to an activity artifact change set.
 */
export interface GitPatch {
  /** Commit against which the patch is based. */
  baseCommitId?: string;
  /** Unified diff for the change set. */
  unidiffPatch?: string;
  /** Suggested commit message for the change set. */
  suggestedCommitMessage?: string;
}

/** Jules change set carried by an activity artifact. */
export interface ChangeSet {
  /** Git patch details, when present. */
  gitPatch?: GitPatch;
}

/** Artifact attached to a Jules activity. */
export interface ActivityArtifact {
  /** Change set artifact. */
  changeSet?: ChangeSet;
  /** Optional media artifact. */
  media?: {
    url?: string;
    mimeType?: string;
    description?: string;
  };
  [key: string]: unknown;
}

/**
 * Represents an activity within a session.
 */
export interface Activity {
  /** Resource name format: sessions/{session_id}/activities/{activity_id} */
  name: string;
  /** Timestamp when activity occurred. */
  createTime?: string;
  /** Identity or system that originated the activity. */
  originator?: string | Record<string, unknown>;
  /** Human-readable activity description. */
  description?: string;
  /** Activity artifacts, including change sets. */
  artifacts?: ActivityArtifact[];
  /** Event-specific payloads. */
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
 * Response object for listing activities.
 */
export interface ListActivitiesResponse {
  /** A list of activities. */
  activities: Activity[];
  /** A token for the next page of results. */
  nextPageToken?: string;
}

/**
 * Request object for sending a message.
 */
export interface SendMessageRequest {
  /** The message content to send. */
  prompt: string;
}
