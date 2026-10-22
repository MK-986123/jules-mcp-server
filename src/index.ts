#!/usr/bin/env node
import 'dotenv/config';
/**
 * Google Jules MCP Server
 * A Model Context Protocol server for the Google Jules API
 * with built-in scheduling capabilities
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { JulesClient } from './api/jules-client.js';
import { ScheduleStorage } from './storage/schedule-store.js';
import { CronEngine } from './scheduler/cron-engine.js';
import { JulesResources } from './mcp/resources.js';
import {
  JulesTools,
  CreateTaskSchema,
  CreateRepolessTaskSchema,
  ManageSessionSchema,
  GetSessionStatusSchema,
  WaitForSessionSchema,
  GetActivitiesSinceSchema,
  ScheduleTaskSchema,
  DeleteScheduleSchema,
  DeleteSessionSchema,
  GetSourceDetailsSchema,
  PaginationSchema,
  SessionReviewSchema,
} from './mcp/tools.js';
import { JulesPromptManager, JULES_PROMPTS } from './mcp/prompts.js';
import { RepositoryValidator } from './utils/security.js';

/**
 * Main server class for the Jules MCP server.
 * Handles the initialization of components and setup of MCP request handlers.
 */
class JulesMCPServer {
  private server: Server;
  private client: JulesClient;
  private storage: ScheduleStorage;
  private scheduler: CronEngine;
  private resources: JulesResources;
  private tools: JulesTools;
  private promptManager: JulesPromptManager;

  /**
   * Initializes the Jules MCP Server.
   * Sets up the server, client, storage, scheduler, resources, tools, and prompts.
   */
  constructor() {
    // Initialize security validator with environment config
    RepositoryValidator.initialize();

    // Initialize MCP server
    this.server = new Server(
      {
        name: 'jules-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {},
          logging: {},
        },
      }
    );

    // Initialize Jules API client
    this.client = new JulesClient();

    // Initialize storage and scheduler
    this.storage = new ScheduleStorage();
    this.scheduler = new CronEngine(
      this.storage,
      this.client,
      (msg) => {
        // Log to MCP client
        void this.server.sendLoggingMessage({
          level: 'info',
          data: msg,
        });
      }
    );

    // Initialize MCP components
    this.resources = new JulesResources(
      this.client,
      this.storage,
      this.scheduler
    );
    this.tools = new JulesTools(this.client, this.storage, this.scheduler);
    this.promptManager = new JulesPromptManager();

    this.setupHandlers();
  }

  /**
   * Sets up MCP protocol handlers.
   * Configures handlers for listing and reading resources, tools, and prompts.
   */
  private setupHandlers(): void {
    // Resource handlers
    this.server.setRequestHandler(
      ListResourcesRequestSchema,
      async () => ({
        resources: [
          {
            uri: 'jules://sources',
            name: 'Connected Repositories',
            description:
              'List of GitHub repositories connected to Jules',
            mimeType: 'application/json',
          },
          {
            uri: 'jules://sessions/list',
            name: 'Recent Sessions',
            description: 'Summary of recent Jules coding sessions',
            mimeType: 'application/json',
          },
          {
            uri: 'jules://sessions/{id}/activities',
            name: 'Session Activities',
            description: 'Raw activity log for a specific session',
            mimeType: 'application/json',
          },
          {
            uri: 'jules://sessions/{id}/full',
            name: 'Session Details',
            description: 'Full session details including activities and outputs',
            mimeType: 'application/json',
          },
          {
            uri: 'jules://sessions/{id}/diff',
            name: 'Session Diff',
            description: 'Latest available change set for a specific session',
            mimeType: 'application/json',
          },
          {
            uri: 'jules://schedules',
            name: 'Scheduled Tasks',
            description: 'Locally-managed recurring Jules tasks',
            mimeType: 'application/json',
          },
          {
            uri: 'jules://schedules/history',
            name: 'Schedule Execution History',
            description: 'History of scheduled task executions',
            mimeType: 'application/json',
          },
        ],
      })
    );

    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        const uri = request.params.uri;

        try {
          let content: string;

          if (uri === 'jules://sources') {
            content = await this.resources.getSources();
          } else if (uri === 'jules://sessions/list') {
            content = await this.resources.getSessionsList();
          } else if (uri === 'jules://schedules') {
            content = await this.resources.getSchedules();
          } else if (uri === 'jules://schedules/history') {
            content = await this.resources.getScheduleHistory();
          } else if (uri.startsWith('jules://sessions/') && uri.endsWith('/activities')) {
            const sessionId = uri.replace('jules://sessions/', '').replace('/activities', '');
            content = await this.resources.getSessionActivities(sessionId);
          } else if (uri.startsWith('jules://sessions/') && uri.endsWith('/diff')) {
            const sessionId = uri.replace('jules://sessions/', '').replace('/diff', '');
            content = await this.resources.getSessionDiff(sessionId);
          } else if (uri.startsWith('jules://sessions/') && uri.endsWith('/full')) {
            // Extract session ID from URI
            const sessionId = uri.replace('jules://sessions/', '').replace('/full', '');
            content = await this.resources.getSessionFull(sessionId);
          } else {
            throw new Error(`Unknown resource URI: ${uri}`);
          }

          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: content,
              },
            ],
          };
        } catch (error) {
          throw new Error(
            `Failed to read resource ${uri}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }
    );

    // Tool handlers
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'list_sources', description: 'List one page of repositories connected to Jules. Use exact returned source names and branch metadata.', schema: PaginationSchema, readOnly: true },
        { name: 'list_sessions', description: 'List one page of Jules sessions to locate existing work before creating another task.', schema: PaginationSchema, readOnly: true },
        { name: 'get_session_review', description: 'Read session details, a page of plan/feedback evidence and continuation token. Follow every page before approving a plan.', schema: SessionReviewSchema, readOnly: true },
        { name: 'get_session_diff', description: 'Read session patch artifacts and pagination evidence. Review GitHub PR checks separately before merging.', schema: SessionReviewSchema, readOnly: true },
        { name: 'create_coding_task', description: 'Create a Jules coding task. Plan approval is required by default and a pull request is created on completion. Returns immediately; planning may still be in progress.', schema: CreateTaskSchema, readOnly: false },
        { name: 'create_repoless_task', description: 'Create a Jules task without repository context, requiring plan approval.', schema: CreateRepolessTaskSchema, readOnly: false },
        { name: 'manage_session', description: 'Approve a reviewed plan or send feedback. reject_plan requests a revision and preserves the session; delete_session is a separate destructive action.', schema: ManageSessionSchema, readOnly: false },
        { name: 'get_session_status', description: 'Read the current state of a Jules session.', schema: GetSessionStatusSchema, readOnly: true },
        { name: 'wait_for_session', description: 'Poll briefly, returning on completion, failure, user attention, or timeout. Timeout returns the observed state; call again later.', schema: WaitForSessionSchema, readOnly: true },
        { name: 'get_activities_since', description: 'Read one page and locally filter activities after a timestamp. Continue with nextPageToken even when the filtered page is empty.', schema: GetActivitiesSinceSchema, readOnly: true },
        { name: 'schedule_recurring_task', description: 'Create a persistent recurring task (at most hourly). Execution requires this process to remain running.', schema: ScheduleTaskSchema, readOnly: false },
        { name: 'list_schedules', description: 'Read locally managed schedules.', schema: z.object({}), readOnly: true },
        { name: 'delete_schedule', description: 'Delete a locally managed schedule.', schema: DeleteScheduleSchema, readOnly: false },
        { name: 'delete_session', description: 'Permanently delete a Jules session. Requesting a plan revision does not require this action.', schema: DeleteSessionSchema, readOnly: false },
        { name: 'get_source_details', description: 'Read branch and repository metadata for an exact Jules source resource name.', schema: GetSourceDetailsSchema, readOnly: true },
      ].map(({ name, description, schema, readOnly }) => ({
        name,
        description,
        inputSchema: z.toJSONSchema(schema, { io: 'input' }) as { type: 'object' },
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: string;

        switch (name) {
          case 'list_sources': {
            result = await this.tools.listSources(PaginationSchema.parse(args ?? {}));
            break;
          }
          case 'list_sessions': {
            result = await this.tools.listSessions(PaginationSchema.parse(args ?? {}));
            break;
          }
          case 'get_session_review': {
            result = await this.tools.getSessionReview(SessionReviewSchema.parse(args));
            break;
          }
          case 'get_session_diff': {
            result = await this.tools.getSessionDiff(SessionReviewSchema.parse(args));
            break;
          }
          case 'create_coding_task': {
            const validated = CreateTaskSchema.parse(args);
            result = await this.tools.createCodingTask(validated);
            break;
          }

          case 'create_repoless_task': {
            const validated = CreateRepolessTaskSchema.parse(args);
            result = await this.tools.createRepolessTask(validated);
            break;
          }

          case 'manage_session': {
            const validated = ManageSessionSchema.parse(args);
            result = await this.tools.manageSession(validated);
            break;
          }

          case 'get_session_status': {
            const validated = GetSessionStatusSchema.parse(args);
            result = await this.tools.getSessionStatus(validated);
            break;
          }

          case 'wait_for_session': {
            const validated = WaitForSessionSchema.parse(args);
            result = await this.tools.waitForSession(validated);
            break;
          }

          case 'get_activities_since': {
            const validated = GetActivitiesSinceSchema.parse(args);
            result = await this.tools.getActivitiesSince(validated);
            break;
          }

          case 'schedule_recurring_task': {
            const validated = ScheduleTaskSchema.parse(args);
            result = await this.tools.scheduleRecurringTask(validated);
            break;
          }

          case 'list_schedules': {
            result = await this.tools.listSchedules();
            break;
          }

          case 'delete_schedule': {
            const validated = DeleteScheduleSchema.parse(args);
            result = await this.tools.deleteSchedule(validated);
            break;
          }

          case 'delete_session': {
            const validated = DeleteSessionSchema.parse(args);
            result = await this.tools.deleteSession(validated);
            break;
          }

          case 'get_source_details': {
            const validated = GetSourceDetailsSchema.parse(args);
            result = await this.tools.getSourceDetails(validated);
            break;
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        const parsed = JSON.parse(result);
        return {
          content: [
            {
              type: 'text',
              text: result,
            },
          ],
          isError: parsed.success === false,
        };
      } catch (error) {
        const isZod = error instanceof z.ZodError;
        const msg = isZod
          ? 'Validation failed. Check input format and required parameters.'
          : 'An internal error occurred. Please check server logs.';
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    });

    // Prompt handlers
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: JULES_PROMPTS.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      })),
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const content = this.promptManager.renderPrompt(name, args || {});
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: content,
              },
            },
          ],
        };
      } catch (error) {
        throw new Error(
          `Failed to render prompt: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });
  }

  /**
   * Starts the MCP server.
   * Connects the transport and initializes the scheduler.
   */
  async start(): Promise<void> {
    // Create stdio transport
    const transport = new StdioServerTransport();

    // Handle shutdown
    process.on('SIGINT', () => {
      this.scheduler.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      this.scheduler.shutdown();
      process.exit(0);
    });

    // Connect and run
    await this.server.connect(transport);

    // Initialize scheduler after transport is ready so logging works
    try {
      await this.scheduler.initialize();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      void this.server.sendLoggingMessage({
        level: 'error',
        data: `Scheduler initialization failed: ${message}`,
      });
    }

    // Log startup
    void this.server.sendLoggingMessage({
      level: 'info',
      data: 'Jules MCP Server started successfully',
    });
  }
}

// Entry point
const server = new JulesMCPServer();
server.start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
