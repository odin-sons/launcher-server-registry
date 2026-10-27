# Security policy

## What to report

- A listed community that serves malware, or whose files changed to something harmful after review.
  Include the entry id, what you saw and, if you can, the file hashes.
- A weakness in the registry itself: the CI checks, the VirusTotal handling, the signing and
  publishing workflows, or anything that could let someone other than the maintainers influence the
  signed index.
- A suspected leak of the registry signing key.

A report of a harmful listing is acted on first by setting the entry to `suspended`, which the
launcher honours as soon as it fetches the next index. Reports are triaged as quickly as the
maintainers can; there is no guaranteed response time.

## How to report

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue or pull request for a security problem
until a maintainer has confirmed the fix is published.

If the Security tab offers no reporting form, open a public issue that says only "security contact
needed", without details, and a maintainer will reach out.

## Scope

In scope: this repository, its workflows and the published index.

Out of scope: the launcher itself (report it in the launcher repository), a community's own game
servers, and mods that are not listed here.

## Key compromise

The registry key is a CI secret, never a file in this repository. A suspected leak is handled as a
compromise: the key is replaced in the next launcher build, as described in the launcher's
[registry-trust-policy.md](https://github.com/odin-sons/Launcher/blob/master/docs/registry-trust-policy.md).
