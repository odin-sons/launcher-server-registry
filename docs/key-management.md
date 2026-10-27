# Signing key: generation, use and rotation

The registry index is signed with an ECDSA P-256 key, SHA-256, DER encoded, as described in the
launcher's [registry-format.md](https://github.com/odin-sons/Launcher/blob/master/docs/registry-format.md).
The private key lives only in the secret `REGISTRY_SIGNING_KEY` of the GitHub Environment `registry`.
It is never committed, printed, cached or uploaded: the signing job writes only the signed
`index.json`.

## How an index is made

`tools/sign-index.js` reads every `servers/*.json` (and refuses to continue if one is invalid), builds the
payload, signs the exact payload bytes, checks the result with the verifier that mirrors the launcher's
reader, and writes `index.json` with `.nojekyll` and a `_headers` file.

| Payload field | Value |
|---------------|-------|
| `schema` | `1` |
| `serial` | The issue time in Unix seconds. There is no stored counter: every later signing has a higher serial as long as the clock moves forward, and two signings in the same second share one. The launcher refuses a lower serial than one it has accepted, so a replayed old index loses against a newer one. |
| `issuedAt`, `expiresAt` | `yyyy-MM-ddTHH:mm:ssZ`; `expiresAt` is `issuedAt` plus `validityDays` (14 in `config/index.json`, never more than 31) |
| `minLauncher` | From `config/index.json`; raising it makes older launchers show "update required" |
| `servers` | Every entry with its documented fields in a fixed order, sorted by id, with its status (`approved`, `needs-approval`, `suspended`); at most 500, and the envelope at most 1 MiB |

The workflow signs on every merge that changes `servers/` or the configuration, and daily, so the
index never gets close to its 14-day expiry unless the schedule stops (see the maintainer checklist).

## Generate the key

On a machine you trust, with OpenSSL 1.1.1 or newer. The private key never goes into this repository
or a chat; the file is deleted once it is in the secret.

```bash
umask 077
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out registry-r1.key.pem
openssl pkey -in registry-r1.key.pem -pubout -out r1.pub.pem
node tools/key-info.js r1.pub.pem r1
```

1. Paste the content of `registry-r1.key.pem` into the environment secret `REGISTRY_SIGNING_KEY`
   (Settings, Environments, `registry`), then delete the file and keep an offline backup in a password
   manager or on an encrypted drive.
2. Commit `r1.pub.pem` as `keys/r1.pub.pem` in a pull request. The signing job refuses to sign unless the
   secret's public half equals that file, so a wrong secret is caught before anything is published.
3. `node tools/key-info.js` prints the key as a base64 `SubjectPublicKeyInfo` and the line for the
   launcher: put it in `RegistryKeySet.Official` in `Launcher.Core/RegistryKeySet.cs`
   (`new KeyValuePair<string, byte[]>("r1", Convert.FromBase64String("..."))`) and ship that launcher build
   before the first index is relied on.

A check you can run at any time against a published index:

```bash
curl -fsS https://<mirror>/index.json -o index.json
node tools/verify-index.js index.json --public-key keys/r1.pub.pem
```

## Rotation

A signed index never delivers a new trusted key: a leaked key must not be able to install another. The
launcher ships a list of accepted keys, and rotation goes through a launcher release.

1. Generate the new key as above with a new id (`r2`). Commit `keys/r2.pub.pem`.
2. Release a launcher build that accepts both `r1` and `r2`. Wait until most players have updated; the
   launcher's own update is the delivery channel.
3. Create the secret and variable for the new key: set `REGISTRY_SIGNING_KEY` in the `registry`
   environment to the new key and the variable `REGISTRY_KEY_ID` to `r2`, in one sitting. The next
   run signs with `r2`. Launchers that only know `r1` stop accepting new indexes; they keep working
   from their cache until it expires and then show "update required" for the registry, so do not skip step 2.
4. Release a launcher build that drops `r1`, and delete `keys/r1.pub.pem` and your backup of the old private key.

## Compromise

A suspected leak is a compromise, not a rotation.

1. Disable publishing: set the repository variable `REGISTRY_PUBLISH` to anything but `true`, and remove
   the secret from the `registry` environment.
2. Generate a new key and release a launcher build that trusts only the new key (and no longer the old one).
3. Re-enable publishing with the new key. Players on older builds keep trusting the leaked key until they
   update, so tell players to update.
4. Review the Actions history and the `registry` environment's deployments for signings you did not expect.

## What protects the key

- The environment `registry` is restricted to the `main` branch, so no pull request or other branch can
  read the secret. Signing workflows never run on `pull_request`; `test/workflows.test.js` fails if the key
  is referenced outside a job bound to that environment, or on a pull request trigger.
- Every action is pinned to a commit SHA and the signing job uses only first-party actions. The job has
  `contents: read` and nothing else; publishing happens in separate jobs that receive only the signed
  `site` artifact.
- The index is verified by the launcher against the pinned public key. A compromised mirror or deployment
  job can withhold or replay an index until it expires, but cannot forge one.

## Try it without the key

`registry-dry-run` (Actions, Run workflow) signs the current `servers/` with a key generated inside
the job, verifies the result with the same verifier, prints what would be published and publishes
nothing. Locally: `node tools/sign-index.js --throwaway --out dist/site`.
