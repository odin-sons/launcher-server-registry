## Community

<!-- Who runs this community, and for whom? One or two sentences. -->

- Entry: `servers/<id>.json`
- Change: <!-- new community / updated files / status change / removal -->
- Website or chat where the maintainers can reach you:

## Files

- Mirrors (all serve identical content):
- Modpack: <!-- number of mods, what kind of server, anything unusual such as native code or installers -->
- Theme, About page, terms: <!-- included / not included -->

## Checklist

- [ ] The file is `servers/<id>.json` and `id` matches the file name
- [ ] This pull request touches nothing outside `servers/`
- [ ] Every mirror is `https`, has no credentials and ends in `/`
- [ ] `digests` pins `servers.json`, every manifest, `changelog.md` and every theme, About and terms file with its images
- [ ] The digests are lowercase SHA-256 of the files exactly as published
- [ ] `status` is `approved`; I understand a maintainer decides and may change it
- [ ] The name does not imitate another community, the launcher or the registry
- [ ] The terms do not claim that the launcher or the registry endorses this community
- [ ] I have read [CONTRIBUTING.md](https://github.com/odin-sons/launcher-server-registry/blob/main/CONTRIBUTING.md) and know what CI checks and what review means

<!-- CI posts one comment with the result. Fix every error it lists, then push again. -->
