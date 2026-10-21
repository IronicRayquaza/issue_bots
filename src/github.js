// GitHub REST API: search open issues in the configured repository.

const GITHUB_API = "https://api.github.com";

/**
 * Searches open issues (not pull requests) in `repo` matching `keywords`.
 * Returns up to `limit` results ordered by GitHub's relevance ranking.
 */
export async function searchOpenIssues(repo, keywords, limit = 5) {
  // Strip characters that GitHub search treats as syntax, so model output
  // can't inject qualifiers like "repo:" or quoted phrases.
  const cleaned = keywords.replace(/["':()]/g, " ").trim();
  const q = `${cleaned} repo:${repo} is:issue is:open`;
  const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}`;

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ods-triage-bot",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub search failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.items.map((item) => ({
    number: item.number,
    title: item.title,
    body: item.body,
    url: item.html_url,
  }));
}

/** Builds a "new issue" URL with the title and body pre-filled. */
export function newIssueUrl(repo, title, body) {
  const params = new URLSearchParams({ title, body });
  return `https://github.com/${repo}/issues/new?${params}`;
}
