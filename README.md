# Pipeline Sniper Tax

A strategy for the [Pipeline](https://github.com/MetalLegBob/pipeline) router on Solana: a
launch pool that taxes snipers. A buy right after launch pays 99% tax, and that tax falls to 0%
over a configurable window (for example 1.5 or 10 minutes). The creator's wallet is exempt.
Works with SPL Token and Token-2022. To protect buyers, a pool refuses a launch token with a
mint or freeze authority or a transfer hook, and a transfer fee that can still change or is
above 5%.

> **Status:** in development, live on devnet. The design is in [`docs/PLAN.md`](docs/PLAN.md),
> the self-review of the program and its fixes in [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md),
> and the one of the launch site in [`docs/SITE-SECURITY-REVIEW.md`](docs/SITE-SECURITY-REVIEW.md).

## Repository

| Path | Contents |
|---|---|
| `docs/SECURITY-REVIEW.md` | Self-review of the program: findings, evidence, fixes and their tests |
| `docs/SITE-SECURITY-REVIEW.md` | Self-review of the launch site: findings, fixes, tests and the owner's open decisions |
| `docs/PLAN.md` | Design, account validation, threat model, test plan and phases |
| `docs/HANDOFF.md` | Current state, commands, pitfalls and devnet details, for the next session |
| `docs/LAUNCH-SITE.md` | Plan for the launch website (approved), with its progress |
| `crates/sniper-tax-math` | Pure maths: the tax curve, the tax split and constant-product pricing, with property tests |
| `programs/sniper-tax` | The Anchor program: the Pipeline strategy |
| `crates/sniper-tax-client` | Addresses, account types and instruction builders, for launchers, scripts and integrators |
| `crates/sniper-tax-tests` | Integration tests against the real Pipeline router from devnet |
| `test-programs/test-hook` | Test transfer hook for the integration tests |
| `crates/sniper-tax-devnet` | Registration, config and a demo launch on devnet |
| `metadata/sniper-tax.devnet.json` | Strategy metadata for Pipeline terminals (devnet) |
| `app/` | The launch site on devnet, in progress (Vite, React, `@solana/kit`): a launch page, a list of launches, token pages with the live tax and trading, and a creator dashboard to claim the tax; with its TypeScript client, tested against the Rust client |

## Build and test

The Rust version in `rust-toolchain.toml` is picked automatically.

You need `cargo-build-sbf` 4.6.0 (`cargo install cargo-build-sbf --version 4.6.0 --locked`).

```sh
(cd programs && cargo build-sbf)       # the program, into programs/target/deploy
(cd test-programs && cargo build-sbf)  # the test hook, into test-programs/target/deploy
scripts/fetch-pipeline-router.sh       # the router live on devnet, into fixtures/
cargo test --workspace                 # maths, property and integration tests
(cd app && npm ci && npm test)         # the site and its client (Node 20.19 or later)
(cd app && npm run test:browser)       # the built site in Chromium, with a stand-in wallet
(cd app && npm run dev)                # the site on http://localhost:5173, against devnet
```

## Devnet

Live on devnet, registered with the Pipeline router:

| | Where |
|---|---|
| The launch site | <https://sniper-tax-launch-devnet.majoco21.workers.dev> (devnet only; the one official address until the name and domain are chosen) |
| Program | [`EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b`](https://explorer.solana.com/address/EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b?cluster=devnet) |
| Demo pool (90 s tax window) | [`GeajhDYc24MyRecNv1a69nSsa2kdUtwbhLec6xpqVG3B`](https://explorer.solana.com/address/GeajhDYc24MyRecNv1a69nSsa2kdUtwbhLec6xpqVG3B?cluster=devnet) |
| Upgrade authority, config admin and treasury | `CUiq3QQbXMsrgCpiN423zr2NTrdfPRuGUy9EQKQ6CGap` (a wallet only for devnet) |

In the demo, a sniper who bought about 5 seconds after launch paid 93.5% tax. A buy after the
window paid nothing. Of the tax, 90% went to the creator and 10% to the treasury.

Upgrading the existing devnet program is described in [`docs/HANDOFF.md`](docs/HANDOFF.md)
(section "Devnet").

Deploying your own:

You need the Solana CLI 4.4 and a wallet with about 6 devnet SOL (from
[faucet.solana.com](https://faucet.solana.com)). The program address in `declare_id!` belongs to
the keypair in `programs/target/deploy/`. To deploy your own copy, create your own keypair and
change the address in `programs/sniper-tax/src/lib.rs`, `crates/sniper-tax-client/src/lib.rs` and
the metadata.

```sh
solana program deploy programs/target/deploy/sniper_tax.so \
  --program-id programs/target/deploy/sniper_tax-keypair.json --keypair <wallet> --url devnet
KEYPAIR=<wallet> TREASURY=<address> cargo run -p sniper-tax-devnet -- setup
KEYPAIR=<wallet> cargo run -p sniper-tax-devnet -- demo --wait
```

`setup` registers the program with the Pipeline router and creates the config. `config` (signed
by the current admin) moves the treasury (`TREASURY`) and, with `ADMIN`, proposes a new admin, who
takes over with `accept-admin`. `demo` creates a test token, launches a pool in one transaction,
has a sniper buy right after launch, buys again after the window (with `--wait`), and claims and
sweeps the tax.

Keypairs are never committed: `scripts/check-no-keypairs.sh` and the pre-commit hook
(`git config core.hooksPath .githooks`) check for them.

## License

Apache-2.0, see [`LICENSE`](LICENSE). Copyright 2026 MajocoReborn.

Parts of the test harness, the way the program builds Pipeline instructions, and the keypair
check script are adapted from [Pipeline](https://github.com/MetalLegBob/pipeline) (Apache-2.0).
The files themselves say where.
