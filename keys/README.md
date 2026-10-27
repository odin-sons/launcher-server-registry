# Registry public keys

`<key-id>.pub.pem` is the public half of the signing key with that id, for example `r1.pub.pem`. The
signing job refuses to sign unless the secret `REGISTRY_SIGNING_KEY` belongs to this file, and the
publishing job verifies every published index against it. The private key is never stored here.

See [docs/key-management.md](../docs/key-management.md).
