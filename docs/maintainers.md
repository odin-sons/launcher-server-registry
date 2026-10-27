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

## Scheduled re-scan

`.github/workflows/rescan.yml` runs daily (04:23 UTC) and on demand. For every `approved` entry it
downloads each pinned file from every mirror and compares the hash, and (with `VIRUSTOTAL_API_KEY`) looks
the entry's code files up again, asking VirusTotal for a fresh analysis when its report is older than 7
days. A pinned file whose hash changed or disappeared, or a file now flagged by at least the threshold
and not on the benign list, opens a pull request that sets the entry to `needs-approval`. A mirror
that cannot be reached is only noted: an outage does not demote a community.

- [ ] Settings, Actions, General, Workflow permissions: tick "Allow GitHub Actions to create and approve
      pull requests". Without it the workflow opens an issue with the same text instead.
- [ ] Do not make the re-scan pull requests merge themselves: merging one is a maintainer's decision,
      and the merge is what removes the community from new installs in the next index.
- [ ] GitHub switches scheduled workflows off after 60 days without repository activity. The re-scan and
      the re-signing both depend on the schedule, so watch the Actions tab or use a monthly commit.
- Re-scan commits are made through the API and are signed by GitHub; this is the one place where the
  registry's own history carries GitHub-signed commits.

## Signing and publishing

`.github/workflows/publish.yml` signs and publishes; `registry-dry-run` rehearses it. Nothing
publishes until the repository variable `REGISTRY_PUBLISH` is `true`, so merging the workflow is safe.
Key handling is in [key-management.md](key-management.md).

- [ ] Environment `registry` (Settings, Environments): deployment branches limited to `main`; add
      required reviewers only if you do not want the scheduled re-signing to run unattended (it is
      designed to). Secret `REGISTRY_SIGNING_KEY`: the PEM private key (PKCS#8 from
      `openssl genpkey`). Optional variable `REGISTRY_KEY_ID` (default `r1`).
- [ ] Commit the public key as `keys/r1.pub.pem`.
- [ ] Put the key in the launcher: `node tools/key-info.js keys/r1.pub.pem r1` prints the line for
      `RegistryKeySet.Official` (`Launcher.Core/RegistryKeySet.cs`). Ship a launcher with it before
      players rely on the registry.
- [ ] GitHub Pages (Settings, Pages): source "GitHub Actions". The deployment uses the built-in
      `github-pages` environment.
- [ ] Cloudflare Pages: create a Direct Upload project with the name in `config/mirrors.json`
      (`odinsons-registry` by default, which gives `https://odinsons-registry.pages.dev/`), production
      branch `main`. Add the repository secrets `CLOUDFLARE_API_TOKEN` (a token with "Cloudflare Pages: Edit"
      for that account only) and `CLOUDFLARE_ACCOUNT_ID`. Without them the Cloudflare job skips itself with a
      notice and publishing continues to the other hosts. The deploy job runs a pinned `wrangler`
      (4.148.0 through `npx`); it is the one third-party package in the pipeline and runs in a job that
      never sees the signing key.
- [ ] Decide the public names: the defaults in `config/mirrors.json` are the GitHub Pages address
      of this repository and the `pages.dev` project above. Custom domains are better (a domain you can
      move to another host), and each mirror you change here must be changed in the launcher too.
- [ ] Set the variable `REGISTRY_PUBLISH` to `true` and run the `publish` workflow once.
- [ ] Run `registry-dry-run` first (Actions, Run workflow) to see the index that would be signed.
- [ ] Watch the schedule: `publish` runs daily (05:41 UTC); the index is valid for 14 days.

After a publish the `verify` job fetches `index.json` from every configured host and checks signature,
expiry and serial against `keys/<id>.pub.pem`. A host that is configured but behind fails the run.

### What the launcher has to list

`OfficialRegistry.Mirrors` in `Launcher.Core/OfficialRegistry.cs` takes the base URLs of the hosts
that serve `index.json`, the same as the `url` fields of `config/mirrors.json` (both end in `/`):

```
https://odin-sons.github.io/launcher-server-registry/
https://odinsons-registry.pages.dev/
```

## Setup order

1. Merge the pull requests in order (scaffold, validation, VirusTotal, re-scan, signing), locally and signed.
2. Branch protection and the required checks `test` and `validate`.
3. Secrets: `VIRUSTOTAL_API_KEY`. Settings: Actions may create pull requests.
4. Key, environment `registry`, `keys/r1.pub.pem`, the launcher build that pins it.
5. Pages and Cloudflare, then `REGISTRY_PUBLISH=true`.
