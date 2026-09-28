import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpClient } from '@activepieces/pieces-common';
import { createSessionAction } from '../dist/lib/actions/create-session.js';
import {
  approvePlan,
  listActivities,
  listSources,
  sendMessage,
} from '../dist/lib/api.js';

const source = {
  name: 'sources/github-myorg-myrepo',
  githubRepo: {
    owner: 'myorg',
    repo: 'myrepo',
    htmlUrl: 'https://github.com/myorg/myrepo',
    defaultBranch: { displayName: 'trunk' },
    branches: [{ displayName: 'trunk' }, { displayName: 'release' }],
    isPrivate: true,
  },
};

async function withMockedRequests(handler, run) {
  const original = httpClient.sendRequest;
  httpClient.sendRequest = handler;
  try {
    await run();
  } finally {
    httpClient.sendRequest = original;
  }
}

test('empty approval and message responses issue one POST each then GET state', async () => {
  for (const [operation, expectedPath, args] of [
    [approvePlan, '/v1alpha/sessions/session-1:approvePlan', ['session-1']],
    [
      sendMessage,
      '/v1alpha/sessions/session-1:sendMessage',
      ['session-1', 'feedback'],
    ],
  ]) {
    const requests = [];
    await withMockedRequests(async (request) => {
      requests.push(request);
      if (request.method === 'POST') return { body: undefined };
      return {
        body: { name: 'sessions/session-1', id: 'session-1', prompt: 'task' },
      };
    }, async () => {
      const session = await operation({ apiKey: 'test-key' }, ...args);
      assert.equal(session.id, 'session-1');
    });
    assert.deepEqual(
      requests
        .filter((request) => request.method === 'POST')
        .map((request) => new URL(request.url).pathname),
      [expectedPath]
    );
    assert.equal(requests.filter((request) => request.method === 'GET').length, 1);
  }
});

test('source discovery and session creation preserve exact names and resolve the Jules default branch', async () => {
  const requests = [];
  await withMockedRequests(async (request) => {
    requests.push(request);
    if (request.url.endsWith('/sources?pageSize=100')) {
      return { body: { sources: [source] } };
    }
    if (request.url.endsWith(`/${source.name}`)) return { body: source };
    if (request.url.endsWith('/sessions')) {
      return {
        body: {
          name: 'sessions/session-2',
          id: 'session-2',
          prompt: 'Fix a bug in this repository',
          sourceContext: {
            source: source.name,
            githubRepoContext: { startingBranch: 'trunk' },
          },
        },
      };
    }
    throw new Error(`Unexpected Jules API request: ${request.url}`);
  }, async () => {
    const listed = await listSources({ apiKey: 'test-key' });
    assert.equal(listed.sources[0].name, source.name);
    const session = await createSessionAction.run({
      auth: { apiKey: 'test-key' },
      propsValue: {
        repository: listed.sources[0].name,
        prompt: 'Fix a bug in this repository',
        autoCreatePR: true,
      },
    });
    assert.equal(session.sourceContext.source, source.name);
    assert.equal(
      session.sourceContext.githubRepoContext.startingBranch,
      'trunk'
    );
    assert.ok(requests.some((request) => request.url.endsWith(`/${source.name}`)));
    const creation = requests.find((request) => request.url.endsWith('/sessions'));
    assert.equal(creation.body.sourceContext.source, source.name);
    assert.equal(creation.body.sourceContext.githubRepoContext.startingBranch, 'trunk');
  });
});

test('activity listing preserves current Jules event and change-set artifact fields', async () => {
  const activity = {
    name: 'sessions/session-1/activities/activity-1',
    createTime: '2026-01-15T10:04:00Z',
    originator: 'agent',
    description: 'Changes ready',
    planApproved: {},
    artifacts: [
      {
        changeSet: {
          gitPatch: {
            baseCommitId: 'abc123',
            unidiffPatch: '--- a/file.ts\n+++ b/file.ts',
            suggestedCommitMessage: 'Update file',
          },
        },
      },
    ],
  };
  await withMockedRequests(async () => ({
    body: { activities: [activity], nextPageToken: 'next-page' },
  }), async () => {
    const response = await listActivities({ apiKey: 'test-key' }, 'session-1');
    assert.equal(response.activities[0].createTime, activity.createTime);
    assert.deepEqual(
      response.activities[0].artifacts[0].changeSet.gitPatch,
      activity.artifacts[0].changeSet.gitPatch
    );
    assert.equal(response.nextPageToken, 'next-page');
  });
});
