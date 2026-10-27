# Maintainer checklist

Everything the repository owner has to configure by hand. Nothing in this repository changes
repository settings, branch protection, Environments, secrets, Pages or Cloudflare; each item below
is a step for a person with admin rights. Items are grouped by the pull request that needs them.

## Repository

- [ ] Branch protection on `main`: require a pull request, require review from code owners, require
      the `test` check (and, once the validation workflow is merged, `validate`), require signed
      commits, block force pushes and deletion.
- [ ] Keep merging local and signed: GitHub's merge button and `gh pr merge` rewrite commits on the
      server and drop their signatures. Merge with `git merge --no-ff -S`, push, and delete the branch.
- [ ] Private vulnerability reporting (Settings, Code security) so that [SECURITY.md](../SECURITY.md)
      works as written.
- [ ] Two-factor authentication with a hardware-backed second factor for every owner and maintainer.

## Code owners

`.github/CODEOWNERS` names `@fogrew`, the repository owner. It can become a team: replace the owner
on the `/servers/` line with a reviewer team to let more people approve listings while signing-related
paths (`/.github/`, `/tools/`, `/config/`, `/keys/`, `/data/`, `/schema/`) stay with the owners. A
team must have write access to the repository for its code-owner review to count.

## Validation workflow

`.github/workflows/validate.yml` needs no secret and no setting beyond the defaults.

- [ ] Add the `validate` check to the required checks of `main`. The workflow runs on every pull
      request (so the check always reports) and only comments on pull requests that touch `servers/`.
- [ ] Settings, Actions, General, "Fork pull request workflows": leave the defaults. The workflow uses
      `pull_request_target`, so it runs the code of `main`, never the code of the pull request, and
      reads the entry files through the API as plain data. The only token it holds is the job's own,
      read-only for the downloading job and `pull-requests: write` for the job that posts the comment.
- [ ] Keep `tools/ci/` and `tools/lib/` under code-owner review: a change there is a change to what
      runs with write access on pull requests.

The comment is edited in place and identified by `<!-- registry-validation -->`. Only a comment from
`github-actions[bot]` that starts with that marker is ever edited.

## VirusTotal

- [ ] Create a VirusTotal account for the registry and add its API key as the repository secret
      `VIRUSTOTAL_API_KEY` (Settings, Secrets and variables, Actions). Until it exists the workflow posts
      "not run" and nothing is sent anywhere. The free tier allows 4 requests a minute and 500 a day; the
      key must not be shared with other tools, since the daily count is kept per key.
- [ ] Decide the threshold in `config/virustotal.json` (default 5: files that this many engines call
      malicious or suspicious are listed first). It only changes the label in the comment; a detection
      never fails a check. `reservedForRescan` (default 150) keeps part of the day for the scheduled
      re-scan.
- [ ] Review `data/virustotal-benign.json` in pull requests. It lists the SHA-256 of the BepInEx and
      Doorstop files of official releases, which are skipped (they would otherwise use up the quota and
      look suspicious). `node tools/benign.js --note <release> <root> <files>` adds more. Add a file only
      after checking where it came from.

The scan job holds the key in the environment of one step. That step also downloads files from the
community's mirrors (only the ones VirusTotal does not know, to upload them), through the same hardened
downloader as validation; the key is only ever sent to `www.virustotal.com`. Files over 32 MiB are not
uploaded: the comment lists them for a manual look.
