# Pipeline Sniper Tax: ontwerpplan

> Status: **plan, nog geen code.** Gebaseerd op Pipeline commit `a2d5bfb`
> (`MetalLegBob/pipeline`, "Router verification and security audit, with the hardened router").

## 1. Doel

Een Anchor-programma voor Pipeline dat nieuwe tokens beschermt tegen snipers:

- Een koop direct na de launch betaalt **99% tax**.
- Die tax **daalt naar 0%** in een instelbare periode, bijvoorbeeld **90 seconden (1,5 min)** of **600 seconden (10 min)**.
- De **creator-wallet is vrijgesteld**.
- Volledige ondersteuning voor **SPL Token en Token-2022** via `anchor_spl::token_interface`, met strikte account-validatie.

## 2. Waarom een Pipeline *strategy* (en geen Token-2022 hook of transfer fee)

| Optie | Werkt het? | Reden |
|---|---|---|
| Token-2022 **TransferFee**-extensie | Nee | Een nieuwe fee gaat pas 2 epochs later in (enkele dagen). Een daling van 99% naar 0% in minuten kan dus niet. Bovendien geldt de fee voor *elke* transfer, ook gewone wallet-transfers. |
| Token-2022 **TransferHook** | Nee | Een hook kan een transfer alleen goedkeuren of weigeren, geen tax inhouden. Hij draait bovendien bij elke transfer. |
| "Wrapper"-strategy rond een andere AMM | Nee | Dat wordt router → wrapper → AMM → token program → hook, 5 niveaus. Solana staat er 4 toe, dus het faalt met hooked tokens. |
| **Eigen strategy: launch-pool met ingebouwde sniper tax** | **Ja** | De strategy bepaalt zelf de prijs en vermindert de effectieve input met de tax. Elke integratie (bots, terminals, charts) die Pipeline gebruikt, ziet en quote de pool automatisch. |

Pipeline-feiten waar het ontwerp op leunt (gecontroleerd in de code):

1. De router-`swap` eist `trader: Signer` en geeft **exact die key** door als account-index 2 en als `TradeRequest.trader` (`programs/pipeline/src/lib.rs`, regels 477, 493 en 666). De market-PDA tekent de call. Als de strategy de market-signer controleert, is `trader` dus betrouwbaar. Daarop rust de creator-vrijstelling.
2. De handtekening van de creator bereikt `pipeline_init_market` **nooit**. Daarom komt er een aparte `launch`-instructie die de creator zelf tekent (zie §4).
3. Strategy Guide-regel 10 zegt dat input tot het einde van de swap in de input-vault blijft. De tax blijft dus fysiek in de quote-vault staan en wordt apart bijgehouden (`accrued_tax`).
4. Strategy Guide-regel 2 schrijft `credited_input(vault − reserve, amount_sent)` voor. Wij moeten daarbij **ook de opgebouwde tax aftrekken** (zie §8, aanval A1).

## 3. Mechanisme

### 3.1 Levenscyclus van een pool

```
create_market (router, permissionless)      launch (creator tekent)            claim_tax (creator)
 ┌──────────────────────────┐   ┌────────────────────────────────┐   ┌──────────────────┐
 │ pool = Pending           │──▶│ token + quote storten          │──▶│ tax → creator    │
 │ vaults aangemaakt        │   │ launch_ts = Clock.unix_ts      │   │ (onbeperkt vaak) │
 │ params vast in PDA-seeds │   │ pool = Live, tax-klok start    │   └──────────────────┘
 └──────────────────────────┘   └────────────────────────────────┘
```

Aanbevolen: `create_market` + 2× `init_fee_account` + `launch` in **één transactie**. Dat is atomair, dus niemand kan tussen de stappen in komen. Eventueel komt daar een "dev buy" van de creator bij, belastingvrij.

### 3.2 Tax-curve (standaard lineair)

```
elapsed = max(0, now − launch_ts)
tax_bps(elapsed) = end_bps                                               als elapsed ≥ duration
                 = end_bps + (start_bps − end_bps) · (duration − elapsed) / duration   (floor)
```

Met `start_bps = 9900`, `end_bps = 0`:

| Verstreken | Duur 90 s | Duur 600 s |
|---|---|---|
| 0 s | 99,0% | 99,0% |
| 30 s | 66,0% | 94,05% |
| 45 s | 49,5% | 91,57% |
| 60 s | 33,0% | 89,1% |
| 89 s | 1,1% | 84,31% |
| 300 s | 0% | 49,5% |
| 540 s | 0% | 9,9% |
| ≥ duur | 0% | 0% |

De curve daalt alleen (property-getest). Een swap die later landt dan zijn quote is dus altijd gelijk of **gunstiger** voor de koper. Quotes met een verouderde klok zijn daardoor conservatief.

### 3.3 Waar de tax op valt

- **Alleen kopen** (quote-mint → launch-token), op de **input** in de quote-mint (SOL of USDC).
- Exact-in: `tax = credited − floor(credited · (10000 − bps) / 10000)`. De tax rondt naar boven af, `effective = credited − tax` gaat de constant-product-curve in.
- Exact-out: de benodigde `effective = in_given_out(...)`, dan `gross = ceil(effective · 10000 / (10000 − bps))`. Omdat `bps ≤ 9900` deelt dit nooit door 0. Bewijs dat `floor(gross·(10000−bps)/10000) ≥ effective` komt in een property-test.
- Verkopen: geen tax (beslispunt B2).
- **Creator vrijgesteld:** als `trader == pool.creator`, dan `bps = 0`.
- Pipeline's eigen 0,25% fee komt daar los bovenop. De router rekent die over het hele bedrag dat de trader uitgaf, inclusief tax.

Voorbeeld: een sniper koopt op t = 0 voor 10 SOL. Er gaat 9,9 SOL naar de creator-tax, 0,1 SOL de curve in, en de sniper betaalt daarbovenop 0,025 SOL Pipeline-fee.

### 3.4 Waar de tax heen gaat (standaard: creator)

- De tax blijft in de quote-vault staan, met `pool.accrued_tax_quote += tax`. Hij telt **niet** mee in `reserve_quote`, dus de prijs blijft zuiver.
- De custom action `claim_tax` (creator tekent) maakt `accrued_tax_quote` over naar een quote-tokenaccount naar keuze.
- Er is **geen withdraw van liquiditeit**: de launch-liquiditeit zit permanent vast ("LP burned"-equivalent). De creator kan de pool dus niet leegtrekken (rug).

### 3.5 Verdienmodel voor de dev (B9: aandeel in de tax plus een kleine launch-fee)

Solana-gebruikers letten scherp op kosten, dus de fees blijven laag en zichtbaar:

| Bron | Standaard | Harde cap in code | Wie betaalt |
|---|---|---|---|
| **A. Aandeel in de sniper tax** | 10% van elke ingehouden tax | 20% | Uit het tax-deel van de creator. De sniper betaalt niets extra, gewone kopers na het venster ook niet |
| **B. Launch-fee** | 0,01 SOL per `launch` | 0,05 SOL | De creator, eenmalig. Ter vergelijking: de rent voor pool en vaults is samen ongeveer 0,007 SOL |

Werking:

- Een globale `ProtocolConfig`-PDA (`["config"]`) bevat `admin`, `treasury`, `protocol_tax_share_bps` en `launch_fee_lamports`. De upgrade authority van het programma maakt hem één keer aan. Daarna mag de `admin` de waarden wijzigen, maar alleen binnen de caps.
- **Vastgezet per pool:** `pipeline_init_market` kopieert het tax-aandeel en de launch-fee naar de pool. Een latere config-wijziging raakt alleen nieuwe pools.
- De launch-fee is `min(pool.launch_fee_lamports, config.launch_fee_lamports)`. De creator betaalt dus nooit meer dan bij het aanmaken gold, en profiteert van een latere verlaging (bijvoorbeeld een promotie met 0 SOL).
- Het tax-aandeel: `protocol = floor(tax · share / 10000)` en `creator = tax − protocol`. Afronding valt in het voordeel van de creator. Beide bedragen blijven in de quote-vault staan (Strategy Guide-regel 10), als `accrued_protocol_quote` en `accrued_tax_quote`.
- `sweep_protocol_fees` is permissionless en stuurt `accrued_protocol_quote` alleen naar de ATA van `config.treasury`, net als Pipeline's eigen `sweep_fees`.
- `pipeline_quote` rekent met de totale tax. Het aandeel verandert niets aan wat de koper krijgt, dus quotes blijven kloppen.

Voorbeeld: een sniper koopt op t = 0 voor 10 SOL. De tax is 9,9 SOL, waarvan 0,99 SOL naar de dev-treasury gaat en 8,91 SOL naar de creator. De sniper betaalt daarnaast 0,025 SOL aan Pipeline.

## 4. State

```rust
#[account]
#[derive(InitSpace)]
pub struct LaunchPool {
    pub version: u8,                 // voor toekomstige migraties
    pub status: PoolStatus,          // Pending | Live
    pub bump: u8,
    pub creator: Pubkey,             // vrijgesteld + mag launchen/claimen
    pub token_mint: Pubkey,          // mint-index 0 in MarketInfo
    pub quote_mint: Pubkey,          // mint-index 1
    pub token_vault: Pubkey,         // ATA(pool, token_mint, token_program_token)
    pub quote_vault: Pubkey,         // ATA(pool, quote_mint, token_program_quote)
    pub market_signer: Pubkey,       // PDA(["market", ID, pool], PIPELINE)
    pub reserve_token: u64,
    pub reserve_quote: u64,
    pub accrued_tax_quote: u64,      // creator-deel, in quote_vault, NIET in reserves
    pub accrued_protocol_quote: u64, // dev-deel, in quote_vault, NIET in reserves
    pub tax_start_bps: u16,          // ≤ 9900
    pub tax_end_bps: u16,            // ≤ MAX_END_BPS (anti-honeypot cap)
    pub tax_duration_secs: u32,      // binnen [MIN_DURATION, MAX_DURATION]
    pub protocol_tax_share_bps: u16, // vastgezet bij init, ≤ 2000
    pub launch_fee_lamports: u64,    // vastgezet bij init, ≤ 0,05 SOL
    pub launch_ts: i64,              // 0 zolang Pending
    pub _reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {          // PDA ["config"]
    pub admin: Pubkey,               // mag binnen de caps wijzigen (multisig aanbevolen)
    pub treasury: Pubkey,            // ontvangt launch-fees en het tax-aandeel
    pub protocol_tax_share_bps: u16, // standaard 1000 (10%)
    pub launch_fee_lamports: u64,    // standaard 10_000_000 (0,01 SOL)
    pub bump: u8,
    pub _reserved: [u8; 64],
}
```

**PDA-seeds** (Strategy Guide-regel 8: parameters in het adres, zodat een pool met slechte parameters het adres van een goede niet kan bezetten):

```
["launch", token_mint, quote_mint, creator, params_bytes(start_bps, end_bps, duration)]
```

`InitParams` (Borsh, in `init_data`): `{ creator: Pubkey, tax_start_bps: u16, tax_end_bps: u16, tax_duration_secs: u32 }`. Seed-helpers knippen de data in `creator` (32 bytes) en `params` (8 bytes), omdat één seed maximaal 32 bytes mag zijn. Data met een verkeerde lengte wordt geweigerd.

## 5. Instructies en account-validatie

Alle tokenaccounts zijn `InterfaceAccount<'info, Mint/TokenAccount>`, alle token programs `Interface<'info, TokenInterface>`. Elke transfer is `transfer_checked`, waarbij de transfer-hook-accounts (remaining accounts) worden doorgegeven.

### 5.1 `pipeline_init_market(data: Vec<u8>)`: router, vanuit `create_market`

| Account | Type | Constraints |
|---|---|---|
| `market_signer` | `Signer` | handler: `== PDA(["market", crate::ID, pool], PIPELINE_PROGRAM_ID)` |
| `pool` | `Account<LaunchPool>` | `init, payer = payer, space = 8 + INIT_SPACE, seeds = [...§4], bump` |
| `payer` | `Signer`, `mut` | router-setup-payer. Alleen rent betalen, niet reassignen |
| `system_program` | `Program<System>` | |
| `token_mint` | `InterfaceAccount<Mint>` | `mint::token_program = token_program_token` |
| `quote_mint` | `InterfaceAccount<Mint>` | `mint::token_program = token_program_quote`; handler: `!= token_mint` |
| `token_vault` | `InterfaceAccount<TokenAccount>` | `init_if_needed, associated_token::{mint = token_mint, authority = pool, token_program = token_program_token}` |
| `quote_vault` | idem | idem voor quote |
| `token_program_token`, `token_program_quote` | `Interface<TokenInterface>` | |
| `associated_token_program` | `Program<AssociatedToken>` | |
| `config` | `Account<ProtocolConfig>` | `seeds = [b"config"], bump = config.bump` |

Handler: valideert de params (`start ≤ 9900`, `end ≤ start`, `end ≤ MAX_END_BPS`, duur binnen grenzen) en de mint-policy (§6), kopieert het tax-aandeel en de launch-fee uit `config`, en zet `status = Pending`.

### 5.2 `pipeline_market_info()`

`pool: Account<LaunchPool>`. Anchor controleert de owner en de discriminator, zodat `register_existing_market` op een willekeurig account van ons programma faalt. Geeft `MarketInfo { mints: [token, quote], vaults: [token_vault, quote_vault], supports_exact_out: true }` terug (beslispunt B6).

### 5.3 `pipeline_resolve_accounts(ResolveRequest)` en `pipeline_quote(TradeRequest)`

Alleen-lezen. `pool: Account<LaunchPool>`, de andere 9 vaste accounts zijn `UncheckedAccount` (placeholders, worden niet gelezen).

- Resolve geeft `[output_vault (writable)]` terug, met `complete: true`.
- Quote roept `pool.quote(&trade, Clock::get()?.unix_timestamp)` aan. Dat is **dezelfde functie** als in swap. Een Pending pool of een lege reserve geeft een fout.

### 5.4 `pipeline_swap(SwapRequest)`: router, vanuit `swap`

| Account | Type | Constraints |
|---|---|---|
| `market_signer` | `Signer` | `address = pool.market_signer @ NotPipeline` (alleen via de router) |
| `pool` | `Account<LaunchPool>`, `mut` | `constraint = pool.status == Live @ NotLive` |
| `trader` | `UncheckedAccount` | identiteit; handler: `request.trade.trader == Some(trader.key())` |
| `trader_input`, `trader_output` | `UncheckedAccount`, `mut` | het token program controleert ze (de router meet saldi) |
| `input_vault` | `UncheckedAccount`, `mut` | handler: `== pool.vault(input_index)` |
| `input_mint`, `output_mint` | `InterfaceAccount<Mint>` | handler: `== pool.mint(index)` (defense in depth; de router controleert dit ook) |
| `input_token_program`, `output_token_program` | `Interface<TokenInterface>` | `== mint.owner` |
| remaining[0] | output-vault | `== pool.vault(output_index)` |
| remaining[1..] | hook-accounts | doorgeven aan `transfer_checked` |

Handler, in deze volgorde:

1. `credited = credited_input(vault_balance, reserve_in + accrued_tax_in + accrued_protocol_in, amount_sent)`
2. `quote = pool.quote(trade, now)`, met tax, creator-check en CP-wiskunde
3. `require!(quote.amount_in ≤ credited)`, `refund = credited − quote.amount_in`
4. Refund en output via `transfer_checked`, getekend door de pool-PDA
5. `reserve_in += effective_in`, `accrued_protocol_in += protocol_share`, `accrued_tax_in += tax − protocol_share`, `reserve_out −= amount_out`. Updates gebeuren via de trade zelf, niet via vault-saldi, zodat donaties buiten de prijs blijven.

### 5.5 `launch(amount_token: u64, amount_quote: u64)`: custom action, creator tekent

| Account | Type | Constraints |
|---|---|---|
| `creator` | `Signer` | |
| `pool` | `Account<LaunchPool>`, `mut` | `has_one = creator @ NotCreator`, `has_one = token_mint`, `has_one = quote_mint`, `has_one = token_vault`, `has_one = quote_vault`, `constraint = status == Pending @ AlreadyLaunched` |
| `token_mint` / `quote_mint` | `InterfaceAccount<Mint>` | `mint::token_program = …` |
| `creator_token` | `InterfaceAccount<TokenAccount>`, `mut` | `token::mint = token_mint, token::authority = creator, token::token_program = token_program_token` |
| `creator_quote` | idem | idem voor quote |
| `token_vault`, `quote_vault` | `InterfaceAccount<TokenAccount>`, `mut` | via `has_one` |
| token programs | `Interface<TokenInterface>` | |
| `config` | `Account<ProtocolConfig>` | `seeds = [b"config"], bump = config.bump` |
| `treasury` | `SystemAccount`, `mut` | `address = config.treasury @ WrongTreasury` |
| `system_program` | `Program<System>` | |
| remaining | hook-accounts | |

Handler:

1. Beide bedragen moeten groter dan 0 zijn.
2. De mint-policy wordt opnieuw gecontroleerd (de freeze- en mint-authority kunnen sinds init veranderd zijn).
3. De launch-fee `min(pool.launch_fee_lamports, config.launch_fee_lamports)` gaat met een system-transfer van `creator` naar `treasury` (overgeslagen bij 0).
4. Er wordt gecrediteerd **wat aankwam**: vault-saldo na min vóór, wat transfer-fee-tokens afvangt.
5. `launch_ts = Clock.unix_timestamp`, `status = Live`.

### 5.6 `claim_tax()`: custom action, creator tekent

| Account | Type | Constraints |
|---|---|---|
| `creator` | `Signer` | |
| `pool` | `Account<LaunchPool>`, `mut` | `has_one = creator`, `has_one = quote_mint`, `has_one = quote_vault`, `constraint = accrued_tax_quote > 0 @ NothingToClaim` |
| `quote_mint` | `InterfaceAccount<Mint>` | `mint::token_program = token_program_quote` |
| `quote_vault` | `InterfaceAccount<TokenAccount>`, `mut` | via `has_one` |
| `destination` | `InterfaceAccount<TokenAccount>`, `mut` | `token::mint = quote_mint, token::token_program = token_program_quote` |
| `token_program_quote` | `Interface<TokenInterface>` | |

Handler: zet `accrued_tax_quote` op 0 **vóór** de transfer (checks-effects-interactions) en maakt het bedrag over met `transfer_checked`.

### 5.7 `sweep_protocol_fees()`: custom action, iedereen mag hem aanroepen

| Account | Type | Constraints |
|---|---|---|
| `pool` | `Account<LaunchPool>`, `mut` | `has_one = quote_mint`, `has_one = quote_vault`, `constraint = accrued_protocol_quote > 0 @ NothingToClaim` |
| `config` | `Account<ProtocolConfig>` | `seeds = [b"config"], bump = config.bump` |
| `quote_mint` | `InterfaceAccount<Mint>` | `mint::token_program = token_program_quote` |
| `quote_vault` | `InterfaceAccount<TokenAccount>`, `mut` | via `has_one` |
| `treasury_quote` | `InterfaceAccount<TokenAccount>`, `mut` | `associated_token::{mint = quote_mint, authority = config.treasury, token_program = token_program_quote}` |
| `token_program_quote` | `Interface<TokenInterface>` | |

Handler: zet `accrued_protocol_quote` op 0 en maakt het bedrag over naar de treasury. Omdat de bestemming vastligt, is permissionless veilig.

### 5.8 `initialize_config(...)` en `update_config(...)`: beheer

- `initialize_config`: alleen de upgrade authority van het programma, één keer. Gecontroleerd via `program.programdata_address() == Some(program_data.key())` en `program_data.upgrade_authority_address == Some(signer)`. Maakt `config` aan met `init, seeds = [b"config"], bump`.
- `update_config`: `has_one = admin`. Valideert `protocol_tax_share_bps ≤ 2000` en `launch_fee_lamports ≤ 0,05 SOL`. Kan `admin` en `treasury` wijzigen.

### 5.9 Foutcodes

`BadInitData`, `NotPipeline`, `WrongAccount`, `TraderMismatch`, `NotCreator`, `NotLive`, `AlreadyLaunched`, `OneSidedDeposit`, `InsufficientInput`, `InsufficientLiquidity`, `NothingToClaim`, `ForbiddenMintExtension`, `FreezeAuthorityPresent`, `MintAuthorityPresent`, `MathOverflow`, `WrongTreasury`, `FeeAboveCap`, `NotUpgradeAuthority`.

## 6. Token-2022-beleid (launch-token)

Gecontroleerd in `pipeline_init_market` en opnieuw in `launch`, door de mint te parsen met `StateWithExtensions<Mint>` en `get_extension_types()`. Een SPL Token-mint (zonder extensies) is altijd goed.

| Extensie / eigenschap | Beleid | Reden |
|---|---|---|
| Freeze authority | **Moet `None` zijn** | Anders kan de creator de vault of de wallets van kopers bevriezen (honeypot) |
| Mint authority | **`None` bij launch** (beslispunt B5) | Anders is oneindig bijminten en dumpen mogelijk |
| MetadataPointer, TokenMetadata, Group(Pointer), GroupMember(Pointer) | Toegestaan | Alleen cosmetisch |
| TransferFeeConfig | Toegestaan | `credited_input` meet wat aankomt. Clients rekenen de output om |
| TransferHook | Toegestaan, accounts worden doorgegeven | De call depth past precies: router(1) → strategy(2) → token(3) → hook(4). Metadata waarschuwt dat een hook verkopen kan blokkeren |
| InterestBearingConfig, ScaledUiAmount | Toegestaan | Beïnvloeden alleen het UI-bedrag. De wiskunde draait op ruwe bedragen |
| MintCloseAuthority | Toegestaan | Sluiten kan alleen bij supply 0 |
| **PermanentDelegate** | **Geweigerd** | De delegate kan de vaults leeghalen |
| **NonTransferable** | **Geweigerd** | Dan kan er niet gehandeld worden |
| **Pausable** | **Geweigerd** | Kan de handel stilleggen of kopers vastzetten |
| **DefaultAccountState** | **Geweigerd** | Accounts kunnen bevroren starten |
| **ConfidentialTransfer\***, ConfidentialMintBurn | **Geweigerd** | Vertroebelt de vault-boekhouding |
| Onbekende (nieuwe) extensie | **Geweigerd** | Fail-closed |

De quote-mint krijgt **geen** freeze-check (USDC heeft een freeze authority), maar wel dezelfde extensie-denylist.

## 7. Repo-structuur en dependencies

```
Pipeline-Sniper-Tax/
├── Cargo.toml                      # host-workspace: crates/*
├── rust-toolchain.toml             # 1.97.1 (gelijk aan Pipeline)
├── programs/
│   ├── Cargo.toml                  # SBF-workspace, overflow-checks = true, lto = "fat"
│   └── sniper-tax/                 # Anchor-programma (Apache-2.0)
│       └── src/{lib.rs, state.rs, instructions/*.rs, policy.rs, errors.rs}
├── crates/
│   ├── sniper-tax-math/            # pure wiskunde (no_std-vriendelijk), host-testbaar
│   └── sniper-tax-tests/           # LiteSVM-integratietests tegen de echte router
├── metadata/sniper-tax.json        # pipeline-strategy-metadata/1
├── scripts/devnet/                 # TS-smoketest met @solana/kit en de Pipeline-SDK
└── docs/PLAN.md                    # dit document
```

- `anchor-lang = "=1.2.2"` (features `init-if-needed`) en `anchor-spl = "=1.2.2"`: exact dezelfde versies als Pipeline.
- `pipeline-strategy-interface` als git-dependency, gepind op `rev = "a2d5bfb"` (Apache-2.0).
- De router-`.so` voor tests wordt gebouwd uit dezelfde gepinde rev. De BSL 1.1 staat gebruik buiten productie toe, en tests vallen daaronder.
- Build: `cargo-build-sbf 4.6.0` (sBPF v3). Tests: `litesvm = "=0.18.2"`, `proptest`.
- CI (GitHub Actions): `fmt`, `clippy -D warnings`, `build-sbf`, `cargo test --workspace` en een keypair-check (zoals bij Pipeline).

## 8. Dreigingsmodel

| # | Aanval | Mitigatie |
|---|---|---|
| A1 | Opgebouwde tax of dev-fee in de quote-vault wordt bij de volgende swap als "gratis input" gecrediteerd. Door de cap op `amount_sent` speelt dit alleen bij quote-mints met een transfer fee, maar dan betaalt de onopgehaalde tax het verschil | `credited_input(vault, reserve + accrued_tax + accrued_protocol, amount_sent)` plus een regressietest (`a_transfer_fee_quote_mint_never_spends_unclaimed_tax`) |
| A2 | Sniper roept `pipeline_swap` direct aan (zonder router en zonder fee) met trader = creator | `market_signer` moet de router-PDA zijn en tekenen. Alleen de router kan dat |
| A3 | Sniper geeft `trade.trader = creator` mee | De router zet die waarde zelf. We controleren ook `trade.trader == accounts[2]` |
| A4 | Iemand maakt de pool van de creator eerder aan (front-run `create_market`) | Het adres bevat creator en params, dus het resultaat is identiek aan wat de creator wilde. De frontend slaat dan `create_market` over. `launch` vereist nog steeds de creator. Aanbevolen is één atomaire tx |
| A5 | Vault-ATA's worden vooraf aangemaakt om de pool te blokkeren | `init_if_needed` |
| A6 | Tokens worden naar een vault gedoneerd om de prijs te manipuleren | Reserves bewegen alleen met trades en `launch`. Donaties tellen niet |
| A7 | `register_existing_market` op een willekeurig account | `Account<LaunchPool>`, discriminator- en owner-check |
| A8 | Creator zet `end_bps = 9900` (permanente honeypot) | Harde cap `MAX_END_BPS` (voorstel 500 = 5%) |
| A9 | Afronding bij exact-out laat iemand onder de tax uitkomen | Tax rondt naar boven af, gross naar boven. Property-tests: `gross − tax ≥ effective` en `tax ≥ ceil(gross·bps/10000)` |
| A10 | Overflow bij grote bedragen | u128 en de 256-bit `mul_div` uit de referentie, `overflow-checks = true` |
| A11 | Kloktrucs | `elapsed` verzadigt op 0 (geen negatieve tijd). Leader-timestamps wijken hooguit een paar seconden af, wat voor minuten-schaal acceptabel is |
| A12 | Freeze, permanent delegate of pause op het launch-token | Mint-policy (§6), gecontroleerd bij init én launch |
| A13 | Handelen vóór de launch | `status == Live`-check plus de regel dat een lege reserve niet geprijsd wordt |
| A14 | Creator zet de vrijstelling in voor anderen (koopt voor derden) | Bekende beperking: de creator kan dat altijd. Documenteren |
| A15 | Tokens worden buiten deze pool verhandeld (andere DEX) | Buiten onze macht. De tax beschermt alleen deze pool. Bij launch heeft de creator de hele supply, dus er is geen andere liquiditeit tenzij de creator die zelf maakt |
| A16 | De admin verhoogt de fees van bestaande pools | Fees liggen per pool vast bij init. De launch-fee is `min(snapshot, huidig)`. Harde caps in de code |
| A17 | Een nep-`config` wordt meegegeven | `Account<ProtocolConfig>` met `seeds = [b"config"]` |
| A18 | De dev-fee wordt naar een verkeerd account gesweept | De bestemming moet de ATA van `config.treasury` zijn |
| A19 | De admin-key wordt gestolen | De schade blijft binnen de caps en geldt alleen voor nieuwe pools. Aanbevolen: admin op een multisig (bijvoorbeeld Squads) |

## 9. Testplan

**Unit- en property-tests (`sniper-tax-math`, proptest):**

- `tax_bps` daalt monotoon in `elapsed`, zit tussen `end` en `start`, en is exact `start` bij 0 en `end` bij ≥ duur.
- De exact-in- en exact-out-inversie klopt en is minimaal: `gross − 1` is net te weinig.
- `tax ≤ input`, en er is geen overflow over de volledige u64-ruimte.
- Quote is gelijk aan swap voor dezelfde `(state, now, trader)`.

**LiteSVM-integratie (echte router-`.so` en ons programma):**

1. Het happy path als één atomaire tx: `create_market` → `init_fee_account` ×2 → `launch` → swap.
2. De tax op t = 0, T/2, T−1, T en T+1, met de klok gezet via `set_sysvar::<Clock>`, voor 90 s en 600 s.
3. De creator betaalt 0% en een niet-creator betaalt het verwachte percentage. `SwapEvent.received` klopt met de quote.
4. `claim_tax`: alleen de creator, het bedrag klopt, en een tweede claim geeft `NothingToClaim`.
5. Regressie A1: na een tax-swap levert een tweede swap met kleine input geen extra output op.
6. Directe call zonder router geeft `NotPipeline`. Een verkeerde market-signer faalt ook.
7. `register_existing_market` op een niet-pool-account faalt.
8. Vooraf aangemaakte ATA's, donaties naar vaults en een front-run `create_market`.
9. Swap vóór de launch, een tweede `launch` en een `launch` door een niet-creator falen allemaal.
10. Exact-out: koop, refund, afronding.
11. Compute: quote < 200k CU (de quoter-cap) en een swap ruim binnen budget.
12. Dev-fee: de verdeling klopt (creator plus dev is precies de tax), `sweep_protocol_fees` gaat alleen naar de treasury-ATA, en de launch-fee komt aan bij de treasury.
13. Config: alleen de upgrade authority kan hem aanmaken, alleen de admin kan hem wijzigen, waarden boven de cap worden geweigerd, en een wijziging raakt bestaande pools niet.

**Token-2022:**

- Een launch-token met TransferFee (input- én outputkant).
- TransferHook, met de `test-hook`- en `test-hook-refill`-programma's uit Pipeline.
- Geweigerde mints: PermanentDelegate, NonTransferable, Pausable, DefaultAccountState, freeze authority aanwezig en mint authority aanwezig.
- Een Token-2022-token tegen een SPL-quote (WSOL).

## 10. Fasering

| Fase | Inhoud | Klaar als |
|---|---|---|
| 0 | Repo-skelet, toolchain, CI, git-dependency op Pipeline, router-`.so` in de testharness | CI groen op een leeg programma |
| 1 | `sniper-tax-math` met property-tests | Alle invarianten uit §9 groen |
| 2 | Anchor-programma: state, de 5 Pipeline-instructies, `launch`, `claim_tax`, `sweep_protocol_fees`, config-beheer, mint-policy | `cargo build-sbf` slaagt |
| 3 | LiteSVM-integratie- en adversariële tests (§9) | Alle tests groen |
| 4 | Token-2022-tests | Alle tests groen |
| 5 | Metadata-JSON, TS-smoketest, deploy op devnet en `register_strategy` | Een demo-launch met 90 s tax handelt via Pipeline op devnet |
| 6 | Review: eigen audit-ronde, en eventueel extern | Daarna kiezen tussen een upgrade authority op een multisig en het programma bevriezen |

### Voortgang

- **Fase 0, klaar:** workspace, `rust-toolchain.toml` (1.97.1), CI (fmt, clippy, sBPF-build, router ophalen, alle tests, keypair-check) en een pre-commit-hook.
- **Fase 1, klaar:** `crates/sniper-tax-math` met 11 unit-tests en 12 property-tests (2.000 gevallen per stuk) voor alle invarianten uit §9. Bewust afgebroken afrondingen worden door de tests gevangen.
- **Fase 2, klaar:** `programs/sniper-tax` (Anchor 1.2.2), devnet-programma-adres `EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b`. Vondst: de `transfer_checked`-CPI van `anchor-spl` 1.2.2 geeft geen transfer-hook-accounts door, dus het programma gebruikt een eigen helper.
- **Fase 3, klaar:** `crates/sniper-tax-tests`, 24 LiteSVM-tests tegen de router-binary die live op devnet draait (`scripts/fetch-pipeline-router.sh`, vastgepind op sha256). Ze dekken §9 punt 1–13. Bij punt 3 controleren de tests de saldi in plaats van de `SwapEvent` te decoderen. Een swap gebruikt minder dan 80.000 compute units en een quote minder dan 50.000. Een bewust verwijderde A1-bescherming wordt door de tests gevangen.
- **Fase 4, deels:** transfer-fee-tokens als launch-token en als quote-mint, en geweigerde mints (permanent delegate, freeze- en mint-authority) zijn getest. Transfer hooks nog niet: daarvoor is een klein test-hook-programma nodig.

## 11. Beslissingen

Alle beslissingen zijn genomen. B1–B8 zijn goedgekeurd zoals aanbevolen, B9 is gekozen als A plus een kleine B:

| # | Vraag | Besluit |
|---|---|---|
| B1 | Waar gaat de tax heen? | Naar de creator, claimbaar met `claim_tax` |
| B2 | Welke trades worden belast? | Alleen kopen |
| B3 | Vorm van de curve | Lineair |
| B4 | Duur en startpercentage | Vrij instelbaar binnen [60 s, 30 min], UI-presets 90 s en 600 s, start standaard 99% |
| B5 | Mint authority verplicht ingetrokken bij launch? | Ja |
| B6 | Exact-out ondersteunen? | Ja |
| B7 | Markt-type | Constant-product met echte liquiditeit (v1); bonding curve met virtuele reserve eventueel in v2 |
| B8 | Permanente fee na het venster (`end_bps`) | 0% standaard, max 5% |
| B9 | Verdienmodel voor de dev van het programma | 10% van de sniper tax (cap 20%) plus 0,01 SOL per launch (cap 0,05 SOL), vastgezet per pool. Zie §3.5 |
