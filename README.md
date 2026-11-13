# Pipeline Sniper Tax: launch site

The launch site for the sniper-tax launch pool on the [Pipeline](https://github.com/MetalLegBob/pipeline)
router on Solana: launch a token into a pool whose buys pay a sniper tax that falls to zero,
follow launches and their live tax, trade, and claim the tax as a creator.

> **The protocol moved.** The on-chain program, its crates and tests, the TypeScript SDK, the
> design and the security review now live in
> **[MajocoReborn/pipeline-sniper-tax-strategy](https://github.com/MajocoReborn/pipeline-sniper-tax-strategy)**,
> with a [guide for launchpads](https://github.com/MajocoReborn/pipeline-sniper-tax-strategy/blob/main/docs/INTEGRATION.md).
> This repository keeps the site, which uses that SDK. History before the move (up to
> `7b7517c`) is here.

> **Status:** devnet only, at <https://sniper-tax-launch-devnet.majoco21.workers.dev> (the one
> official address until the name and domain are chosen).

## Repository

| Path | Contents |
|---|---|
| `app/` | The site (Vite, React, `@solana/kit`): a launch page, a list of launches, token pages with the live tax and trading, and a creator dashboard to claim the tax |
| `app/vendor/` | The protocol's TypeScript SDK, `@majocoreborn/sniper-tax-sdk`, pinned to a commit of the protocol repository until it is on npm |
| `docs/HANDOFF.md` | Current state of the site, commands, pitfalls, hosting and devnet runs |
| `docs/LAUNCH-SITE.md` | Plan for the site (approved), with its progress |
| `metadata/sniper-tax.devnet.json` | The strategy metadata the router registration still points at; kept until the registration points at the protocol repository |
| `scripts/update-sdk.sh` | Rebuilds the vendored SDK at its pinned commit, or checks it (`--check`) |

## Build and test

Node 20.19 or later.

```sh
cd app
npm ci
npm test          # typecheck, prettier, vitest
npm run build     # the static site -> app/dist
npm run dev       # the site on http://localhost:5173, against devnet
```

The site runs on Cloudflare (a Worker with static assets), deployed from `main` on every
push; see [`docs/HANDOFF.md`](docs/HANDOFF.md).

Keypairs are never committed: `scripts/check-no-keypairs.sh` and the pre-commit hook
(`git config core.hooksPath .githooks`) check for them.

## License

Apache-2.0, see [`LICENSE`](LICENSE). Copyright 2026 MajocoReborn.

`app/src/vendor/pipeline/http.ts` and the keypair check script are adapted from
[Pipeline](https://github.com/MetalLegBob/pipeline) (Apache-2.0). The files themselves say
where.
