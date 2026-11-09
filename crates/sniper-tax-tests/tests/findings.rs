//! Findings of the security review (docs/SECURITY-REVIEW.md), shown against the deployed
//! program. Each test pins today's behaviour; when a finding is fixed, its test flips to
//! assert the fix.

use sniper_tax_tests::*;
use spl_token_2022_interface::extension::transfer_fee::instruction::set_transfer_fee;

/// Finding H1: a launch token may keep its transfer-fee authority. The creator can launch
/// with no fee and raise it to 100% later (it takes effect two epochs on), after which
/// every sell delivers nothing: a honeypot.
#[test]
fn finding_h1_a_kept_fee_authority_can_trap_sellers() {
    let mut env = Env::new();
    // A 0% fee whose authority (the admin, who also created the mint) is kept.
    let pool = env.launched_pool(PoolOptions {
        token: MintSpec::token_2022(6).with_transfer_fee(0, u64::MAX),
        ..PoolOptions::default()
    });
    env.set_time(LAUNCH_TS + 1_000);
    let buyer = env.buyer(&pool, 5 * SOL);
    env.swap(&pool, &buyer, Side::Buy, exact_in(SOL, 1))
        .expect("buy");
    let tokens = env.token_balance(&env.token_account(&pool, &buyer.pubkey()));
    assert!(tokens > 0);

    // The fee authority raises the fee to 100%; Token-2022 applies it two epochs later.
    let admin = env.admin.pubkey();
    let ix = set_transfer_fee(
        &router::TOKEN_2022_PROGRAM_ID,
        &pool.token_mint,
        &admin,
        &[],
        10_000,
        u64::MAX,
    )
    .unwrap();
    env.send(&[ix], &[]).expect("raise the fee");
    let mut clock = env.svm.get_sysvar::<solana_clock::Clock>();
    clock.epoch += 2;
    env.svm.set_sysvar::<solana_clock::Clock>(&clock);

    // Now a sell with any minimum fails, and one without a minimum takes the tokens and
    // pays nothing.
    let quote_account = env.quote_account(&pool, &buyer.pubkey());
    let before = env.token_balance(&quote_account);
    assert!(env
        .swap(&pool, &buyer, Side::Sell, exact_in(tokens / 2, 1))
        .is_err());
    env.swap(&pool, &buyer, Side::Sell, exact_in(tokens / 2, 0))
        .expect("a sell with no minimum goes through");
    assert_eq!(env.token_balance(&quote_account), before);
    assert_eq!(
        env.token_balance(&env.token_account(&pool, &buyer.pubkey())),
        tokens - tokens / 2 - ceil_bps(tokens / 2, 25)
    );
}
