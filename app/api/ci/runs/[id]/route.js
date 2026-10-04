import { ghHeaders, pickRun } from '../../lib';

/**
 * One run's detail: jobs with step conclusions, the pushed commit's file
 * changes (public API — powers the "拉取/翻译" summary for every historical
 * run), and — only when GH_TOKEN is configured — each job's raw log text
 * (the log download endpoint requires an authenticated token even on public
 * repos; without it the UI links out to github.com where logs are public).
 * Completed runs are immutable → cached an hour; runs still in progress are
 * cached 30s so growing logs refresh.
 */
export const revalidate = 60;
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LOG_CAP = 1_500_000; // chars per job log, safety valve
const COMMIT_CAP = 400; // files listed per commit

export async function GET(req, { params }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return Response.json({ error: 'bad run id' }, { status: 400 });
  }
  const url = new URL(req.url);
  const base = `https://api.github.com/repos/Sam5440/ys_problem_web/actions`;

  const jobsRes = await fetch(`${base}/runs/${id}/jobs?per_page=30`, {
    headers: ghHeaders(),
    next: { revalidate: 300 },
  });
  if (!jobsRes.ok) {
    return Response.json({ error: `GitHub API ${jobsRes.status}` }, { status: 502 });
  }
  const jobsData = await jobsRes.json();
  const jobs = (jobsData.jobs || []).map((j) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    steps: (j.steps || []).map((s) => ({
      number: s.number,
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
    })),
  }));

  // Raw logs: token-only on the GitHub API. Anonymous visitors still get the
  // full log on github.com itself, which the UI links to.
  const logs = [];
  if (process.env.GH_TOKEN) {
    for (const job of jobs) {
      const logRes = await fetch(`${base}/jobs/${job.id}/logs`, {
        headers: ghHeaders(),
        next: { revalidate: 3600 },
      });
      let text = null;
      if (logRes.ok) {
        const raw = await logRes.text();
        text = raw.length > LOG_CAP ? `${raw.slice(0, LOG_CAP)}\n…（日志过长，已截断）` : raw;
      } else if (logRes.status !== 404) {
        text = `（日志获取失败：GitHub API ${logRes.status}）`;
      }
      logs.push({ jobId: job.id, text });
    }
  }

  // The run's own push: a commit authored by github-actions[bot] inside the
  // run's time window (the run's head_sha predates its push). Public
  // metadata; tells which statements were pulled and which files
  // (translations) the run changed. Absent for no-change runs.
  let commit = null;
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  if (since && until && /^\d{4}-/.test(since) && /^\d{4}-/.test(until)) {
    const cRes = await fetch(
      `https://api.github.com/repos/Sam5440/ys_problem_web/commits?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=20`,
      { headers: ghHeaders(), next: { revalidate: 3600 } },
    );
    if (cRes.ok) {
      const list = await cRes.json();
      const botCommit = (Array.isArray(list) ? list : []).find(
        (c) => c.commit?.author?.name === 'github-actions[bot]' || c.author?.login === 'github-actions[bot]',
      );
      if (botCommit) {
        commit = {
          sha: botCommit.sha.slice(0, 7),
          message: botCommit.commit?.message?.split('\n')[0],
          author: botCommit.commit?.author?.name,
          date: botCommit.commit?.author?.date,
        };
        const dRes = await fetch(`https://api.github.com/repos/Sam5440/ys_problem_web/commits/${botCommit.sha}`, {
          headers: ghHeaders(),
          next: { revalidate: 3600 },
        });
        if (dRes.ok) {
          const d = await dRes.json();
          commit.files = (d.files || []).slice(0, COMMIT_CAP).map((f) => ({
            file: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
          }));
        }
      }
    }
  }

  return Response.json({ jobs, logs, commit, logsAvailable: logs.length > 0 });
}
