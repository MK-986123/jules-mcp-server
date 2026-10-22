#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const storageDir = await mkdtemp(path.join(tmpdir(), 'jules-mcp-smoke-'));
const client = new Client({ name: 'jules-offline-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', fileURLToPath(new URL('./smoke-fixture.mjs', import.meta.url)), path.join(projectRoot, 'dist/index.js')],
  env: {
    PATH: process.env.PATH ?? '',
    JULES_API_KEY: 'offline-fixture-only',
    JULES_ENCRYPTION_KEY: 'offline-fixture-storage-only',
    JULES_ALLOWED_REPOS: 'smoke/repo',
    JULES_STORAGE_DIR: storageDir,
    JULES_API_MAX_RETRIES: '0',
    DOTENV_CONFIG_PATH: path.join(storageDir, 'no-env-file'),
  },
  cwd: projectRoot,
  stderr: 'pipe',
});

/** Calls a tool and decodes its JSON result, failing on protocol/tool errors. */
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, `${name} failed: ${JSON.stringify(response.content)}`);
  return JSON.parse(response.content[0].text);
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['list_sources', 'list_sessions', 'get_session_review', 'get_session_diff', 'manage_session']) {
    assert.ok(tools.some((tool) => tool.name === name), `Missing tool ${name}`);
  }
  const createSchema = tools.find((tool) => tool.name === 'create_coding_task').inputSchema;
  assert.equal(createSchema.properties.require_plan_approval.default, true);
  assert.equal(tools.find((tool) => tool.name === 'get_session_review').annotations.readOnlyHint, true);
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((prompt) => prompt.name === 'prepare_task_brief'));
  const { resources } = await client.listResources();
  assert.ok(resources.some((resource) => resource.uri === 'jules://sources'));

  const sources = await call('list_sources');
  assert.equal(sources.sources[0].name, 'sources/fixture-repository');
  assert.equal((await call('list_sessions')).sessions.length, 0);
  const task = await call('create_coding_task', {
    source: sources.sources[0].name,
    prompt: 'Fix the fixture bug and run focused checks.',
  });
  assert.equal(task.state, 'AWAITING_PLAN_APPROVAL');
  const review = await call('get_session_review', { session_id: task.sessionId });
  assert.equal(review.activities[0].plan.steps[0].title, 'Inspect and fix the bug');
  assert.equal(review.nextPageToken, 'patch-page');
  const waiting = await call('wait_for_session', { session_id: task.sessionId });
  assert.equal(waiting.finalState, 'AWAITING_PLAN_APPROVAL');
  await call('manage_session', { session_id: task.sessionId, action: 'reject_plan', message: 'Keep the fix scoped to one module.' });
  await call('manage_session', { session_id: task.sessionId, action: 'approve_plan' });
  assert.equal((await call('get_session_status', { session_id: task.sessionId })).state, 'COMPLETED');
  const diff = await call('get_session_diff', { session_id: task.sessionId, page_token: review.nextPageToken });
  assert.match(diff.patch, /diff --git/);
  const uncertain = await client.callTool({ name: 'create_coding_task', arguments: { source: sources.sources[0].name, prompt: 'Simulate uncertain task creation fixture' } });
  assert.equal(uncertain.isError, true);
  const failure = JSON.parse(uncertain.content[0].text);
  assert.equal(failure.outcomeUnknown, true);
  assert.match(failure.recovery, /list_sessions/);
  const activities = await call('get_activities_since', { session_id: task.sessionId, since: '2026-01-01T00:00:00Z' });
  assert.equal(activities.nextPageToken, 'patch-page');
  console.log(`[mcp:smoke] PASS: ${tools.length} tools, ${prompts.length} prompts; discovery, creation, plan review, feedback, approval, status, pagination and patch review (offline fixtures; no network).`);
} catch (error) {
  console.error('[mcp:smoke] FAIL:', error);
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
  await rm(storageDir, { recursive: true, force: true });
}
