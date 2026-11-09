//! Token-2022 transfer hooks: every transfer the program makes must forward the hook's
//! extra accounts. The test hook counts the transfers of its mint in its one extra
//! account, so each step checks exactly how many hooked transfers ran.

use sniper_tax_tests::*;

/// Sends `ix` with `hooks` appended as remaining accounts.
fn with_hooks(mut ix: Instruction, hooks: &[AccountMeta]) -> Instruction {
    ix.accounts.extend_from_slice(hooks);
    ix
}

#[test]
fn a_hooked_launch_token_launches_and_trades_both_ways() {
    let mut env = Env::new();
    let hook = env.load_test_hook();
    let (pool, created) = env.create_pool(PoolOptions {
        token_program: client::TOKEN_2022_PROGRAM_ID,
        token_transfer_hook: Some(hook),
        ..PoolOptions::default()
    });
    created.expect("create_market");
    let hooks = test_hook::accounts(&pool.token_mint);
    let creator = pool.creator.insecure_clone();
    let launch = pool.launch_ix(
        &creator.pubkey(),
        &env.treasury,
        pool.options.token_amount,
        pool.options.quote_amount,
    );

    // Without the hook's accounts the token transfer can't run.
    assert!(env
        .send(std::slice::from_ref(&launch), &[&creator])
        .is_err());
    env.send(&[with_hooks(launch, &hooks)], &[&creator])
        .expect("launch");
    assert_eq!(env.hook_count(&pool.token_mint), 1);
    env.assert_solvent(&pool);

    // A buy pays out the hooked token: its hook accounts go after the output vault.
    let buyer = env.buyer(&pool, 5 * SOL);
    let quote = env
        .quote(
            &pool,
            Side::Buy,
            TradeMode::ExactIn,
            SOL,
            Some(buyer.pubkey()),
        )
        .unwrap();
    let args = exact_in(SOL, quote.amount_out);
    let before = env.pool_state(&pool);
    let bare = pool.swap_ix(&buyer.pubkey(), Side::Buy, &args);
    assert!(env.send(&[bare], &[&buyer]).is_err());
    assert_eq!(env.pool_state(&pool), before);
    let ix = pool.swap_ix_with_hooks(&buyer.pubkey(), Side::Buy, &args, hooks.clone(), vec![]);
    env.send(&[ix], &[&buyer]).expect("buy");
    let tokens = env.token_balance(&env.token_account(&pool, &buyer.pubkey()));
    assert_eq!(tokens, quote.amount_out);
    assert_eq!(env.hook_count(&pool.token_mint), 2);

    // An exact-in sell: the router sends the token in and takes its fee in it (two hooked
    // transfers); the program pays out SOL.
    let selling = tokens / 4;
    let ix = pool.swap_ix_with_hooks(
        &buyer.pubkey(),
        Side::Sell,
        &exact_in(selling, 1),
        vec![],
        hooks.clone(),
    );
    env.send(&[ix], &[&buyer]).expect("sell");
    assert_eq!(env.hook_count(&pool.token_mint), 4);

    // An exact-out sell: the program also refunds the unused tokens, through the hook.
    let want = SOL / 1_000;
    let quote = env
        .quote(&pool, Side::Sell, TradeMode::ExactOut, want, None)
        .unwrap();
    let account = env.token_account(&pool, &buyer.pubkey());
    let held = env.token_balance(&account);
    let ix = pool.swap_ix_with_hooks(
        &buyer.pubkey(),
        Side::Sell,
        &exact_out(quote.amount_in * 2, want),
        vec![],
        hooks.clone(),
    );
    env.send(&[ix], &[&buyer]).expect("exact-out sell");
    assert_eq!(env.hook_count(&pool.token_mint), 7);
    assert_eq!(
        held - env.token_balance(&account),
        quote.amount_in + ceil_bps(quote.amount_in, 25)
    );
    env.assert_solvent(&pool);
}

#[test]
fn a_hooked_quote_mint_works_for_buys_refunds_claims_and_sweeps() {
    let mut env = Env::new();
    let hook = env.load_test_hook();
    let (pool, created) = env.create_pool(PoolOptions {
        custom_quote: Some(None),
        quote_transfer_hook: Some(hook),
        ..PoolOptions::default()
    });
    created.expect("create_market");
    let hooks = test_hook::accounts(&pool.quote_mint);
    let creator = pool.creator.insecure_clone();
    let launch = pool.launch_ix(
        &creator.pubkey(),
        &env.treasury,
        pool.options.token_amount,
        pool.options.quote_amount,
    );
    env.send(&[with_hooks(launch, &hooks)], &[&creator])
        .expect("launch");
    assert_eq!(env.hook_count(&pool.quote_mint), 1);

    // A taxed exact-out buy: the router sends the maximum in, the program refunds the
    // rest, the router takes its fee. Three hooked transfers.
    let buyer = env.buyer(&pool, 50 * SOL);
    let want = 1_000_000_000;
    let quote = env
        .quote(&pool, Side::Buy, TradeMode::ExactOut, want, None)
        .unwrap();
    let ix = pool.swap_ix_with_hooks(
        &buyer.pubkey(),
        Side::Buy,
        &exact_out(quote.amount_in * 2, want),
        vec![],
        hooks.clone(),
    );
    env.send(&[ix], &[&buyer]).expect("buy");
    assert_eq!(env.hook_count(&pool.quote_mint), 4);
    assert_eq!(
        env.token_balance(&env.token_account(&pool, &buyer.pubkey())),
        want
    );
    let state = env.pool_state(&pool);
    assert!(state.accrued_tax_quote > 0 && state.accrued_protocol_quote > 0);

    // The creator's claim needs the hook's accounts too.
    let claim = pool.claim_tax_ix(&creator.pubkey(), &pool.creator_quote);
    assert!(env.send(std::slice::from_ref(&claim), &[&creator]).is_err());
    let before = env.token_balance(&pool.creator_quote);
    env.send(&[with_hooks(claim, &hooks)], &[&creator])
        .expect("claim");
    assert_eq!(
        env.token_balance(&pool.creator_quote) - before,
        state.accrued_tax_quote
    );
    assert_eq!(env.hook_count(&pool.quote_mint), 5);

    // And so does the sweep to the treasury.
    let treasury = env.treasury;
    let treasury_quote = env.create_ata(&treasury, &pool.quote_mint, &pool.quote_program);
    let sweep = pool.sweep_ix(&treasury, &treasury_quote);
    env.send(&[with_hooks(sweep, &hooks)], &[]).expect("sweep");
    assert_eq!(
        env.token_balance(&treasury_quote),
        state.accrued_protocol_quote
    );
    assert_eq!(env.hook_count(&pool.quote_mint), 6);
    env.assert_solvent(&pool);
}
