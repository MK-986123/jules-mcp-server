/**
 * Type definitions for Google Jules v1alpha REST API
 * Based on: https://jules.google/docs/api/reference/
 */

/**
 * Represents a source repository for Jules.
 */
export interface Source {
  /** Opaque resource name returned by the API; do not construct it from a URL. */
  name: string;
  /** Unique source identifier. */
  id?: string;
  /** GitHub repository details */
  githubRepo?: {
    /** The owner of the GitHub repository. */
    owner: string;
    /** The name of the GitHub repository. */
    repo: string;
    /** The HTML URL of the GitHub repository. */
    htmlUrl?: string;
    /** The default branch of the GitHub repository. */
    defaultBranch: string | { displayName: string };
    /** Available repository branches. */
    branches?: { displayName: string }[];
    /** Whether the repository is private. */
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
  | 'CANCELED';

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
 * Type of activity in a session.
 * - `PLAN_GENERATED`: A plan was generated.
 * - `PROGRESS_UPDATED`: Progress was updated.
 * - `SESSION_COMPLETED`: Session was completed.
 * - `MESSAGE_SENT`: A message was sent.
 * - `ACTIVITY_TYPE_UNSPECIFIED`: Unspecified activity type.
 */
export type ActivityType =
  | 'PLAN_GENERATED'
  | 'PROGRESS_UPDATED'
  | 'SESSION_COMPLETED'
  | 'MESSAGE_SENT'
  | 'AGENT_MESSAGED'
  | 'PLAN_APPROVED'
  | 'ACTIVITY_TYPE_UNSPECIFIED';

/**
 * Represents a set of changes in a plan.
 */
export interface ChangeSet {
  /** Source resource associated with a patch returned by the Jules API. */
  source?: string;
  /** Git patch artifact returned by the Jules API. */
  gitPatch?: {
    /** Commit on which the patch is based. */
    baseCommitId?: string;
    /** Unified diff for the proposed changes. */
    unidiffPatch?: string;
    /** Commit message suggested by Jules. */
    suggestedCommitMessage?: string;
  };
  /** Unified patch for the full change set */
  patch?: string;
  /** Array of file changes */
  changes?: {
    /** The path of the file changed. */
    path: string;
    /** The diff of the changes. */
    diff?: string;
    /** The old content of the file. */
    oldContent?: string;
    /** The new content of the file. */
    newContent?: string;
  }[];
}

/**
 * Represents an activity within a session.
 */
export interface Activity {
  /** Resource name format: sessions/{session_id}/activities/{activity_id} */
  name: string;
  /** Unique activity ID returned by the API. */
  id?: string;
  /** Actor that generated the activity. */
  originator?: string;
  /** Human-readable activity description. */
  description?: string;
  /** Timestamp returned by the current API. */
  createTime?: string;
  /** Legacy activity type retained for older fixtures and consumers. */
  type?: ActivityType;
  /** Legacy timestamp retained for older fixtures and consumers. */
  timestamp?: string;
  /** Artifacts produced by an activity, including reviewable patches and test output. */
  artifacts?: {
    /** Proposed repository changes. */
    changeSet?: ChangeSet;
    /** Command execution evidence. */
    bashOutput?: { command?: string; output?: string; exitCode?: number };
    /** Inline media data returned by Jules. */
    media?: { mimeType?: string; data?: string };
  }[];
  /** Activity-specific payload */
  planGenerated?: {
    /** The generated plan description. */
    plan: string | {
      /** Identifier of the generated plan. */
      id?: string;
      /** Ordered implementation steps. */
      steps?: { id?: string; index?: number; title?: string; description?: string }[];
      /** Timestamp when the plan was created. */
      createTime?: string;
    };
    /** The set of changes proposed in the plan. */
    changeSet?: ChangeSet;
  };
  progressUpdated?: {
    /** The progress message. */
    message?: string;
    /** Summary of current progress. */
    title?: string;
    /** Details of current progress. */
    description?: string;
    /** The completion percentage. */
    percentage?: number;
  };
  sessionCompleted?: {
    /** Whether the session completed successfully. */
    success?: boolean;
    /** A message describing the completion. */
    message?: string;
    /** The URL of the created pull request, if any. */
    pullRequestUrl?: string;
    /** The final set of changes for the session, if available. */
    changeSet?: ChangeSet;
  };
  messageSent?: {
    /** The message content. */
    prompt: string;
    /** The sender of the message. */
    sender: 'USER' | 'AGENT';
  };
  planApproved?: {
    /** When the plan was approved. */
    approvedAt?: string;
    /** Identifier of the approved plan. */
    planId?: string;
  };
  agentMessaged?: {
    /** Agent-authored message requiring user attention. */
    message?: string;
    /** Agent message returned by the current API. */
    agentMessage?: string;
  };
  /** User feedback recorded by the current API. */
  userMessaged?: { userMessage: string };
  /** Failure details returned by the current API. */
  sessionFailed?: { reason?: string };
  media?: {
    /** Optional media URL. */
    url?: string;
    /** Media MIME type. */
    mimeType?: string;
    /** Optional human-readable description. */
    description?: string;
  };
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
