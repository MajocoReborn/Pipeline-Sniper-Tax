# Launch site: plan

> Status: **approved on 10 November 2026** (decisions in section 8; the name and domain come later). Devnet first. Progress is in section 7.

## 1. Goal

A website where a creator launches a token with a sniper-tax pool in a few clicks, and where
anyone can find, follow and trade those launches. Today only a developer can launch, with the
devnet tool; the site is what turns the program into a product (see the market research of
10 November: the on-chain core exists, the product layer does not).

The site must make the buyer protection visible, because that is the selling point against
extractive launchpads: who the creator is, how much supply sits outside the pool, the tax
right now and when it ends, the permanent fee, and the trust flags Pipeline reports.

## 2. What already exists, and what we reuse

| Piece | Where | Use |
|---|---|---|
| Our program on devnet | `EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b` | `create_market` (through the router), `launch`, `claim_tax`, `sweep_protocol_fees` |
| Our instruction builders | `crates/sniper-tax-client` (Rust) | Ported to TypeScript; the Rust crate generates test vectors so both always agree |
| Pipeline's hosted API (devnet) | `https://pipeline-devnet.up.railway.app` | Market list with trust flags, trades, OHLCV candles, quotes, ready-to-sign swap transactions, a live WebSocket stream. No keys; 20 reads/s and 5 quotes or swaps/s per IP |
| Pipeline's TypeScript SDK | `sdk/ts` in `MetalLegBob/pipeline` (Apache-2.0, built on `@solana/kit`) | `createMarket`, `initFeeAccount`, `swap`, decoders, trust flags. Not published yet (`private`, placeholder name), so we vendor a pinned copy |

What we build ourselves: token creation, the launch form, our pool decoder and live tax
display, the token page, and the creator's claim.

## 3. Pages and flows

### 3.1 Launch (creator)

1. Connect a wallet (any Wallet Standard wallet: Phantom, Solflare, Backpack).
2. Fill in:
   - name, symbol, image, short description;
   - supply (fixed by default: 1,000,000,000 tokens, 6 decimals);
   - share of the supply in the pool (default 100%; anything kept by the creator is shown on the token page);
   - SOL liquidity for the pool;
   - tax schedule, one of three presets (decision S8: the sniper tax is always on):
     - **Strong:** 99% falling to 0% over 10 minutes;
     - **Normal:** 99% falling to 0% over 90 seconds;
     - **Mild:** 50% falling to 0% over 60 seconds;
   - a permanent fee after the window: 0% by default, at most 5%.

   The site never offers a launch without sniper tax, although the program would accept 0%.
3. Preview: every cost before signing (rent for mint, metadata, pool and vaults; the 0.01 SOL launch fee; Pipeline's fee accounts) and exactly what the creator will hold afterwards.
4. Sign two transactions (one transaction is too small for both, 1,232 bytes):
   - **Token:** a Token-2022 mint with built-in metadata (MetadataPointer + TokenMetadata, both allowed by the policy). Mint the supply to the creator, then revoke the mint authority. No freeze authority. Set the metadata update authority to `None`, so the name and image can't change after launch (review finding L3).
   - **Pool:** the router's `create_market`, both `init_fee_account`s and our `launch`, in one transaction (tested in `create_and_launch_fit_one_transaction`).
5. Done: a link to the token page, with the tax clock running.

### 3.2 Launches (anyone)

The list of our pools from `/v1/markets?strategy=EZwL…&sort=newest`, each with: image and
name, the **current tax** (computed in the browser from the pool's schedule and
`launch_ts`), price, 24-hour volume, and trust flags. Filters: new, tax still running, most
traded.

### 3.3 Token page (anyone)

- Price chart from the API's candles, and recent trades.
- Buy and sell: a quote, then a swap transaction from `/v1/swap-transaction`. Before signing, show the tax, Pipeline's 0.25% fee, any site fee, and the minimum received.
- A live tax countdown.
- **Transparency box:** creator address, share of supply outside the pool, permanent fee, tax collected so far, the program's flags (`upgradeable`, metadata status), and the mint's flags.

### 3.4 Creator dashboard

Claimable tax per pool, with a `claim_tax` button. `sweep_protocol_fees` is permissionless;
the site may offer it too.

## 4. Architecture

- **A static single-page app:** Vite, React and TypeScript, on `@solana/kit`. No server and no database for the MVP: data comes from Pipeline's API and a Solana RPC, transactions are built in the browser and signed in the wallet.
- **Hosting:** a static host (Cloudflare Pages, Vercel or GitHub Pages), free for this size.
- **RPC:** the public devnet endpoint. Mainnet needs a paid RPC (Helius, Triton or similar), with a domain-restricted key or a small proxy.
- **Location:** `app/` in this repository, so the TypeScript builders are tested against vectors from the Rust client in the same CI.

## 5. Security

The site builds transactions that move users' money, so:

- **No keys** on the site or a server; everything is signed in the user's wallet.
- **Simulate before signing**, and show a plain summary of what will happen. Refuse to send if the simulation differs from the preview.
- **Don't trust the API blindly:** derive pool and vault addresses locally, check the pool account's owner is our program, and read the tax schedule from the chain before quoting.
- **User content is data:** token names, symbols, descriptions and image URLs are untrusted; render them as text, never as HTML, and load images only over HTTPS.
- **Supply chain:** few dependencies, a committed lockfile, pinned versions, no third-party scripts or trackers, a strict Content Security Policy.
- **Phishing:** one official domain, linked from the README and the metadata.
- The Security-Agent repo reviews the site like the program.

## 6. Revenue

- What exists: 10% of the sniper tax and the 0.01 SOL launch fee, both in the program.
- **New option: a site fee per trade.** Pipeline's swap has an optional integrator fee that the trader signs; it goes to an account of our choice. It has no cap in the router, so the site must show it. It applies only to trades made through our site; other front-ends can still trade our pools without it. That keeps the "not extractive" story honest: a small, visible fee for the service, not a hidden one in the program.

## 7. Milestones

| # | Contents | Done when |
|---|---|---|
| 1 | TypeScript client: pool address, decoders, `launch`, `claim_tax`, `sweep_protocol_fees`; vendored Pipeline SDK; test vectors from the Rust client | Vectors match in CI |
| 2 | Launch flow on devnet: token creation, pool creation and launch, previews, simulation | A launch from the site trades through Pipeline |
| 3 | Launch list and token page: chart, trades, buy and sell, live tax, transparency box | A sniper buy and a later buy show the right tax |
| 4 | Creator dashboard: claim | A creator claims their tax from the site |
| 5 | Polish, a security review (Security-Agent), deploy to a public devnet URL | The site is reachable and reviewed |

### Progress

- **Milestone 1, done (10 November):** `app/src/client`, the TypeScript client on `@solana/kit`:
  - the config and pool addresses, `PoolKeys` and the creator's token accounts;
  - decoders for `LaunchPool` and `ProtocolConfig`;
  - builders for `create_market`, the fee accounts, `launch`, `claim_tax`, `sweep_protocol_fees`, `pipeline_quote` and router swaps;
  - the tax schedule (`taxBpsAt`, `applicableTaxBps`, `currentTaxBps`), with the program's integer maths.

  Pipeline's SDK is vendored unmodified in `app/src/vendor/pipeline` (`VENDORED.md`). `crates/sniper-tax-client/examples/ts_vectors.rs` writes `app/test/vectors.json`: addresses, instruction bytes and flags, encoded accounts, and 324 tax rates. The 21 tests in `app/test/client.test.ts` match all of it, and CI fails if the vectors are stale. Of nine deliberate bugs in the client, the tests catch seven; the other two (`<= 0` as `< 0`, and `>= duration` as `> duration` in the tax curve) give the same rate at those points for every schedule the program accepts.

- **Milestone 2, done (10 November).** The launch logic is in `app/src/launch`, without React, so the page and the tests share it; the page is in `app/src/components`.
  - The form and its rules (`form.ts`): the three presets, a permanent fee of 0 to 5%, a creator share of 0 to 20%, at least 0.05 SOL for the pool, and an https link for the image.
  - The two transactions (`transactions.ts`):
    - the token: Token-2022 with frozen metadata, no freeze authority, and the mint authority revoked after minting; at most 875 bytes;
    - the pool: wrap the SOL, `create_market`, both fee accounts and `launch`; at most 1,071 of the 1,232 bytes.
  - The cost preview (`chain.ts`) reads rent from the cluster and splits the costs per transaction. Each transaction is simulated first. It isn't sent if the simulation fails, or if it would spend more than its share of the preview (`run.ts`).
  - If the creator declines the second transaction, or it fails, the token already exists; the page then offers to create the pool for it.
  - Wallets connect through the Wallet Standard and sign with `signAndSendTransaction`. The page has a strict Content Security Policy and shows everything the creator types as text only.
  - Checked in Chromium with a stand-in wallet, on desktop and phone widths: with an unfunded key, the simulation stopped the launch and the wallet was never asked.
  - **On devnet:** a launch by the end-to-end test and a launch through the page (in Chromium, with a stand-in wallet that signs in Node.js) both cost exactly what the preview showed. A buy through the router 2 seconds after launch paid 96.8% tax. Pipeline's API lists both markets and quotes with the tax, and a buy with its `/v1/swap-transaction` went through. Addresses and figures are in `HANDOFF.md` (Devnet).

- **Milestone 3, done (11 November):** the launch list and the token page, with trading, proven on devnet.
  - `app/src/client/pricing.ts`: the pool's trade maths (tax split, constant product, exact-in and exact-out quotes), checked against 513 cases from the Rust crate in `test/vectors.json`.
  - `app/src/market`:
    - `api.ts` reads Pipeline's API as untrusted data. Every field is checked, and malformed entries are dropped.
    - `pools.ts` accepts a pool only if our program owns it and it sits at the address its own fields derive.
    - `history.ts` works out the exact tax of every trade by walking back from the pool's reserves, including trades that share a slot. It is checked against a real devnet trade (96.80% exact, where the block time suggests 95.70%) and a simulated sniper rush.
    - `trade.ts` builds buys and sells (wrap and unwrap SOL, Pipeline's 0.25% fee, a minimum received that allows for 2 seconds of clock drift plus slippage) and simulates before signing. `runTrade` returns the slot the trade landed in.
    - After a trade, the token page reads the pool as of that slot (`minContextSlot`), asking again while the RPC node is behind, so the next quote includes the trade.
    - `view.ts` holds the token details, the buyer checks and the value series.
  - Pages (hash routes):
    - `#/`: the launch list, with filters for new, tax still running and most traded;
    - `#/pool/<pool>`: the live tax, the market value chart, the trades with the tax each paid, buy and sell, and "What the chain says" (trust checks from the SDK's own mint and program inspection);
    - `#/launch`: the launch form.
  - Not from the API: Pipeline's candles price each trade by what the trader paid, so a 97% sniper buy looks like a 31× spike. The chart uses the pool's reserves after each trade instead.
  - Read-only devnet check: `DEVNET_E2E=1 npx vitest run test/devnet.market.e2e.test.ts`. All four devnet markets verify, every listed trade gets an exact tax, a quoted buy simulates, and one past its minimum fails with the router's `InsufficientOutput`.
  - **On devnet (11 November):**
    - `test/devnet.e2e.test.ts` launches with the Normal preset and a permanent 1%, then another wallet buys twice through `market/trade.ts`: a sniper buy seconds after launch and a buy after the 90-second window. After each buy, `taxHistory` accounts for every trade Pipeline's API lists, back to the reserves at launch, and the creator's and protocol's parts of each trade's tax add up exactly to what the pool accrued. In the final run the sniper buy (0.01 SOL, 9 seconds after launch) paid 89.20% and received 9.6 million tokens instead of about 81.8 million; the buy after the window paid the permanent 1% and received exactly the quoted 79.4 million. The pool accrued 8,118,000 lamports for the creator and 902,000 for the protocol: the sum of both taxes, to the lamport.
    - A buy and a sell through the token page in Chromium, with a stand-in Wallet Standard wallet that signs in Node.js. The page simulated each trade before the wallet was asked. The buy (0.01 SOL at 1%) received exactly the tokens the page quoted and cost 0.01 SOL plus Pipeline's fee and the signature fee; the sell (the page's "Max") received the quoted 0.009877 SOL, and the trades list then showed both with their tax. The table fits at desktop width and scrolls inside its card on a phone; the page itself doesn't scroll sideways.
    - **Found and fixed by the page check:** the first sell was quoted from the reserves before the visitor's own buy (0.008381 SOL; it received 0.009877). The public RPC spreads requests over nodes a few slots apart, so the reload after the buy came from a node that hadn't seen it. Reading as of the trade's slot fixes it; the repeat run matched the quote. Also: a "you" badge in the trades list no longer pushes the tax column out of view, and `clockOffset` takes our time when the slot was read, so a slow RPC answer doesn't count as clock offset.
    - Addresses and figures are in `HANDOFF.md` (Devnet).

- **Milestone 4, done (11 November):** the creator dashboard, `#/creator` ("Your launches").
  - `app/src/market/creator.ts`:
    - `creatorPools` asks the chain for every pool of our program with the creator's address in its creator field (`getProgramAccounts` by account size and that field), then verifies each the way the token page does. A pool the API hasn't indexed shows too, and a node that ignores the filter can't slip in someone else's pool.
    - `runClaim` builds the claim: the creator's wrapped-SOL account (created if needed), `claim_tax` into it and, if the site created it, closing it, so the tax arrives as SOL. It is simulated first and not sent if the creator would end up with less than the unclaimed tax less the fee (or, when the tax stays wrapped, would pay more than the fee). Only the creator, only pools against SOL, and only with something to claim.
  - The page lists each pool with its live tax and unclaimed tax, a total, and a Claim button per pool; after a claim it reads the pools as of the claim's slot. It says that the protocol's part is separate and that the launch liquidity stays in the pool for good. `sweep_protocol_fees` is not offered yet.
  - **On devnet:** the end-to-end test now ends with the creator finding the new pool through `creatorPools` and claiming through `runClaim`: 8,118,000 lamports unclaimed, 8,113,000 more SOL in the creator's wallet (the 5,000 difference is the signature fee), nothing left for the creator in the pool, and the protocol's part and the reserves untouched. Through the dashboard in Chromium, with the stand-in wallet as the creator, three pools were claimed, each paying exactly its unclaimed tax less the fee (8,298,000, 8,019,900 and 8,118,000 lamports); each row then showed nothing left. The wallet saw the instructions create the wrapped-SOL account, call our program and close the account, after the page said "Simulated". The page doesn't scroll sideways at 390 pixels.

## 8. Decisions

The owner took every recommendation on 10 November 2026; the name and domain come later.

| # | Question | Decision |
|---|---|---|
| S1 | Where does the site live? | `app/` in this repo (shared CI and test vectors) |
| S2 | Framework | Vite + React + TypeScript (static, simple to host) |
| S3 | Token images | MVP: the creator pastes an image URL. Later: upload to IPFS or Arweave through a pinning service, which needs a small server for its key |
| S4 | Token standard | Token-2022 with built-in metadata (no Metaplex dependency, metadata frozen at launch). Measured through the router: a swap costs 37,500–39,300 compute units against 35,100–35,200 for SPL Token, a few lamports at any priority fee |
| S5 | Site fee per trade | 0% on devnet; decide before mainnet. A typical front-end fee is 0.5–1% |
| S6 | Creator's share outside the pool | Default 0%, at most 20%, always shown |
| S7 | Name and domain | Later |
| S8 | Is the sniper tax always on, or optional? | **Decided (10 November): always on**, with an adjustable strength (the presets in 3.1). Every launch on the site protects buyers, and the protocol earns on every tax. Making it optional later is a small site change, since the program accepts 0% |

## 9. Out of scope for now

The bonding curve (v2), mainnet, a mobile app, comments and other social features, and
image uploads.
