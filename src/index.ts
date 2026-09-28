#!/usr/bin/env node
import 'dotenv/config';
import {
  McpServer,
  ResourceTemplate,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
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
  ListSourcesSchema,
  GetSessionActivitiesSchema,
  GetSessionDiffSchema,
  ApprovePlanSchema,
  SendSessionMessageSchema,
} from './mcp/tools.js';
import { JulesPromptManager, JULES_PROMPTS } from './mcp/prompts.js';
import { RepositoryValidator } from './utils/security.js';

/**
 * Main server class for the Jules MCP server.
 * Handles the initialization of components and setup of MCP request handlers.
 */
class JulesMCPServer {
  private server: McpServer;
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
    this.server = new McpServer(
      {
        name: 'jules-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {},
        },
        instructions:
          'Discover Jules sources and reuse each exact source name. Review current session state before approval or deletion. Stop waiting when Jules needs user input. Never include the Jules API key in tool arguments or outputs.',
        supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      }
    );

    // Initialize Jules API client
    this.client = new JulesClient();

    // Initialize storage and scheduler
    this.storage = new ScheduleStorage();
    this.scheduler = new CronEngine(
      this.storage,
      this.client,
      (msg) => process.stderr.write(`${msg}\n`)
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
    this.server.server.oninitialized = () => {
      void this.initializeScheduler();
    };
    this.server.server.onclose = () => {
      this.scheduler.shutdown();
    };
  }

  /**
   * Sets up MCP protocol handlers.
   * Configures handlers for listing and reading resources, tools, and prompts.
   */
  private setupHandlers(): void {
    const registerStaticResource = (
      name: string,
      uri: string,
      description: string,
      reader: () => Promise<string>
    ): void => {
      this.server.registerResource(
        name,
        uri,
        { description, mimeType: 'application/json' },
        async (resourceUri) => ({
          contents: [
            {
              uri: resourceUri.href,
              mimeType: 'application/json',
              text: await reader(),
            },
          ],
        })
      );
    };

    registerStaticResource(
      'connected-sources',
      'jules://sources',
      'Connected Jules sources with their exact resource names.',
      () => this.resources.getSources()
    );
    registerStaticResource(
      'recent-sessions',
      'jules://sessions/list',
      'A bounded summary of recent Jules sessions.',
      () => this.resources.getSessionsList()
    );
    registerStaticResource(
      'scheduled-tasks',
      'jules://schedules',
      'Locally managed recurring Jules tasks.',
      () => this.resources.getSchedules()
    );
    registerStaticResource(
      'schedule-history',
      'jules://schedules/history',
      'Execution history for locally managed schedules.',
      () => this.resources.getScheduleHistory()
    );

    const readTemplate = async (
      name: 'activities' | 'full' | 'diff',
      uri: URL,
      variables: Record<string, string | string[] | undefined>
    ) => {
      const sessionId = z
        .string()
        .regex(/^[\w-]+$/, 'Session ID contains invalid characters')
        .parse(variables.id);
      const text =
        name === 'activities'
          ? await this.resources.getSessionActivities(sessionId)
          : name === 'diff'
            ? await this.resources.getSessionDiff(sessionId)
            : await this.resources.getSessionFull(sessionId);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text }],
      };
    };

    this.server.registerResource(
      'session-activities',
      new ResourceTemplate('jules://sessions/{id}/activities', { list: undefined }),
      {
        description: 'A bounded page of current Jules activities with a continuation token.',
        mimeType: 'application/json',
      },
      (uri, variables) => readTemplate('activities', uri, variables)
    );
    this.server.registerResource(
      'session-details',
      new ResourceTemplate('jules://sessions/{id}/full', { list: undefined }),
      {
        description: 'Session details and one bounded page of current activities.',
        mimeType: 'application/json',
      },
      (uri, variables) => readTemplate('full', uri, variables)
    );
    this.server.registerResource(
      'session-diff',
      new ResourceTemplate('jules://sessions/{id}/diff', { list: undefined }),
      {
        description: 'Latest Jules git patch artifact and associated metadata.',
        mimeType: 'application/json',
      },
      (uri, variables) => readTemplate('diff', uri, variables)
    );

    // Register tools from the same Zod schemas used for runtime validation.
    const readOnly = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    };
    const externalWrite = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    };
    const destructive = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };
    const definitions = [
      {
        name: 'list_sources',
        description: 'Discover Jules sources. Pass the exact returned name unchanged to task creation.',
        schema: ListSourcesSchema,
        annotations: readOnly,
      },
      {
        name: 'get_source_details',
        description: 'Read metadata for an exact Jules source resource name.',
        schema: GetSourceDetailsSchema,
        annotations: readOnly,
      },
      {
        name: 'create_coding_task',
        description: 'Create a Jules coding session using an exact source name from list_sources. Branch defaults to Jules source metadata.',
        schema: CreateTaskSchema,
        annotations: externalWrite,
      },
      {
        name: 'create_repoless_task',
        description: 'Create a Jules session without a repository source.',
        schema: CreateRepolessTaskSchema,
        annotations: externalWrite,
      },
      {
        name: 'get_session',
        description: 'Read current session state and recommended next steps.',
        schema: GetSessionStatusSchema,
        annotations: readOnly,
      },
      {
        name: 'get_session_status',
        description: 'Compatibility alias for get_session.',
        schema: GetSessionStatusSchema,
        annotations: readOnly,
      },
      {
        name: 'get_session_activities',
        description: 'Read a bounded page of current Jules activities and its continuation cursor.',
        schema: GetSessionActivitiesSchema,
        annotations: readOnly,
      },
      {
        name: 'get_session_diff',
        description: 'Read the latest change-set git patch and metadata from Jules activity artifacts.',
        schema: GetSessionDiffSchema,
        annotations: readOnly,
      },
      {
        name: 'wait_for_session',
        description: 'Poll until a terminal or user-action state is observed, or return a structured timeout result.',
        schema: WaitForSessionSchema,
        annotations: readOnly,
      },
      {
        name: 'approve_plan',
        description: 'Approve a Jules plan waiting for human approval.',
        schema: ApprovePlanSchema,
        annotations: externalWrite,
      },
      {
        name: 'send_session_message',
        description: 'Send feedback or a response to a Jules session.',
        schema: SendSessionMessageSchema,
        annotations: externalWrite,
      },
      {
        name: 'manage_session',
        description: 'Deprecated compatibility tool for plan approval or messaging. Plan rejection is not supported; delete the session explicitly.',
        schema: ManageSessionSchema,
        annotations: externalWrite,
      },
      {
        name: 'get_activities_since',
        description: 'Read activities at or after a supplied RFC3339 createTime.',
        schema: GetActivitiesSinceSchema,
        annotations: readOnly,
      },
      {
        name: 'schedule_recurring_task',
        description: 'Create a locally persisted recurring Jules task.',
        schema: ScheduleTaskSchema,
        annotations: externalWrite,
      },
      {
        name: 'list_schedules',
        description: 'List locally managed recurring tasks.',
        schema: z.object({}),
        annotations: readOnly,
      },
      {
        name: 'delete_schedule',
        description: 'Delete a locally managed schedule.',
        schema: DeleteScheduleSchema,
        annotations: destructive,
      },
      {
        name: 'delete_session',
        description: 'Delete a Jules session. This operation is destructive and does not imply a returned cancellation state.',
        schema: DeleteSessionSchema,
        annotations: destructive,
      },
    ];
    const outputSchema = z.object({}).passthrough();
    for (const definition of definitions) {
      this.server.registerTool(
        definition.name,
        {
          description: definition.description,
          inputSchema: definition.schema,
          outputSchema,
          annotations: definition.annotations,
        },
        async (args) => {
          const result = await this.dispatchTool(definition.name, args);
          const structuredContent = JSON.parse(result) as Record<string, unknown>;
          return {
            content: [{ type: 'text', text: result }],
            structuredContent,
            isError: structuredContent.success === false,
          };
        }
      );
    }

    for (const prompt of JULES_PROMPTS) {
      const argsSchema = z.object(
        Object.fromEntries(
          prompt.arguments.map((argument) => [
            argument.name,
            argument.required ? z.string() : z.string().optional(),
          ])
        )
      );
      this.server.registerPrompt(
        prompt.name,
        { description: prompt.description, argsSchema },
        (args) => ({
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: this.promptManager.renderPrompt(
                  prompt.name,
                  args as Record<string, string>
                ),
              },
            },
          ],
        })
      );
    }
  }

  /**
   * Validates and dispatches an MCP tool call to its JulesTools operation.
   * @param name - The registered MCP tool name.
   * @param args - Untrusted tool arguments validated against the registered schema.
   * @returns A JSON string containing the structured tool result.
   */
  private async dispatchTool(name: string, args: unknown): Promise<string> {
    switch (name) {
      case 'create_coding_task':
        return this.tools.createCodingTask(CreateTaskSchema.parse(args));
      case 'create_repoless_task':
        return this.tools.createRepolessTask(CreateRepolessTaskSchema.parse(args));
      case 'list_sources':
        return this.tools.listSources(ListSourcesSchema.parse(args));
      case 'manage_session':
        return this.tools.manageSession(ManageSessionSchema.parse(args));
      case 'approve_plan':
        return this.tools.manageSession({
          ...ApprovePlanSchema.parse(args),
          action: 'approve_plan',
        });
      case 'send_session_message':
        return this.tools.manageSession({
          ...SendSessionMessageSchema.parse(args),
          action: 'send_message',
        });
      case 'get_session':
      case 'get_session_status':
        return this.tools.getSessionStatus(GetSessionStatusSchema.parse(args));
      case 'get_session_activities':
        return this.tools.getSessionActivities(
          GetSessionActivitiesSchema.parse(args)
        );
      case 'get_session_diff':
        return this.tools.getSessionDiff(GetSessionDiffSchema.parse(args));
      case 'wait_for_session':
        return this.tools.waitForSession(WaitForSessionSchema.parse(args));
      case 'get_activities_since':
        return this.tools.getActivitiesSince(
          GetActivitiesSinceSchema.parse(args)
        );
      case 'schedule_recurring_task':
        return this.tools.scheduleRecurringTask(ScheduleTaskSchema.parse(args));
      case 'list_schedules':
        return this.tools.listSchedules();
      case 'delete_schedule':
        return this.tools.deleteSchedule(DeleteScheduleSchema.parse(args));
      case 'delete_session':
        return this.tools.deleteSession(DeleteSessionSchema.parse(args));
      case 'get_source_details':
        return this.tools.getSourceDetails(GetSourceDetailsSchema.parse(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Returns the configured MCP server for the stdio serving helper.
   * @returns The MCP server with Jules tools, resources, and prompts registered.
   */
  getMcpServer(): McpServer {
    return this.server;
  }

  /**
   * Loads and starts scheduled tasks after a client completes initialization.
   */
  private async initializeScheduler(): Promise<void> {
    try {
      await this.scheduler.initialize();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      process.stderr.write(`Scheduler initialization failed: ${message}\n`);
    }
  }
}

// Entry point
const handle = serveStdio(() => new JulesMCPServer().getMcpServer(), {
  legacy: 'serve',
  onerror: (error) => process.stderr.write(`MCP transport error: ${error.message}\n`),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
