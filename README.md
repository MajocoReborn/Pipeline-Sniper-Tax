# Pipeline Sniper Tax

Een strategy voor de [Pipeline](https://github.com/MetalLegBob/pipeline)-router op Solana: een
launch-pool die snipers belast. Een koop direct na de launch betaalt 99% tax, en die tax zakt in
een instelbare periode (bijvoorbeeld 1,5 of 10 minuten) naar 0%. De creator-wallet is vrijgesteld.
Werkt met SPL Token en Token-2022.

> **Status:** in ontwikkeling, nog niet on-chain. Het ontwerp staat in [`docs/PLAN.md`](docs/PLAN.md).

## Repository

| Pad | Inhoud |
|---|---|
| `docs/PLAN.md` | Ontwerp, account-validatie, dreigingsmodel, testplan en fasering |
| `crates/sniper-tax-math` | Pure wiskunde: tax-curve, tax-verdeling en constant-product-prijzen, met property-tests |
| `programs/sniper-tax` | Het Anchor-programma: de Pipeline-strategy |
| `crates/sniper-tax-tests` | Integratietests tegen de echte Pipeline-router van devnet |

## Bouwen en testen

De Rust-versie in `rust-toolchain.toml` wordt automatisch gekozen.

Je hebt `cargo-build-sbf` 4.6.0 nodig (`cargo install cargo-build-sbf --version 4.6.0 --locked`).

```sh
(cd programs && cargo build-sbf)       # het programma, naar programs/target/deploy
scripts/fetch-pipeline-router.sh       # de router die live op devnet draait, naar fixtures/
cargo test --workspace                 # wiskunde-, property- en integratietests
```

Keypairs worden nooit gecommit: `scripts/check-no-keypairs.sh` en de pre-commit-hook
(`git config core.hooksPath .githooks`) controleren dat.
