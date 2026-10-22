# Jules operating practices

Research checked on October 21, 2026 (America/Los_Angeles). This guide combines current official documentation with recommended practices for using ChatGPT/Codex to select, brief, steer, and review Jules work.

## Division of work

Use ChatGPT/Codex to inspect the actual repository and issue, choose a bounded task, write the brief, review the plan, resolve questions, and review the final changes. Jules performs the asynchronous coding work in its cloud VM. GitHub provides the shared issue, branch, pull request, and CI evidence.

Start with one task in one repository. Increase concurrency only for independent changes with separate file ownership and acceptance criteria. Keep plan review and merge decisions distinct: approving an implementation plan does not establish that the resulting code passes review.

## Match tasks to the available environment

These are recommended task families, not a claim that any particular project or account has been inspected or configured.

| Work area | Suitable Jules task | Verification to retain elsewhere |
| --- | --- | --- |
| Software and MCP automation | One API contract repair, connector action, pagination fix, or regression with a focused fixture | Real service authentication, host integration, and representative live call |
| Android | A scoped Kotlin/Java change, Gradle repair, resource correction, or unit test | Device/emulator behavior, permissions, background execution, and hardware features unless the task environment demonstrably supports them |
| Linux/Electron integration | Portable application logic, packaging scripts, or a reproducible build repair | Actual Ubuntu/Wayland/X11 session, tray, portals, GPU, launcher, OAuth callback, and native modules on the target machine |
| AI runtimes and image workflows | Parser/loader contract tests with small fixtures, configuration logic, metadata validation, or a CPU-reproducible bug | GPU/CUDA compatibility, VRAM/OOM behavior, model quality, and full model loading on the intended runtime |
| Repository maintenance | A dependency update with a passing lockfile/build, narrow documentation repair, or one measured optimization | Deployment, release credentials, production behavior, and claimed performance gains without measurements |

Official documentation describes an Ubuntu VM with common language runtimes and setup scripts. It does not establish that the VM has the target desktop session, Android device, GPU, model files, or private network access needed by the last column. Require explicit evidence before assigning acceptance criteria that depend on those capabilities.

Source: [Jules environment setup](https://jules.google/docs/environment/), [FAQ](https://jules.google/docs/faq/).

## Prepare each repository once

1. Authorize only the intended GitHub repositories in the Jules GitHub app and the bridge's `JULES_ALLOWED_REPOS` list. Discover and copy the actual Jules source name; source names are opaque API resource identifiers.
2. Maintain `AGENTS.md` with the repository map, exact install/build/test commands, versions that matter, known constraints, and what counts as completed work. Jules explicitly supports repository instructions through `AGENTS.md`.
3. Configure a lightweight, repeatable setup script in the repository's Jules configuration. Use discrete install/build/test commands, then **Run and Snapshot**. Avoid watch commands or a persistent development server in the setup script.
4. Keep real secrets out of the repository and task brief. If a task actually needs repository-level environment variables, configure and enable them through Jules's supported settings; do not assume the REST create-session body has an environment/secrets field.
5. Run a small task through the entire review cycle before enabling recurring or proactive work.

Sources: [getting started](https://jules.google/docs/), [environment setup](https://jules.google/docs/environment/), [FAQ](https://jules.google/docs/faq/), [environment-variable announcement](https://jules.google/docs/changelog/).

## Use a concrete task brief

```text
Repository and starting branch: <verified repository/branch>
Problem: <observed trigger and current behavior, with issue or file references>
Desired behavior: <specific result>
Scope: <files/components in scope and behavior that must be preserved>
Evidence: <reproduction, relevant logs, existing tests, and confirmed constraints>
Acceptance: <observable checks and exact repository commands>
Runtime limits: <checks needing a real service/device/GPU and how to report them>
Delivery: implement the smallest change, include test evidence and limitations,
and create a reviewable PR. Do not merge or deploy.
Planning: return a plan for review; identify unsupported assumptions and blockers.
```

Replace every placeholder with verified context before dispatch. Avoid broad requests such as “fix everything” or “optimize code.” Do not add unrelated cleanup to an otherwise scoped repair. For performance work, include a reproducible baseline and measurement method; for a bug, include a failing case when possible.

Source: [writing and running tasks](https://jules.google/docs/running-tasks/).

## Operate the feedback loop

1. **Discover:** Use `list_sources` and `get_source_details` to confirm the repository and starting branch. Use the connected GitHub tools to inspect the issue, relevant files, and existing PRs before starting duplicate work.
2. **Dispatch:** Use `create_coding_task` with the exact returned source name, explicit branch, `require_plan_approval: true`, and `auto_create_pr: true`. Keep the returned session ID and URL.
3. **Review the plan:** Use `get_session_review`. Follow all activity continuation tokens before treating a page as the complete record. Check the proposed scope, setup assumptions, acceptance criteria, and any question from Jules.
4. **Steer:** Use `manage_session` with `send_message` or `reject_plan` to request a precise revision. In this bridge, rejecting a plan requests revision through a message; it is not a documented upstream reject/cancel endpoint. It does not delete the session.
5. **Approve:** Use `manage_session` with `approve_plan` once the concrete plan has been reviewed and approval is authorized. This permits Jules to execute; it does not merge the resulting PR.
6. **Monitor:** Use short status/wait calls and `get_activities_since`. This bridge filters each retrieved page by timestamp locally. Follow every continuation token, even if the filtered page is empty, before treating retrieval as complete. Preserve timestamps, deduplicate by activity ID, and inspect new feedback requests. Report changes requiring attention rather than repeating an unchanged status.
7. **Review the result:** Read `get_session_diff`, activity command outputs, and the GitHub PR/checks. Verify the changed behavior against the brief; ask Jules for corrections with concrete evidence. A session state of `COMPLETED` is not independent proof of correctness.

If creation, approval, or feedback returns a timeout, read recent sessions/activities before retrying. The documented API has no idempotency-key field for these mutations, and a lost response can follow a successful action.

Sources: [sessions](https://jules.google/docs/api/reference/sessions), [activities](https://jules.google/docs/api/reference/activities), [reviewing plans](https://jules.google/docs/review-plan/), [reviewing code](https://jules.google/docs/code/).

## Current capabilities and boundaries

- **API access:** The REST API remains experimental `v1alpha`, using `x-goog-api-key`. It supports listing/getting sources, creating/listing/getting/deleting sessions, sending messages, approving plans, and reading activities. Source connection, repository setup, and user preferences are not exposed as configuration endpoints in the reviewed reference.
- **Explicit plan control:** `requirePlanApproval` must be true in the API request. Omitted means automatic approval. The web planning guide also describes timed auto-approval, so do not rely on a prompt alone to enforce the pause.
- **Repoless work:** The API supports starting a session without `sourceContext`. Use it for a self-contained script or prototype; it does not carry repository knowledge, and it cannot replace repository-specific acceptance checks.
- **Activity evidence:** Plans are structured objects under `planGenerated.plan`; patches and command outputs are activity `artifacts`. Activities are immutable. The bridge's `get_activities_since` filters paginated activity results locally and returns the original continuation token. The upstream reference includes a `createTime` query example and the changelog describes a range cursor, but this bridge does not send that parameter and its live behavior was not tested here.
- **Native scheduling:** Jules now has built-in scheduled tasks. The reviewed REST reference contains no scheduling endpoint, so this bridge's cron schedules are separate local state and require the bridge process to remain running. Do not configure the same job in both places. Use an explicit timezone, such as `America/Los_Angeles`, for local schedules. Keep exactly one bridge process and tunnel profile per schedule storage directory to prevent duplicate scheduled executions; `JULES_STORAGE_DIR` can isolate separate instances.
- **GitHub triggers and feedback:** A GitHub issue labeled `jules` can start native work when the Jules GitHub app is authorized. Jules can respond to PR review comments; its global **Reactive Mode** restricts that behavior to comments mentioning `@Jules`. This provides a useful deliberate steering option.
- **CI repair:** The official changelog reports automatic GitHub Actions failure repair for PRs Jules creates. Continue reviewing the resulting commits and checks; the feature is not evidence that arbitrary PRs are covered.
- **MCP inside Jules:** Jules can call selected service MCP servers configured in its settings. This is a separate direction from ChatGPT controlling Jules through this bridge. The official February 2026 announcement listed Linear, Stitch, Neon, Tinybird, Context7, and Supabase; do not infer support for arbitrary custom servers.
- **Limits:** The current plans page lists rolling-24-hour task caps of 15/100/300 and concurrency caps of 3/15/60 for free/Pro/Ultra. Verify the actual account's current allowance before scheduling. The model table on that page conflicts with newer model announcements, so do not select tasks based on a hardcoded model assumption.

Sources: [API quickstart](https://jules.google/docs/api/reference/), [sessions](https://jules.google/docs/api/reference/sessions), [types](https://jules.google/docs/api/reference/types), [activities](https://jules.google/docs/api/reference/activities), [scheduled tasks](https://jules.google/docs/scheduled-tasks/), [task triggers](https://jules.google/docs/running-tasks/), [dated feature announcements](https://jules.google/docs/changelog/), [usage limits](https://jules.google/docs/usage-limits/).

## Reconcile documentation conflicts

The dated official changelog says scheduled tasks gained **Edit**, **Pause**, and **Resume** on January 26, 2026; the scheduled-task guide still says editing is unsupported. Prefer the newer dated announcement and inspect the current UI. Neither source establishes a public REST scheduling endpoint.

The Session types page marks `sourceContext` required, while the session creation page and January 26, 2026 changelog explicitly support repoless sessions. Treat it as optional for creation and handle missing repository context when reading those sessions.

Different official examples use different source-name shapes. Always copy the resource name returned by the Sources API rather than constructing one. Do not infer current account state, subscription, connection success, or execution results from documentation alone.

For the supported ChatGPT connection and verification checkpoints, see [ChatGPT and Codex setup](CHATGPT.md).
