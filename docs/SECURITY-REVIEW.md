# Beveiligingsreview (zelf-review, fase 6)

> Dit is een interne review door dezelfde ontwikkelaar die de code schreef. Ze vervangt
> geen externe audit; voor mainnet blijft die aan te raden.

## Scope

| | |
|---|---|
| Programma | `programs/sniper-tax`. Gereviewd: sha256 `222ee7691fe1b9ca344f0831b5b9ead3b863a59ba38c26c5384a105a92f09c3a`, de versie op devnet (`EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b`) |
| Oplossingen | Versie met sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd` (10 november 2026). Lost H1, H2, L1, L2, I1 en I2 op. Draait op devnet zodra de eigenaar upgradet (zie `HANDOFF.md`) |
| Mee bekeken | `crates/sniper-tax-math` (de prijsberekening van het programma) en de wisselwerking met de Pipeline-router (vastgepinde devnet-binary) |
| Methode | Elke instructie en constraint nagelopen met een aanvallersblik. Elk vermoeden is waar mogelijk met een test op de echte router bevestigd of weerlegd. Daarnaast: property-tests, de stresstest (60.000 stappen) en de mutatietest |

## Samenvatting

| ID | Ernst | Bevinding | Bewijs | Status |
|---|---|---|---|---|
| H1 | Hoog | De fee-bevoegdheid van een token kan de pool later in een honeypot veranderen | `tests/findings.rs` | **Opgelost**: fee-authority moet `None` zijn, fee hooguit 5% |
| H2 | Hoog | Een transfer hook kan verkopen blokkeren (honeypot) | Pipeline's eigen test `restrictive_hook_blocks_selling…` en `ROUTER.md` | **Opgelost** voor het launch-token; op de quote-mint bewust toegestaan |
| M1 | Middel | Eén wallet is upgrade authority én config-admin | Configuratie op devnet | Open: operationeel |
| M2 | Middel | De creator heeft door het ontwerp voordelen tegenover kopers | Ontwerp (§3 van PLAN) | Open: transparant maken |
| L1 | Laag | Een verkeerde treasury of launch-fee kan alle launches laten falen | Code-analyse | **Opgelost** voor de launch-fee; de treasury-eis is gedocumenteerd |
| L2 | Laag | De config-admin kan in één stap naar een onbruikbaar adres gaan | Code-analyse | **Opgelost**: overdracht in twee stappen |
| L3 | Laag | Weergave-extensies kunnen na de launch misleiden | Code-analyse | Open |
| L4 | Laag | De tijd op de chain kan enkele seconden afwijken | Ontwerp | Geaccepteerd |
| L5 | Laag | Een programma als creator kan belastingvrij kopen aanbieden | Ontwerp | Geaccepteerd, vermelden |
| L6 | Laag | Afhankelijk van de upgradebare Pipeline-router | Router-upgrade van 9 november | Bewaakt door de vastgepinde router |
| I1–I4 | Info | Cosmetica en kleine punten | Zie onder | I1 en I2 opgelost; I3 en I4 bewust zo gelaten |

Geen enkele bevinding laat iemand **zonder medewerking van de creator of de beheerder** geld uit een pool halen. H1 en H2 gaan over de bescherming van kopers tegen een kwaadwillende creator. Juist dat is de belofte van een launchpad.

## Bevindingen

### H1: de fee-bevoegdheid van een token kan de pool in een honeypot veranderen

**Wat:** het mint-beleid (`policy.rs`) staat de extensie `TransferFeeConfig` toe, maar controleert niet wie de fee mag wijzigen. Token-2022 laat de `transfer_fee_config_authority` de fee verhogen tot 100%. De nieuwe fee gaat twee epochs later in.

**Gevolg:** een creator lanceert met 0% fee en zet de fee na de launch op 100%. Daarna:
- levert elke verkoop niets op: de vault ontvangt 0 tokens, dus de verkoper krijgt 0 SOL;
- met een minimale opbrengst faalt elke verkoop;
- kopers krijgen 0 tokens.

De ingehouden fees kan de creator als `withdraw_withheld_authority` zelf opnemen. Hetzelfde kan met een eigen **quote-mint** met fee-bevoegdheid. Dat is minder waarschijnlijk, want kopers moeten die munt eerst hebben.

**Bewijs (vóór de oplossing):** `finding_h1_a_kept_fee_authority_can_trap_sellers` in `crates/sniper-tax-tests/tests/findings.rs` (commit `34d2f3d`). Na de verhoging faalde een verkoop met minimum, en een verkoop zonder minimum nam de tokens en betaalde niets. Die test is nu omgedraaid: zo'n token wordt geweigerd.

**Aanbevolen oplossing**, in `policy::check_launch_authorities` en de quote-check bij `launch`:
- Een launch-token met `TransferFeeConfig` moet `transfer_fee_config_authority == None` hebben. Dan staat de fee voor altijd vast.
- Zowel de huidige als de toekomstige fee moet onder een maximum blijven, bijvoorbeeld 500 bps.
- Voor de quote-mint: dezelfde regel, of een allowlist (WSOL, USDC).

**Oplossing (keuze van de eigenaar: optie a, ook voor de quote-mint):** `policy::check_transfer_fee`, aangeroepen in `launch` voor beide mints. Een mint met `TransferFeeConfig` wordt geweigerd als:
- de `transfer_fee_config_authority` niet `None` is (`TransferFeeAuthorityPresent`);
- de fee die nu geldt, of een fee die voor een later epoch gepland staat, boven 500 bps (5%) ligt (`TransferFeeAboveCap`).

Een oude fee die niet meer geldt, blijft in de mint staan en telt niet mee. De check gebeurt bij `launch`, het laatste moment vóór de handel begint: tussen `create_market` en `launch` kan de authority de fee nog wijzigen of intrekken. Daarna staat de fee voor altijd vast.

Tests in `crates/sniper-tax-tests/tests/findings.rs`, elk voor het launch-token én de quote-mint:
- `finding_h1_a_mint_with_a_fee_authority_is_refused`: geweigerd met fee-authority. Na het intrekken lanceert de pool, en daarna kan niemand de fee nog verhogen;
- `finding_h1_a_transfer_fee_above_5_percent_is_refused`: 501 bps geweigerd, 500 bps toegestaan;
- `finding_h1_the_fee_in_force_and_a_scheduled_fee_both_count`: 1% nu en 100% gepland wordt geweigerd. 10% nu en 1% gepland wordt geweigerd tot de 1% geldt, en lanceert daarna.

### H2: een transfer hook kan verkopen blokkeren

**Wat:** het beleid staat `TransferHook` toe. De hook-authority kan het hook-programma vervangen, en een hook-programma kan zelf upgradebaar of kwaadwillend zijn. Een hook die transfers naar de vault weigert, laat kopen wel toe en verkopen niet. Pipeline beschrijft dit zelf ("Restrictive transfer hooks… can be bought through Pipeline but not sold", `ROUTER.md`) en test het (`restrictive_hook_blocks_selling_unless_the_fee_account_is_whitelisted`).

**Gevolg:** dezelfde honeypot als bij H1, maar dan direct vanaf de launch mogelijk.

**Aanbevolen oplossing:** kies één van:
1. **Weiger `TransferHook` op het launch-token.** Dit is de aanbeveling voor een launchpad: kopers moeten altijd kunnen verkopen. Laat hooks alleen toe op een quote-mint uit een allowlist.
2. Sta alleen hooks toe met hook-authority `None` en een hook-programma zonder upgrade authority. Dat is controleerbaar via de ProgramData. Een vanaf het begin kwaadwillende hook blijft dan mogelijk.
3. Een allowlist van bekende hook-programma's in de config.

De hook-tests (`transfer_hook.rs`) blijven nuttig voor de quote-kant of voor optie 3.

**Oplossing (keuze van de eigenaar: optie 1, zonder allowlist voor de quote-mint):** het extensiebeleid verschilt nu per kant (`policy::MintRole`). `TransferHook` is geweigerd op het launch-token (`ForbiddenMintExtension`), al bij `create_market`, en opnieuw bij `launch`. Op de quote-mint mag een hook blijven.

Tests:
- `finding_h2_a_hooked_launch_token_is_refused` in `findings.rs`;
- `a_hooked_quote_mint_works_for_every_transfer` in `transfer_hook.rs`: alle transfers van het programma met een hook op de quote-mint (`launch`, refund, de output van een verkoop, `claim_tax` en `sweep_protocol_fees`), met exacte tellerstanden.

**Restrisico, geaccepteerd door de eigenaar:** een quote-mint met een hook kan dezelfde honeypot maken, want een hook die transfers uit de quote-vault weigert, blokkeert de opbrengst van elke verkoop. Dat vraagt een eigen quote-mint met een kwaadwillende of vervangbare hook, en kopers moeten die munt eerst hebben. De launch-UI moet een quote-mint met een hook daarom duidelijk tonen, of alleen bekende quote-mints aanbieden (WSOL, USDC).

### M1: één wallet is upgrade authority én config-admin

**Wat:** de upgrade authority van het programma en de config-admin zijn dezelfde wallet (`DEwdb…`).

**Gevolg:** wie die key heeft, kan:
- het programma vervangen door code die alle vaults leeghaalt, inclusief de vergrendelde liquiditeit en de onopgehaalde tax van creators;
- de treasury omzetten.

Voor kopers en creators is dit het grootste vertrouwensrisico.

**Aanbevolen oplossing:**
- Voor mainnet: upgrade authority en admin op een multisig (bijvoorbeeld Squads), liefst met een timelock op upgrades.
- Bevries het programma na een externe audit, of publiceer een upgradebeleid.
- Maak verifieerbare builds (`solana-verify`), zoals Pipeline sinds 9 november doet. Dan kan iedereen nagaan dat de binary bij de broncode hoort.

### M2: de creator heeft door het ontwerp voordelen

**Wat:** de creator koopt belastingvrij, ook tijdens het venster. Hij houdt de supply die niet in de pool zit, en kan een permanente fee tot 5% instellen.

**Gevolg:** een creator kan goedkoop inkopen terwijl anderen 99% tax betalen, en daarna dumpen.

**Aanbevolen oplossing:** dit is een ontwerpkeuze uit het oorspronkelijke idee ("exclusief creator wallet"). Maak het zichtbaar in de launch-UI en in de metadata: het creator-adres, het deel van de supply buiten de pool, en `tax_end_bps`. Optioneel kan creator-kopen tijdens het venster worden beperkt of verboden.

### L1: een verkeerde treasury of launch-fee kan alle launches laten falen

**Wat:** `launch` maakt de launch-fee met een system-transfer over naar `config.treasury`, dat een `SystemAccount` moet zijn.

**Gevolg:** twee situaties leiden ertoe dat elke `launch` faalt tot de admin het herstelt:
- de admin zet de treasury op een account dat geen system-account is;
- de treasury is leeg en de fee ligt onder het rent-minimum van een leeg account (0,00065 SOL op devnet op 9 november; de rent kan per cluster verschillen).

**Aanbevolen oplossing:** `update_config` laat alleen een fee van 0 of een fee boven het rent-minimum toe. Documenteer daarnaast dat de treasury een system-account met saldo moet zijn.

**Oplossing:** `update_config` en `initialize_config` weigeren een launch-fee tussen 0 en het rent-minimum van een leeg account (`LaunchFeeBelowRent`). Het programma leest de rent van de cluster zelf (`Rent::get`), dus het minimum klopt op elke cluster. Een fee van precies het minimum komt ook bij een lege treasury aan.

Test: `finding_l1_a_launch_fee_below_rent_is_refused` in `findings.rs`. Het weigert 1 lamport en het minimum min 1; 0 en het minimum zelf gaan wel, ook naar een lege treasury, en `initialize_config` controleert hetzelfde.

Blijft operationeel: de treasury moet een system-account zijn (een wallet, of de vault-PDA van een multisig). Een treasury die van een ander programma is, laat `launch` falen tot de admin hem verplaatst.

### L2: de config-admin gaat in één stap over

**Wat:** `update_config` zet een nieuwe admin direct. Een typfout of een adres dat niet kan tekenen (een PDA) zet de config voor altijd vast. De devnet-tool controleert dit al, het programma niet.

**Aanbevolen oplossing:** overdracht in twee stappen: `propose_admin` gevolgd door `accept_admin`, getekend door de nieuwe admin.

**Oplossing:**
- `update_config` wijzigt alleen nog de treasury en de fees (argumenten `ConfigUpdate`, zonder admin).
- `propose_admin(new_admin)` (getekend door de admin) zet `pending_admin`. Een nieuw voorstel vervangt het vorige; `Pubkey::default()` trekt het in.
- `accept_admin` (getekend door de voorgestelde admin) maakt die admin en wist het voorstel (`NotPendingAdmin` voor iedereen anders).

`pending_admin` neemt de eerste 32 van de 64 gereserveerde bytes van de config in. De config op devnet (gereserveerde bytes allemaal 0) leest na de upgrade dus als "geen voorstel". Een multisig, zoals de vault-PDA van Squads, kan `accept_admin` via een CPI tekenen.

Test: `finding_l2_the_admin_moves_only_when_the_successor_accepts` in `findings.rs`. Alleen de admin stelt voor. Een voorstel voor een adres dat niemand beheert, verandert niets, en een nieuw voorstel vervangt het. Alleen de voorgestelde admin accepteert, ook de oude admin niet. Tot dan blijft de oude admin aan het roer. Een ingetrokken voorstel kan niet worden geaccepteerd. Na de overdracht is de oude admin eruit, en is het voorstel verbruikt.

### L3: weergave-extensies kunnen na de launch misleiden

**Wat:** `MetadataPointer`/`TokenMetadata` (naam, symbool, afbeelding), `ScaledUiAmount` en `InterestBearingConfig` zijn toegestaan. Hun authorities kunnen na de launch wijzigen wat wallets en terminals tonen. De prijsberekening raken ze niet, want die werkt met ruwe bedragen.

**Aanbevolen oplossing:** vereis bij `launch` dat die authorities `None` zijn, of laat het aan de launch-UI over om ze te tonen.

### L4: de tijd op de chain kan enkele seconden afwijken

De tax-curve gebruikt `Clock::unix_timestamp`, en die stellen leaders binnen grenzen vast. De curve kan dus enkele seconden verschuiven. Op een venster van 90 s of meer is dat aanvaardbaar.

### L5: een programma als creator

Als `InitParams.creator` een PDA is, kan dat programma via de router belastingvrij kopen voor anderen. Dat is de keuze van die creator; vermeld het in de UI.

### L6: afhankelijk van de upgradebare Pipeline-router

De creator-vrijstelling vertrouwt erop dat de router de ondertekenende trader doorgeeft. De router is upgradebaar door Pipeline. `scripts/fetch-pipeline-router.sh` pint de binary vast, en de CI stopt bij een wijziging. Op 9 november gebeurde dat (slot 520510501). De broncode was toen ongewijzigd, en alle tests slaagden tegen de nieuwe binary.

### I1–I4: info

- **I1:** `LaunchPool::apply` gebruikt `MathOverflow` voor "een verkoop met tax", wat niet kan gebeuren. Een eigen foutcode is duidelijker.
  **Opgelost:** de eigen foutcode `TaxedSell`. Geen test kan hem raken: de wiskunde belast nooit een verkoop (`creator_and_sells_pay_nothing` en de property-tests).
- **I2:** de constraint `destination != quote_vault` in `ClaimTax` doet hetzelfde als Anchors eigen duplicaatcheck.
  **Opgelost:** de constraint is weg. `the_creator_claims_their_tax_once` laat zien dat een claim naar de vault zelf nog steeds faalt, met `ConstraintDuplicateMutableAccount`.
- **I3:** het filter `*reserve > 0` in `Pricing::settle` kan nooit triggeren. Het is de enige overgebleven mutant in de mutatietest. Bewust laten staan als verdediging.
- **I4:** iedereen kan de pool van een creator vroeg aanmaken. Dat is onschadelijk: hij blijft Pending en alleen de creator kan lanceren. De pool legt wel de fees vast die op dat moment gelden. Die zijn begrensd, en de launch-fee is altijd de laagste van de twee.

## Gecontroleerd en in orde

| Aanval of risico | Waarom het niet werkt | Test |
|---|---|---|
| De router omzeilen (en zo de fee en de tax) | `pipeline_swap` eist de market-PDA van de router als signer | `swaps_only_come_through_the_router` |
| Zich als creator voordoen | De router zet de trader zelf, en `trade.trader` moet gelijk zijn aan account 2 | `swaps_only_come_through_the_router`, `the_creator_trades_tax_free` |
| Onopgehaalde tax als gratis input | Input telt pas boven reserve plus opgebouwde tax, met een cap op `amount_sent` | `a_transfer_fee_quote_mint_never_spends_unclaimed_tax` (vangt de mutant) |
| De tax ontlopen door een koop op te splitsen | De tax rondt per koop naar boven af | property-test `splitting_a_buy_never_saves_tax` |
| Afronding in het voordeel van de trader | Output rondt naar beneden af, input bij exact-out naar boven, en k daalt nooit | property-tests en de stresstest |
| Donaties om de prijs te bewegen | Reserves bewegen alleen met trades en `launch` | `donations_do_not_move_the_price` en de stresstest |
| De pool leegkopen | De output blijft altijd kleiner dan de reserve | `the_pool_can_never_be_emptied` |
| Vaults vooraf aanmaken (blokkeren) | `init_if_needed` met volledige ATA-constraints | `vaults_created_in_advance_do_not_block_a_pool` |
| De pool van de creator vooraf aanmaken | Het adres bevat de creator en het schema; alleen de creator lanceert | `creating_the_creators_pool_first_gains_nothing` |
| `register_existing_market` op een ander account | De `Account`-discriminator wordt gecontroleerd | `register_existing_market_rejects_accounts_that_are_not_pools` |
| Andermans tax claimen, of de dev-fee elders heen sturen | `has_one = creator`; de sweep gaat alleen naar de ATA van de treasury | `the_creator_claims_their_tax_once`, `protocol_tax_is_swept_only_to_the_treasury` |
| Fees verhogen voor bestaande pools | Vastgelegd per pool, harde maxima, launch-fee is het minimum | `the_config_is_capped_and_changes_reach_new_pools_only` |
| Gevaarlijke mints (permanent delegate, freeze, mint) | Beleid bij aanmaken en bij launch | `a_permanent_delegate_mint_is_refused`, `launch_requires_revoked_mint_and_freeze_authorities` |
| Een fee die na de launch omhoog kan, of boven 5% ligt (H1) | Fee-authority `None` en fee hooguit 5%, nu en gepland, op beide mints | `findings.rs` |
| Een hook op het launch-token (H2) | Geweigerd bij aanmaken en bij launch | `finding_h2_a_hooked_launch_token_is_refused` |
| De config-admin naar een verkeerd adres (L2) | Overdracht in twee stappen | `finding_l2_the_admin_moves_only_when_the_successor_accepts` |
| Hook-accounts die niet doorkomen | Een eigen `transfer_checked`-helper | `transfer_hook.rs`, op de quote-mint (vangt de mutant) |
| Reentrancy via een hook | Solana staat niet toe dat een programma dat al op de stack staat opnieuw wordt aangeroepen | — |
| Overflow | u128-tussenwaarden, `checked_*`, `overflow-checks = true` | `a_supply_near_the_u64_limit_trades_without_overflow`, `quotes_never_panic` |

## Aanbevolen volgorde

1. **Vóór mainnet, in het programma: gedaan** (10 november 2026, sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`):
   - H1: fee-authority `None` en een fee-maximum van 5%, op beide mints;
   - H2: hooks op het launch-token geweigerd;
   - L1 en L2, en de info-punten I1–I2.

   Dit veranderde de binary. Upgraden op devnet kan alleen de eigenaar, met zijn eigen wallet; de opdracht staat in `HANDOFF.md`.
2. **Vóór mainnet, operationeel:**
   - M1: multisig, timelock of bevriezen, en een verifieerbare build;
   - M2: transparantie in de UI;
   - L3: weergave-authorities tonen of eisen;
   - het restrisico van H2: hooks op de quote-mint tonen, of alleen bekende quote-mints aanbieden.
3. **Daarna:** een externe audit van de definitieve versie.
