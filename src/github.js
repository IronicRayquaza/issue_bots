// GitHub REST API: fork syncing and duplicate search in the upstream repository.

const GITHUB_API = "https://api.github.com";

async function githubRequest(method, path, body) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ods-triage-bot",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

/** Looks up the repository `fork` was forked from, as "owner/repo". */
export async function getUpstreamRepo(fork) {
  const res = await githubRequest("GET", `/repos/${fork}`);
  if (!res.ok) {
    throw new Error(`Could not read ${fork}: ${res.status} ${res.data.message ?? ""}`);
  }
  if (!res.data.parent) {
    throw new Error(`${fork} is not a fork; set GITHUB_UPSTREAM_REPO explicitly.`);
  }
  return res.data.parent.full_name;
}

/**
 * Updates `branch` on the fork from the same branch upstream (the "Sync fork"
 * button on GitHub). Returns { ok, mergeType, message }.
 * mergeType is "none" when already up to date, "fast-forward" or "merge" otherwise.
 */
export async function syncFork(fork, branch) {
  const res = await githubRequest("POST", `/repos/${fork}/merge-upstream`, { branch });
  if (res.ok) {
    return { ok: true, mergeType: res.data.merge_type, message: res.data.message };
  }
  // 409 = merge conflict between the fork and upstream; 422 = branch can't be synced.
  return { ok: false, status: res.status, message: res.data.message ?? "Unknown error" };
}

async function search(query, limit) {
  const path = `/search/issues?q=${encodeURIComponent(query)}&per_page=${limit}`;
  const res = await githubRequest("GET", path);
  if (!res.ok) {
    throw new Error(`GitHub search failed: ${res.status} ${res.data.message ?? ""}`);
  }
  return res.data.items;
}

/**
 * Searches `repo` for open issues, open pull requests, and merged pull requests
 * matching `keywords`: up to `limit` open items plus up to `limit` merged PRs,
 * each ordered by relevance.
 */
export async function searchIssuesAndPulls(repo, keywords, limit = 5) {
  // Strip characters that GitHub search treats as syntax, so model output
  // can't inject qualifiers like "repo:" or quoted phrases.
  const cleaned = keywords.replace(/["':()]/g, " ").trim();
  const [open, merged] = await Promise.all([
    // No is:issue / is:pr qualifier, so this returns both.
    search(`${cleaned} repo:${repo} is:open`, limit),
    search(`${cleaned} repo:${repo} is:pr is:merged`, limit),
  ]);

  const seen = new Set();
  const results = [];
  for (const item of [...open, ...merged]) {
    if (seen.has(item.number)) continue;
    seen.add(item.number);
    const isPull = Boolean(item.pull_request);
    results.push({
      number: item.number,
      kind: isPull ? "pull request" : "issue",
      state: isPull && item.pull_request.merged_at ? "merged" : item.state,
      title: item.title,
      body: item.body,
      url: item.html_url,
    });
  }
  return results;
}

/** Builds a "new issue" URL with the title and body pre-filled. */
export function newIssueUrl(repo, title, body) {
  const params = new URLSearchParams({ title, body });
  return `https://github.com/${repo}/issues/new?${params}`;
}
