/**
 * Read-only proxy for the repo's GitHub Actions runs (public repo, public
 * API). The browser could call api.github.com directly, but anonymous rate
 * limits are per visitor IP and unbounded; proxying lets us cache heavily —
 * completed runs are immutable, so most requests are served from Next's
 * fetch cache and the shared-IP anonymous budget (60/hr) stays safe.
 * Set the optional GH_TOKEN env (repo secret) to lift the rate limit.
 */
const REPO = 'Sam5440/ys_problem_web';

export const ghHeaders = () => {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ys-problem-web',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GH_TOKEN) h.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  return h;
};

export const pickRun = (r) =>
  r && {
    id: r.id,
    name: r.name,
    displayTitle: r.display_title,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    createdAt: r.created_at,
    runStartedAt: r.run_started_at,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
    headSha: (r.head_sha || '').slice(0, 7),
  };
