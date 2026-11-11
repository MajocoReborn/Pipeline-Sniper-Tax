# Handoff: current state (11 November 2026)

For a new session. The design and background are in [`PLAN.md`](PLAN.md), the review in
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md); this document says where everything is, how to test
it and what to watch out for.

**Latest step (11 November):** the launch site is live on devnet at
<https://sniper-tax-launch-devnet.majoco21.workers.dev>, on Cloudflare (decision S9), deployed from `main` on every
push. PR #2 (milestones 1 to 4), #3 (the hosting config and security headers) and #4 (the build
settings) are merged. See "Hosting".

**Before that (11 November):** milestones 3 and 4 of the launch site are done and proven on devnet.
Milestone 3 is the launch list and the token page, with trading: the end-to-end test makes a sniper
buy and a buy after the window through the site's trade code and checks the tax of every trade
against what the pool accrued, and a buy and a sell went through the token page in Chromium.
Milestone 4 is the creator dashboard (`#/creator`): the test ends with the creator claiming their
tax through the site's code, and three claims went through the page in Chromium. See "Trading and
claiming through the site" under "Devnet", and [`LAUNCH-SITE.md`](LAUNCH-SITE.md) for the progress.
Next is milestone 5: polish, a security review of the site and a public devnet deploy.

**Earlier (10 November):** findings H1, H2, I1, I2, L1 and L2 from the review are fixed in the
program, following the owner's choices (see "The owner's choices"). The new binary has sha256
`9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`. The owner upgraded devnet to it
the same day (slot 520838510); see "Devnet".

## Repo and branch

- Repo: `MajocoReborn/Pipeline-Sniper-Tax`.
- PR #1 (`claude/sleepy-faraday-1fldh4`) was merged into `main` on 10 November 2026 (merge
  commit `6756dc6`). New work starts on a fresh branch from `main`.
- PR #2 (`claude/happy-knuth-hv0t34`), the launch site with milestones 1 to 4, was merged into
  `main` on 11 November 2026 (merge commit `a65266e`).
- PR #3 (hosting config) and PR #4 (build settings), both from `claude/milestone-3-launch-site-x9b94m`,
  were merged on 11 November. GitHub's default branch should be `main` (it was still PR #1's branch).
- The repo is public, so the strategy metadata on `main` is reachable: Pipeline's API reports it
  `valid` since 10 November. If the repo goes private again, it turns `metadata-unreachable`;
  then host the metadata elsewhere and update the registration's URI (the router has
  `update_metadata`).
- CI (`.github/workflows/ci.yml`) is a single job:
  - formatting and clippy;
  - the sBPF build of the program;
  - fetching the router from devnet;
  - all tests.

  It has been green on every push so far.

## What is where

| Path | Contents |
|---|---|
| `programs/sniper-tax` | The Anchor 1.2.2 program (the Pipeline strategy). `lib.rs` (instructions and account structs), `state.rs`, `policy.rs` (Token-2022 policy), `token.rs` (transfer helper), `errors.rs` |
| `crates/sniper-tax-math` | Pure maths: the tax curve, the tax split and constant-product. Used by the program |
| `crates/sniper-tax-client` | Addresses (`PoolKeys`, PDAs), mirrored account types and every instruction builder. No LiteSVM, no keypairs |
| `crates/sniper-tax-tests` | LiteSVM harness (`src/lib.rs`, on top of the client crate) and integration tests: `launch_pool.rs` (24), `findings.rs` (6), `extremes.rs` (4), `stress.rs` (2), `transfer_hook.rs` (1) |
| `test-programs/test-hook` | Test transfer hook that counts every transfer, in its own workspace so it doesn't touch the lockfile or the binary of the real program |
| `crates/sniper-tax-devnet` | Devnet tool on the client crate: `setup` (registration and config), `demo` (a complete launch), `config` (move the treasury, propose a new admin), `accept-admin` (the proposed admin takes over) |
| `metadata/sniper-tax.devnet.json` | Strategy metadata for Pipeline terminals |
| `scripts/fetch-pipeline-router.sh` | Fetches the router binary from devnet, pinned by sha256, into `fixtures/pipeline.so` |
| `docs/PLAN.md` | Design, account validation, threat model, decisions, progress |
| `docs/SECURITY-REVIEW.md` | Self-review: findings, fixes and their tests |
| `docs/LAUNCH-SITE.md` | Plan for the launch website (approved), with its progress |
| `app/` | The launch site (Node 20.19 or later). `src/client` is the TypeScript client; `src/vendor/pipeline` is Pipeline's SDK, vendored unmodified (`VENDORED.md`); `src/launch` holds the launch logic without React (form rules, both transactions, costs, simulation, `runLaunch`); `src/market` reads markets and trades from Pipeline's API, verifies pools, works out each trade's tax (`history.ts`), builds trades (`trade.ts`) and finds a creator's pools and claims their tax (`creator.ts`); `src/components` holds the pages. `public/_headers` holds the response headers for the host and `wrangler.jsonc` the Cloudflare config (see "Hosting"). `test/vectors.json` comes from the Rust client |

## Build and test

```sh
cargo install cargo-build-sbf --version 4.6.0 --locked   # once; downloads ~1.6 GB of platform tools
(cd programs && cargo build-sbf)                         # program -> programs/target/deploy
(cd test-programs && cargo build-sbf)                    # test hook -> test-programs/target/deploy
scripts/fetch-pipeline-router.sh                         # router -> fixtures/pipeline.so (needs devnet RPC)
cargo test --workspace                                   # all tests, ~30 s
cargo clippy --workspace --all-targets -- -D warnings
(cd programs && cargo clippy --all-targets -- -D warnings)
cargo fmt --all -- --check && (cd programs && cargo fmt --all -- --check)
(cd app && npm ci && npm test)                           # typecheck, prettier, vitest
(cd app && npm run build)                                # the static site -> app/dist
(cd app && npm run dev)                                  # the site on http://localhost:5173 (devnet)
(cd app && npm run vectors)                              # after changing the Rust client
```

A launch from the site's own code on devnet, then a sniper buy and a buy after the window by
another wallet through the site's trade code, with the tax of every trade checked against the
pool, and last the creator's claim (about 0.14 devnet SOL net and two minutes; the public devnet RPC has no airdrop, so fund a
throwaway key first and keep it outside the repository). The read-only check verifies every
devnet market and its trades, and spends nothing. `--silent=false` prints the addresses and
figures, which Vitest hides for a passing test:

```sh
cd app && DEVNET_E2E=1 DEVNET_E2E_KEYPAIR=/path/to/throwaway.json npx vitest run test/devnet.e2e.test.ts --silent=false
cd app && DEVNET_E2E=1 npx vitest run test/devnet.market.e2e.test.ts --silent=false
```

Extra:

```sh
# Long stress test (60,000 steps, ~20 s in release)
STRESS_SEEDS=30 STRESS_STEPS=1000 cargo test -p sniper-tax-tests --release --test stress
# Mutation test of the maths (cargo install cargo-mutants --locked)
cargo mutants -p sniper-tax-math
```

**Expected results**

| Test | Result |
|---|---|
| `sniper-tax-math` | 13 unit tests and 12 property tests (2,000 cases each) |
| `sniper-tax-client` | 1 unit test (pool address equals the program's seeds) |
| `launch_pool` | 24 integration tests |
| `extremes` | 4 tests |
| `stress` | 2 tests |
| `findings` | 6 tests, one per fixed finding from `SECURITY-REVIEW.md`: H1 (fee authority, fee above 5%, the fee in force and a scheduled fee), H2 (hook on the launch token), L1 (launch fee below rent) and L2 (two-step admin transfer) |
| `transfer_hook` | 1 test, with the hook on the quote mint. Every path in which the program makes transfers: `launch`, refund, the output of a sell, `claim_tax` and `sweep_protocol_fees`. With exact counter values; without the hook accounts they fail cleanly |
| Long stress run | 43,139 trades, 12,814 of them taxed buys, without a single broken invariant |
| Mutation test | 78 of 79 mutants caught (84 found, 5 unviable). Because of the one survivor, `cargo mutants` exits with code 2 |
| `app` (`npm test`) | 78 tests: the client and the pool's maths against the Rust vectors, the launch form and transactions, the API parser, pool verification and reads as of a slot, the per-trade tax walk, quotes, trade transactions and the check before a trade is sent, a creator's pools and the claim, the routes, the response headers, the page views, and display helpers. The devnet tests are skipped without `DEVNET_E2E` |
| `app/test/devnet.e2e.test.ts` | 1 test, about 106 s on devnet: a launch, a sniper buy and a buy after the window, each followed by the tax check against the pool, then the creator's claim (passed on 11 November, see Devnet) |
| `app/test/devnet.market.e2e.test.ts` | 1 read-only test, about 1 s, plus a simulated buy with `DEVNET_E2E_KEYPAIR`: every devnet market verifies and every listed trade gets an exact tax |

The one surviving mutant is equivalent to the original code: the filter `*reserve > 0` in `Pricing::settle` can never trigger, because `check_liquidity` and the formulas already rule that case out.

## Pitfalls: read this before cleaning up

1. **Line numbers are in the binary.** Anchor puts the file and line number in error messages. Every shifted line in `programs/sniper-tax/src/*.rs` gives a different binary.
   - The current source gives sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd` (375,568 bytes), also from a clean build.
   - Pipeline's API and `solana-verify get-program-hash` show the same program as `987678b54d6f68a6…`: they hash the code with its trailing zero bytes removed, not the whole `.so` file.
   - Devnet runs this version since 10 November (slot 520838510). Before that it ran `222ee7691fe1b9ca344f0831b5b9ead3b863a59ba38c26c5384a105a92f09c3a`, the build of commit `8bb831b`.
   - The build does not depend on the directory the repo is in: dependencies appear in the binary with paths relative to their crate. `cargo-build-sbf` 4.6.0 (platform tools v1.58) and the lockfile determine the result.
   - Cleaning up the program means: deploying again (an upgrade) on devnet, or accepting that devnet runs an older version.
2. **The program address is in three places:** `declare_id!` in `programs/sniper-tax/src/lib.rs`, `PROGRAM_ID` in `crates/sniper-tax-client/src/lib.rs`, and the metadata JSON. The program keypair only existed in the old cloud environment. A fresh `cargo build-sbf` creates a new keypair in `target/deploy/`. The tests don't need it, because LiteSVM loads the `.so` at the fixed address; only deploying to a new address needs the keypair.
3. **The `transfer_checked` CPI of `anchor-spl` 1.2.2 does not pass on transfer-hook accounts.** Therefore always use the program's own `token::transfer_checked`, never Anchor's.
4. **Anchor 1.x refuses the same writable account twice** (`ConstraintDuplicateMutableAccount`), before our own constraints run.
5. **The router takes its 0.25% fee from the trader's input account after the swap.** Tests that sell everything therefore fail with "insufficient funds"; sell at most 99%.
6. **Output hook accounts:** according to Pipeline's `INTEGRATOR-GUIDE.md`, the client puts the output mint's hook accounts after the requested strategy accounts. `pipeline_swap` passes everything after the output vault to both transfers. Tested in `transfer_hook.rs`, with a sell that pays out the hooked quote mint.
7. **The router is pinned.** If Pipeline upgrades the router on devnet, `fetch-pipeline-router.sh` stops. Then check what changed and run `--accept-new`.
8. **The cloud environment's sandbox refused to build the cloned Pipeline repo** (external code). That is why the router is downloaded instead of built. The Solana CLI 4.4.1 (`cargo install solana-cli`) needs Rust 1.98.1 and `libudev-dev`.
9. **The test hook program has its own workspace** (`test-programs/`). In the `programs/` workspace it changes the shared lockfile, and with it the binary of the real program.
10. **New error codes go at the end only.** Anchor numbers error codes in order (6000, 6001, …). New codes therefore come after the existing ones in `errors.rs`, so clients keep the old numbers.
11. **`update_config` has new arguments** (`ConfigUpdate`: treasury, tax share, launch fee; no admin any more). The old and new versions therefore don't fit together. After the upgrade, don't use an old build of the devnet tool; and use the new tool's `config` or `accept-admin` only after the upgrade: the old program doesn't know `propose_admin` and `accept_admin`, and refuses the new arguments of `update_config`.
12. **The metadata names the treasury as a fixed address** (`metadata/sniper-tax.devnet.json`, for `launch` and `sweep_protocol_fees`). If the admin moves the treasury, update the metadata too. Otherwise `launch` from a terminal fails with `WrongTreasury`. On 10 November it went from the old treasury `HcQgs…` to `DEwdb…`, and then to the devnet wallet `CUiq3QQ…`.
13. **The Solana CLI needs a keypair file** (a JSON array of 64 bytes). A wallet that exists only as a private key, or only in a wallet app, must first be turned into one, locally: from the seed phrase with `solana-keygen recover 'prompt://?key=0/0'`, or from the private key through a hidden prompt. Never paste a key or seed phrase into a chat. The 12 words the CLI prints during a deploy belong to the temporary buffer account, not to the wallet.
14. **The TypeScript client mirrors the Rust client.** After changing `crates/sniper-tax-client` or a layout in the program, regenerate `app/test/vectors.json` (`cd app && npm run vectors`) and make the TypeScript match. CI regenerates the vectors and fails if the committed file differs.
15. **The site's cost preview must stay exact.** `app/src/launch/run.ts` refuses to send a transaction that would spend more than its share of `launchCosts` (`chain.ts`). If a launch starts creating another account (a change in the program or the router), add it to `launchCosts` and `SPACE`, or every launch from the site stops before the wallet is asked.
16. **The Content Security Policy is in two places:** `app/index.html` (a meta tag, for any host) and `app/public/_headers` (the header Cloudflare sends, with `frame-ancestors 'none'` added, which only works as a header). `test/headers.test.ts` fails if they differ. `connect-src` lists every host the page talks to; a new RPC or API host goes in both, or the browser blocks it. Only the dev server allows inline styles (`vite.config.ts`).
17. **A launch is two transactions.** If the pool transaction fails or the creator declines it, the token already exists, with its whole supply in the creator's wallet. The page then offers to create the pool for that token (`createPool`), with the same form: the pool's address depends on the creator and the tax schedule, and its tokens on the creator's share.
18. **The program keeps no per-trade record of tax.** `app/src/market/history.ts` works it out by walking back from the pool's reserves through Pipeline's trade list. If the walk fails, the API is usually behind the chain; the page then marks rates as estimates (≈) from the block time, which can be a second off the program's clock.
19. **Custom error codes are ambiguous.** The router's `InsufficientOutput` and our `NotUpgradeAuthority` are both 6021, so the site recognises slippage by the log line, not the number. After serialisation the RPC reports codes as strings (`{"Custom":"1"}`).
20. **Pipeline's candles include the tax.** They price each trade by what the trader paid, so a sniper buy looks like a spike. The site charts the market value from the pool's reserves instead.
21. **The public devnet RPC is several nodes, a few slots apart.** Right after a trade, a plain read can come from a node that hasn't seen it: on 11 November the token page quoted a sell from the reserves before the visitor's own buy. Read as of the trade's slot instead: `runTrade` returns it, and `readVerifiedPool(rpc, pool, slot)` passes it as `minContextSlot` and asks again while the node is behind. The devnet tests read balances the same way.
22. **The public devnet RPC rate-limits bursts** (HTTP 429), for example right after a launch. The devnet tests use `patientRpc()` from `test/helpers.ts`, which waits and retries. The site doesn't retry: its pages keep their last data and poll again.
23. **The creator dashboard needs `getProgramAccounts` with filters.** The public devnet RPC allows it; some mainnet RPC providers restrict or charge extra for it. Check that before choosing a mainnet RPC, or the dashboard stays empty.

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

| | |
|---|---|
| Program | `EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b` (registered with the Pipeline router) |
| Upgrade authority, config admin and treasury | `CUiq3QQbXMsrgCpiN423zr2NTrdfPRuGUy9EQKQ6CGap`: a wallet only for devnet, created locally by the owner (7.0 devnet SOL on 10 November). Until 10 November all three were on the owner's general wallet `DEwdb…N8tYn`, which now has no role here |
| Version on devnet | sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`, upgraded on 10 November 2026 at slot 520838510 (signature `3QJQDcHTB1dmS3YDvwz1KPPQ83eZi9yuzxigk8Ymw8pfWWzmpmN1seVdd7FfnhEDCpojaT5S4cCAQSYbeMURW2Vc`). Before that: `222ee769…` (slot 520494490) |
| Config | `6wCct5q2tQ2WGfbtLcEzaH756aGnkMuSnnexaHmquL93`: 10% tax share, 0.01 SOL launch fee. `pending_admin` is empty (checked after the upgrade) |
| Demo pool | `GeajhDYc24MyRecNv1a69nSsa2kdUtwbhLec6xpqVG3B` |

**Deploying a new version.** Upgrading at the same address needs the devnet wallet `CUiq3QQ…`, and that key is never in a cloud session. The owner therefore does the upgrade locally (choice 4a). On Windows, use WSL.

1. Tools, once:

   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust; the repo picks its version
   sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"    # Solana CLI; then open a new terminal
   cargo install cargo-build-sbf --version 4.6.0 --locked
   solana-keygen pubkey <path-to-wallet.json>                       # must print CUiq3QQ…6CGap
   ```
2. Build, from the repo on the branch of PR #1:

   ```sh
   git clone https://github.com/MajocoReborn/Pipeline-Sniper-Tax.git
   cd Pipeline-Sniper-Tax && git checkout claude/sleepy-faraday-1fldh4
   (cd programs && cargo build-sbf)
   shasum -a 256 programs/target/deploy/sniper_tax.so        # Linux: sha256sum
   ```

   Expected: `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`, 375,568 bytes. If the hash differs, don't deploy; first find out why (a different `cargo-build-sbf`, a changed lockfile or local changes). Later commits that only touch docs leave the hash unchanged.
3. Upgrade, with the wallet as upgrade authority and as payer:

   ```sh
   solana program deploy programs/target/deploy/sniper_tax.so \
     --program-id EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b \
     --upgrade-authority <path-to-wallet.json> \
     --keypair <path-to-wallet.json> \
     --url devnet
   ```

   - Keep `--url devnet`. Without it the upgrade goes to the cluster in the local Solana config (`solana config get`).
   - The new binary is 12,744 bytes larger than the ProgramData account (362,824 bytes). A recent Solana CLI (2.x or later) extends the account itself. If the CLI still reports that the account is too small, extend it first with `solana program extend EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b 12744 --keypair <path-to-wallet.json> --url devnet`.
   - The deploy first writes the binary into a buffer (about 1.9 SOL, which comes back) and pays rent for the extra space (about 0.07 SOL).
   - If the deploy breaks off halfway, recover the buffer SOL with `solana program close --buffers --keypair <path-to-wallet.json> --url devnet`.
   - The program keypair is not needed, only the upgrade authority.
4. Check:

   ```sh
   solana program dump EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b onchain.so --url devnet
   head -c 375568 onchain.so | shasum -a 256
   ```

   That must give the same hash. `head` cuts off the zeros that are there if the account was made larger than the binary. Then record the version on devnet in this table.

After the upgrade nothing else is needed on-chain: the pool and config layouts are unchanged, and existing pools keep working.

**The upgrade of 10 November.** The owner deployed the binary built and tested in the cloud session, after checking its sha256 locally, so no local build was needed (for mainnet: build it yourself, or use a verifiable build). The CLI extended the ProgramData account by itself, to exactly 375,568 bytes, and closed the buffer; it cost about 0.067 SOL. Checked afterwards from the cloud session: the on-chain hash matches, the transaction is finalized, the config is intact, and a simulated `pipeline_quote` on the demo pool succeeds (3,775 compute units) with exactly the constant-product output, since its tax window is long over. A new session can also deploy the program to a new address; then change the three places from pitfall 2.

**Moving control to the devnet wallet (10 November).** All three roles moved from `DEwdb…` to `CUiq3QQ…`, checked on-chain afterwards:

- 7 devnet SOL with `solana transfer`;
- the upgrade authority with `solana program set-upgrade-authority … --new-upgrade-authority <new-keypair.json>`, so the new wallet co-signs and a typo is impossible;
- the treasury and an admin proposal with the devnet tool's `config` (signature `4Fiix5BY…`);
- the admin with `accept-admin`, signed by the new wallet (signature `3dXCrc3e…`).

The new wallet was derived with Phantom's path (`solana-keygen recover 'prompt://?key=0/0'`), so its seed phrase gives the same address in a wallet app. `solana-keygen new` derives without a path, which gives a different address from the same words.

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

**Administration.** `config` moves the treasury (keeping the fees) and, with `ADMIN`, proposes a new admin. The new admin takes over with `accept-admin`, with their own wallet as `KEYPAIR`. Until then, the current admin stays in charge. The metadata URI in the registration points to `main`. It only works after PR #1 is merged, and only if the repo is public.

## Cleaned up

- **Client crate:** `crates/sniper-tax-client` holds the account types (one mirror of the program, in one place), the PDAs and every instruction builder. `launch_ix` and `claim_tax_ix` take the creator from the pool parameters. The test harness and the devnet tool build on it; the devnet tool no longer depends on LiteSVM.
- **Test options:** mints are described with `MintSpec` (`MintSpec::token_2022(6).with_transfer_fee(..)`) and the quote side with `QuoteMint`, instead of loose flags and an `Option<Option<..>>`.
- **Router pinned again:** Pipeline rebuilt the same router code (slot 520510501). Every test passes against it.
- **Docs in English** (10 November): README, PLAN, HANDOFF and SECURITY-REVIEW were translated from Dutch, so everyone can read them. Code and comments were already English.

## Fixed in the program (10 November)

Following the owner's choices, in one version (sha256 `9f24dafa…`). Details and tests per finding are in `SECURITY-REVIEW.md`.

| Finding | Change | Error code | Tests |
|---|---|---|---|
| H1 | `policy::check_transfer_fee` at `launch`, for both mints: no `transfer_fee_config_authority`, and the fee in force and a scheduled fee at most 500 bps | `TransferFeeAuthorityPresent`, `TransferFeeAboveCap` | `findings.rs`: three H1 tests, each for the launch token and the quote mint |
| H2 | `TransferHook` refused on the launch token (`policy::MintRole`), at `create_market` and at `launch`. Allowed on the quote mint | `ForbiddenMintExtension` | `finding_h2_a_hooked_launch_token_is_refused`, `a_hooked_quote_mint_works_for_every_transfer` |
| I1 | A dedicated error code for "a sell with tax" | `TaxedSell` | Unreachable; the maths never taxes a sell |
| I2 | Constraint `destination != quote_vault` in `ClaimTax` removed; Anchor already refuses it | `ConstraintDuplicateMutableAccount` | `the_creator_claims_their_tax_once` |
| L1 | `initialize_config` and `update_config` refuse a launch fee between 0 and the rent-exempt minimum | `LaunchFeeBelowRent` | `finding_l1_a_launch_fee_below_rent_is_refused` |
| L2 | `update_config` no longer changes the admin; new: `propose_admin` and `accept_admin`, with `pending_admin` in the config's reserved bytes | `NotPendingAdmin` | `finding_l2_the_admin_moves_only_when_the_successor_accepts` |

A manual mutation round on the program confirms that the tests guard these checks: twenty mutants, each built and tested one at a time, and all twenty caught. Examples: inverting the hook rule, not checking the fee authority or one of the two fees, an off-by-one bps or lamport at the boundary, and skipping a step of the admin transfer.

## Still to clean up

- **Redundant safety check:** the filter `*reserve > 0` in `Pricing::settle` (in the maths crate, which the program uses) can never trigger. It is deliberately kept as a defence (I3).

## Deliberately left as is

- **The devnet tool** speaks JSON-RPC through `curl`. That works and keeps the tool small; a real RPC client (`solana-rpc-client`) pulls in many dependencies for a helper script.
- **Language:** everything in the repository and on GitHub is in English; conversations with the owner are in Dutch (see `CLAUDE.md`).

## The owner's choices (10 November)

1. **H1, fee authority: a.** A mint with a transfer fee is allowed only if its `transfer_fee_config_authority` is `None` and both the fee in force and a scheduled fee are at most 500 bps (5%). The same rule applies to the quote mint.
2. **H2, transfer hooks: a.** Hooks on the launch token are refused. The quote mint may keep a hook, without an allowlist. Its residual risk is described in the review under H2.
3. **Small program points: a.** I1, I2, L1 and L2 are in the same version.
4. **Deploy: a.** The owner upgrades locally with their own wallet; the commands are under "Devnet".

## Full run (10 November)

Run after the changes, with the exit code of every step:

| Step | Exit code | Result |
|---|---|---|
| `scripts/check-no-keypairs.sh` | 0 | No keypairs in the repo |
| `cargo fmt --check`, in all three workspaces | 0, 0, 0 | |
| `cargo clippy -D warnings`, in all three workspaces | 0, 0, 0 | |
| `cargo build-sbf` in `programs/`, from an empty `target/` | 0 | sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`, 375,568 bytes |
| `cargo build-sbf` in `test-programs/`, from an empty `target/` | 0 | |
| `scripts/fetch-pipeline-router.sh` | 0 | The router is unchanged (slot 520510501) |
| `cargo test --workspace` | 0 | 63 tests |
| Long stress test (`STRESS_SEEDS=30 STRESS_STEPS=1000`, release) | 0 | 43,139 trades, 12,814 taxed buys, no failure. Same as the previous run: the stress test uses mints the new policy doesn't affect |
| `cargo mutants -p sniper-tax-math` | 2 | 78 of 79 caught. Exit code 2 means "mutants missed": only the known, equivalent mutant in `Pricing::settle` (I3). The maths crate did not change |

In addition, the unchanged source (commit `8bb831b`) built exactly `222ee769…`, the version on devnet, in a fresh environment. The build is therefore reproducible.

## Open items

1. **Launch site:** the plan in [`LAUNCH-SITE.md`](LAUNCH-SITE.md) is approved (the name and domain come later). Milestones 1 (the TypeScript client), 2 (the launch page), 3 (the launch list and token page, with trading) and 4 (the creator dashboard, with claims) are done and proven on devnet. Milestone 5 is under way: the site is live on devnet at <https://sniper-tax-launch-devnet.majoco21.workers.dev> (S9, see "Hosting"); the security review of the site (how the Security-Agent repo does it is open) and the name and domain (S7) are still to decide. The site doesn't offer `sweep_protocol_fees` yet. The throwaway keys are empty (their SOL went back to the devnet wallet) and lived only in the cloud session's scratchpad, so a new devnet run needs a new key.
2. **Optional:** run `demo` on devnet (about 0.2 SOL) to see a full launch on the new version.
3. **Phase 6:** the self-review is in [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md). H1, H2, L1, L2, I1 and I2 are fixed. Still open: M1 and M2 (operational), L3 (display extensions) and the residual risk of a hook on the quote mint. After that, an external audit.
4. **Before mainnet:**
   - a dedicated program keypair;
   - the treasury and the config admin on a multisig, for example Squads;
   - decide whether to freeze the upgrade authority.
