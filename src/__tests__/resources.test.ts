import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JulesResources } from '../mcp/resources.js';
import type { JulesClient } from '../api/jules-client.js';
import type { ScheduleStorage } from '../storage/schedule-store.js';
import type { CronEngine } from '../scheduler/cron-engine.js';

describe('JulesResources', () => {
  let clientMock: JulesClient;
  let storageMock: ScheduleStorage;
  let schedulerMock: CronEngine;
  let resources: JulesResources;

  beforeEach(() => {
    clientMock = {
      listSessions: vi.fn(),
      getSession: vi.fn(),
      listActivities: vi.fn(),
      listSources: vi.fn(),
    } as unknown as JulesClient;

    storageMock = {
      listTasks: vi.fn().mockResolvedValue([]),
    } as unknown as ScheduleStorage;

    schedulerMock = {
      getNextInvocation: vi.fn().mockReturnValue(null),
    } as unknown as CronEngine;

    resources = new JulesResources(clientMock, storageMock, schedulerMock);
  });

  it('getSessionsList returns formatted sessions', async () => {
    (clientMock.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessions: [
        {
          id: 'abc123',
          title: 'Test Task',
          state: 'COMPLETED',
          prompt: 'Fix the bug',
          sourceContext: { source: 'sources/github/owner/repo' },
          createTime: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const result = JSON.parse(await resources.getSessionsList());
    expect(result.count).toBe(1);
    expect(result.untrustedContentNotice).toContain('untrusted data');
    expect(result.sessions[0].id).toBe('abc123');
    expect(result.sessions[0].repository).toBe('sources/github/owner/repo');
  });

  it('getSessionsList uses repoless label when sourceContext is absent', async () => {
    (clientMock.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessions: [
        {
          id: 'def456',
          prompt: 'Generate a script',
          state: 'COMPLETED',
        },
      ],
    });

    const result = JSON.parse(await resources.getSessionsList());
    expect(result.sessions[0].repository).toBe('repoless');
  });

  it('getSchedules returns empty list when no tasks', async () => {
    const result = JSON.parse(await resources.getSchedules());
    expect(result.count).toBe(0);
    expect(result.schedules).toEqual([]);
  });

  it('getSources returns formatted sources', async () => {
    (clientMock.listSources as ReturnType<typeof vi.fn>).mockResolvedValue({
      sources: [
        {
          name: 'sources/github/owner/repo',
          githubRepo: {
            owner: 'owner',
            repo: 'repo',
            defaultBranch: { displayName: 'main' },
            branches: [{ displayName: 'main' }],
            isPrivate: false,
            htmlUrl: 'https://github.com/owner/repo',
          },
        },
        {
          name: 'sources/unknown',
        }
      ],
    });

    const result = JSON.parse(await resources.getSources());
    expect(result.count).toBe(2);
    expect(result.sources[0].name).toBe('sources/github/owner/repo');
    expect(result.sources[0].repository).toBe('owner/repo');
    expect(result.sources[0].url).toBe('https://github.com/owner/repo');
    expect(result.sources[1].repository).toBe('Unknown');
    expect(result.sources[0].defaultBranch).toBe('main');
  });

  it('getSessionActivities returns formatted activities', async () => {
    (clientMock.listActivities as ReturnType<typeof vi.fn>).mockResolvedValue({
      activities: [
        {
          name: 'sessions/sess1/activities/1',
          createTime: '2026-01-01T00:00:00Z',
          originator: 'agent',
          description: 'Plan generated',
          planGenerated: { plan: 'Plan details' },
        },
      ],
    });

    const result = JSON.parse(await resources.getSessionActivities('sess1'));
    expect(result.count).toBe(1);
    expect(result.untrustedContentNotice).toContain('untrusted data');
    expect(result.activities[0].createTime).toBe('2026-01-01T00:00:00Z');
    expect(result.activities[0].planGenerated.plan).toBe('Plan details');
  });

  it('getSessionFull returns complete session with activities formatted correctly', async () => {
    (clientMock.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sess-full',
      state: 'COMPLETED',
      sourceContext: {
        source: 'sources/github-myorg-myrepo',
        githubRepoContext: { startingBranch: 'develop' },
      },
      outputs: [
        {
          pullRequest: {
            url: 'https://github.com/owner/repo/pull/1',
            title: 'Fix issue',
          }
        }
      ]
    });

    (clientMock.listActivities as ReturnType<typeof vi.fn>).mockResolvedValue({
      activities: [
        {
          name: 'sessions/sess-full/activities/1',
          createTime: '2026-01-01T00:00:00Z',
          description: 'Plan generated',
          planGenerated: {
            plan: 'Step 1: Code',
          },
          artifacts: [
            { changeSet: { gitPatch: { unidiffPatch: 'diff --git a/test.ts' } } },
          ],
        },
        {
          name: 'sessions/sess-full/activities/2',
          createTime: '2026-01-01T00:01:00Z',
          progressUpdated: { message: 'working', percentage: 50 },
        },
        {
          name: 'sessions/sess-full/activities/3',
          createTime: '2026-01-01T00:02:00Z',
          sessionCompleted: { message: 'done' },
        },
        {
          name: 'sessions/sess-full/activities/4',
          createTime: '2026-01-01T00:03:00Z',
          userMessaged: { prompt: 'do this' },
        },
        {
          name: 'sessions/sess-full/activities/5',
          createTime: '2026-01-01T00:04:00Z',
          agentMessaged: { message: 'I am doing this' },
        },
        {
          name: 'sessions/sess-full/activities/6',
          createTime: '2026-01-01T00:05:00Z',
          planApproved: { approvedAt: '2026-01-01T00:00:00Z' },
        },
        {
          name: 'sessions/sess-full/activities/7',
          createTime: '2026-01-01T00:06:00Z',
          description: 'Future alpha event',
        }
      ],
    });

    const result = JSON.parse(await resources.getSessionFull('sess-full'));
    expect(result.session.id).toBe('sess-full');
    expect(result.untrustedContentNotice).toContain('untrusted data');
    expect(result.session.pullRequests).toHaveLength(1);

    expect(result.activities).toHaveLength(7);
    expect(result.activities[0].createTime).toBe('2026-01-01T00:00:00Z');
    expect(result.activities[0].artifacts[0].changeSet.gitPatch.unidiffPatch).toContain('diff --git');
    expect(result.activities[3].userMessaged.prompt).toBe('do this');
    expect(result.session.branch).toBe('develop');
  });

  it('getSessionFull exposes pagination rather than implying complete history', async () => {
    (clientMock.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sess-full-2',
      state: 'PLANNING',
    });

    (clientMock.listActivities as ReturnType<typeof vi.fn>).mockResolvedValue({
      activities: [
        {
          name: 'sessions/sess-full-2/activities/1',
          createTime: '2026-01-01T00:00:00Z',
          description: 'Activity on first page',
        }
      ],
      nextPageToken: 'next',
    });

    const result = JSON.parse(await resources.getSessionFull('sess-full-2'));
    expect(result.activitiesComplete).toBe(false);
    expect(result.nextPageToken).toBe('next');
  });
});
