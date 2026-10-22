// Loaded only by the offline smoke subprocess. Every fetch is intercepted.
import assert from 'node:assert/strict';

const source = {
  name: 'sources/fixture-repository',
  githubRepo: { owner: 'smoke', repo: 'repo', defaultBranch: { displayName: 'main' } },
};
let session;
let feedbackReceived = false;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://jules.googleapis.com');
  const route = url.pathname.replace('/v1alpha', '');
  const body = options.body ? JSON.parse(options.body) : {};
  let payload;
  if (route === '/sources') payload = { sources: [source] };
  else if (route === '/sources/fixture-repository') payload = source;
  else if (route === '/sessions' && options.method === 'POST') {
    if (body.prompt === 'Simulate uncertain task creation fixture') return new Response('{}', { status: 503 });
    assert.equal(body.requirePlanApproval, true);
    assert.equal(body.automationMode, 'AUTO_CREATE_PR');
    assert.equal(body.sourceContext.source, source.name);
    session = { ...body, id: 'fixture-session', name: 'sessions/fixture-session', state: 'AWAITING_PLAN_APPROVAL' };
    payload = session;
  } else if (route === '/sessions') payload = { sessions: session ? [session] : [] };
  else if (route === '/sessions/fixture-session') payload = session;
  else if (route === '/sessions/fixture-session:sendMessage') {
    assert.ok(body.prompt);
    feedbackReceived = true;
    payload = {};
  } else if (route === '/sessions/fixture-session:approvePlan') {
    assert.ok(feedbackReceived);
    session.state = 'COMPLETED';
    payload = {};
  } else if (route === '/sessions/fixture-session/activities') {
    assert.ok(!url.searchParams.has('filter'));
    payload = url.searchParams.get('pageToken') === 'patch-page' ? {
      activities: [{ id: 'patch', createTime: '2026-01-02T00:01:00Z', artifacts: [{ changeSet: { source: source.name, gitPatch: { baseCommitId: 'fixture', unidiffPatch: 'diff --git a/file.ts b/file.ts\n+fixed\n' } } }] }],
    } : {
      activities: [{ id: 'plan', createTime: '2026-01-02T00:00:00Z', planGenerated: { plan: { id: 'plan-1', steps: [{ id: '1', title: 'Inspect and fix the bug' }] } } }],
      nextPageToken: 'patch-page',
    };
  } else throw new Error(`Unexpected offline fixture request: ${options.method ?? 'GET'} ${route}`);
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
