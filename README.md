# OdinSons launcher server registry

The official registry of community servers for the [OdinSons Valheim launcher](https://github.com/odin-sons/Launcher).

A modpack is executable code on a player's machine, so the launcher offers a community only if it is
listed here. A listing is a pull request: CI checks the files the community publishes, a maintainer
reads the change, and merging it adds the community to the next signed index. The launcher pins the
registry's public key, verifies every index it downloads, and refuses files whose digest differs from
the one recorded here.

The trust model, including what a signature and a VirusTotal scan do and do not prove, is in the
launcher repository: [registry-trust-policy.md](https://github.com/odin-sons/Launcher/blob/master/docs/registry-trust-policy.md)
and [registry-format.md](https://github.com/odin-sons/Launcher/blob/master/docs/registry-format.md).

## How it works

```
servers/<id>.json  --pull request-->  CI checks + maintainer review  --merge-->  signed index.json
                                                                                       |
                                                    GitHub Pages, Cloudflare Pages  <--+
```

- `servers/<id>.json` is one community: its name, status, mirrors and the SHA-256 of every file the
  launcher must be able to trust (manifests, display files).
- The index is rebuilt and signed in CI on every merge and on a schedule, so it never expires while
  the registry is alive, and is published to several hosts.
- Approved entries are re-checked on a schedule. A changed or newly flagged file moves the entry to
  `needs-approval` through a pull request.

## Repository layout

| Path | Purpose |
|------|---------|
| `servers/` | One entry per community |
| `schema/server.schema.json` | JSON Schema for an entry |
| `docs/` | Maintainer documentation |
| `.github/` | Code owners, pull request template, workflows |

## For server owners

Read [CONTRIBUTING.md](CONTRIBUTING.md): what to publish, how to pin it, what CI checks and what a
review means.

## For maintainers

[docs/maintainers.md](docs/maintainers.md) lists everything a repository owner has to configure.

## Reporting a problem

A malicious or compromised listing, or a weakness in the registry itself, is a security issue: see
[SECURITY.md](SECURITY.md).

## Development

Node.js 20 or newer, no dependencies to install.

```bash
node --test
```

## License

[MIT](LICENSE).
