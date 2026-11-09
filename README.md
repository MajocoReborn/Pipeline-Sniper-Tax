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
| `programs/` | Het Anchor-programma (volgt in fase 2) |

## Bouwen en testen

De Rust-versie in `rust-toolchain.toml` wordt automatisch gekozen.

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Keypairs worden nooit gecommit: `scripts/check-no-keypairs.sh` en de pre-commit-hook
(`git config core.hooksPath .githooks`) controleren dat.
