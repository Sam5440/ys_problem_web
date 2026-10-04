import { ghHeaders, pickRun } from '../lib';

/** List of workflow runs, 50 per page (?page=N). Cached 3 minutes. */
export const revalidate = 180;
export const dynamic = 'force-dynamic';

export async function GET(req) {
  const page = Math.max(1, Number(new URL(req.url).searchParams.get('page') || 1) || 1);
  const url = `https://api.github.com/repos/Sam5440/ys_problem_web/actions/runs?per_page=50&page=${page}`;
  const res = await fetch(url, { headers: ghHeaders(), next: { revalidate: 180 } });
  if (!res.ok) {
    return Response.json({ error: `GitHub API ${res.status}` }, { status: 502 });
  }
  const data = await res.json();
  return Response.json({
    total: data.total_count,
    runs: (data.workflow_runs || []).map(pickRun),
  });
}
