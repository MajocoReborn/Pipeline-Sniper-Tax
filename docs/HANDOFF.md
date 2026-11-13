# Handoff: current state of the launch site (13 November 2026)

For a new session. This repository holds the launch site. **The protocol (the on-chain
program, its crates and tests, the TypeScript SDK, the design and the security review) moved
on 13 November to
[MajocoReborn/pipeline-sniper-tax-strategy](https://github.com/MajocoReborn/pipeline-sniper-tax-strategy)**;
read its `docs/HANDOFF.md` for the program, its build, its devnet deployment and its pitfalls.
This document covers the site: where everything is, how to test it and what to watch out for.
The site's plan and progress are in [`LAUNCH-SITE.md`](LAUNCH-SITE.md).

**Latest step (13 November):** the site uses the protocol's SDK (`@majocoreborn/sniper-tax-sdk`)
instead of its own copy of the client (`app/src/client`, removed), and Pipeline's published
`@pipeline-sol/sdk` 0.1.1 instead of a vendored copy (only `http.ts`, which the package
doesn't export, is still vendored). Until the SDK is on npm it is installed from
`app/vendor/`, built by `scripts/update-sdk.sh` from a pinned commit of the protocol
repository; CI checks that the file is exactly what that commit gives. The site's behaviour is
unchanged: the same 52 tests that remain here pass (the client's 26 tests moved with it).

**Before that (11 November):** the site is live on devnet at
<https://sniper-tax-launch-devnet.majoco21.workers.dev>, on Cloudflare (decision S9), deployed
from `main` on every push. Milestones 3 (the launch list and the token page, with trading) and
4 (the creator dashboard) are done and proven on devnet; see "Devnet" below.

## Repo and branch

- Repo: `MajocoReborn/Pipeline-Sniper-Tax`. New work starts on a fresh branch from `main`.
- The repo is public. The router registration's metadata URI still points at
  `metadata/sniper-tax.devnet.json` on this repository's `main`, so keep that file (and the
  repo public) until the protocol's devnet tool has pointed the registration at the protocol
  repository (`sniper-tax-devnet metadata`, see its handoff). Then delete it here.
- CI (`.github/workflows/ci.yml`): `checks` (no keypairs; the vendored SDK and the vectors are
  the pinned commit's) and `app` (typecheck, prettier, vitest, build).

## What is where

| Path | Contents |
|---|---|
| `app/` | The launch site (Node 20.19 or later). `src/launch` holds the launch logic without React (form rules, both transactions, costs, simulation, `runLaunch`); `src/market` reads markets and trades from Pipeline's API, verifies pools, works out each trade's tax (`history.ts`), builds trades (`trade.ts`) and finds a creator's pools and claims their tax (`creator.ts`); `src/components` holds the pages. `public/_headers` holds the response headers for the host and `wrangler.jsonc` the Cloudflare config (see "Hosting") |
| `app/vendor/` | The protocol's SDK as an npm tarball, until it is on npm (`README.md` there) |
| `app/src/vendor/pipeline/http.ts` | Pipeline's `boundedFetch`, unmodified; the npm package doesn't export it (`VENDORED.md`) |
| `app/test/vectors.json` | Test vectors from the protocol's Rust client, at the SDK's pinned commit |
| `scripts/update-sdk.sh` | Rebuilds `app/vendor/` and the vectors at the pinned commit, or checks them (`--check`) |
| `metadata/sniper-tax.devnet.json` | The strategy metadata the registration still points at (see above) |
| `docs/LAUNCH-SITE.md` | Plan for the launch website (approved), with its progress |

## Build and test

```sh
(cd app && npm ci && npm test)          # typecheck, prettier, vitest
(cd app && npm run build)               # the static site -> app/dist
(cd app && npm run dev)                 # the site on http://localhost:5173 (devnet)
scripts/update-sdk.sh --check           # the vendored SDK is the pinned commit's
SDK_COMMIT=<sha> scripts/update-sdk.sh  # move to another commit of the protocol repository
```

After moving the SDK, set `SDK_COMMIT` in the script to the new commit, so CI checks it.

A launch from the site's own code on devnet, then a sniper buy and a buy after the window by
another wallet through the site's trade code, with the tax of every trade checked against the
pool, and last the creator's claim (about 0.14 devnet SOL net and two minutes; the public devnet
RPC has no airdrop, so fund a throwaway key first and keep it outside the repository). The
read-only check verifies every devnet market and its trades, and spends nothing.
`--silent=false` prints the addresses and figures:

```sh
cd app && DEVNET_E2E=1 DEVNET_E2E_KEYPAIR=/path/to/throwaway.json npx vitest run test/devnet.e2e.test.ts --silent=false
cd app && DEVNET_E2E=1 npx vitest run test/devnet.market.e2e.test.ts --silent=false
```

**Expected results**

| Test | Result |
|---|---|
| `app` (`npm test`) | 52 tests: the launch form and transactions, the API parser, pool verification and reads as of a slot, the per-trade tax walk, quotes, trade transactions and the check before a trade is sent, a creator's pools and the claim, the routes, the response headers, the page views, and display helpers. The devnet tests are skipped without `DEVNET_E2E`. The SDK's own 33 tests run in the protocol repository |
| `app/test/devnet.e2e.test.ts` | 1 test, about 106 s on devnet: a launch, a sniper buy and a buy after the window, each followed by the tax check against the pool, then the creator's claim |
| `app/test/devnet.market.e2e.test.ts` | 1 read-only test, about 1 s, plus a simulated buy with `DEVNET_E2E_KEYPAIR` |

## Pitfalls: read this before changing the site

1. **The SDK and the vectors are pinned together.** The site's client is `@majocoreborn/sniper-tax-sdk` from the protocol repository, installed from `app/vendor/` at the commit in `scripts/update-sdk.sh`, and `app/test/vectors.json` comes from the same commit. Move both at once with `scripts/update-sdk.sh`; CI's `--check` fails if either differs from what the pinned commit gives. Changes to the client itself are made in the protocol repository.
2. **The site's cost preview must stay exact.** `app/src/launch/run.ts` refuses to send a transaction that would spend more than its share of `launchCosts` (`chain.ts`). If a launch starts creating another account (a change in the program or the router), add it to `launchCosts` and `SPACE`, or every launch from the site stops before the wallet is asked.
3. **The Content Security Policy is in two places:** `app/index.html` (a meta tag, for any host) and `app/public/_headers` (the header Cloudflare sends, with `frame-ancestors 'none'` added, which only works as a header). `test/headers.test.ts` fails if they differ. `connect-src` lists every host the page talks to; a new RPC or API host goes in both, or the browser blocks it. Only the dev server allows inline styles (`vite.config.ts`).
4. **A launch is two transactions.** If the pool transaction fails or the creator declines it, the token already exists, with its whole supply in the creator's wallet. The page then offers to create the pool for that token (`createPool`), with the same form: the pool's address depends on the creator and the tax schedule, and its tokens on the creator's share.
5. **The program keeps no per-trade record of tax.** `app/src/market/history.ts` works it out by walking back from the pool's reserves through Pipeline's trade list. If the walk fails, the API is usually behind the chain; the page then marks rates as estimates (≈) from the block time, which can be a second off the program's clock.
6. **Custom error codes are ambiguous.** The router's `InsufficientOutput` and our `NotUpgradeAuthority` are both 6021, so the site recognises slippage by the log line, not the number. After serialisation the RPC reports codes as strings (`{"Custom":"1"}`).
7. **Pipeline's candles include the tax.** They price each trade by what the trader paid, so a sniper buy looks like a spike. The site charts the market value from the pool's reserves instead.
8. **The public devnet RPC is several nodes, a few slots apart.** Right after a trade, a plain read can come from a node that hasn't seen it: on 11 November the token page quoted a sell from the reserves before the visitor's own buy. Read as of the trade's slot instead: `runTrade` returns it, and `readVerifiedPool(rpc, pool, slot)` passes it as `minContextSlot` and asks again while the node is behind. The devnet tests read balances the same way.
9. **The public devnet RPC rate-limits bursts** (HTTP 429), for example right after a launch. The devnet tests use `patientRpc()` from `test/helpers.ts`, which waits and retries. The site doesn't retry: its pages keep their last data and poll again.
10. **The creator dashboard needs `getProgramAccounts` with filters.** The public devnet RPC allows it; some mainnet RPC providers restrict or charge extra for it. Check that before choosing a mainnet RPC, or the dashboard stays empty.

## Hosting

Decision S9 (11 November): the site is hosted on **Cloudflare, as a Worker with static assets**
and no Worker code. Free, also for commercial use, and it sends our own response headers.
GitHub Pages can't send headers, so no `frame-ancestors`; Vercel's free plan is for
non-commercial use only.

- `app/public/_headers`: the Content Security Policy with `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, a
  `Cross-Origin-Opener-Policy` that still lets wallets open popups, a `Permissions-Policy`
  without camera, microphone, location or payments, and a year's cache for `/assets/*`. Vite copies
  it into `dist/`; Cloudflare doesn't serve it as a file. USB, HID and serial are deliberately not
  blocked: some wallets talk to hardware wallets from the page.
- `app/wrangler.jsonc`: the Worker `sniper-tax-launch-devnet`, serving `app/dist`.
- Checked on 11 November with wrangler 4.154.0: `wrangler deploy --dry-run` reads the config and
  the five files, and under `wrangler dev` the page sends every header above, `/_headers` is a 404,
  and in Chromium the launch list and a token page load without a single CSP error while framing
  the page from another origin is refused.

**Deploying** (the owner, with their own Cloudflare account; no keys in the repository):

- From the dashboard, connected to GitHub (redeploys on every push to `main`): Workers & Pages →
  Create application → GitHub → this repository. The form has no root directory field, so the
  commands change into `app` themselves (this is how the owner set it up on 11 November):
  - Project name: `sniper-tax-launch-devnet` (must equal `name` in `app/wrangler.jsonc`);
  - Build command: `cd app && npm ci && npm run build`;
  - Deploy command: `npx wrangler@4.154.0 deploy --cwd app`;
  - Version command, for other branches: `npx wrangler@4.154.0 versions upload --cwd app`. It
    uploads a version without deploying it. The form's default, `wrangler preview`, needs Worker
    Previews set up; without them the build of a pull request's branch failed at once.

  Then, under Settings → Build → Branch control, make sure the production branch is `main`.
  Cloudflare takes the repository's default branch, and on GitHub that was still PR #1's
  `claude/sleepy-faraday-1fldh4`, which has no `app/`: the first build failed with
  `cd: can't cd to app`. Set GitHub's default branch to `main` too. Cloudflare's guide:
  https://developers.cloudflare.com/workers/ci-cd/builds/.
- Or from a computer with Node 20.19 or later:

  ```sh
  cd app && npm ci && npm run build
  npx wrangler@4.154.0 login
  npx wrangler@4.154.0 deploy
  ```

- The site runs at **<https://sniper-tax-launch-devnet.majoco21.workers.dev>** since 11 November (first live
  version `7f3c67c8`, built from `main` at `65af0ee` in 25 seconds). `majoco21` is the account's
  workers.dev subdomain, chosen by the owner; changing it (Workers & Pages, "Subdomain", Change)
  changes the site's address at once, and the old address stops working. Check the headers with
  `curl -sI <url> | grep -i -e content-security-policy -e x-frame-options`.
- Checked live on 11 November: every header from `_headers` arrives, `/_headers` and
  `/wrangler.jsonc` are 404, the script is the same file a local build makes
  (`index-Dp3tQour.js`), and in Chromium the launch list, a token page with its exact taxes and
  the launch and creator pages load without one console error, with no sideways scrolling at
  390 pixels; framing the site from another origin is refused.
- A custom domain comes with the name (S7). Keep `wrangler.jsonc`'s `compatibility_date` at or
  before the date the pinned wrangler supports (4.154.0: 30 October 2026), or `wrangler dev`
  refuses to start; raise both together.

## Devnet

The program and its deployment are described in the protocol repository's handoff. For
reference:

| | |
|---|---|
| Program | `EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b` (registered with the Pipeline router) |
| Upgrade authority, config admin and treasury | `CUiq3QQbXMsrgCpiN423zr2NTrdfPRuGUy9EQKQ6CGap`: a wallet only for devnet, created locally by the owner (7.0 devnet SOL on 10 November). Until 10 November all three were on the owner's general wallet `DEwdb…N8tYn`, which now has no role here |
| Version on devnet | sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`, upgraded on 10 November 2026 at slot 520838510 (signature `3QJQDcHTB1dmS3YDvwz1KPPQ83eZi9yuzxigk8Ymw8pfWWzmpmN1seVdd7FfnhEDCpojaT5S4cCAQSYbeMURW2Vc`). Before that: `222ee769…` (slot 520494490) |
| Config | `6wCct5q2tQ2WGfbtLcEzaH756aGnkMuSnnexaHmquL93`: 10% tax share, 0.01 SOL launch fee. `pending_admin` is empty (checked after the upgrade) |
| Demo pool | `GeajhDYc24MyRecNv1a69nSsa2kdUtwbhLec6xpqVG3B` |

**Launches from the site (10 November).** The first launches built by the site's code, paid by a throwaway key (`5frqE7XgGfsz6bmjCK4ABpkChuGJEsFcZSURNxL53vve`, funded with 0.4 devnet SOL from the devnet wallet; its key was never in the repository):

| Launched by | Token | Pool | Pipeline market |
|---|---|---|---|
| `app/test/devnet.e2e.test.ts` | `FvwwZZNuXmuCXEhP7y8Zsr9i7WYwL9Z7GvVMEFsPxxcw` (Site E2E Test) | `GAw4Zbn3Z26t1k9otfHerR4zZYSbEXtD8P9Yun9sfFdj` | `EvXtpuXsMQi5ZPhQKHQCA7GNPyN7u5RRsLoPWfGd1TuC` |
| The page in Chromium, with a stand-in wallet | `7Ef6T3cgMsrcbg2qk2ZehVVMYBrWN9kjvzNeH8ZhACWY` (Site UI Test) | `6jb2KV5UD9GxYihd2aieHKh1PKPQpnP6Wku95qGMstTA` | `2YT9jEF5i4kg15883cwyCtuuHSuMrUrFTeqLPmPCbZVv` |

- **Cost:** both launches cost exactly what the preview showed, to the lamport. The page's launch cost 0.125255 SOL: 0.1 into the pool, and 0.025255 for rent, the 0.01 launch fee and the transaction fees. The token transaction used 38,209 compute units and the pool transaction 200,390, within the default limit of 200,000 per instruction.
- **The sniper tax through the router:** in the end-to-end test another wallet bought with 0.01 SOL, 2 seconds after the launch. It paid 96.8% tax (9,680,000 lamports: 8,712,000 for the creator, 968,000 for the protocol) and received 2,870,813 tokens; without the tax it would have received about 81.8 million.
- **Through Pipeline's API:** a quote 48 seconds after the page's launch included the tax (about 46%). After the window, a fresh wallet bought with 0.005 SOL using `/v1/swap-transaction`, checked and simulated before signing, and received the quoted 42,857,142 tokens. The API lists both markets with the mint flags (no mint or freeze authority, metadata update authority `null`) and both trades.

**Trading and claiming through the site (11 November, milestones 3 and 4).** Paid by a new throwaway key, `6UKuJiruzY9CaMyhRdH7tBL4mDPmSbeAkZVmGXnJeTb3` (funded by the owner with 2.5 devnet SOL; the 1.7695 SOL left was sent back to the devnet wallet `CUiq3QQ…` on 11 November, so both keys are empty), and a second one for the page, `64byJXMekQ4K6iVtfHVHnM8bPm9s5dLsJhuDfJrRS5EZ` (0.05 SOL from the first). Neither key was ever in the repository. All launches used the Normal preset with a permanent 1% and a 10% creator share:

| Launched by | Token | Pool | Pipeline market |
|---|---|---|---|
| `devnet.e2e.test.ts`, with the claim | `5e5QzJ2CqtxzUQYD8pr6RL8R6WokA5otAp8Lt81bEUD6` | `CnTExQ5t8NL1tqTB2vdtjwrbGdzKTe4DJrH6tEX5pKJX` | `7U6qYVGen8juFxjyQt3Nn2gUZHv677sst7dkGFjiwXVV` |
| `devnet.e2e.test.ts`, final run of milestone 3 | `8WYzyDwFDkNeocdJgXRKaeUtH9U4DZAkgWVwck7Lfs26` | `BcyhLgMmp3rYPcFV469SKXntGJoPuuVHoN8PDXhuvfKf` | `2Vb4ziRTKvKc2X9JaCM8n8tfjSNsphDWLFbWw6HzeA1u` |
| `devnet.e2e.test.ts`, a run before the clock fix | `6xyaUVZtf1Ue7ppMqxpVatrh21zhWUC9jQMunGvHEegM` | `8UGKZ85zExbYZyBB7GAkAoCfcVzZ4R3XjW3fYKhXBGwJ` | `FooUor3b2heSVnZiukA6KAb59ph2EVhakhjkJd3UGvwR` |
| `devnet.e2e.test.ts`, earlier run; then traded through the page | `7rXH6JUZ1AxH2QNezmUHYYzM31UUb9EM8BXjnDyQ29NP` | `Hvn2LMdgdmdcrZeGz22qRd6LU2qU8xP5D7nHsNWRChku` | `8zCNap3SLvuqY3hpjVhTfiMQ5cUtQeD2oNTaA2NnJi1J` |
| `devnet.e2e.test.ts`, a run stopped by a 429 right after the launch (no trades) | `2vfSZFaLeosszDr8UDGSCt3cjq6BHFPcM4MvaFYNHggx` | `9XsPE4rkdL8ePnETEFHHm61kWw1HMzVHjHsoAzQZNcGp` | `Bh55jfjtVQM2w2tYEd65JG7561EcicwcgdxvE9A7SYkj` |

- **Launch cost:** each cost exactly the 125,270,240 lamports the preview showed.
- **The sniper tax, exactly (final run of milestone 3; the run with the claim gave the same figures):** a buy of 0.01 SOL through `market/trade.ts`, 9 seconds after the launch, paid 89.20% (8,920,000 lamports: 8,028,000 for the creator, 892,000 for the protocol) and received 9,616,145.63 tokens instead of about 81.8 million. Its quote, made the moment the launch confirmed, allowed for 99%; the tax fell while the buy was on its way. After the window, the same wallet bought 0.01 SOL at the permanent 1% (100,000 lamports) and received exactly the quoted 79,426,925.20 tokens. After each buy, `taxHistory` accounted for every trade back to the reserves at launch, and the creator's and protocol's parts added up to the pool's accrued 8,118,000 and 902,000 lamports. Signatures: sniper buy `gSNQQCZWtXu2rm8FfmKaLHTBCPWNFzHkAGctzqvmtV4d3FKZAbDVaSZouuoA6ZRpEhA6vQnhP9mmwMtH6U14ZcA`, later buy `3PBfn4zU7QLAs7j3XN735scUWTyeZKEXTH6tEEaLAJh2H2MyE68rV6Dywqo8JdZwihWxmuCnrJzyXTGZ1EUJU3QZ`.
- **Through the page in Chromium** (the built site under `vite preview`, so with the strict CSP), on pool `Hvn2LM…`, with a stand-in Wallet Standard wallet whose `signAndSendTransaction` hands the bytes to Node.js. The wallet checked that the fee payer was its own key and that the page said "Simulated" before it signed; it saw the instructions create the wrapped-SOL account, wrap, create the token account, swap through the router and close the wrapped-SOL account (a sell: create, swap, close).
  - Buy, 0.01 SOL at 1% (`5q8s5aR73Dv1foo8VTg5kDag66uxxoynL2VafE5DcPCJSksDRQaJ9jbMVAQt5JjL4GthYWE78Un3yAokPvG4gdv8`): received 66,390,873.036453 tokens, the page's quote of 66,390,873.03; the wallet paid 10,030,000 lamports (the amount, Pipeline's 25,000 and the 5,000 signature fee).
  - Sell, the page's "Max" of 66,225,309.76 tokens plus Pipeline's fee of 165,563.27, which is every token (`54pQgDM1bFL7UQKKcNdU5QHXEfTWc1AYK7nDTYrddkS5bhMxNYMbvsF6u8nfYdKygTiW4mCfjfod9mjsntEtBuet`): received 9,877,328 lamports, the page's quote of 0.009877 SOL.
  - The first round, before the fix in pitfall 21, quoted the sell at 0.008381 SOL from the reserves before the buy, and received 0.009877 (`2n3d6Fin…LmyH`, `64TxutUG…w2F8`).
  - The trades list shows all six trades of the pool with their exact tax (89.2%, then 1% on each later buy, none on the sells). At 390 pixels wide the page doesn't scroll sideways; the trades table scrolls inside its card.

- **The creator's claim, from the site's code:** the test with the claim found its new pool through `creatorPools` (the chain, by the creator field) and claimed through `runClaim`: 8,118,000 lamports unclaimed, and 8,113,000 more SOL in the creator's wallet, the difference being the signature fee (`LMVfBKTxKnhN1F6CQHtESrRHunhE9E9vurwmBE1dtWPT927Q46PqkyWpGQz4rskmH4KkbtEqSr7JDEowMPcXwDQ`). Afterwards the pool held nothing for the creator, and the protocol's 902,000 and the reserves were untouched.
- **Claims through the dashboard in Chromium,** with the stand-in wallet as the creator `6UKu…eTb3`: the dashboard listed all five of its pools with their unclaimed tax. Claimed on `Hvn2LM…` 8,298,000 lamports (`3rSWDWiHuA4p6FciJr8CtHvaXnRa87nULmvkB9jALTCi6ae83BsbS785N747iMuCFMqH1UoHVpGt4qzLC1ZmivqK`), on `8UGKZ85…` 8,019,900 (`gUKnSBBdizvUeyHkxZLe1ddHEamLZiP2hXoqHFBgBEHdRSjDqZCxvskDCKqRMiKwarz6SDTvsqHtVX5Yx7jiMPs`) and on `BcyhLg…` 8,118,000 (`4mgozrmX79pmKdquoEoe4dFmYvcFkkpSMnScHiY7TxqY92amGP217V51KQsMu9BCCdfuzGiqVUU5VTKREpGst7io`). Each time the wallet's SOL grew by exactly that less 5,000 lamports, and the row then showed nothing left. The wallet saw the page say "Simulated" before it signed, and the instructions create the wrapped-SOL account, call our program and close the account.

## Open items

1. **Milestone 5:** the security review of the site (how the Security-Agent repo does it is
   open) and the name and domain (S7) are still to decide. The site doesn't offer
   `sweep_protocol_fees` yet. The throwaway keys are empty and lived only in a cloud
   session's scratchpad, so a new devnet run needs a new key.
2. **The SDK on npm:** once `@majocoreborn/sniper-tax-sdk` is published, install it from npm
   and drop `app/vendor/` (see its `README.md`).
3. **The metadata:** delete `metadata/` here once the registration points at the protocol
   repository.
4. **A site fee:** Pipeline's integrator fee is the way a front end earns on the trades it
   routes; the SDK's `exactIn`/`swapIx` take one. See the protocol's `docs/INTEGRATION.md`.
