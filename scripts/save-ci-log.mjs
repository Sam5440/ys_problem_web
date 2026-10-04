/**
 * Saves the current workflow run's full job log into the repo:
 *   public/ci-logs/<UTC date>-<run id>.log   (raw log, noise-filtered)
 *   public/ci-logs/<UTC date>-<run id>.json  (header + parsed summary)
 * then prunes files older than RETENTION_DAYS and pushes both in their own
 * commit. Runs as the workflow's last step, so the downloaded log covers
 * everything up to the data commit; the save step's own output is naturally
 * absent.
 *
 * Auth: the workflow's GITHUB_TOKEN with `actions: read` permission (the
 * job-log download endpoint requires it even on public repos).
 */
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_DIR = path.join(ROOT, 'public', 'ci-logs');
const RETENTION_DAYS = 60;
const MAX_CHARS = 400_000;

const REPO = process.env.GITHUB_REPOSITORY; // e.g. Sam5440/ys_problem_web
const RUN_ID = process.env.GITHUB_RUN_ID;
const EVENT = process.env.GITHUB_EVENT_NAME;
const TOKEN = process.env.GITHUB_TOKEN;

if (!REPO || !RUN_ID || !TOKEN) {
  console.error('save-ci-log: missing GITHUB_* env — not running in Actions, skipping.');
  process.exit(0);
}

const api = (p) => `https://api.github.com/repos/${REPO}/actions${p}`;
const gh = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ys-problem-web' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJobLog() {
  // find this run's job (single-job workflow; GITHUB_JOB names it "update")
  let job = null;
  for (let i = 0; i < 3 && !job; i++) {
    const res = await fetch(api(`/runs/${RUN_ID}/jobs?per_page=20`), { headers: gh });
    if (res.ok) {
      const jobs = (await res.json()).jobs || [];
      job = jobs.find((j) => j.name === process.env.GITHUB_JOB) || jobs[0] || null;
    } else {
      console.warn(`jobs list HTTP ${res.status} (try ${i + 1})`);
    }
    if (!job) await sleep(5000);
  }
  if (!job) throw new Error('could not locate the run job via API');

  let text = null;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(api(`/jobs/${job.id}/logs`), { headers: gh, redirect: 'follow' });
    if (res.ok) {
      text = await res.text();
      break;
    }
    console.warn(`job log HTTP ${res.status} (try ${i + 1})`);
    await sleep(5000);
  }
  return { job, text };
}

/** Strip apt/playwright install noise and hard-cap the size (keep the tail —
    the interesting steps are late in the log). */
function cleanLog(raw) {
  let lines = raw.split('\n').filter((l) => !/^(Get:\d|Get:\d+|Unpacking|Selecting previously|Preparing to unpack|Setting up|Progress:\s*\d)/.test(l.trim()));
  let text = lines.join('\n');
  if (text.length > MAX_CHARS) {
    text = `（日志过长：已省略开头 ${text.length - MAX_CHARS} 字符，保留尾部）\n` + text.slice(-MAX_CHARS);
  }
  return text;
}

function summarize(text) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\s*/, '')); // strip GH log timestamps
  const fetched = [];
  const fetchFailed = [];
  const aiByProblem = [];
  const aiLines = [];
  const addedFiles = [];
  let pushed = false;
  for (const l of lines) {
    let m;
    if ((m = l.match(/^\s*(?:\[\d+\/\d+\])?\s*✓\s*([A-Z]{1,4}\d+[A-Za-z0-9]*)\s+—\s+(.+?)(?:\s*\(\d+ samples?\))?\s*$/))) {
      fetched.push({ code: m[1], title: m[2] });
    } else if ((m = l.match(/no statement for (\S+)/))) {
      fetchFailed.push(m[1]);
    } else if ((m = l.match(/^\s*(\S+?):\s*\d+ segment\(s\) to translate/))) {
      aiByProblem.push(m[1]);
    } else if (/✓ (title|legend|input|output|note)\[/.test(l) || /✗ \S/.test(l)) {
      if (aiLines.length < 30) aiLines.push(l.trim());
    } else if ((m = l.match(/create mode 100\d+ (data\/(?:statements|daily|leaderboard)\S*)/))) {
      addedFiles.push(m[1]);
    }
    if (/^\s*git push\s*$/.test(l)) pushed = true;
  }
  const aiDone = Number((text.match(/Done: (\d+) segment/) || [])[1] || 0);
  return { fetched, fetchFailed, aiByProblem, aiLines, aiDone, addedFiles, pushed };
}

async function main() {
  const { job, text: rawLog } = await fetchJobLog();
  const startedAt = job?.started_at || new Date().toISOString();
  const date = startedAt.slice(0, 10);

  let logText;
  let summary = null;
  if (rawLog) {
    logText = cleanLog(rawLog);
    summary = summarize(logText);
  } else {
    logText = '（日志下载失败，仅有元数据）';
  }

  const header = {
    runId: Number(RUN_ID),
    event: EVENT,
    startedAt,
    savedAt: new Date().toISOString(),
    url: `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${RUN_ID}`,
    jobName: job?.name || null,
  };
  const failure = /##\[error\]/.test(logText);
  if (failure) header.conclusion = 'failure';

  await mkdir(OUT_DIR, { recursive: true });
  const base = `${date}-${RUN_ID}`;
  await writeFile(path.join(OUT_DIR, `${base}.log`), `<!--YSLOG ${JSON.stringify(header)}-->\n${logText}\n`);
  await writeFile(
    path.join(OUT_DIR, `${base}.json`),
    JSON.stringify({ ...header, failure, summary }, null, 2) + '\n',
  );
  console.log(`saved ${base}.log (${logText.length} chars)`);

  // prune entries older than the retention window (filename date prefix)
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  let pruned = 0;
  for (const f of await readdir(OUT_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})-/);
    if (m && Date.parse(`${m[1]}T00:00:00Z`) < cutoff) {
      await unlink(path.join(OUT_DIR, f)).catch(() => {});
      pruned++;
    }
  }
  if (pruned) console.log(`pruned ${pruned} expired log file(s)`);
}

main().catch((e) => {
  console.error('save-ci-log failed:', e.message);
  process.exit(1); // non-fatal for the workflow? no — keep visible; use continue-on-error in YAML
});
