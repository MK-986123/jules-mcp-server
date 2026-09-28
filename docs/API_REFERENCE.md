# Jules MCP Server API Reference

Reference for the Jules resources, tools, and prompts currently exposed by this MCP server. The Jules API is v1alpha; this server does not claim complete API coverage.

## Resources

Resources are read-only data that provide context to the AI assistant.

### jules://sources

**Description:** List of GitHub repositories connected to Jules

**MIME Type:** `application/json`

#### Response Format

```json
{
  "description": "Connected GitHub repositories available for Jules tasks",
  "count": 2,
  "sources": [
    {
      "name": "sources/github-owner-repo",
      "repository": "owner/repo",
      "defaultBranch": "main",
      "url": "https://github.com/owner/repo"
    }
  ]
}
```

**Usage:** Read this before creating tasks to ensure the repository is connected.
`name` is an opaque Jules resource name. Copy it exactly from this response; do not construct it from the repository owner/name. The resource projects `githubRepo.defaultBranch.displayName` as the string `defaultBranch`. In the Jules API response, `githubRepo.defaultBranch` is an object, and `branches`, `isPrivate`, `owner`, `repo`, and `htmlUrl` may also be present.

The Jules `Source` object contains a `name` such as `sources/github-myorg-myrepo` and `githubRepo` metadata. That example is illustrative, not a required naming pattern.

```json
{
  "name": "sources/github-myorg-myrepo",
  "githubRepo": {
    "owner": "myorg",
    "repo": "myrepo",
    "htmlUrl": "https://github.com/myorg/myrepo",
    "defaultBranch": { "displayName": "main" },
    "branches": [{ "displayName": "main" }, { "displayName": "release" }],
    "isPrivate": true
  }
}
```

---

### jules://sessions/list

**Description:** Recent Jules coding sessions

**MIME Type:** `application/json`

#### Response Format

```json
{
  "description": "Recent Jules sessions (tasks)",
  "count": 5,
  "sessions": [
    {
      "id": "session-abc123",
      "title": "Add API tests",
      "state": "COMPLETED",
      "prompt": "Add comprehensive API tests...",
      "repository": "sources/github-owner-repo",
      "created": "2025-01-15T10:00:00Z"
    }
  ]
}
```

**Usage:** Monitor active tasks or check historical sessions.

---

### Session resource templates

The parameterized session resources are registered as templates, not as concrete resource URIs:

- `jules://sessions/{id}/activities`
- `jules://sessions/{id}/full`
- `jules://sessions/{id}/diff`

Use the session ID in the requested URI. Activity and full-session results are bounded and include continuation information where applicable.

---

### jules://sessions/{id}/activities

**Description:** Raw activity log for a specific session

**URI Pattern:** `jules://sessions/{sessionId}/activities`

**MIME Type:** `application/json`

#### Response Format

```json
{
  "sessionId": "abc123",
  "count": 3,
  "activities": [
    {
      "name": "sessions/abc123/activities/activity-1",
      "createTime": "2025-01-15T10:04:00Z",
      "originator": "agent",
      "description": "Plan generated",
      "planGenerated": { "plan": { "steps": [] } },
      "artifacts": []
    }
  ],
  "nextPageToken": "opaque-page-cursor"
}
```

Activity pages are bounded. Use `nextPageToken` to request later pages; do not treat the first page as complete history. Activity records use `createTime`, `originator`, `description`, an event payload (for example `planGenerated`, `planApproved`, `userMessaged`, `agentMessaged`, `progressUpdated`, `sessionCompleted`, or `sessionFailed`), and optional `artifacts`. Change-set patches are nested at `artifacts[].changeSet.gitPatch` and can include `baseCommitId`, `unidiffPatch`, and `suggestedCommitMessage`.

---

### jules://sessions/{id}/full

**Description:** Session details and a bounded activity page including plan and progress context

**URI Pattern:** `jules://sessions/{sessionId}/full`

**MIME Type:** `application/json`

#### Response Format

```json
{
  "session": {
    "id": "abc123",
    "title": "Fix auth bug",
    "state": "AWAITING_PLAN_APPROVAL",
    "prompt": "Fix the authentication timeout issue...",
    "repository": "sources/github-owner-backend",
    "branch": "main",
    "automationMode": "AUTO_CREATE_PR",
    "requirePlanApproval": true,
    "created": "2025-01-15T10:00:00Z",
    "updated": "2025-01-15T10:05:00Z"
  },
  "activities": [
    {
      "name": "sessions/abc123/activities/activity-1",
      "createTime": "2025-01-15T10:04:00Z",
      "originator": "agent",
      "description": "Plan generated",
      "planGenerated": { "plan": { "steps": ["Analyze configuration"] } },
      "artifacts": []
    },
    {
      "name": "sessions/abc123/activities/activity-2",
      "createTime": "2025-01-15T10:05:00Z",
      "originator": "agent",
      "description": "Awaiting plan approval",
      "progressUpdated": {},
      "artifacts": []
    }
  ],
  "activityCount": 2,
  "activitiesComplete": true
}
```

The activity fields above reflect the current Jules shape; activity payloads are event-specific. A session may have more activities than fit in the bounded page; check `activitiesComplete` and `nextPageToken`.

---

### jules://sessions/{id}/diff

**Description:** unified diff of proposed changes for a specific session

**URI Pattern:** `jules://sessions/{sessionId}/diff`

**MIME Type:** `application/json`

#### Response Format

```json
{
  "sessionId": "abc123",
  "activityName": "sessions/abc123/activities/activity-4",
  "createTime": "2025-01-15T10:08:00Z",
  "source": "sources/github-owner-backend",
  "complete": true,
  "baseCommitId": "a1b2c3d4",
  "unidiffPatch": "--- a/src/api.ts\n+++ b/src/api.ts\n@@ ...",
  "suggestedCommitMessage": "Fix authentication timeout"
}
```

The resource selects the latest available `artifacts[].changeSet.gitPatch` from bounded activity history and returns its `baseCommitId`, `unidiffPatch`, suggested commit message, and source. Check `complete` and `nextPageToken` when history exceeds the page cap.

---

### jules://schedules

**Description:** All locally-managed scheduled tasks

**MIME Type:** `application/json`

#### Response Format

```json
{
  "description": "Locally-managed scheduled Jules tasks",
  "count": 2,
  "schedules": [
    {
      "id": "uuid-1",
      "name": "Weekly Deps Update",
      "cron": "0 9 * * 1",
      "enabled": true,
      "repository": "sources/github-owner-repo",
      "prompt": "Update all dependencies...",
      "nextRun": "2025-01-20T09:00:00Z",
      "lastRun": "2025-01-13T09:00:00Z",
      "lastSessionId": "session-xyz"
    }
  ]
}
```

**Usage:** Audit active schedules, check next execution times.

---

### jules://schedules/history

**Description:** Execution history of scheduled tasks

**MIME Type:** `application/json`

#### Response Format

```json
{
  "description": "Execution history of scheduled tasks",
  "count": 10,
  "history": [
    {
      "taskName": "Weekly Deps Update",
      "executedAt": "2025-01-13T09:00:00Z",
      "sessionId": "session-xyz",
      "prompt": "Update all dependencies to latest versions..."
    }
  ]
}
```

**Usage:** Audit trail for compliance and debugging.

---

## Tools

Tools are executable functions that perform actions.

### create_coding_task

**Description:** Creates an immediate Jules coding session

#### Parameters

| Parameter | Type | Required | Default | Description |
| ----------- | ------ | ---------- | --------- | ------------- |
| `prompt` | string | Yes | - | Natural language task instruction |
| `source` | string | Yes | - | Exact opaque Jules source name from `list_sources` or `jules://sources` |
| `branch` | string | No | Jules default branch | Git branch to base changes on; omitted branch is resolved from source metadata |
| `auto_create_pr` | boolean | No | true | Automatically create Pull Request |
| `require_plan_approval` | boolean | No | false | Pause for manual plan review |
| `title` | string | No | - | Optional session title |

#### Returns

```json
{
  "success": true,
  "sessionId": "abc123",
  "state": "PLANNING",
  "message": "Session created and executing automatically.",
  "monitorUrl": "https://jules.google/sessions/abc123"
}
```

#### Error Response

```json
{
  "success": false,
  "error": "Repository not found. Please check jules://sources"
}
```

**Consequential:** No (returns immediately; actual code changes happen asynchronously)

---

### manage_session (compatibility tool)

**Description:** Manage active sessions (approve plans, send feedback)

#### Parameters

| Parameter | Type | Required | Description |
| ----------- | ------ | ---------- | ------------- |
| `session_id` | string | Yes | Session ID to manage |
| `action` | enum | Yes | "approve_plan" or "send_message" |
| `message` | string | Conditional | Required if action is "send_message" |

#### Returns

```json
{
  "success": true,
  "message": "Plan approved. Session is now executing.",
  "newState": "IN_PROGRESS"
}
```

Use `approve_plan` and `send_session_message` for narrowly-scoped operations. Jules has no separate plan-rejection endpoint; use `delete_session` only when the intention is to delete the session.

---

### approve_plan and send_session_message

`approve_plan` takes `session_id` and approves a plan awaiting approval. `send_session_message` takes `session_id` and `message` to provide feedback or reply to Jules. Both are external writes; neither has a separate plan-rejection variant.

---

### get_session_status

**Description:** Get current status and guidance for next steps

#### Parameters

| Parameter | Type | Required | Description |
| ----------- | ------ | ---------- | ------------- |
| `session_id` | string | Yes | Session ID |

#### Returns

```json
{
  "sessionId": "abc123",
  "title": "Fix auth bug",
  "state": "AWAITING_PLAN_APPROVAL",
  "prompt": "Fix the authentication timeout...",
  "repository": "sources/github-owner-backend",
  "updated": "2025-01-15T10:05:00Z",
  "nextSteps": "Plan is ready. Read jules://sessions/abc123/full to review the plan, then call approve_plan to proceed."
}
```

**Consequential:** No (read-only)

---

### schedule_recurring_task

**Description:** Schedule a task to run automatically on a cron schedule

#### Parameters

| Parameter | Type | Required | Default | Description |
| ----------- | ------ | ---------- | --------- | ------------- |
| `task_name` | string | Yes | - | Unique schedule identifier |
| `cron_expression` | string | Yes | - | Cron format (minute hour day month weekday) |
| `prompt` | string | Yes | - | Task instruction |
| `source` | string | Yes | - | Repository resource name |
| `branch` | string | No | "main" | Git branch |
| `auto_create_pr` | boolean | No | true | Auto-create PRs |
| `require_plan_approval` | boolean | No | false | Require approval |
| `timezone` | string | No | System TZ | Timezone for cron |

**Cron Format:** `minute(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-6)`

#### Returns

```json
{
  "success": true,
  "message": "Task 'Weekly Deps Update' scheduled successfully",
  "scheduleId": "uuid-here",
  "cron": "0 9 * * 1",
  "nextExecution": "2025-01-20T09:00:00Z"
}
```

**Consequential:** Yes (creates persistent schedule that will execute autonomously)

---

### list_schedules

**Description:** List all active scheduled tasks

**Parameters:** None

#### Returns

```json
{
  "success": true,
  "count": 2,
  "schedules": [
    {
      "id": "uuid-1",
      "name": "Weekly Deps Update",
      "cron": "0 9 * * 1",
      "enabled": true,
      "repository": "sources/github-owner-repo",
      "prompt": "Update all dependencies...",
      "nextRun": "2025-01-20T09:00:00Z",
      "lastRun": "2025-01-13T09:00:00Z",
      "lastSessionId": "session-xyz"
    }
  ]
}
```

**Consequential:** No (read-only)

---

### delete_schedule

**Description:** Remove a scheduled task

#### Parameters

| Parameter | Type | Required | Description |
| ----------- | ------ | ---------- | ------------- |
| `task_name` | string | Yes | Name of schedule to delete |

#### Returns

```json
{
  "success": true,
  "message": "Schedule 'Weekly Deps Update' deleted successfully"
}
```

**Consequential:** Yes (permanently removes schedule)

---

### wait_for_session

**Description:** Wait a bounded time for a session to reach a target state.

#### Parameters

| Parameter | Type | Required | Default | Description |
| ----------- | ------ | ---------- | --------- | ------------- |
| `session_id` | string | Yes | - | Jules session ID |
| `timeout_seconds` | number | No | 30 | Maximum wait, configurable up to 1800 seconds |
| `poll_interval_seconds` | number | No | 10 | Polling interval |
| `target_states` | string[] | No | Terminal and user-action states | States that stop waiting |

The default stop states include `COMPLETED`, `FAILED`, `AWAITING_PLAN_APPROVAL`, `AWAITING_USER_FEEDBACK`, and `PAUSED`. A timeout returns a normal result with the last observed state and `timedOut: true`.

---

### delete_session

**Description:** Delete a Jules session

#### Parameters

| Parameter | Type | Required | Description |
| ----------- | ------ | ---------- | ------------- |
| `session_id` | string | Yes | Session ID |

#### Returns

```json
{
  "success": true,
  "message": "Session 'abc123' deleted successfully"
}
```

Jules exposes deletion, not a separate rejection action. The tool does not invent a resulting session state.

---

### get_source_details

**Description:** Get detailed information about a source repository

#### Parameters

| Parameter | Type | Required | Description |
| ----------- | ------ | ---------- | ------------- |
| `source_name` | string | Yes | Exact opaque source name returned by Jules |

#### Returns

```json
{
  "success": true,
  "name": "sources/github-owner-repo",
  "repository": "owner/repo",
  "defaultBranch": "main",
  "url": "https://github.com/owner/repo",
  "metadata": { ... }
}
```

**Consequential:** No (read-only)

---

## Prompts

Prompts are templates that help users leverage Jules effectively.

### refactor_module

**Description:** Guided refactoring workflow with clear goals

#### Arguments

- `repository` (required) - Repository name (owner/repo)
- `module_path` (required) - Path to file/module
- `goal` (required) - Refactoring objective

#### Rendered Output

```text
I want to refactor the module at src/auth/login.ts in repository myorg/backend.

Goal: improve performance

Please create a Jules coding task with a detailed prompt that:
1. Identifies the specific files to modify
2. Explains the refactoring goal clearly
3. Specifies any patterns or conventions to follow
4. Includes test requirements

Discover the repository with `list_sources` or `jules://sources`, then pass its exact returned Jules source name to `create_coding_task`. Do not construct or rewrite source names.
```

---

### setup_weekly_maintenance

**Description:** Automated weekly maintenance setup

#### Arguments

- `repository` (required) - Repository name
- `tasks` (required) - Comma-separated task list

#### Rendered Output

```text
I want to set up weekly automated maintenance for repository myorg/frontend.

Maintenance tasks to include:
- dependency updates
- linter fixes
- security audit

Please use the schedule_recurring_task tool with:
- Cron expression: "0 3 * * 1" (Every Monday at 3 AM)
- A comprehensive prompt covering all tasks
- Auto-create PR: true
- Source: use the exact returned Jules source name; do not construct or rewrite it
```

---

### audit_security

**Description:** Comprehensive security audit task

#### Arguments

- `repository` (required) - Repository name

**Includes:** OWASP Top 10 checks, dependency vulnerabilities, secret scanning

---

### fix_failing_tests

**Description:** Test failure resolution template

#### Arguments

- `repository` (required)
- `test_command` (required) - How to run tests

---

### update_dependencies

**Description:** Dependency update with breaking change handling

#### Arguments

- `repository` (required)
- `package_manager` (required) - npm, yarn, or pnpm

---

## Session State Machine

Understanding session states is crucial for monitoring:

```text
QUEUED
  ↓
PLANNING (Jules analyzing code)
  ↓
AWAITING_PLAN_APPROVAL (if required)
  ↓ (after approve_plan)
IN_PROGRESS (Jules making changes)
  ↓
COMPLETED, FAILED, or a future Jules state
```

### State-Specific Actions

| State | Recommended Action |
| ------- | ------------------- |
| `QUEUED` | Wait, no action needed |
| `PLANNING` | Wait for plan generation |
| `AWAITING_PLAN_APPROVAL` | Read plan, then approve or send feedback |
| `AWAITING_USER_FEEDBACK` | Read activities and send the requested feedback |
| `PAUSED` | Inspect session status and activities for the next required action |
| `IN_PROGRESS` | Monitor progress via activities |
| `COMPLETED` | Review PR and merge if satisfactory |
| `FAILED` | Read activities to diagnose, may need new session |

## Rate Limits and Quotas

Jules API has usage limits (exact limits not public, likely based on tier):

- **Concurrent sessions:** Limited (varies by account)
- **Daily tasks:** Limited (free tier may have lower limits)

### Best Practices

- Don't create excessive scheduled tasks
- Monitor usage via `jules://sessions/list`
- Space out scheduled task execution times

## Error Codes

Common errors and their meanings:

| Error | Cause | Solution |
| ------- | ------- | ---------- |
| "JULES_API_KEY environment variable is required" | Missing API key | Set JULES_API_KEY |
| "Repository not found" | Source not connected or invalid name | Check jules://sources |
| "Invalid cron expression" | Malformed cron string | Use format: minute hour day month weekday |
| "A schedule named 'X' already exists" | Name collision | Use delete_schedule or different name |
| "Jules API error: 401" | Invalid API key | Verify key in Jules settings |
| "Jules API error: 404" | Resource not found | Check session ID or source name |
| "Jules API error: 429" | Rate limit exceeded | Wait and retry |

## Extending the Server

### Adding Custom Tools

To add a new tool, modify `src/mcp/tools.ts`:

```typescript
export const MyCustomSchema = z.object({
  param1: z.string(),
});

export class JulesTools {
  async myCustomTool(args: z.infer<typeof MyCustomSchema>): Promise<string> {
    // Implementation
    return JSON.stringify({ success: true });
  }
}
```

Then register in `src/index.ts`:

```typescript
{
  name: 'my_custom_tool',
  description: 'Does something custom',
  inputSchema: zodToJsonSchema(MyCustomSchema),
}
```

### Adding Custom Resources

Modify `src/mcp/resources.ts`:

```typescript
async getMyCustomResource(): Promise<string> {
  const data = await this.client.someApiCall();
  return JSON.stringify({ formatted: data });
}
```

Register in `src/index.ts` resource list and handler.

## Implementation Notes

### Asynchronous Execution

Jules sessions are **asynchronous**. The `create_coding_task` tool returns immediately with a session ID. The actual work happens in the background.

**Implication:** AI assistants can poll with `get_session` or use `wait_for_session`. The wait tool defaults to 30 seconds, returns a structured timeout with the last observed state, and stops by default when Jules needs user input.

### Polling Best Practices

To avoid excessive API calls:

- Poll every 30-60 seconds for active sessions
- Use exponential backoff for completed sessions
- Cache session status locally for a few seconds

### Local vs Remote State

#### Remote State (Jules API)

- Sessions and their activities
- Source repository list

#### Local State (MCP Server)

- Scheduled tasks
- Schedule execution history

This hybrid model means schedules are not visible in the Jules web UI (they're local to the MCP server).

## Google Jules REST API Overview

The Jules MCP server acts as an integration layer over the Google Jules REST API (v1alpha). The core API concepts from Google's official documentation include:

### Core API Concepts

The API is structured around three primary resource types:

- **Source:** Represents the codebase Jules will work on (currently supports GitHub repositories). The Jules GitHub app must be installed before a repository can be used as a source.
- **Session:** A continuous unit of work or "project" initiated with a natural language prompt and a specific source.
- **Activity:** Individual events within a session, such as the agent generating a plan, a user sending a message, or progress updates.

### Technical Specifications

- **Base URL:** `https://jules.googleapis.com/v1alpha`
- **Authentication:** Uses API keys passed in the `X-Goog-Api-Key` header. Keys are managed at [jules.google.com/settings](https://jules.google.com/settings).
- **Resource Naming:** Session and activity resource names follow the API contract. Source names are opaque values in the `sources/{source}` resource form; use the exact source name returned by Jules.

### Common API Operations Supported by this Server

| Task | Method | Endpoint |
| :--- | :--- | :--- |
| **List Sources** | `GET` | `/v1alpha/sources` |
| **Get Source** | `GET` | `/v1alpha/sources/{name}` |
| **Create Session** | `POST` | `/v1alpha/sessions` |
| **List Sessions** | `GET` | `/v1alpha/sessions` |
| **Get or Delete Session** | `GET`, `DELETE` | `/v1alpha/sessions/{id}` |
| **Send Message** | `POST` | `/v1alpha/sessions/{id}:sendMessage` |
| **Approve Plan** | `POST` | `/v1alpha/sessions/{id}:approvePlan` |
| **List Activities** | `GET` | `/v1alpha/sessions/{id}/activities` |

**Documentation Links:**

- [Google for Developers - Jules API Reference](https://developers.google.com/jules/api/reference/rest)
- [Jules API Quickstart](https://developers.google.com/jules/docs/quickstart)

## Version Compatibility

| Component | Version | Notes |
| ----------- | --------- | ------- |
| Jules API | v1alpha | Experimental, may change |
| MCP Protocol | 2025-11-25 and 2026-07-28 | Legacy and current stdio negotiation |
| Node.js | >=20.0.0 | Runtime floor for MCP TypeScript SDK v2 |
| TypeScript | >=5.0.0 | For strict type checking |

## Additional Resources

- **Jules Quickstart:** <https://jules.google/docs/api/reference/>
- **Jules API Reference:** <https://developers.google.com/jules/api/reference/rest>
- **MCP Specification:** <https://modelcontextprotocol.io/docs>
- **MCP TypeScript SDK:** <https://github.com/modelcontextprotocol/typescript-sdk>
- **Cron Expression Tester:** <https://crontab.guru>
