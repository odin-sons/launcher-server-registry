# Contributing: listing a community

This guide is for people who run a community and want its modpack offered in the OdinSons launcher.
Listing is a pull request that adds one file, `servers/<id>.json`.

Listing is not an endorsement. A status says how the registry vetted the files, not that the
maintainers back a community or its terms. The launcher tells players so.

## Before you start

You need:

- Your files published over HTTPS on one to eight mirrors that serve identical content. The launcher
  tries them in order and falls back when one is down.
- A modpack described by the launcher's manifests (`update.info` and friends, produced by the
  launcher's Indexer), and a `servers.json` that lists your game servers.
- A community name and, optionally, a website and a chat link.

Optional presentation files are described in the launcher repository: a theme
([themes.md](https://github.com/odin-sons/Launcher/blob/master/docs/themes.md)), an About page and
terms ([server-page.md](https://github.com/odin-sons/Launcher/blob/master/docs/server-page.md)).

## The entry file

`servers/<id>.json`, where `<id>` is 2 to 32 lowercase letters, digits or hyphens, starting with a
letter or digit. The file name and the `id` field must match.

| Field | Required | Rules |
|-------|----------|-------|
| `id` | yes | `^[a-z0-9][a-z0-9-]{1,31}$`; also the file name; unique |
| `name` | yes | 1 to 48 characters, no control characters |
| `status` | yes | `approved`, `needs-approval` or `suspended`; maintainers have the last word |
| `mirrors` | yes | 1 to 8 `https` base URLs ending in `/`, no credentials, query or fragment; most preferred first |
| `digests` | yes | 1 to 64 entries: a path relative to a mirror base URL (no `..`, no leading `/` or `\`) to the lowercase hex SHA-256 of that file |
| `website`, `community` | no | `https` links; `community` is your own chat, on any messenger |
| `theme` | no | path of `theme.json`; it and every image it names must be in `digests` |
| `about` | no | path of `about.json`; must be in `digests` |
| `terms` | no | language code (`en`, `de`, `pt-BR`: two or three letters and at most one subtag) to path of a Markdown file, for example `{ "en": "terms/en.md" }`; `en` is required, at most 16 languages; every path must be in `digests` |

Unknown fields are ignored by the launcher and are not published. The machine-readable form is
[schema/server.schema.json](schema/server.schema.json).

What goes into `digests`: every file the launcher must trust before it downloads anything else, that
is `servers.json`, each profile's manifests (`<profile>/update.info`, `update_admin.info`,
`optional.info`, `game*.info`), `changelog.md`, and the theme, About and terms files with their
images. The mods themselves are pinned by the SHA-256 values inside the manifests, so changing a
manifest means changing its digest.

Compute a digest with `sha256sum <file>` (Linux), `shasum -a 256 <file>` (macOS) or
`Get-FileHash -Algorithm SHA256 <file>` (PowerShell, lowercase the result). With Node.js 20 or newer,
`node tools/digest.js <site-root> servers.json Profile/update.info` prints the whole `digests` object.

```json
{
  "id": "your-community",
  "name": "Your Community",
  "status": "approved",
  "mirrors": ["https://files.example-host.net/Launcher/"],
  "website": "https://your-community.net/",
  "digests": {
    "servers.json": "<64 lowercase hex characters>",
    "Profile/update.info": "<64 lowercase hex characters>"
  }
}
```

Set `status` to `approved` in your pull request: merging it is the approval. A maintainer may ask you
to change it.

## Submitting

1. Fork this repository and add `servers/<id>.json`. Touch nothing else: a pull request that changes
   files outside `servers/` is flagged and needs a maintainer's attention.
2. Run `node tools/validate.js servers/<id>.json` in your fork. It downloads your files and checks them
   the way CI does, so you see the result before anyone else does.
3. Open a pull request and fill in the template.
4. CI downloads your files and posts one comment with the result. It is updated in place whenever you
   push. Fix everything marked as an error.
5. A maintainer reviews the change (below). Merging adds your community to the next signed index.

## What CI checks

- The entry matches the schema, its file name matches its `id`, and the name is not already taken.
- Every mirror is `https` without credentials, and serves every file in `digests`.
- Each file's SHA-256 equals the pinned digest. A file is rejected as soon as it grows past its limit
  while downloading.
- Every manifest parses, and the files it lists download from your mirror and match the hashes and
  sizes in the manifest. The three game manifests (`game.info`, `game_macos.info`, `game_linux.info`) are parsed and their vanilla game files are not downloaded; their executables are only looked up on VirusTotal by hash. Any other `.info` file is treated as a mod list and fully verified. Files are checked on every mirror. File names that Windows would fold (a trailing dot or space, a stream suffix, case) are refused.
- The theme, About and terms files named by the entry are in `digests`, parse, and respect the limits
  below.
- Files that carry code are looked up on VirusTotal by hash, and unknown ones are uploaded. Detections
  are shown to the maintainers as a signal; they are not an automatic verdict.

| File | Limit |
|------|-------|
| Entry file | 64 KiB |
| `theme.json`, `about.json` | 16 KiB each |
| Logo | PNG, 256 KiB, 512 x 512 pixels |
| Art picture | PNG or JPEG, 1 MiB, 1920 x 1080 pixels |
| Terms | 20 KiB per language |
| Manifest | 16 MiB |
| `changelog.md` | 64 KiB |
| `servers.json`, other pinned files | 1 MiB |
| One file listed in a manifest | 256 MiB |
| All files listed in manifests | 2 GiB |

Every URL in your entry is treated as hostile by CI: only `https`, no credentials, limited
redirects, no private addresses, capped size and time.

## What review means

A maintainer reads the diff, checks who the community is and what the mods are, looks at the theme
and the terms, and weighs the CI and VirusTotal results. Automation narrows what the reviewer has to
read; it does not replace reading.

Review may reject a listing for terms that imitate the launcher or the registry, for claims that
either endorses the community, for a name that impersonates someone else, or for mods the maintainers
are not willing to put in front of players. VirusTotal flags are a reason to look closer, not a
verdict in either direction: BepInEx and similar loaders are flagged by a few engines because of what
they do.

## After you are listed

- Changing your files means a new pull request with the new digests. The old ones stop matching, and
  the launcher refuses files that do not match the signed digest.
- Approved entries are re-checked on a schedule. If a pinned file changes or a file is newly flagged,
  a pull request moves your entry to `needs-approval` until a maintainer has looked again.
- To leave the registry, open a pull request that deletes your file.
- To report a problem with a listing, see [SECURITY.md](SECURITY.md).

## Conventions

Everything in this repository, including commit messages and pull request text, is in English.
Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
