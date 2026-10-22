/**
 * MCP Tools - Executable functions for LLM interaction with Jules
 * Tools allow the LLM to trigger actions (create tasks, approve plans, schedule)
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { JulesAPIError, type JulesClient } from '../api/jules-client.js';
import type { ScheduleStorage } from '../storage/schedule-store.js';
import { JulesResources } from './resources.js';
import { CronEngine } from '../scheduler/cron-engine.js';
import type { ScheduledTask } from '../types/schedule.js';
import type { Session, SessionState } from '../types/jules-api.js';
import { RepositoryValidator, smartTruncate, containsSecret, RateLimitError, SecurityError, RateLimiter } from '../utils/security.js';

// Input validation schemas
const SourceNameSchema = z.string().max(512)
  .regex(/^sources\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'Use the exact source name returned by list_sources')
  .refine((name) => !name.split('/').some((part) => part === '.' || part === '..'), 'Invalid source path');
export const CreateTaskSchema = z.object({
  prompt: z
    .string()
    .min(10, 'Prompt must be at least 10 characters')
    .max(10000, 'Prompt must not exceed 10,000 characters')
    .refine((val) => val.trim().length > 0, 'Prompt cannot be empty or whitespace only')
    .refine((val) => !containsSecret(val), 'Prompt contains potential secrets (e.g., API keys). Please remove them.')
    .describe(
      'Natural language instruction for the coding task. Be specific about files, goals, and constraints.'
    ),
  source: SourceNameSchema
    .describe(
      'Exact source resource name returned by list_sources.'
    ),
  branch: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/, 'Branch name contains invalid characters')
    .max(255, 'Branch name too long')
    .default('main')
    .describe('Git branch to base changes on'),
  auto_create_pr: z
    .boolean()
    .default(true)
    .describe('If true, automatically creates a Pull Request upon completion'),
  require_plan_approval: z
    .boolean()
    .default(true)
    .describe(
      'If true, pauses at AWAITING_PLAN_APPROVAL state for manual review'
    ),
  title: z
    .string()
    .max(200, 'Title must not exceed 200 characters')
    .optional()
    .describe('Optional human-readable session title'),
});

export const ManageSessionSchema = z.object({
  session_id: z
    .string()
    .regex(/^[\w-]+$/, 'Session ID contains invalid characters')
    .describe('The ID of the session to manage'),
  action: z
    .enum(['approve_plan', 'send_message', 'reject_plan'])
    .describe('Action to perform on the session'),
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(5000, 'Message must not exceed 5,000 characters')
    .refine((val) => !containsSecret(val), 'Message contains potential secrets. Please remove them.')
    .optional()
    .describe('Message content (required for send_message action)'),
});

export const CreateRepolessTaskSchema = z.object({
  prompt: z
    .string()
    .min(10, 'Prompt must be at least 10 characters')
    .max(10000, 'Prompt must not exceed 10,000 characters')
    .refine((val) => val.trim().length > 0, 'Prompt cannot be empty or whitespace only')
    .refine((val) => !containsSecret(val), 'Prompt contains potential secrets (e.g., API keys). Please remove them.')
    .describe('Natural language instruction for a repoless Jules task.'),
  title: z
    .string()
    .max(200, 'Title must not exceed 200 characters')
    .optional()
    .describe('Optional human-readable session title'),
});

const waitTargetStateSchema = z.enum([
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER_FEEDBACK',
]);

export const WaitForSessionSchema = z.object({
  session_id: z
    .string()
    .regex(/^[\w-]+$/, 'Session ID contains invalid characters')
    .describe('The ID of the session to wait for'),
  timeout_seconds: z
    .number()
    .int()
    .min(5, 'timeout_seconds must be at least 5')
    .max(50, 'timeout_seconds must not exceed 50')
    .default(25)
    .describe('Maximum time to wait before timing out'),
  poll_interval_seconds: z
    .number()
    .min(5, 'poll_interval_seconds must be at least 5')
    .max(60, 'poll_interval_seconds must not exceed 60')
    .default(10)
    .describe('Polling interval while waiting for the target state'),
  target_states: z
    .array(waitTargetStateSchema)
    .default(['COMPLETED', 'FAILED', 'CANCELED', 'AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK'])
    .describe('States that should stop the polling loop'),
});

export const PaginationSchema = z.object({
  page_size: z.number().int().min(1).max(100).default(20),
  page_token: z.string().max(4096).optional(),
});

export const SessionReviewSchema = z.object({
  session_id: z.string().regex(/^[\w-]+$/),
  page_token: z.string().max(4096).optional(),
});

export const GetActivitiesSinceSchema = z.object({
  page_token: z.string().max(4096).optional(),
  session_id: z
    .string()
    .regex(/^[\w-]+$/, 'Session ID contains invalid characters')
    .describe('The ID of the session to inspect'),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, 'since must be a valid UTC ISO 8601 timestamp')
    .describe('ISO 8601 timestamp used as the lower bound'),
  page_size: z
    .number()
    .min(1, 'page_size must be at least 1')
    .max(200, 'page_size must not exceed 200')
    .default(50)
    .optional()
    .describe('Maximum number of activities to return'),
});

export const GetSessionStatusSchema = z.object({
  session_id: z.string().regex(/^[\w-]+$/, 'Session ID contains invalid characters').describe('The ID of the session to check'),
});

export const ScheduleTaskSchema = z.object({
  task_name: z
    .string()
    .min(1, 'Task name cannot be empty')
    .max(100, 'Task name must not exceed 100 characters')
    .regex(/^[\w\s-]+$/, 'Task name can only contain letters, numbers, spaces, hyphens, and underscores')
    .describe('Unique name for this schedule (e.g., "Weekly Dependency Update")'),
  cron_expression: z
    .string()
    .regex(/^[\d\s*,/-]+$/, 'Cron expression contains invalid characters')
    .describe(
      'Standard cron expression (e.g., "0 9 * * 1" for Mondays at 9 AM). Format: minute hour day month weekday'
    ),
  prompt: z
    .string()
    .min(10, 'Prompt must be at least 10 characters')
    .max(10000, 'Prompt must not exceed 10,000 characters')
    .refine((val) => !containsSecret(val), 'Prompt contains potential secrets (e.g., API keys). Please remove them.')
    .describe('The coding task instruction to execute'),
  source: SourceNameSchema
    .describe('Exact source resource name returned by list_sources'),
  branch: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/, 'Branch name contains invalid characters')
    .max(255, 'Branch name too long')
    .default('main')
    .describe('Git branch to target'),
  auto_create_pr: z
    .boolean()
    .default(true)
    .describe('Whether to auto-create PRs'),
  require_plan_approval: z
    .boolean()
    .default(true)
    .describe('Whether to require manual plan approval'),
  timezone: z
    .string()
    .optional()
    .describe('Timezone for cron execution (e.g., "America/New_York")'),
});

export const DeleteScheduleSchema = z.object({
  task_name: z.string().describe('Name of the scheduled task to delete'),
});

export const DeleteSessionSchema = z.object({
  session_id: z.string().regex(/^[\w-]+$/).describe('The ID of the session to delete'),
});

export const GetSourceDetailsSchema = z.object({
  source_name: SourceNameSchema
    .describe('Exact source resource name returned by list_sources'),
});

/**
 * Manages the available tools for the Jules MCP server.
 */
export class JulesTools {
  private readonly rateLimiter: RateLimiter;

  /**
   * Creates an instance of JulesTools.
   *
   * @param client - The Jules API client used to execute tool operations.
   * @param storage - The storage engine for persisting scheduled tasks.
   * @param scheduler - The cron engine managing recurring execution.
   */
  constructor(
    private readonly client: JulesClient,
    private readonly storage: ScheduleStorage,
    private readonly scheduler: CronEngine
  ) {
    // Rate limiting applies only to task creation (write operations). Read/poll operations are intentionally exempt.
    this.rateLimiter = new RateLimiter(10, 60000);
  }

  /**
   * Resolves a source identity before enforcing the repository allowlist.
   * @param sourceName - Exact resource name returned by the Jules API.
   * @returns Validated source metadata.
   */
  private async validateSource(sourceName: string) {
    const source = await this.client.getSource(sourceName);
    if (!source.githubRepo) throw new SecurityError('Source has no GitHub repository identity.');
    RepositoryValidator.validateRepository(`sources/github/${source.githubRepo.owner}/${source.githubRepo.repo}`);
    return source;
  }

  /**
   * Validates repository access before steering an existing session.
   * @param sessionId - Session to inspect before any mutation.
   * @returns The inspected session.
   */
  private async validateSession(sessionId: string): Promise<Session> {
    const session = await this.client.getSession(sessionId);
    if (session.sourceContext?.source) await this.validateSource(session.sourceContext.source);
    return session;
  }

  /**
   * Lists one page of connected source repositories for tool-only clients.
   * @param args - Page size and continuation token.
   * @returns Source payload with its original continuation token.
   */
  async listSources(args: z.infer<typeof PaginationSchema>): Promise<string> {
    return this.executeWithErrorHandling(() => this.client.listSources(args.page_size, args.page_token));
  }

  /**
   * Lists one page of existing Jules sessions without starting work.
   * @param args - Page size and continuation token.
   * @returns Session payload with its original continuation token.
   */
  async listSessions(args: z.infer<typeof PaginationSchema>): Promise<string> {
    return this.executeWithErrorHandling(() => this.client.listSessions(args.page_size, args.page_token));
  }

  /**
   * Reads the session and one page of plan, question and progress evidence.
   * @param args - Session ID and activity continuation token.
   * @returns Review payload, including the next activity cursor when present.
   */
  async getSessionReview(args: z.infer<typeof SessionReviewSchema>): Promise<string> {
    return this.executeWithErrorHandling(async () => JSON.parse(await new JulesResources(this.client, this.storage, this.scheduler).getSessionFull(args.session_id, args.page_token)) as unknown);
  }

  /**
   * Reads patch artifacts for review through a tool-only client.
   * @param args - Session ID and activity continuation token.
   * @returns Patch evidence and continuation information.
   */
  async getSessionDiff(args: z.infer<typeof SessionReviewSchema>): Promise<string> {
    return this.executeWithErrorHandling(async () => JSON.parse(await new JulesResources(this.client, this.storage, this.scheduler).getSessionDiff(args.session_id, args.page_token)) as unknown);
  }

  /**
   * Returns the preferred session monitor URL.
   * @param session - Session payload returned by the Jules API.
   * @returns Public monitor URL for the session.
   */
  private getMonitorUrl(session: Session): string {
    return session.url || `https://jules.google.com/sessions/${session.id}`;
  }

  /**
   * Returns the first pull request URL exposed in session outputs.
   * @param session - Session payload returned by the Jules API.
   * @returns Pull request URL when available.
   */
  private getPullRequestUrl(session: Session): string | undefined {
    return session.outputs?.find((output) => output.pullRequest?.url)?.pullRequest?.url;
  }

  /**
   * Returns the repository identifier for a session or a repoless fallback.
   * @param session - Session payload returned by the Jules API.
   * @returns Repository resource name or a repoless label.
   */
  private getRepositoryLabel(session: Session): string {
    return session.sourceContext?.source || 'repoless';
  }

  /**
   * Sleeps for the requested duration.
   * @param milliseconds - Delay duration in milliseconds.
   * @returns Promise resolving after the delay.
   */
  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }

  /**
   * Helper: Executes a tool operation with consistent error handling and formatting.
   * Catches exceptions and returns them as a structured JSON error string, allowing
   * the LLM to gracefully handle failures.
   *
   * @template T The expected return type of the operation.
   * @param operation - The asynchronous operation to execute.
   * @param reconciliation - Safe recovery guidance for calls that may mutate upstream state.
   * @returns {Promise<string>} A JSON string representing the structured result or error.
   */
  private async executeWithErrorHandling<T>(
    operation: () => Promise<T>,
    reconciliation?: string
  ): Promise<string> {
    try {
      const result = await operation();

      return JSON.stringify(result);
    } catch (error) {
      const isPassthrough = 
        error instanceof z.ZodError ||
        error instanceof SecurityError ||
        error instanceof RateLimitError;

      const logMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Tool execution error: ${logMsg}`);

      const apiError = error instanceof JulesAPIError;
      const errorMsg = apiError
        ? `Jules API request failed${error.statusCode ? ` (HTTP ${error.statusCode})` : ''}.`
        : isPassthrough && error instanceof Error
        ? error.message
        : 'An internal error occurred. Please check server logs.';

      return JSON.stringify({
        success: false,
        error: errorMsg,
        ...(apiError ? {
          statusCode: error.statusCode,
          outcomeUnknown: Boolean(reconciliation && (!error.statusCode || error.statusCode >= 500)),
          recovery: reconciliation || 'Check the configured credentials, network, quotas and session status before retrying.',
        } : {}),
      });
    }
  }

  /**
   * Tool: create_coding_task
   * Creates an immediate Jules coding session to execute a specific task.
   *
   * @param args - The structured arguments matching `CreateTaskSchema`.
   * @returns {Promise<string>} A JSON string representing the created session details, including its ID and status.
   */
  async createCodingTask(
    args: z.infer<typeof CreateTaskSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      if (!this.rateLimiter.isAllowed()) {
        throw new RateLimitError('Rate limit exceeded. Please wait before creating more tasks.');
      }

      // SECURITY: Validate repository allowlist
      await this.validateSource(args.source);

      const session = await this.client.createSession({
        prompt: args.prompt,
        sourceContext: {
          source: args.source,
          githubRepoContext: {
            startingBranch: args.branch,
          },
        },
        automationMode: args.auto_create_pr
          ? 'AUTO_CREATE_PR'
          : 'AUTOMATION_MODE_UNSPECIFIED',
        requirePlanApproval: args.require_plan_approval,
        title: args.title,
      });

      const statusMsg = args.require_plan_approval
        ? 'Session created with plan approval required; planning may still be in progress. Use jules://sessions/{id}/full to review the plan, then call manage_session with action=approve_plan.'
        : 'Session created and executing automatically.';

      return {
        sessionId: session.id,
        state: session.state,
        message: statusMsg,
        monitorUrl: this.getMonitorUrl(session),
        prUrl: this.getPullRequestUrl(session),
      };
    }, 'Check list_sessions for this task before creating another session; a lost response can follow successful creation.');
  }

  /**
   * Tool: create_repoless_task
   * Creates a Jules session without a repository source context.
   *
   * @param args - The structured arguments matching `CreateRepolessTaskSchema`.
   * @returns {Promise<string>} A JSON string representing the created session details.
   */
  async createRepolessTask(
    args: z.infer<typeof CreateRepolessTaskSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      if (!this.rateLimiter.isAllowed()) {
        throw new RateLimitError('Rate limit exceeded. Please wait before creating more tasks.');
      }

      const session = await this.client.createSession({
        prompt: args.prompt,
        title: args.title,
        requirePlanApproval: true,
      });

      return {
        sessionId: session.id,
        state: session.state,
        monitorUrl: this.getMonitorUrl(session),
        prUrl: this.getPullRequestUrl(session),
      };
    }, 'Check list_sessions for this task before creating another session; a lost response can follow successful creation.');
  }

  /**
   * Tool: manage_session
   * Manages the lifecycle of an active Jules session, such as approving generated plans
   * or sending feedback messages to the agent.
   *
   * @param args - The structured arguments matching `ManageSessionSchema`.
   * @returns {Promise<string>} A JSON string representing the result of the management action.
   */
  async manageSession(
    args: z.infer<typeof ManageSessionSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      await this.validateSession(args.session_id);
      if (args.action === 'approve_plan') {
        const session = await this.client.approvePlan(args.session_id);
        return {
          message: 'Plan approval accepted. Check get_session_status for the current state.',
          newState: session.state,
        };
      }

      if (args.action === 'reject_plan') {
        await this.client.sendMessage(args.session_id, {
          prompt: args.message || 'Please revise the proposed plan. Wait for my feedback before proceeding.',
        });
        return {
          message: 'Plan revision requested. The session was preserved; review its next plan before approving.',
        };
      }

      if (args.action === 'send_message') {
        if (!args.message) {
          throw new Error('Message is required for send_message action');
        }

        const session = await this.client.sendMessage(args.session_id, {
          prompt: args.message,
        });

        return {
          message: 'Feedback sent to session',
          newState: session.state,
        };
      }

      throw new Error('Invalid action');
    }, 'Check get_session_status and all pages of get_session_review before repeating feedback or approval; the earlier action may have succeeded.');
  }

  /**
   * Tool: get_session_status
   * Retrieves the current status and state of a given Jules session.
   * Provides guidance on what next steps to take based on the state.
   *
   * @param args - The structured arguments matching `GetSessionStatusSchema`.
   * @returns {Promise<string>} A JSON string representing the session status.
   */
  async getSessionStatus(
    args: z.infer<typeof GetSessionStatusSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      const session = await this.client.getSession(args.session_id);

      return {
        sessionId: session.id,
        title: session.title,
        state: session.state,
        prompt: session.prompt,
        repository: this.getRepositoryLabel(session),
        updated: session.updateTime,
        nextSteps: this.getNextStepsForState(session.state || 'UNKNOWN'),
      };
    });
  }

  /**
   * Tool: wait_for_session
   * Polls the Jules API until the target state is reached or the timeout expires.
   *
   * @param args - The structured arguments matching `WaitForSessionSchema`.
   * @returns {Promise<string>} A JSON string representing the final observed session state.
   */
  async waitForSession(
    args: z.infer<typeof WaitForSessionSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      const startedAt = Date.now();
      const deadline = startedAt + args.timeout_seconds * 1000;
      const targetStates = new Set<SessionState>([...args.target_states, 'AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK', 'COMPLETED', 'FAILED', 'CANCELED']);
      let lastSession: Session | undefined;
      const timedOut = () => ({
        sessionId: lastSession?.id || args.session_id,
        finalState: lastSession?.state || 'UNKNOWN',
        timedOut: true,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        nextSteps: this.getNextStepsForState(lastSession?.state || 'UNKNOWN'),
        monitorUrl: lastSession ? this.getMonitorUrl(lastSession) : undefined,
      });

      while (true) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return timedOut();
        let session: Session;
        try {
          session = await this.client.getSession(args.session_id, remainingMs);
        } catch (error) {
          if (Date.now() >= deadline) return timedOut();
          throw error;
        }
        lastSession = session;
        const currentState = session.state;
        if (currentState && targetStates.has(currentState)) {
          return {
            sessionId: session.id,
            title: session.title,
            finalState: currentState,
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
            nextSteps: this.getNextStepsForState(currentState),
            prUrl: this.getPullRequestUrl(session),
          };
        }
        const delayMs = Math.min(args.poll_interval_seconds * 1000, Math.max(0, deadline - Date.now()));
        if (delayMs > 0) await this.delay(delayMs);
      }
    });
  }

  /**
   * Tool: get_activities_since
   * Returns activities newer than the provided timestamp.
   *
   * @param args - The structured arguments matching `GetActivitiesSinceSchema`.
   * @returns {Promise<string>} A JSON string containing recent activities.
   */
  async getActivitiesSince(
    args: z.infer<typeof GetActivitiesSinceSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      const response = await this.client.listActivitiesSince(
        args.session_id,
        args.since,
        args.page_size ?? 50,
        args.page_token
      );

      return {
        sessionId: args.session_id,
        since: args.since,
        count: response.activities.length,
        activities: response.activities,
        nextPageToken: response.nextPageToken,
      };
    });
  }

  /**
   * Tool: schedule_recurring_task
   * Configures a new automated task to run on a specified cron schedule.
   * Persists the schedule locally so it survives server restarts.
   *
   * @param args - The structured arguments matching `ScheduleTaskSchema`.
   * @returns {Promise<string>} A JSON string representing the scheduling result, including the task ID and next run time.
   */
  async scheduleRecurringTask(
    args: z.infer<typeof ScheduleTaskSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      // Validate cron expression
      if (!CronEngine.validateCronExpression(args.cron_expression)) {
        throw new Error(
          `Invalid cron expression: ${args.cron_expression}. Format: minute hour day month weekday`
        );
      }

      if (!CronEngine.isQuotaAwareSchedule(args.cron_expression)) {
        throw new SecurityError('Schedules must execute at most once per hour.');
      }

      // Check for name collision
      const existing = await this.storage.getTaskByName(args.task_name);
      if (existing) {
        throw new Error(
          `A schedule named "${args.task_name}" already exists. Use delete_schedule first or choose a different name.`
        );
      }

      // SECURITY: Validate repository allowlist
      await this.validateSource(args.source);

      // Create scheduled task
      const task: ScheduledTask = {
        id: randomUUID(),
        name: args.task_name,
        cron: args.cron_expression,
        taskPayload: {
          prompt: args.prompt,
          source: args.source,
          branch: args.branch,
          automationMode: args.auto_create_pr
            ? 'AUTO_CREATE_PR'
            : 'AUTOMATION_MODE_UNSPECIFIED',
          requirePlanApproval: args.require_plan_approval,
        },
        timezone: args.timezone,
        createdAt: new Date().toISOString(),
        enabled: true,
      };

      // Persist and schedule
      await this.storage.upsertTask(task);
      this.scheduler.scheduleTask(task);

      const nextRun = this.scheduler.getNextInvocation(task.id);

      return {
        message: `Task "${args.task_name}" scheduled successfully`,
        scheduleId: task.id,
        cron: args.cron_expression,
        nextExecution: nextRun?.toISOString() || 'Unknown',
      };
    });
  }

  /**
   * Tool: list_schedules
   * Retrieves a list of all active locally-managed scheduled tasks.
   *
   * @returns {Promise<string>} A JSON string representing all active schedules and their next execution times.
   */
  async listSchedules(): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      const tasks = await this.storage.listTasks();

      const formatted = tasks.map((task) => {
        const nextRun = this.scheduler.getNextInvocation(task.id);
        return {
          id: task.id,
          name: task.name,
          cron: task.cron,
          enabled: task.enabled,
          repository: task.taskPayload.source,
          prompt: smartTruncate(task.taskPayload.prompt, 60),
          nextRun: nextRun?.toISOString() || 'Not scheduled',
          lastRun: task.lastRun || 'Never',
          lastSessionId: task.lastSessionId,
        };
      });

      return {
        count: formatted.length,
        schedules: formatted,
      };
    });
  }

  /**
   * Tool: delete_schedule
   * Removes an existing scheduled task, stopping future executions and deleting it from storage.
   *
   * @param args - The structured arguments matching `DeleteScheduleSchema`.
   * @returns {Promise<string>} A JSON string confirming the deletion result.
   */
  async deleteSchedule(
    args: z.infer<typeof DeleteScheduleSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      const task = await this.storage.getTaskByName(args.task_name);

      if (!task) {
        throw new Error(`No schedule found with name: ${args.task_name}`);
      }

      // Cancel in-memory job
      this.scheduler.cancelTask(task.id);

      // Remove from storage
      await this.storage.deleteTask(task.id);

      return {
        message: `Schedule "${args.task_name}" deleted successfully`,
      };
    });
  }

  /**
   * Tool: delete_session
   * Deletes or cancels an active Jules session.
   *
   * @param args - The structured arguments matching `DeleteSessionSchema`.
   * @returns {Promise<string>} A JSON string confirming the deletion.
   */
  async deleteSession(
    args: z.infer<typeof DeleteSessionSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      await this.validateSession(args.session_id);
      await this.client.deleteSession(args.session_id);
      return {
        message: `Session "${args.session_id}" deleted successfully`,
      };
    }, 'Inspect session status before repeating deletion; the earlier delete may have succeeded.');
  }

  /**
   * Tool: get_source_details
   * Retrieves detailed information about a specific source repository.
   *
   * @param args - The structured arguments matching `GetSourceDetailsSchema`.
   * @returns {Promise<string>} A JSON string representing the source details.
   */
  async getSourceDetails(
    args: z.infer<typeof GetSourceDetailsSchema>
  ): Promise<string> {
    return this.executeWithErrorHandling(async () => {
      const source = await this.client.getSource(args.source_name);
      return {
        name: source.name,
        repository: source.githubRepo
          ? `${source.githubRepo.owner}/${source.githubRepo.repo}`
          : 'Unknown',
        defaultBranch: typeof source.githubRepo?.defaultBranch === 'string' ? source.githubRepo.defaultBranch : source.githubRepo?.defaultBranch?.displayName,
        url: source.githubRepo?.htmlUrl,
        metadata: source.githubRepo,
      };
    });
  }

  /**
   * Helper: Provides actionable guidance based on a session's current state.
   * Helps the LLM understand what to do next (e.g., approve a plan, wait, or review failures).
   *
   * @param state - The current state string of the session.
   * @returns {string} A string describing the recommended next steps.
   */
  private getNextStepsForState(state: string): string {
    const stateGuide: Record<string, string> = {
      QUEUED: 'Session is queued. Wait for it to start planning.',
      PLANNING: 'Jules is generating a plan. Wait for plan completion.',
      AWAITING_PLAN_APPROVAL:
        'Plan is ready. Call get_session_review to review the plan, then call manage_session with action=approve_plan to proceed.',
      AWAITING_USER_FEEDBACK:
        'Jules asked a clarifying question. Call get_session_review to see the agentMessaged activity, then call manage_session with action=send_message to answer it.',
      IN_PROGRESS:
        'Session is executing. Monitor progress via jules://sessions/{id}/full.',
      PAUSED:
        'Session is paused. Use manage_session with action=send_message to resume.',
      COMPLETED:
        'Session completed. Check the final activity for Pull Request URL or artifacts.',
      FAILED:
        'Session failed. Review activities to diagnose the issue.',
      CANCELED: 'Session was canceled.',
    };

    return stateGuide[state] || 'Unknown state. Check session activities.';
  }
}
