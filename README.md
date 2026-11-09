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
| `test-programs/test-hook` | Test-transfer-hook voor de integratietests |
| `crates/sniper-tax-devnet` | Registratie, config en een demo-launch op devnet |
| `metadata/sniper-tax.devnet.json` | Strategy-metadata voor Pipeline-terminals (devnet) |

## Bouwen en testen

De Rust-versie in `rust-toolchain.toml` wordt automatisch gekozen.

Je hebt `cargo-build-sbf` 4.6.0 nodig (`cargo install cargo-build-sbf --version 4.6.0 --locked`).

```sh
(cd programs && cargo build-sbf)       # het programma, naar programs/target/deploy
(cd test-programs && cargo build-sbf)  # de test-hook, naar test-programs/target/deploy
scripts/fetch-pipeline-router.sh       # de router die live op devnet draait, naar fixtures/
cargo test --workspace                 # wiskunde-, property- en integratietests
```

## Devnet

Live op devnet, geregistreerd bij de Pipeline-router:

| | Adres |
|---|---|
| Programma | [`EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b`](https://explorer.solana.com/address/EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b?cluster=devnet) |
| Demo-pool (90 s tax-venster) | [`GeajhDYc24MyRecNv1a69nSsa2kdUtwbhLec6xpqVG3B`](https://explorer.solana.com/address/GeajhDYc24MyRecNv1a69nSsa2kdUtwbhLec6xpqVG3B?cluster=devnet) |
| Upgrade authority, config-admin en treasury | `DEwdbWGmGf6vdtRMkBXez2zJ71JbAaJ1DdD1s3bN8tYn` |

In de demo betaalde een sniper die ongeveer 5 seconden na de launch kocht 93,5% tax. Een koop na het
venster betaalde niets. Van de tax ging 90% naar de creator en 10% naar de treasury.

Zelf deployen:

Je hebt de Solana CLI 4.4 nodig en een wallet met ongeveer 6 devnet-SOL (via
[faucet.solana.com](https://faucet.solana.com)). Het programma-adres in `declare_id!` hoort bij
de keypair in `programs/target/deploy/`. Wie zelf deployt, maakt een eigen keypair en past het
adres aan in `programs/sniper-tax/src/lib.rs`, `crates/sniper-tax-tests/src/lib.rs` en de metadata.

```sh
solana program deploy programs/target/deploy/sniper_tax.so \
  --program-id programs/target/deploy/sniper_tax-keypair.json --keypair <wallet> --url devnet
KEYPAIR=<wallet> TREASURY=<adres> cargo run -p sniper-tax-devnet -- setup
KEYPAIR=<wallet> cargo run -p sniper-tax-devnet -- demo --wait
```

`setup` registreert het programma bij de Pipeline-router en maakt de config aan. `config`
(met `ADMIN` en `TREASURY`, getekend door de huidige admin) draagt het beheer over. `demo` maakt
een testtoken, lanceert een pool in één transactie, laat een sniper direct na de launch kopen,
koopt opnieuw na het venster (met `--wait`) en claimt en sweept de tax.

Keypairs worden nooit gecommit: `scripts/check-no-keypairs.sh` en de pre-commit-hook
(`git config core.hooksPath .githooks`) controleren dat.

## Licentie

Apache-2.0, zie [`LICENSE`](LICENSE). Copyright 2026 MajocoReborn.

Delen van de testharness, de opbouw van de Pipeline-instructies in het programma en het
keypair-checkscript zijn aangepast van [Pipeline](https://github.com/MetalLegBob/pipeline)
(Apache-2.0). De bestanden zelf vermelden waar.
