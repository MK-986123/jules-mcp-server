# Connect Jules to ChatGPT and Codex

Research checked on October 21, 2026 (America/Los_Angeles). This guide distinguishes the bridge's local checks from an authenticated Jules call and a successful ChatGPT connection. The selected deployment target is the existing computer, with `MK-986123/jules-mcp-server` as the pilot repository.

## Supported connection paths

This server speaks MCP over **stdio**. Local MCP clients such as Codex can launch it directly. ChatGPT needs a reachable MCP connection; it cannot launch this process directly on your computer.

The recommended private connection is **OpenAI Secure MCP Tunnel**, which supports an existing stdio server. This preserves the current server and avoids a public listener. A separately hosted HTTPS endpoint with OAuth 2.1 is another option, but this repository does not implement that hosting or OAuth flow. ChatGPT cannot present a custom static API key to an MCP server; a bearer-token-only HTTP wrapper is therefore insufficient for direct ChatGPT authentication.

Sources: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [plugin authentication](https://developers.openai.com/plugins/build/auth), [connecting custom MCP servers](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

## Account and host prerequisites

1. Sign in to [Jules](https://jules.google.com) and connect the intended GitHub repositories. The Jules Sources API can read existing connections; it cannot create them. The ChatGPT GitHub connector and the Jules GitHub app have separate authorization.
2. Generate a Jules API key in [Jules settings](https://jules.google.com/settings), and make it available to the bridge as `JULES_API_KEY` through the host's secret mechanism. Do not paste it into a chat, task prompt, command argument, or repository.
3. For the pilot, set `JULES_ALLOWED_REPOS=MK-986123/jules-mcp-server`. Use a separate persistent `JULES_ENCRYPTION_KEY` for schedule storage. Store the API and encryption keys outside version control.
4. Run the bridge and tunnel client on the selected existing computer. A sleeping laptop or an ephemeral development environment cannot provide continuous availability. The computer must be online before live setup can be verified.
5. Verify permission to create and use a custom MCP plugin in the target ChatGPT workspace. The current OpenAI help article describes full read/write MCP support for Business and Enterprise/Edu on the web, and read/fetch custom connections for Pro. Product availability and workspace controls must be checked in the actual account. Creating a custom connection on mobile is not supported by that article.
6. For the tunnel, obtain an actual `tunnel_id` from [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels). Creating or editing a tunnel requires Tunnels **Read + Manage**; running the client and selecting it require **Read + Use**. Associate it with the target ChatGPT workspace and relevant Platform organization. The tunnel runtime credential is separate from the Jules API key.

Sources: [Jules authentication](https://jules.google/docs/api/reference/authentication), [Jules sources](https://jules.google/docs/api/reference/sources), [OpenAI connection permissions](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt), [tunnel permissions and associations](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Prepare the bridge

From the checked-out repository, install the locked dependencies and run:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run mcp:smoke
npm run doctor
```

The smoke test is an offline protocol check. `npm run doctor` checks the built server and required configuration without printing key values or contacting Jules. A `MISSING` result means configuration still needs attention; neither command proves access to your Jules account.

After configuring the real key, allowlist, and encryption key, run:

```bash
npm run doctor -- --live
```

This adds a read-only Jules sources request; it never creates a coding session. It checks whether the allowed repositories appear on the first source page. If more pages are reported, inspect them using `list_sources` and its continuation tokens. Copy the returned source name exactly; do not derive it from a GitHub URL. Do not create a task merely to test credentials.

Use a launcher that changes into the repository directory before running `node dist/index.js` if you rely on a local `.env` file: dotenv resolves that file relative to the working directory. Prefer the host's environment/secret facility for a persistent service. Keep the bridge's normal stdout reserved for MCP traffic.

Set `JULES_STORAGE_DIR` to a dedicated, persistent directory on the existing computer if the default `~/.jules-mcp` is unsuitable. Preserve that directory and its encryption key across restarts. Run exactly one bridge process, managed by one tunnel-client profile, per schedule storage directory. Parallel bridge copies would each load and execute the same schedules; do not point a second local client or tunnel profile at that directory. Use separate storage directories for isolated test instances.

## Configure Secure MCP Tunnel

Download `tunnel-client` from [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) or the official [latest release](https://github.com/openai/tunnel-client/releases/latest). Verify the installed client's own help; keep runbooks linked to the latest release rather than a pinned download URL.

The following commands follow the official tunnel guide. Replace the tunnel ID and absolute path with actual values, and provide `CONTROL_PLANE_API_KEY` through the runtime environment without writing its value in a command or chat. The bridge process must also receive its Jules environment variables. If using a repository-specific launcher, use its absolute path as `--mcp-command` instead.

```bash
tunnel-client help quickstart

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile jules \
  --tunnel-id YOUR_ACTUAL_TUNNEL_ID \
  --mcp-command "node /absolute/path/to/jules-mcp-server/dist/index.js"

tunnel-client doctor --profile jules --explain
tunnel-client run --profile jules
```

Keep the client running while discovering tools and using the plugin. The official client exposes local health/readiness endpoints and a loopback admin UI at `/ui`. Confirm readiness and active polling before trying ChatGPT. The tunnel requires outbound HTTPS to OpenAI and local access to the stdio server; it does not require inbound public access.

The tunnel forwards requests; it does not add Jules authentication or repository authorization. Preserve those controls in the bridge. Its documented per-request deadline is 120 seconds, so use short status/wait calls and resume monitoring across calls instead of holding one request open for an entire coding task.

## Connect and verify in ChatGPT

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button, then **Add custom MCP server**.
2. Under **Connection**, choose **Tunnel** and select the same tunnel or enter its actual ID. If it is missing, check the workspace association and **Read + Use** permission.
3. Configure the connection's authentication according to the selected private-server setup and workspace policy. Review the displayed risk warning, then create the plugin and inspect the discovered tools. Keep it private to the intended account/workspace during testing.
4. Select the resulting plugin in a new chat and ask it to list Jules sources. Confirm that the response comes from your account and includes the expected repository.
5. Run one agreed, bounded task with `require_plan_approval: true` and `auto_create_pr: true`. Read the plan with `get_session_review`, request a revision with `manage_session` if necessary, and approve the selected plan only after review.
6. Read activity and patch evidence, then inspect the resulting pull request using the GitHub connector. Compare changed files and check results against the brief before deciding to merge.

A connected GitHub plugin helps select work and review PRs. It does not grant this bridge a Jules API key, install the Jules GitHub app, or create the tunnel.

## Verification checkpoints

| Checkpoint | Evidence required |
| --- | --- |
| Local implementation | Typecheck, lint, tests, and MCP smoke actually pass |
| Jules authentication | `npm run doctor -- --live` succeeds, and paginated source discovery confirms the pilot repository in the intended Jules account |
| Tunnel | `doctor` succeeds, client is ready, and polling is active |
| ChatGPT connection | The installed plugin executes `list_sources` from a chat |
| Controlled work cycle | A task waits for plan approval; feedback, approval, activity, diff, and PR review all work |

At the time this guide was written, no live Jules credential or tunnel ID was available in this workspace, and the selected existing computer was not online through the available connection. Live account authentication, persistent hosting, tunnel readiness, and the ChatGPT work cycle therefore remain unverified. Passing local checks must not be reported as a completed ChatGPT integration.

## Troubleshooting

- **No sources:** Check the Jules account and GitHub app repository selection, then refresh Jules. Do not add credentials to prompts.
- **Tunnel absent:** Check the target ChatGPT workspace association, Platform organization, and **Read + Use** permission. Organization-only association is insufficient for a different workspace.
- **Discovery fails:** Keep the tunnel process running, rerun `doctor`, and confirm the stdio command starts successfully in the configured environment.
- **Tools differ from the server:** ChatGPT can retain an approved snapshot of tool definitions. An authorized owner/admin must refresh and approve the changed tool actions before use; do not recreate duplicate plugins as a refresh strategy.
- **A write action is unavailable:** Inspect actual plan/workspace permissions and app action controls. A successful read does not prove write availability.
- **A mutation times out:** Inspect recent sessions/activities before retrying. An absent response does not prove task creation, feedback, or approval failed.

For operating practices and task selection, see [Jules operations](JULES_OPERATIONS.md).
