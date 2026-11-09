# Overdracht: stand van zaken (9 november 2026)

Voor een nieuwe sessie die verdergaat met **code opschonen en opnieuw testen**. Ontwerp en
achtergrond staan in [`PLAN.md`](PLAN.md); dit document zegt waar alles staat, hoe je het test
en waar je op moet letten.

## Repo en branch

- Repo: `MajocoReborn/Pipeline-Sniper-Tax`.
- Al het werk staat op branch `claude/sleepy-faraday-1fldh4`, in draft-PR #1 naar `main`. `main`
  bevat alleen de eerste commit (het plan). Zolang PR #1 niet gemerged is, werk je op die branch
  verder, of merge je eerst.
- CI (`.github/workflows/ci.yml`) is één job:
  - formatting en clippy;
  - de sBPF-build van het programma;
  - de router van devnet ophalen;
  - alle tests.

  Op elke push tot nu toe was hij groen.

## Wat er staat

| Pad | Inhoud |
|---|---|
| `programs/sniper-tax` | Het Anchor 1.2.2-programma (de Pipeline-strategy). `lib.rs` (instructies en account-structs), `state.rs`, `policy.rs` (Token-2022-beleid), `token.rs` (transfer-helper), `errors.rs` |
| `crates/sniper-tax-math` | Pure wiskunde: tax-curve, tax-verdeling en constant-product. Wordt door het programma gebruikt |
| `crates/sniper-tax-tests` | LiteSVM-harness (`src/lib.rs`) en integratietests: `launch_pool.rs` (24), `extremes.rs` (4), `stress.rs` (2) |
| `crates/sniper-tax-devnet` | Devnet-tool: `setup` (registreren en config) en `demo` (complete launch) |
| `metadata/sniper-tax.devnet.json` | Strategy-metadata voor Pipeline-terminals |
| `scripts/fetch-pipeline-router.sh` | Haalt de router-binary van devnet op, vastgepind op sha256, naar `fixtures/pipeline.so` |
| `docs/PLAN.md` | Ontwerp, account-validatie, dreigingsmodel, beslissingen, voortgang |

## Bouwen en testen

```sh
cargo install cargo-build-sbf --version 4.6.0 --locked   # eenmalig; downloadt ~1,6 GB platform-tools
(cd programs && cargo build-sbf)                         # programma -> programs/target/deploy
scripts/fetch-pipeline-router.sh                         # router -> fixtures/pipeline.so (devnet-RPC nodig)
cargo test --workspace                                   # alle tests, ~30 s
cargo clippy --workspace --all-targets -- -D warnings
(cd programs && cargo clippy --all-targets -- -D warnings)
cargo fmt --all -- --check && (cd programs && cargo fmt --all -- --check)
```

Extra:

```sh
# Lange stresstest (60.000 stappen, ~20 s in release)
STRESS_SEEDS=30 STRESS_STEPS=1000 cargo test -p sniper-tax-tests --release --test stress
# Mutatietest van de wiskunde (cargo install cargo-mutants --locked)
cargo mutants -p sniper-tax-math
```

**Verwachte uitkomsten**

| Test | Uitkomst |
|---|---|
| `sniper-tax-math` | 13 unit-tests en 12 property-tests (2.000 gevallen per stuk) |
| `launch_pool` | 24 integratietests |
| `extremes` | 4 tests |
| `stress` | 2 tests |
| Lange stressrun | 43.139 trades, waarvan 12.814 belaste kopen, zonder één geschonden invariant |
| Mutatietest | 78 van 79 mutanten gevangen |

De ene mutant die overblijft is gelijkwaardig aan de originele code: het filter `*reserve > 0` in `Pricing::settle` kan nooit triggeren, omdat `check_liquidity` en de formules dat geval al uitsluiten.

## Valkuilen: lees dit vóór het opschonen

1. **Regelnummers zitten in de binary.** Anchor zet bestand en regelnummer in foutmeldingen. Elke verschoven regel in `programs/sniper-tax/src/*.rs` geeft een andere binary. De versie op devnet heeft sha256 `222ee7691fe1b9ca344f0831b5b9ead3b863a59ba38c26c5384a105a92f09c3a`; dat is de build van de huidige broncode. Opschonen in het programma betekent: opnieuw deployen (upgrade) op devnet, of accepteren dat devnet een oudere versie draait.
2. **Het programma-adres staat op drie plekken:** `declare_id!` in `programs/sniper-tax/src/lib.rs`, `PROGRAM_ID` in `crates/sniper-tax-tests/src/lib.rs`, en in de metadata-JSON. De programma-keypair stond alleen in de oude cloud-omgeving. Een nieuwe `cargo build-sbf` maakt een nieuwe keypair aan in `target/deploy/`. De tests hebben die niet nodig, want LiteSVM laadt de `.so` op het vaste adres; alleen deployen naar een nieuw adres vraagt de keypair.
3. **De `transfer_checked`-CPI van `anchor-spl` 1.2.2 geeft geen transfer-hook-accounts door.** Gebruik daarom altijd `token::transfer_checked` uit het programma, nooit die van Anchor.
4. **Anchor 1.x weigert hetzelfde schrijfbare account twee keer** (`ConstraintDuplicateMutableAccount`), nog vóór onze eigen constraints.
5. **De router haalt zijn fee van 0,25% na de swap van het input-account van de trader.** Tests die alles verkopen falen daarom met "insufficient funds"; verkoop hooguit 99%.
6. **Output-hook-accounts:** volgens Pipeline's `INTEGRATOR-GUIDE.md` zet de client de hook-accounts van de output-mint achter de opgevraagde strategy-accounts. `pipeline_swap` geeft alles na de output-vault door aan beide transfers. Dat is correct, maar nog niet getest (zie open punten).
7. **De router is vastgepind.** Upgradet Pipeline de router op devnet, dan stopt `fetch-pipeline-router.sh`. Controleer dan wat er veranderd is en draai `--accept-new`.
8. **De sandbox van de cloud-omgeving weigerde de gekloonde Pipeline-repo te bouwen** (externe code). Daarom wordt de router gedownload in plaats van gebouwd. De Solana CLI 4.4.1 (`cargo install solana-cli`) vraagt Rust 1.98.1 en `libudev-dev`.

## Devnet

| | |
|---|---|
| Programma | `EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b` (geregistreerd bij de Pipeline-router) |
| Upgrade authority, config-admin en treasury | `DEwdbWGmGf6vdtRMkBXez2zJ71JbAaJ1DdD1s3bN8tYn` (wallet van de eigenaar, met de resterende devnet-SOL) |
| Demo-pool | `GeajhDYc24MyRecNv1a69nSsa2kdUtwbhLec6xpqVG3B` |

**Een nieuwe versie deployen.** Upgraden op hetzelfde adres kan alleen met de wallet van de eigenaar, en die key staat niet in een cloud-sessie.

- De eigenaar doet de upgrade lokaal:

  ```sh
  solana program deploy programs/target/deploy/sniper_tax.so --program-id EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b --upgrade-authority <wallet> --url devnet
  ```

  Bij een upgrade is de programma-keypair niet nodig, alleen de upgrade authority.
- Of een sessie deployt op een nieuw adres en past de drie plekken uit valkuil 2 aan.

`crates/sniper-tax-devnet` heeft een `config`-commando om de admin en de treasury later weer over te dragen. De metadata-URI in de registratie wijst naar `main` en werkt pas na de merge van PR #1, en alleen als de repo publiek is.

## Kandidaten voor opschonen

- **Een client-crate:** `sniper-tax-client` met de account-types, PDA's en instructie-builders. Die zitten nu in de testharness (`crates/sniper-tax-tests/src/lib.rs`), die ook test-specifieke dingen bevat (keypair en opties in `Pool`). Tests en de devnet-tool zouden de client-crate gebruiken, en integrators kunnen hem ook gebruiken. Dit raakt het programma niet.
- **Gespiegelde types:** `LaunchPool`, `ProtocolConfig`, `InitParams` en `ConfigArgs` staan dubbel (in het programma en in de tests). Met een client-crate kan dat op één plek.
- **Foutcode:** `LaunchPool::apply` gebruikt `MathOverflow` voor "een verkoop met tax", wat niet kan gebeuren. Een eigen foutcode of een `debug_assert` is duidelijker. Let op valkuil 1.
- **Dubbele check:** de constraint `destination != quote_vault` in `ClaimTax` doet hetzelfde als Anchors eigen duplicaatcheck. Hij mag weg. Let op valkuil 1.
- **De devnet-tool** praat JSON-RPC via `curl`. Dat werkt, maar een echte RPC-client is netter.
- **Taal:** de docs zijn Nederlands, de code-commentaren Engels. Kies of je dat zo wilt houden.

## Open punten

1. **Tests met transfer-hook-tokens.** Daarvoor is een klein test-hook-programma nodig, met een extra account in de ExtraAccountMetaList. Test kopen (de output-hook-accounts achter de output-vault), verkopen (input-hook-accounts via de router), `launch` en `claim_tax`.
2. **Fase 6:** een review- of audit-ronde.
3. **Voor mainnet:**
   - een eigen programma-keypair;
   - de treasury en de config-admin op een multisig, bijvoorbeeld Squads;
   - besluiten of de upgrade authority bevroren wordt.
