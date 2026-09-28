import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JulesResources } from '../mcp/resources.js';
import type { JulesClient } from '../api/jules-client.js';
import type { ScheduleStorage } from '../storage/schedule-store.js';
import type { CronEngine } from '../scheduler/cron-engine.js';
import type { Activity } from '../types/jules-api.js';

describe('JulesResources — extended coverage', () => {
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

  describe('getSources', () => {
    it('returns formatted source list', async () => {
      (clientMock.listSources as ReturnType<typeof vi.fn>).mockResolvedValue({
        sources: [
          {
            name: 'sources/github/owner/repo',
            githubRepo: {
              owner: 'owner',
              repo: 'repo',
              defaultBranch: { displayName: 'main' },
              htmlUrl: 'https://github.com/owner/repo',
            },
          },
        ],
      });

      const result = JSON.parse(await resources.getSources()) as { count: number; sources: { repository: string }[] };
      expect(result.count).toBe(1);
      expect(result.sources[0].repository).toBe('owner/repo');
    });
  });

  describe('getSessionActivities', () => {
    it('returns current activity fields and cursor metadata', async () => {
      (clientMock.listActivities as ReturnType<typeof vi.fn>).mockResolvedValue({
        activities: [{
          name: 'sessions/sess-1/activities/1',
          createTime: '2026-01-01T00:00:00Z',
          originator: 'agent',
          description: 'Plan generated',
          planGenerated: { plan: 'Plan' },
        }],
        nextPageToken: 'cursor-1',
      });

      const result = JSON.parse(await resources.getSessionActivities('sess-1')) as {
        sessionId: string;
        count: number;
        complete: boolean;
        nextPageToken: string;
        activities: { createTime: string }[];
      };
      expect(result.sessionId).toBe('sess-1');
      expect(result.count).toBe(1);
      expect(result.complete).toBe(false);
      expect(result.nextPageToken).toBe('cursor-1');
      expect(result.activities[0].createTime).toBe('2026-01-01T00:00:00Z');
    });
  });

  describe('getSessionFull', () => {
    it('returns combined session and activities', async () => {
      (clientMock.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-1',
        title: 'Test Session',
        state: 'COMPLETED',
        prompt: 'fix the tests',
        createTime: '2026-01-01T00:00:00Z',
      });
      (clientMock.listActivities as ReturnType<typeof vi.fn>).mockResolvedValue({
        activities: [
          {
            name: 'sessions/sess-1/activities/1',
            createTime: '2026-01-01T01:00:00Z',
            originator: 'agent',
            description: 'Session completed',
            sessionCompleted: { message: 'Done' },
          },
        ],
      });

      const result = JSON.parse(await resources.getSessionFull('sess-1')) as { session: { id: string }; activities: unknown[] };
      expect(result.session.id).toBe('sess-1');
      expect(result.activities).toHaveLength(1);
    });
  });

  describe('getSessionDiff', () => {
    it('returns current git patch artifact metadata', async () => {
      const activity: Activity = {
        name: 'sessions/sess-1/activities/plan-generated-1',
        createTime: '2026-01-01T00:00:00Z',
        artifacts: [
          {
            changeSet: {
              gitPatch: {
                baseCommitId: 'abc123',
                unidiffPatch: 'diff --git a/file.ts',
                suggestedCommitMessage: 'Fix the thing',
              },
            },
          },
        ],
      };
      (clientMock.listActivities as ReturnType<typeof vi.fn>).mockResolvedValue({
        activities: [activity],
      });
      (clientMock.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sess-1',
        sourceContext: { source: 'sources/github-myorg-myrepo' },
      });

      const result = JSON.parse(await resources.getSessionDiff('sess-1')) as {
        unidiffPatch: string;
        baseCommitId: string;
        suggestedCommitMessage: string;
        source: string;
      };
      expect(result.unidiffPatch).toContain('diff --git');
      expect(result.baseCommitId).toBe('abc123');
      expect(result.suggestedCommitMessage).toBe('Fix the thing');
      expect(result.source).toBe('sources/github-myorg-myrepo');
    });

    it('returns no-changeset message when none available', async () => {
      (clientMock.listActivities as ReturnType<typeof vi.fn>).mockResolvedValue({
        activities: [],
      });

      const result = JSON.parse(await resources.getSessionDiff('sess-1')) as { message: string };
      expect(result.message).toContain('No changeSet');
    });
  });

  describe('getScheduleHistory', () => {
    it('returns history sorted by lastRun', async () => {
      (storageMock.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 't1',
          name: 'task-a',
          cron: '0 0 * * *',
          enabled: true,
          lastRun: '2026-01-02T00:00:00Z',
          lastSessionId: 's1',
          taskPayload: { prompt: 'a prompt', source: 'sources/github/o/r', automationMode: 'AUTO_CREATE_PR' },
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 't2',
          name: 'task-b',
          cron: '0 0 * * *',
          enabled: true,
          lastRun: '2026-01-03T00:00:00Z',
          lastSessionId: 's2',
          taskPayload: { prompt: 'b prompt', source: 'sources/github/o/r', automationMode: 'AUTO_CREATE_PR' },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);

      const result = JSON.parse(await resources.getScheduleHistory()) as {
        count: number;
        history: { taskName: string; executedAt: string }[];
      };
      expect(result.count).toBe(2);
      // Most recent first
      expect(result.history[0].taskName).toBe('task-b');
    });

    it('filters tasks without lastRun', async () => {
      (storageMock.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 't1',
          name: 'no-run-yet',
          cron: '0 0 * * *',
          enabled: true,
          taskPayload: { prompt: 'test', source: 'sources/github/o/r', automationMode: 'AUTO_CREATE_PR' },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);

      const result = JSON.parse(await resources.getScheduleHistory()) as { count: number };
      expect(result.count).toBe(0);
    });
  });
});
