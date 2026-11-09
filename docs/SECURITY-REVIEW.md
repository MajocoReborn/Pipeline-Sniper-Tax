# Beveiligingsreview (zelf-review, fase 6)

> Dit is een interne review door dezelfde ontwikkelaar die de code schreef. Ze vervangt
> geen externe audit; voor mainnet blijft die aan te raden.

## Scope

| | |
|---|---|
| Programma | `programs/sniper-tax`. sha256 van de binary: `222ee7691fe1b9ca344f0831b5b9ead3b863a59ba38c26c5384a105a92f09c3a`, gelijk aan devnet (`EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b`) |
| Mee bekeken | `crates/sniper-tax-math` (de prijsberekening van het programma) en de wisselwerking met de Pipeline-router (vastgepinde devnet-binary) |
| Methode | Elke instructie en constraint nagelopen met een aanvallersblik. Elk vermoeden is waar mogelijk met een test op de echte router bevestigd of weerlegd. Daarnaast: property-tests, de stresstest (60.000 stappen) en de mutatietest |

## Samenvatting

| ID | Ernst | Bevinding | Bewijs | Status |
|---|---|---|---|---|
| H1 | Hoog | De fee-bevoegdheid van een token kan de pool later in een honeypot veranderen | `tests/findings.rs` | Open: vraagt een programmawijziging |
| H2 | Hoog | Een transfer hook kan verkopen blokkeren (honeypot) | Pipeline's eigen test `restrictive_hook_blocks_selling…` en `ROUTER.md` | Open: vraagt een programmawijziging |
| M1 | Middel | Eén wallet is upgrade authority én config-admin | Configuratie op devnet | Open: operationeel |
| M2 | Middel | De creator heeft door het ontwerp voordelen tegenover kopers | Ontwerp (§3 van PLAN) | Open: transparant maken |
| L1 | Laag | Een verkeerde treasury of launch-fee kan alle launches laten falen | Code-analyse | Open |
| L2 | Laag | De config-admin kan in één stap naar een onbruikbaar adres gaan | Code-analyse | Open |
| L3 | Laag | Weergave-extensies kunnen na de launch misleiden | Code-analyse | Open |
| L4 | Laag | De tijd op de chain kan enkele seconden afwijken | Ontwerp | Geaccepteerd |
| L5 | Laag | Een programma als creator kan belastingvrij kopen aanbieden | Ontwerp | Geaccepteerd, vermelden |
| L6 | Laag | Afhankelijk van de upgradebare Pipeline-router | Router-upgrade van 9 november | Bewaakt door de vastgepinde router |
| I1–I4 | Info | Cosmetica en kleine punten | Zie onder | Open |

Geen enkele bevinding laat iemand **zonder medewerking van de creator of de beheerder** geld uit een pool halen. H1 en H2 gaan over de bescherming van kopers tegen een kwaadwillende creator. Juist dat is de belofte van een launchpad.

## Bevindingen

### H1: de fee-bevoegdheid van een token kan de pool in een honeypot veranderen

**Wat:** het mint-beleid (`policy.rs`) staat de extensie `TransferFeeConfig` toe, maar controleert niet wie de fee mag wijzigen. Token-2022 laat de `transfer_fee_config_authority` de fee verhogen tot 100%. De nieuwe fee gaat twee epochs later in.

**Gevolg:** een creator lanceert met 0% fee en zet de fee na de launch op 100%. Daarna:
- levert elke verkoop niets op: de vault ontvangt 0 tokens, dus de verkoper krijgt 0 SOL;
- met een minimale opbrengst faalt elke verkoop;
- kopers krijgen 0 tokens.

De ingehouden fees kan de creator als `withdraw_withheld_authority` zelf opnemen. Hetzelfde kan met een eigen **quote-mint** met fee-bevoegdheid. Dat is minder waarschijnlijk, want kopers moeten die munt eerst hebben.

**Bewijs:** `finding_h1_a_kept_fee_authority_can_trap_sellers` in `crates/sniper-tax-tests/tests/findings.rs`. Na de verhoging faalt een verkoop met minimum, en een verkoop zonder minimum neemt de tokens en betaalt niets.

**Aanbevolen oplossing**, in `policy::check_launch_authorities` en de quote-check bij `launch`:
- Een launch-token met `TransferFeeConfig` moet `transfer_fee_config_authority == None` hebben. Dan staat de fee voor altijd vast.
- Zowel de huidige als de toekomstige fee moet onder een maximum blijven, bijvoorbeeld 500 bps.
- Voor de quote-mint: dezelfde regel, of een allowlist (WSOL, USDC).

### H2: een transfer hook kan verkopen blokkeren

**Wat:** het beleid staat `TransferHook` toe. De hook-authority kan het hook-programma vervangen, en een hook-programma kan zelf upgradebaar of kwaadwillend zijn. Een hook die transfers naar de vault weigert, laat kopen wel toe en verkopen niet. Pipeline beschrijft dit zelf ("Restrictive transfer hooks… can be bought through Pipeline but not sold", `ROUTER.md`) en test het (`restrictive_hook_blocks_selling_unless_the_fee_account_is_whitelisted`).

**Gevolg:** dezelfde honeypot als bij H1, maar dan direct vanaf de launch mogelijk.

**Aanbevolen oplossing:** kies één van:
1. **Weiger `TransferHook` op het launch-token.** Dit is de aanbeveling voor een launchpad: kopers moeten altijd kunnen verkopen. Laat hooks alleen toe op een quote-mint uit een allowlist.
2. Sta alleen hooks toe met hook-authority `None` en een hook-programma zonder upgrade authority. Dat is controleerbaar via de ProgramData. Een vanaf het begin kwaadwillende hook blijft dan mogelijk.
3. Een allowlist van bekende hook-programma's in de config.

De hook-tests (`transfer_hook.rs`) blijven nuttig voor de quote-kant of voor optie 3.

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

### L2: de config-admin gaat in één stap over

**Wat:** `update_config` zet een nieuwe admin direct. Een typfout of een adres dat niet kan tekenen (een PDA) zet de config voor altijd vast. De devnet-tool controleert dit al, het programma niet.

**Aanbevolen oplossing:** overdracht in twee stappen: `propose_admin` gevolgd door `accept_admin`, getekend door de nieuwe admin.

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
- **I2:** de constraint `destination != quote_vault` in `ClaimTax` doet hetzelfde als Anchors eigen duplicaatcheck.
- **I3:** het filter `*reserve > 0` in `Pricing::settle` kan nooit triggeren. Het is de enige overgebleven mutant in de mutatietest.
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
| Hook-accounts die niet doorkomen | Een eigen `transfer_checked`-helper | `transfer_hook.rs` (vangt de mutant) |
| Reentrancy via een hook | Solana staat niet toe dat een programma dat al op de stack staat opnieuw wordt aangeroepen | — |
| Overflow | u128-tussenwaarden, `checked_*`, `overflow-checks = true` | `a_supply_near_the_u64_limit_trades_without_overflow`, `quotes_never_panic` |

## Aanbevolen volgorde

1. **Vóór mainnet, in het programma:**
   - H1: fee-authority `None` en een fee-maximum;
   - H2: hooks op het launch-token weigeren;
   - L1 en L2, en de info-punten I1–I2.

   Dit verandert de binary. Upgraden op devnet kan alleen de eigenaar, met zijn eigen wallet.
2. **Vóór mainnet, operationeel:** M1 (multisig, timelock of bevriezen, verifieerbare build) en M2 (transparantie in de UI).
3. **Daarna:** een externe audit van de definitieve versie.
