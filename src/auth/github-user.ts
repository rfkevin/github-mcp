import { GitHubIdentityError, classifyFetchFailure, classifyUserRedirect } from './github-errors';

export async function fetchGithubUser(
  fetcher: typeof fetch,
  accessToken: string,
): Promise<Response> {
  let url = 'https://api.github.com/user';

  for (let redirectCount = 0; redirectCount <= 1; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'github-mcp-worker',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (error) {
      throw new GitHubIdentityError(
        'github_user_network_error',
        undefined,
        classifyFetchFailure(error),
      );
    }

    if (response.status < 300 || response.status >= 400) return response;

    const redirect = classifyUserRedirect(response.headers.get('location'));
    await response.body?.cancel();
    if (redirect.url && redirectCount === 0) {
      url = redirect.url;
      continue;
    }

    throw new GitHubIdentityError(
      'github_user_redirect_rejected',
      response.status,
      { kind: 'redirect_rejected', redirectTarget: redirect.redirectTarget },
    );
  }

  throw new GitHubIdentityError(
    'github_user_redirect_rejected',
    undefined,
    { kind: 'redirect_rejected', redirectTarget: 'github_api_user_endpoint' },
  );
}
