/**
 * Thin git plumbing helpers for the data-branch model. All commits are built
 * with a throwaway index (GIT_INDEX_FILE) so the surrounding checkout's index
 * is never touched — CI checkouts stay clean and local dev never finds data
 * files mysteriously staged.
 *
 * Every data branch commit is a from-scratch snapshot tree of its paths
 * (no read-tree of the parent), which keeps the rolling file retention
 * natural: files pruned from the worktree drop out of the branch tip.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Run git, returning trimmed stdout. Throws with stderr tail on failure. */
export function git(args, { env = {}, check = true } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err && check) {
        const tail = String(stderr || err.message).split('\n').filter(Boolean).slice(-6).join('\n');
        reject(new Error(`git ${args.join(' ')} failed:\n${tail}`));
        return;
      }
      resolve({ stdout: String(stdout).trim(), stderr: String(stderr).trim(), code: err ? err.code || 1 : 0 });
    });
  });
}

/** Commit identity: explicit env override, then the Actions bot, then the
    local git config (so local test pushes are attributed to the developer). */
export async function commitIdentity() {
  let name = process.env.DATA_BOT_NAME;
  let email = process.env.DATA_BOT_EMAIL;
  if (!name && process.env.GITHUB_ACTIONS) {
    name = 'github-actions[bot]';
    email = '41898282+github-actions[bot]@users.noreply.github.com';
  }
  if (!name) name = (await git(['config', 'user.name'], { check: false })).stdout || 'ys-data-bot';
  if (!email) email = (await git(['config', 'user.email'], { check: false })).stdout || 'ys-data-bot@users.noreply.github.com';
  return { name, email };
}

/**
 * Build a tree object from the current worktree.
 * base: a tree-ish whose entries form the starting point (pass null for a
 *   from-scratch snapshot); paths are then added/overwritten from the worktree.
 * paths: worktree paths (dirs or files) to include; ignored files are added
 *   because of -f (data paths are gitignored on main by design). Paths that do
 *   not exist in the worktree are skipped.
 * extraFiles: { [worktreePath]: contents } written straight into the tree as
 *   blobs without touching the worktree (used to inject a vercel.json that
 *   disables Vercel preview deployments for data-only branches).
 */
export async function buildTree({ base = null, paths = [], extraFiles = {} }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ysp-index-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    if (base) await git(['read-tree', base], { env });
    const existing = paths.filter((p) => existsSync(p));
    if (existing.length) {
      await git(['add', '-f', '--', ...existing], { env });
    }
    for (const [file, contents] of Object.entries(extraFiles)) {
      const blob = (
        await new Promise((resolve, reject) => {
          const cp = execFile('git', ['hash-object', '-w', '--stdin'], { env }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
          cp.stdin.end(contents);
        })
      ).trim();
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
    }
    const { stdout } = await git(['write-tree'], { env });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** commit-tree wrapper. parents: array of commit shas ([] = orphan). */
export async function commitTree(tree, parents, message) {
  const { name, email } = await commitIdentity();
  const date = new Date().toISOString();
  const env = {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  };
  const args = ['commit-tree', tree, '-m', message];
  for (const p of parents) args.push('-p', p);
  const { stdout } = await git(args, { env });
  return stdout;
}

/** Tree oid of a commit-ish (null when the ref does not exist remotely). */
export async function remoteTree(branch) {
  const { stdout } = await git(['ls-remote', 'origin', `refs/heads/${branch}`], { check: false });
  const sha = stdout.split('\t')[0];
  if (!sha) return { sha: null, tree: null };
  const t = (await git(['rev-parse', `${sha}^{tree}`], { check: false })).stdout;
  return { sha, tree: t || null };
}

/** Push a commit sha to a branch. force=true rewrites (deploy model). */
export async function pushCommit(sha, branch, { force = false } = {}) {
  const refspec = `${force ? '+' : ''}${sha}:refs/heads/${branch}`;
  return git(['push', 'origin', refspec]);
}

/** True when the push failed because the remote moved (non-fast-forward). */
export function isNonFastForward(err) {
  return /non-fast-forward|fetch first|rejected|stale info/.test(String(err?.message || ''));
}
