# Overdracht: stand van zaken (10 november 2026)

Voor een nieuwe sessie. Ontwerp en achtergrond staan in [`PLAN.md`](PLAN.md), de review in
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md); dit document zegt waar alles staat, hoe je het test
en waar je op moet letten.

**Laatste stap (10 november):** de bevindingen H1, H2, I1, I2, L1 en L2 uit de review zijn in het
programma opgelost, volgens de keuzes van de eigenaar (zie "Keuzes van de eigenaar"). De nieuwe
binary heeft sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`. Devnet
draait nog de oude versie (`222ee769…`) tot de eigenaar upgradet; de opdracht staat onder
"Devnet".

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
| `crates/sniper-tax-client` | Adressen (`PoolKeys`, PDA's), gespiegelde account-types en alle instructie-builders. Geen LiteSVM, geen keypairs |
| `crates/sniper-tax-tests` | LiteSVM-harness (`src/lib.rs`, bovenop de client-crate) en integratietests: `launch_pool.rs` (24), `findings.rs` (6), `extremes.rs` (4), `stress.rs` (2), `transfer_hook.rs` (1) |
| `test-programs/test-hook` | Test-transfer-hook die elke transfer telt, in een eigen workspace zodat hij de lockfile en de binary van het echte programma niet raakt |
| `crates/sniper-tax-devnet` | Devnet-tool op de client-crate: `setup` (registreren en config), `demo` (complete launch), `config` (treasury verplaatsen, nieuwe admin voorstellen), `accept-admin` (de voorgestelde admin neemt over) |
| `metadata/sniper-tax.devnet.json` | Strategy-metadata voor Pipeline-terminals |
| `scripts/fetch-pipeline-router.sh` | Haalt de router-binary van devnet op, vastgepind op sha256, naar `fixtures/pipeline.so` |
| `docs/PLAN.md` | Ontwerp, account-validatie, dreigingsmodel, beslissingen, voortgang |
| `docs/SECURITY-REVIEW.md` | Zelf-review: bevindingen, oplossingen en de tests erbij |

## Bouwen en testen

```sh
cargo install cargo-build-sbf --version 4.6.0 --locked   # eenmalig; downloadt ~1,6 GB platform-tools
(cd programs && cargo build-sbf)                         # programma -> programs/target/deploy
(cd test-programs && cargo build-sbf)                    # test-hook -> test-programs/target/deploy
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
| `sniper-tax-client` | 1 unit-test (pool-adres gelijk aan de seeds van het programma) |
| `launch_pool` | 24 integratietests |
| `extremes` | 4 tests |
| `stress` | 2 tests |
| `findings` | 6 tests, één per opgeloste bevinding uit `SECURITY-REVIEW.md`: H1 (fee-authority, fee boven 5%, de geldende en de geplande fee), H2 (hook op het launch-token), L1 (launch-fee onder de rent) en L2 (admin-overdracht in twee stappen) |
| `transfer_hook` | 1 test, met de hook op de quote-mint. Alle paden waarin het programma transfers doet: `launch`, refund, de output van een verkoop, `claim_tax` en `sweep_protocol_fees`. Met exacte tellerstanden; zonder hook-accounts falen ze netjes |
| Lange stressrun | 43.139 trades, waarvan 12.814 belaste kopen, zonder één geschonden invariant |
| Mutatietest | 78 van 79 mutanten gevangen (84 gevonden, 5 onbouwbaar). Door de ene overblijver eindigt `cargo mutants` met exitcode 2 |

De ene mutant die overblijft is gelijkwaardig aan de originele code: het filter `*reserve > 0` in `Pricing::settle` kan nooit triggeren, omdat `check_liquidity` en de formules dat geval al uitsluiten.

## Valkuilen: lees dit vóór het opschonen

1. **Regelnummers zitten in de binary.** Anchor zet bestand en regelnummer in foutmeldingen. Elke verschoven regel in `programs/sniper-tax/src/*.rs` geeft een andere binary.
   - De huidige broncode geeft sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd` (375.568 bytes), ook bij een schone build.
   - Devnet draait tot de upgrade `222ee7691fe1b9ca344f0831b5b9ead3b863a59ba38c26c5384a105a92f09c3a`, de build van commit `8bb831b`.
   - De build hangt niet af van de map waarin de repo staat: afhankelijkheden staan met paden relatief aan hun crate in de binary. `cargo-build-sbf` 4.6.0 (platform-tools v1.58) en de lockfile bepalen het resultaat.
   - Opschonen in het programma betekent: opnieuw deployen (upgrade) op devnet, of accepteren dat devnet een oudere versie draait.
2. **Het programma-adres staat op drie plekken:** `declare_id!` in `programs/sniper-tax/src/lib.rs`, `PROGRAM_ID` in `crates/sniper-tax-client/src/lib.rs`, en in de metadata-JSON. De programma-keypair stond alleen in de oude cloud-omgeving. Een nieuwe `cargo build-sbf` maakt een nieuwe keypair aan in `target/deploy/`. De tests hebben die niet nodig, want LiteSVM laadt de `.so` op het vaste adres; alleen deployen naar een nieuw adres vraagt de keypair.
3. **De `transfer_checked`-CPI van `anchor-spl` 1.2.2 geeft geen transfer-hook-accounts door.** Gebruik daarom altijd `token::transfer_checked` uit het programma, nooit die van Anchor.
4. **Anchor 1.x weigert hetzelfde schrijfbare account twee keer** (`ConstraintDuplicateMutableAccount`), nog vóór onze eigen constraints.
5. **De router haalt zijn fee van 0,25% na de swap van het input-account van de trader.** Tests die alles verkopen falen daarom met "insufficient funds"; verkoop hooguit 99%.
6. **Output-hook-accounts:** volgens Pipeline's `INTEGRATOR-GUIDE.md` zet de client de hook-accounts van de output-mint achter de opgevraagde strategy-accounts. `pipeline_swap` geeft alles na de output-vault door aan beide transfers. Getest in `transfer_hook.rs`, met een verkoop die de quote-mint met hook uitbetaalt.
7. **De router is vastgepind.** Upgradet Pipeline de router op devnet, dan stopt `fetch-pipeline-router.sh`. Controleer dan wat er veranderd is en draai `--accept-new`.
8. **De sandbox van de cloud-omgeving weigerde de gekloonde Pipeline-repo te bouwen** (externe code). Daarom wordt de router gedownload in plaats van gebouwd. De Solana CLI 4.4.1 (`cargo install solana-cli`) vraagt Rust 1.98.1 en `libudev-dev`.
9. **Het test-hook-programma heeft een eigen workspace** (`test-programs/`). In de workspace van `programs/` verandert hij de gedeelde lockfile, en daarmee de binary van het echte programma.
10. **Nieuwe foutcodes alleen achteraan.** Anchor nummert foutcodes op volgorde (6000, 6001, …). Nieuwe codes staan daarom achter de bestaande in `errors.rs`, zodat clients de oude nummers houden.
11. **`update_config` heeft nieuwe argumenten** (`ConfigUpdate`: treasury, tax-aandeel, launch-fee; geen admin meer). Oude en nieuwe versie passen dus niet op elkaar. Gebruik na de upgrade geen oude build van de devnet-tool, en `config` of `accept-admin` van de nieuwe tool pas na de upgrade: het oude programma kent `propose_admin` en `accept_admin` niet, en weigert de nieuwe argumenten van `update_config`.
12. **De metadata noemt de treasury als vast adres** (`metadata/sniper-tax.devnet.json`, bij `launch` en `sweep_protocol_fees`). Verplaatst de admin de treasury, pas dan ook de metadata aan. Anders faalt `launch` vanuit een terminal met `WrongTreasury`. Tot 10 november stond daar nog de oude treasury `HcQgs…`.

## Devnet

| | |
|---|---|
| Programma | `EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b` (geregistreerd bij de Pipeline-router) |
| Upgrade authority, config-admin en treasury | `DEwdbWGmGf6vdtRMkBXez2zJ71JbAaJ1DdD1s3bN8tYn` (wallet van de eigenaar; 7,48 devnet-SOL op 10 november) |
| Versie op devnet | sha256 `222ee769…` (slot 520494490). De nieuwe versie `9f24dafa…` wacht op de upgrade |
| Config | `6wCct5q2tQ2WGfbtLcEzaH756aGnkMuSnnexaHmquL93`: 10% tax-aandeel, 0,01 SOL launch-fee. De 64 gereserveerde bytes zijn 0, dus na de upgrade is er geen voorgestelde admin |
| Demo-pool | `GeajhDYc24MyRecNv1a69nSsa2kdUtwbhLec6xpqVG3B` |

**Een nieuwe versie deployen.** Upgraden op hetzelfde adres kan alleen met de wallet van de eigenaar, en die key staat niet in een cloud-sessie. De eigenaar doet de upgrade daarom lokaal (keuze 4a).

1. Bouwen, vanuit de repo op de branch van PR #1:

   ```sh
   cargo install cargo-build-sbf --version 4.6.0 --locked   # eenmalig
   (cd programs && cargo build-sbf)
   shasum -a 256 programs/target/deploy/sniper_tax.so        # Linux: sha256sum
   ```

   Verwacht: `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`, 375.568 bytes. Wijkt de hash af, deploy dan niet, en zoek eerst uit waarom (een andere `cargo-build-sbf`, een gewijzigde lockfile of lokale wijzigingen).
2. Upgraden, met de wallet als upgrade authority en als betaler:

   ```sh
   solana program deploy programs/target/deploy/sniper_tax.so \
     --program-id EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b \
     --upgrade-authority <pad-naar-wallet.json> \
     --keypair <pad-naar-wallet.json> \
     --url devnet
   ```

   - De nieuwe binary is 12.744 bytes groter dan het ProgramData-account (362.824 bytes). Een recente Solana CLI (2.x of later) vergroot het account zelf. Meldt de CLI toch dat het account te klein is, vergroot het dan eerst met `solana program extend EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b 12744 --keypair <pad-naar-wallet.json> --url devnet`.
   - De deploy zet de binary eerst in een buffer (ongeveer 1,9 SOL, die terugkomt) en betaalt rent voor de extra ruimte (ongeveer 0,07 SOL).
   - Breekt de deploy halverwege af, haal de buffer-SOL dan terug met `solana program close --buffers --keypair <pad-naar-wallet.json> --url devnet`.
   - De programma-keypair is niet nodig, alleen de upgrade authority.
3. Controleren:

   ```sh
   solana program dump EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b onchain.so --url devnet
   head -c 375568 onchain.so | shasum -a 256
   ```

   Dat moet dezelfde hash geven. `head` knipt de nullen af die er staan als het account groter is gemaakt dan de binary. Leg daarna de versie op devnet vast in deze tabel.

Na de upgrade hoeft er on-chain niets meer: de pool- en config-layout zijn ongewijzigd, en de bestaande pools blijven werken. Een nieuwe sessie kan het programma ook op een nieuw adres deployen; pas dan de drie plekken uit valkuil 2 aan.

**Beheer.** `config` verplaatst de treasury (houdt de fees) en stelt met `ADMIN` een nieuwe admin voor. De nieuwe admin neemt over met `accept-admin`, met zijn eigen wallet als `KEYPAIR`. Tot dan blijft de huidige admin aan het roer. De metadata-URI in de registratie wijst naar `main`. Hij werkt pas na de merge van PR #1, en alleen als de repo publiek is.

## Opgeschoond

- **Client-crate:** `crates/sniper-tax-client` bevat de account-types (één spiegel van het programma, op één plek), de PDA's en alle instructie-builders. `launch_ix` en `claim_tax_ix` nemen de creator uit de pool-parameters. De testharness en de devnet-tool bouwen erop; de devnet-tool hangt niet meer van LiteSVM af.
- **Testopties:** mints worden beschreven met `MintSpec` (`MintSpec::token_2022(6).with_transfer_fee(..)`) en de quote-kant met `QuoteMint`, in plaats van losse vlaggen en een `Option<Option<..>>`.
- **Router opnieuw vastgepind:** Pipeline bouwde dezelfde routercode opnieuw (slot 520510501). Alle tests slagen ertegen.

## Opgelost in het programma (10 november)

Volgens de keuzes van de eigenaar, in één versie (sha256 `9f24dafa…`). Details en tests staan per bevinding in `SECURITY-REVIEW.md`.

| Bevinding | Wijziging | Foutcode | Tests |
|---|---|---|---|
| H1 | `policy::check_transfer_fee` bij `launch`, voor beide mints: geen `transfer_fee_config_authority`, en de geldende en de geplande fee hooguit 500 bps | `TransferFeeAuthorityPresent`, `TransferFeeAboveCap` | `findings.rs`: drie H1-tests, elk voor het launch-token en de quote-mint |
| H2 | `TransferHook` geweigerd op het launch-token (`policy::MintRole`), bij `create_market` en bij `launch`. Op de quote-mint toegestaan | `ForbiddenMintExtension` | `finding_h2_a_hooked_launch_token_is_refused`, `a_hooked_quote_mint_works_for_every_transfer` |
| I1 | Eigen foutcode voor "een verkoop met tax" | `TaxedSell` | Onbereikbaar; de wiskunde belast nooit een verkoop |
| I2 | Constraint `destination != quote_vault` in `ClaimTax` weg; Anchor weigert het al | `ConstraintDuplicateMutableAccount` | `the_creator_claims_their_tax_once` |
| L1 | `initialize_config` en `update_config` weigeren een launch-fee tussen 0 en het rent-minimum | `LaunchFeeBelowRent` | `finding_l1_a_launch_fee_below_rent_is_refused` |
| L2 | `update_config` wijzigt de admin niet meer; nieuw: `propose_admin` en `accept_admin`, met `pending_admin` in de gereserveerde bytes van de config | `NotPendingAdmin` | `finding_l2_the_admin_moves_only_when_the_successor_accepts` |

Een handmatige mutatieronde op het programma bevestigt dat de tests deze checks bewaken. Twintig mutanten, één voor één gebouwd en getest, en alle twintig gevangen. Voorbeelden: de hook-regel omdraaien, de fee-authority of één van de twee fees niet controleren, een fout van één bps of één lamport in de grens, en een stap van de admin-overdracht overslaan.

## Nog op te schonen

- **Dubbele veiligheidscheck:** het filter `*reserve > 0` in `Pricing::settle` (in de wiskunde-crate, die het programma gebruikt) kan nooit triggeren. Het blijft bewust staan als verdediging (I3).

## Bewust zo gelaten

- **De devnet-tool** praat JSON-RPC via `curl`. Dat werkt en houdt de tool klein; een echte RPC-client (`solana-rpc-client`) trekt veel dependencies mee voor een hulpscript.
- **Taal:** de docs zijn Nederlands, code en commentaar Engels.

## Keuzes van de eigenaar (10 november)

1. **H1, fee-bevoegdheid: a.** Een mint met een transfer fee mag alleen als de `transfer_fee_config_authority` `None` is en zowel de geldende als de geplande fee hooguit 500 bps (5%) is. Dezelfde regel geldt voor de quote-mint.
2. **H2, transfer hooks: a.** Hooks op het launch-token worden geweigerd. Op de quote-mint mag een hook blijven, zonder allowlist. Het restrisico daarvan staat in de review onder H2.
3. **Kleine programmapunten: a.** I1, I2, L1 en L2 zitten in dezelfde versie.
4. **Deploy: a.** De eigenaar upgradet zelf lokaal met zijn wallet; de opdracht staat onder "Devnet".

## Volledige reeks (10 november)

Na de wijzigingen gedraaid, met de exitcode van elke stap:

| Stap | Exitcode | Uitkomst |
|---|---|---|
| `scripts/check-no-keypairs.sh` | 0 | Geen keypairs in de repo |
| `cargo fmt --check`, in de drie workspaces | 0, 0, 0 | |
| `cargo clippy -D warnings`, in de drie workspaces | 0, 0, 0 | |
| `cargo build-sbf` in `programs/`, vanaf een lege `target/` | 0 | sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`, 375.568 bytes |
| `cargo build-sbf` in `test-programs/`, vanaf een lege `target/` | 0 | |
| `scripts/fetch-pipeline-router.sh` | 0 | De router is ongewijzigd (slot 520510501) |
| `cargo test --workspace` | 0 | 63 tests |
| Lange stresstest (`STRESS_SEEDS=30 STRESS_STEPS=1000`, release) | 0 | 43.139 trades, 12.814 belaste kopen, geen fout. Gelijk aan de vorige run: de stresstest gebruikt mints die het nieuwe beleid niet raakt |
| `cargo mutants -p sniper-tax-math` | 2 | 78 van 79 gevangen. Exitcode 2 betekent "mutanten gemist": alleen de bekende, gelijkwaardige mutant in `Pricing::settle` (I3). De wiskunde-crate is niet gewijzigd |

Daarnaast bouwde de ongewijzigde broncode (commit `8bb831b`) in een verse omgeving exact `222ee769…`, de versie op devnet. De build is dus reproduceerbaar.

## Open punten

1. **Upgrade op devnet** door de eigenaar (zie "Devnet"). Leg daarna de versie op devnet vast.
2. **Fase 6:** de zelf-review staat in [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md). H1, H2, L1, L2, I1 en I2 zijn opgelost. Open blijven M1 en M2 (operationeel), L3 (weergave-extensies) en het restrisico van een hook op de quote-mint. Daarna een externe audit.
3. **Voor mainnet:**
   - een eigen programma-keypair;
   - de treasury en de config-admin op een multisig, bijvoorbeeld Squads;
   - besluiten of de upgrade authority bevroren wordt.
