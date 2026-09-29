export interface GitHubLabel {
  name: string;
}

export interface GitHubIssue {
  comments: number;
  created_at: string;
  html_url: string;
  labels: GitHubLabel[];
  number: number;
  repository_url: string;
  title: string;
}

export interface RepoIssues {
  count: number;
  issues: GitHubIssue[];
  name: string;
  url: string;
}

export interface GitHubContributor {
  avatar_url: string;
  contributions: number;
  html_url: string;
  login: string;
  name: string | null;
  type: string;
}

export interface GitHubRepo {
  fork: boolean;
  name: string;
}

export interface Contributor {
  avatarUrl: string;
  contributions: number;
  htmlUrl: string;
  login: string;
  name: string | null;
  repos: string[];
}

const API_URL = "https://api.github.com";
const ORG = "shadcn-labs";
const SEARCH_URL = `${API_URL}/search/issues`;
const QUERY = `org:${ORG} type:issue state:open`;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const CONTRIBUTOR_LABELS = new Set(["good first issue", "help wanted"]);

/** How long contributor data stays fresh, in seconds. */
export const CACHE_TTL_SECONDS = 3600;

const AGENT_LOGIN =
  /^(?:aider|cody|cohere|codex|claude|copilot|cursor|deepseek|dependabot|devin|gemini|greptile|qwen|renovate|replit|sourcery|sweep|windsurf)/iu;

const contributorPriority = (issue: GitHubIssue): number => {
  const labels = new Set(issue.labels.map((label) => label.name.toLowerCase()));

  for (const name of CONTRIBUTOR_LABELS) {
    if (labels.has(name)) {
      return 0;
    }
  }

  return 1;
};

const isHuman = (contributor: GitHubContributor): boolean =>
  contributor.type === "User" &&
  !contributor.login.endsWith("[bot]") &&
  !AGENT_LOGIN.test(contributor.login);

const githubFetch = async <T>(url: URL): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status}`);
  }

  return (await response.json()) as T;
};

const fetchIssuesPage = async (
  page: number
): Promise<{ items: GitHubIssue[]; totalCount: number }> => {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", QUERY);
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "created");
  url.searchParams.set("order", "desc");

  const data = await githubFetch<{
    items: GitHubIssue[];
    total_count: number;
  }>(url);

  return { items: data.items, totalCount: data.total_count };
};

export const getIssuesByRepo = async (): Promise<RepoIssues[] | null> => {
  try {
    const firstPage = await fetchIssuesPage(1);
    const pageCount = Math.min(
      Math.ceil(firstPage.totalCount / PAGE_SIZE),
      MAX_PAGES
    );

    const pages =
      pageCount > 1
        ? await Promise.all(
            Array.from({ length: pageCount - 1 }, (_, index) =>
              fetchIssuesPage(index + 2)
            )
          )
        : [];

    const issues = [...firstPage.items, ...pages.flatMap((page) => page.items)];

    const grouped = new Map<string, GitHubIssue[]>();

    for (const issue of issues) {
      const name = issue.repository_url.split("/").at(-1);

      if (!name) {
        continue;
      }

      const bucket = grouped.get(name);

      if (bucket) {
        bucket.push(issue);
      } else {
        grouped.set(name, [issue]);
      }
    }

    return [...grouped.entries()]
      .map(([name, repoIssues]) => ({
        count: repoIssues.length,
        issues: repoIssues.toSorted(
          (a, b) =>
            contributorPriority(a) - contributorPriority(b) ||
            b.created_at.localeCompare(a.created_at)
        ),
        name,
        url: `https://github.com/shadcn-labs/${name}/issues`,
      }))
      .toSorted((a, b) => b.count - a.count);
  } catch {
    return null;
  }
};

const fetchAllPages = async <T>(path: string, page = 1): Promise<T[]> => {
  if (page > MAX_PAGES) {
    return [];
  }

  const url = new URL(`${API_URL}${path}`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(PAGE_SIZE));

  const items = await githubFetch<T[]>(url);

  if (items.length < PAGE_SIZE) {
    return items;
  }

  const rest = await fetchAllPages<T>(path, page + 1);

  return [...items, ...rest];
};

interface CachedContributors {
  expires: number;
  value: Contributor[];
}

const contributorCache = new Map<string, CachedContributors>();

const loadContributors = async (org: string): Promise<Contributor[] | null> => {
  let repos: GitHubRepo[];

  try {
    const all = await fetchAllPages<GitHubRepo>(`/orgs/${org}/repos`);

    repos = all.filter((repo) => !repo.fork);
  } catch {
    return null;
  }

  // allSettled: one rate-limited or 404 repo should not blank the page.
  const results = await Promise.allSettled(
    repos.map((repo) =>
      fetchAllPages<GitHubContributor>(
        `/repos/${org}/${repo.name}/contributors`
      )
    )
  );
  const merged = new Map<string, Contributor>();
  let succeeded = 0;

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      continue;
    }

    succeeded += 1;

    for (const entry of result.value.filter(isHuman)) {
      const existing = merged.get(entry.login);

      if (existing) {
        existing.contributions += entry.contributions;
        existing.repos.push(repos[index].name);
        continue;
      }

      merged.set(entry.login, {
        avatarUrl: entry.avatar_url,
        contributions: entry.contributions,
        htmlUrl: entry.html_url,
        login: entry.login,
        name: entry.name,
        repos: [repos[index].name],
      });
    }
  }

  // Every repo failing means an auth/rate-limit problem, not an empty org.
  if (succeeded === 0) {
    return null;
  }

  return [...merged.values()].toSorted(
    (a, b) =>
      b.contributions - a.contributions || a.login.localeCompare(b.login)
  );
};

/**
 * Every human who has committed to any public repo in the org, aggregated
 * across repos. Bots and coding agents are filtered out.
 *
 * There is no aggregate endpoint on the GitHub REST API, so this costs one
 * request per repo. The route that calls this caches its response for
 * CACHE_TTL_SECONDS, and this in-process memo is a second layer that keeps a
 * warm server from re-fetching inside that window. No token needed: 25
 * requests an hour sits comfortably inside the anonymous 60 req/hr limit.
 */
export const getContributors = async (
  org = ORG
): Promise<Contributor[] | null> => {
  const cached = contributorCache.get(org);

  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }

  const contributors = await loadContributors(org);

  if (contributors === null) {
    console.warn(
      "[github] Could not load contributors — the GitHub API may be rate limited."
    );
    return null;
  }

  contributorCache.set(org, {
    expires: Date.now() + CACHE_TTL_SECONDS * 1000,
    value: contributors,
  });

  return contributors;
};
