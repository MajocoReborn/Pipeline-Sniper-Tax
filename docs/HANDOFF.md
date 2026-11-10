# Handoff: current state (10 November 2026)

For a new session. The design and background are in [`PLAN.md`](PLAN.md), the review in
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md); this document says where everything is, how to test
it and what to watch out for.

**Latest step (10 November):** findings H1, H2, I1, I2, L1 and L2 from the review are fixed in the
program, following the owner's choices (see "The owner's choices"). The new binary has sha256
`9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd`. Devnet still runs the old
version (`222ee769…`) until the owner upgrades; the commands are under "Devnet".

## Repo and branch

- Repo: `MajocoReborn/Pipeline-Sniper-Tax`.
- All work is on branch `claude/sleepy-faraday-1fldh4`, in draft PR #1 to `main`. `main` holds
  only the first commit (the plan). As long as PR #1 is not merged, continue on that branch, or
  merge it first.
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

The one surviving mutant is equivalent to the original code: the filter `*reserve > 0` in `Pricing::settle` can never trigger, because `check_liquidity` and the formulas already rule that case out.

## Pitfalls: read this before cleaning up

1. **Line numbers are in the binary.** Anchor puts the file and line number in error messages. Every shifted line in `programs/sniper-tax/src/*.rs` gives a different binary.
   - The current source gives sha256 `9f24dafa0168585de8e15a519a178ed14e6e2bb7d3f8443862eff1db6379f7cd` (375,568 bytes), also from a clean build.
   - Until the upgrade, devnet runs `222ee7691fe1b9ca344f0831b5b9ead3b863a59ba38c26c5384a105a92f09c3a`, the build of commit `8bb831b`.
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
12. **The metadata names the treasury as a fixed address** (`metadata/sniper-tax.devnet.json`, for `launch` and `sweep_protocol_fees`). If the admin moves the treasury, update the metadata too. Otherwise `launch` from a terminal fails with `WrongTreasury`. Until 10 November it still named the old treasury `HcQgs…`.

## Devnet

| | |
|---|---|
| Program | `EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b` (registered with the Pipeline router) |
| Upgrade authority, config admin and treasury | `DEwdbWGmGf6vdtRMkBXez2zJ71JbAaJ1DdD1s3bN8tYn` (the owner's wallet; 7.48 devnet SOL on 10 November) |
| Version on devnet | sha256 `222ee769…` (slot 520494490). The new version `9f24dafa…` awaits the upgrade |
| Config | `6wCct5q2tQ2WGfbtLcEzaH756aGnkMuSnnexaHmquL93`: 10% tax share, 0.01 SOL launch fee. The 64 reserved bytes are 0, so after the upgrade there is no proposed admin |
| Demo pool | `GeajhDYc24MyRecNv1a69nSsa2kdUtwbhLec6xpqVG3B` |

**Deploying a new version.** Upgrading at the same address needs the owner's wallet, and that key is never in a cloud session. The owner therefore does the upgrade locally (choice 4a). On Windows, use WSL.

1. Tools, once:

   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust; the repo picks its version
   sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"    # Solana CLI; then open a new terminal
   cargo install cargo-build-sbf --version 4.6.0 --locked
   solana-keygen pubkey <path-to-wallet.json>                       # must print DEwdb…N8tYn
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

After the upgrade nothing else is needed on-chain: the pool and config layouts are unchanged, and existing pools keep working. A new session can also deploy the program to a new address; then change the three places from pitfall 2.

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

1. **Upgrade on devnet** by the owner (see "Devnet"). Then record the version on devnet.
2. **Phase 6:** the self-review is in [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md). H1, H2, L1, L2, I1 and I2 are fixed. Still open: M1 and M2 (operational), L3 (display extensions) and the residual risk of a hook on the quote mint. After that, an external audit.
3. **Before mainnet:**
   - a dedicated program keypair;
   - the treasury and the config admin on a multisig, for example Squads;
   - decide whether to freeze the upgrade authority.
