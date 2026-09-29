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

export interface IssuesSnapshot {
  /** ISO timestamp of the GitHub response this data came from. */
  fetchedAt: string;
  /** `null` only when we have never had a successful fetch. */
  groups: RepoIssues[] | null;
  /** True when a refresh failed and we are serving the previous snapshot. */
  stale: boolean;
}

interface SearchPage {
  items: GitHubIssue[];
  totalCount: number;
}

const API_URL = "https://api.github.com";
const ORG = "shadcn-labs";
const SEARCH_URL = `${API_URL}/search/issues`;
const ORG_QUERY = `org:${ORG} type:issue state:open`;
const PAGE_SIZE = 100;
/** GitHub's search API refuses to page past 1000 results for one query. */
const SEARCH_RESULT_CAP = 1000;
const MAX_PAGES = SEARCH_RESULT_CAP / PAGE_SIZE;
const CONTRIBUTOR_LABELS = new Set(["good first issue", "help wanted"]);

/** How long the issues data stays fresh. */
export const ISSUES_CACHE_TTL_SECONDS = 300;

const contributorPriority = (issue: GitHubIssue): number => {
  const labels = new Set(issue.labels.map((label) => label.name.toLowerCase()));

  for (const name of CONTRIBUTOR_LABELS) {
    if (labels.has(name)) {
      return 0;
    }
  }

  return 1;
};

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

const searchIssuesPage = async (
  query: string,
  page: number
): Promise<SearchPage> => {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
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

const remainingPages = (totalCount: number): number[] => {
  const count = Math.min(Math.ceil(totalCount / PAGE_SIZE), MAX_PAGES);

  return Array.from(
    { length: Math.max(count - 1, 0) },
    (_, index) => index + 2
  );
};

/**
 * Splits an org-wide query into per-repo queries, because a single search
 * query cannot see past SEARCH_RESULT_CAP results. Only reached once the org
 * has more open issues than the cap allows.
 */
const fetchIssuesPerRepo = async (): Promise<GitHubIssue[]> => {
  const url = new URL(`${API_URL}/orgs/${ORG}/repos`);
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("type", "public");

  const repos = await githubFetch<{ fork: boolean; name: string }[]>(url);
  const results = await Promise.allSettled(
    repos
      .filter((repo) => !repo.fork)
      .map(async (repo) => {
        const first = await searchIssuesPage(
          `repo:${ORG}/${repo.name} type:issue state:open`,
          1
        );

        const rest = await Promise.all(
          remainingPages(first.totalCount).map((page) =>
            searchIssuesPage(
              `repo:${ORG}/${repo.name} type:issue state:open`,
              page
            )
          )
        );

        return [first.items, ...rest.map((entry) => entry.items)].flat();
      })
  );

  return results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
};

const fetchAllIssues = async (): Promise<GitHubIssue[]> => {
  const first = await searchIssuesPage(ORG_QUERY, 1);

  if (first.totalCount > SEARCH_RESULT_CAP) {
    console.warn(
      `[github] ${first.totalCount} open issues is over the ${SEARCH_RESULT_CAP} result search cap, falling back to per-repo queries.`
    );

    return fetchIssuesPerRepo();
  }

  const rest = await Promise.all(
    remainingPages(first.totalCount).map((page) =>
      searchIssuesPage(ORG_QUERY, page)
    )
  );

  return [first.items, ...rest.map((entry) => entry.items)].flat();
};

const groupByRepo = (issues: GitHubIssue[]): RepoIssues[] => {
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
      url: `https://github.com/${ORG}/${name}/issues`,
    }))
    .toSorted((a, b) => b.count - a.count);
};

const snapshotCache = new Map<string, IssuesSnapshot>();

/**
 * Open issues across the org, grouped by repo, plus the time the data was
 * actually fetched so the page can show how stale it is.
 *
 * Cached in-process for ISSUES_CACHE_TTL_SECONDS. The route wrapping this also
 * sets an edge cache, so a cache hit never reaches GitHub at all. If a refresh
 * fails we keep serving the last good snapshot rather than blanking the page.
 */
export const getIssuesByRepo = async (): Promise<IssuesSnapshot> => {
  const cached = snapshotCache.get(ORG);
  const now = Date.now();

  if (
    cached &&
    now - Date.parse(cached.fetchedAt) < ISSUES_CACHE_TTL_SECONDS * 1000
  ) {
    return cached;
  }

  try {
    const issues = await fetchAllIssues();
    const snapshot: IssuesSnapshot = {
      fetchedAt: new Date().toISOString(),
      groups: groupByRepo(issues),
      stale: false,
    };

    snapshotCache.set(ORG, snapshot);

    return snapshot;
  } catch (error) {
    if (cached) {
      console.warn(
        `[github] Issues refresh failed, serving the snapshot from ${cached.fetchedAt}.`,
        error
      );

      return { ...cached, stale: true };
    }

    console.warn(
      "[github] Issues fetch failed and there is no snapshot to fall back on.",
      error
    );

    return { fetchedAt: new Date().toISOString(), groups: null, stale: true };
  }
};
