/**
 * Action: List Jules-connected sources.
 * Returns exact resource names callers can use when creating a session.
 */

import { createAction, Property } from '@activepieces/pieces-framework';
import { julesAuth, type JulesAuthValue } from '../auth';
import { listSources } from '../api';

/** Action definition for discovering Jules sources. */
export const listSourcesAction = createAction({
  auth: julesAuth,
  name: 'list_sources',
  displayName: 'List Jules Sources',
  description: 'List repositories connected to Jules and their exact source resource names.',
  props: {
    pageSize: Property.Number({
      displayName: 'Page Size',
      description: 'Maximum number of sources to return.',
      required: false,
      defaultValue: 100,
    }),
    pageToken: Property.ShortText({
      displayName: 'Page Token',
      description: 'Continue listing with the nextPageToken from the previous result.',
      required: false,
    }),
  },
  /**
   * Executes the source discovery action.
   * @param context - The context containing auth and property values.
   * @returns Source metadata and a continuation token when more pages remain.
   */
  async run({ auth, propsValue }) {
    const response = await listSources(
      auth as JulesAuthValue,
      propsValue.pageSize ?? 100,
      propsValue.pageToken
    );
    return {
      sources: response.sources.map((source) => ({
        name: source.name,
        repository: source.githubRepo
          ? `${source.githubRepo.owner}/${source.githubRepo.repo}`
          : undefined,
        defaultBranch: source.githubRepo?.defaultBranch?.displayName,
        branches: source.githubRepo?.branches?.map((branch) => branch.displayName),
        isPrivate: source.githubRepo?.isPrivate,
        url: source.githubRepo?.htmlUrl,
      })),
      nextPageToken: response.nextPageToken,
      complete: !response.nextPageToken,
    };
  },
});
