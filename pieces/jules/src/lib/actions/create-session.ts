/**
 * Action: Create a new Jules coding session.
 * Dispatches a coding task to Jules for a GitHub repository.
 */

import { createAction, Property } from '@activepieces/pieces-framework';
import { julesAuth, type JulesAuthValue } from '../auth.js';
import { createSession, resolveSource } from '../api.js';

/**
 * Action definition for creating a new Jules coding session.
 * 
 * Takes repository, branch, prompt, and other settings to initiate a task.
 * Returns the created session object.
 */
export const createSessionAction = createAction({
  auth: julesAuth,
  name: 'create_session',
  displayName: 'Create Coding Session',
  description:
    'Create a new Jules coding session to fix bugs, write features, or improve code in a GitHub repository.',
  props: {
    repository: Property.ShortText({
      displayName: 'Repository',
      description:
        'Exact Jules source name from the list sources action, or a legacy owner/repo value to resolve through Jules.',
      required: false,
    }),
    branch: Property.ShortText({
      displayName: 'Branch',
      description: 'Optional branch. If blank, Jules source default branch is used.',
      required: false,
    }),
    prompt: Property.LongText({
      displayName: 'Task Prompt',
      description: 'Describe the coding task for Jules to perform.',
      required: true,
    }),
    title: Property.ShortText({
      displayName: 'Session Title',
      description: 'A short title for this session.',
      required: false,
    }),
    autoCreatePR: Property.Checkbox({
      displayName: 'Auto-Create Pull Request',
      description: 'Automatically create a PR when Jules finishes.',
      required: false,
      defaultValue: true,
    }),
    requirePlanApproval: Property.Checkbox({
      displayName: 'Require Plan Approval',
      description: 'Pause for human review before Jules starts coding.',
      required: false,
      defaultValue: false,
    }),
  },
  /**
   * Executes the action to create a Jules session.
   * 
   * @param context - The context containing auth and property values.
   * @returns {Promise<import('../api').Session>} The created session.
   * @throws {Error} If the repository is not provided.
   */
  async run({ auth, propsValue }) {
    const typedAuth = auth as JulesAuthValue;
    const sourceIdentifier = propsValue.repository || typedAuth.defaultRepo;
    if (!sourceIdentifier) {
      throw new Error(
        'Repository is required. Set a Jules source name here or a default repository in auth.'
      );
    }

    const source = await resolveSource(typedAuth, sourceIdentifier);
    const defaultBranch = source.githubRepo?.defaultBranch?.displayName;
    const branch = propsValue.branch || defaultBranch;
    if (!branch) {
      throw new Error(
        `Jules source "${source.name}" has no default branch. Supply a branch explicitly.`
      );
    }
    const branches = source.githubRepo?.branches?.map(
      (item) => item.displayName
    );
    if (
      propsValue.branch &&
      branches?.length &&
      !branches.includes(propsValue.branch)
    ) {
      throw new Error(
        `Branch "${propsValue.branch}" is not available on ${source.githubRepo?.owner}/${source.githubRepo?.repo}. Choose a listed branch or leave the field blank.`
      );
    }

    const session = await createSession(typedAuth, {
      prompt: propsValue.prompt,
      sourceContext: {
        source: source.name,
        githubRepoContext: {
          startingBranch: branch,
        },
      },
      title: propsValue.title || propsValue.prompt.substring(0, 100),
      automationMode: propsValue.autoCreatePR
        ? 'AUTO_CREATE_PR'
        : 'AUTOMATION_MODE_UNSPECIFIED',
      requirePlanApproval: propsValue.requirePlanApproval ?? false,
    });

    return session;
  },
});
