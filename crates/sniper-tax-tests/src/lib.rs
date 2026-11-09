//! LiteSVM harness: the sniper-tax program against the real Pipeline router.
//!
//! The router is the exact binary live on devnet (`scripts/fetch-pipeline-router.sh`
//! downloads it into `fixtures/pipeline.so`); the program comes from
//! `programs/target/deploy` (`cd programs && cargo build-sbf`). Router instructions are
//! built with Pipeline's own client; this program's instructions are encoded by hand, as
//! any client would, so the tests also pin its wire format.
//!
//! Adapted in part from Pipeline's LiteSVM harness (`crates/pipeline-tests/tests/common/mod.rs`
//! in MetalLegBob/pipeline, Apache-2.0): the native-mint and upgrade-authority helpers, mint
//! and token-account setup, the transaction-size check and `assert_fails_with`.

#![allow(clippy::result_large_err)]

use std::path::PathBuf;

use borsh::{BorshDeserialize, BorshSerialize};
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
pub use pipeline_client::{self as client, pda, pubkey, AccountMeta, Instruction, Pubkey};
pub use pipeline_strategy_interface::{self as psi, TradeMode};
use solana_clock::Clock;
pub use solana_keypair::Keypair;
pub use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_2022_interface::extension::ExtensionType;
use spl_token_2022_interface::instruction::AuthorityType;

pub use sniper_tax_math::Side;

pub const PROGRAM_ID: Pubkey = pubkey!("EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b");
pub const SOL: u64 = 1_000_000_000;
pub const ROUTER_LISTING_FEE: u64 = 10_000_000;
pub const LAUNCH_FEE: u64 = 10_000_000;
pub const PROTOCOL_SHARE_BPS: u16 = 1_000;
/// The clock at launch in every test.
pub const LAUNCH_TS: i64 = 1_800_000_000;
/// Solana's packet limit for a serialised transaction.
pub const MAX_TRANSACTION_SIZE: usize = 1_232;

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

// ---------------------------------------------------------------------------------------
// Program types, mirrored for clients
// ---------------------------------------------------------------------------------------

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitParams {
    pub creator: Pubkey,
    pub tax_start_bps: u16,
    pub tax_end_bps: u16,
    pub tax_duration_secs: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigArgs {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_tax_share_bps: u16,
    pub launch_fee_lamports: u64,
}

#[derive(BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolStatus {
    Pending,
    Live,
}

#[derive(BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct LaunchPool {
    pub version: u8,
    pub status: PoolStatus,
    pub bump: u8,
    pub creator: Pubkey,
    pub token_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub token_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub market_signer: Pubkey,
    pub reserve_token: u64,
    pub reserve_quote: u64,
    pub accrued_tax_quote: u64,
    pub accrued_protocol_quote: u64,
    pub tax_start_bps: u16,
    pub tax_end_bps: u16,
    pub tax_duration_secs: u32,
    pub protocol_tax_share_bps: u16,
    pub launch_fee_lamports: u64,
    pub launch_ts: i64,
    pub reserved: [u8; 64],
}

#[derive(BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_tax_share_bps: u16,
    pub launch_fee_lamports: u64,
    pub bump: u8,
    pub reserved: [u8; 64],
}

pub fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &PROGRAM_ID).0
}

pub fn pool_address(token_mint: &Pubkey, quote_mint: &Pubkey, params: &InitParams) -> Pubkey {
    let encoded = borsh::to_vec(params).unwrap();
    Pubkey::find_program_address(
        &[
            b"launch",
            token_mint.as_ref(),
            quote_mint.as_ref(),
            &encoded[..32],
            &encoded[32..40],
        ],
        &PROGRAM_ID,
    )
    .0
}

/// An instruction for this program: Anchor discriminator plus Borsh arguments.
pub fn program_ix(
    name: &str,
    args: &impl BorshSerialize,
    accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut data = client::instruction_discriminator(name).to_vec();
    args.serialize(&mut data).unwrap();
    Instruction::new_with_bytes(PROGRAM_ID, &data, accounts)
}

pub fn initialize_config_ix(authority: &Pubkey, args: &ConfigArgs) -> Instruction {
    program_ix(
        "initialize_config",
        args,
        vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new(config_address(), false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
            AccountMeta::new_readonly(pda::program_data(&PROGRAM_ID), false),
            AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
        ],
    )
}

pub fn update_config_ix(admin: &Pubkey, args: &ConfigArgs) -> Instruction {
    program_ix(
        "update_config",
        args,
        vec![
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new(config_address(), false),
        ],
    )
}

// ---------------------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------------------

/// How to create a launch pool in a test.
#[derive(Clone, Debug)]
pub struct PoolOptions {
    pub token_program: Pubkey,
    /// Token-2022 transfer fee on the launch token: `(bps, maximum)`.
    pub token_transfer_fee: Option<(u16, u64)>,
    pub token_permanent_delegate: bool,
    pub token_freeze_authority: bool,
    pub revoke_mint_authority: bool,
    /// Token-2022 transfer hook on the launch token (the test hook's program ID).
    pub token_transfer_hook: Option<Pubkey>,
    /// `None` uses wrapped SOL. `Some(fee)` uses a new Token-2022 quote mint, with a
    /// transfer fee if `fee` is set.
    pub custom_quote: Option<Option<(u16, u64)>>,
    /// Token-2022 transfer hook on a custom quote mint.
    pub quote_transfer_hook: Option<Pubkey>,
    pub tax_start_bps: u16,
    pub tax_end_bps: u16,
    pub tax_duration_secs: u32,
    pub token_amount: u64,
    pub quote_amount: u64,
}

impl Default for PoolOptions {
    fn default() -> Self {
        Self {
            token_program: client::TOKEN_PROGRAM_ID,
            token_transfer_fee: None,
            token_permanent_delegate: false,
            token_freeze_authority: false,
            revoke_mint_authority: true,
            token_transfer_hook: None,
            custom_quote: None,
            quote_transfer_hook: None,
            tax_start_bps: 9_900,
            tax_end_bps: 0,
            tax_duration_secs: 90,
            token_amount: 800_000_000_000_000,
            quote_amount: 5 * SOL,
        }
    }
}

pub struct Pool {
    pub address: Pubkey,
    pub market: Pubkey,
    pub creator: Keypair,
    pub params: InitParams,
    pub token_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub token_program: Pubkey,
    pub quote_program: Pubkey,
    pub token_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub creator_token: Pubkey,
    pub creator_quote: Pubkey,
    pub options: PoolOptions,
}

/// One side of a trade: `(input mint, output mint, input program, output program,
/// input vault, output vault)`.
pub struct Legs {
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub input_program: Pubkey,
    pub output_program: Pubkey,
    pub input_vault: Pubkey,
    pub output_vault: Pubkey,
    pub input_index: u8,
    pub output_index: u8,
}

impl Pool {
    pub fn legs(&self, side: Side) -> Legs {
        match side {
            Side::Buy => Legs {
                input_mint: self.quote_mint,
                output_mint: self.token_mint,
                input_program: self.quote_program,
                output_program: self.token_program,
                input_vault: self.quote_vault,
                output_vault: self.token_vault,
                input_index: 1,
                output_index: 0,
            },
            Side::Sell => Legs {
                input_mint: self.token_mint,
                output_mint: self.quote_mint,
                input_program: self.token_program,
                output_program: self.quote_program,
                input_vault: self.token_vault,
                output_vault: self.quote_vault,
                input_index: 0,
                output_index: 1,
            },
        }
    }

    pub fn create_market_ix(&self, payer: &Pubkey) -> Instruction {
        client::create_market(&client::CreateMarket {
            creator: *payer,
            strategy_program: PROGRAM_ID,
            market_state: self.address,
            market_state_signs: false,
            init_data: borsh::to_vec(&self.params).unwrap(),
            max_creator_lamports: SOL,
            strategy_accounts: vec![
                AccountMeta::new_readonly(self.token_mint, false),
                AccountMeta::new_readonly(self.quote_mint, false),
                AccountMeta::new(self.token_vault, false),
                AccountMeta::new(self.quote_vault, false),
                AccountMeta::new_readonly(self.token_program, false),
                AccountMeta::new_readonly(self.quote_program, false),
                AccountMeta::new_readonly(client::ASSOCIATED_TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(config_address(), false),
            ],
        })
    }

    pub fn fee_account_ixs(&self, payer: &Pubkey) -> [Instruction; 2] {
        [
            client::init_fee_account(payer, &self.market, &self.token_mint, &self.token_program),
            client::init_fee_account(payer, &self.market, &self.quote_mint, &self.quote_program),
        ]
    }

    pub fn launch_ix(
        &self,
        creator: &Pubkey,
        treasury: &Pubkey,
        amount_token: u64,
        amount_quote: u64,
    ) -> Instruction {
        program_ix(
            "launch",
            &(amount_token, amount_quote),
            vec![
                AccountMeta::new(*creator, true),
                AccountMeta::new(self.address, false),
                AccountMeta::new_readonly(self.token_mint, false),
                AccountMeta::new_readonly(self.quote_mint, false),
                AccountMeta::new(
                    pda::associated_token(creator, &self.token_mint, &self.token_program),
                    false,
                ),
                AccountMeta::new(
                    pda::associated_token(creator, &self.quote_mint, &self.quote_program),
                    false,
                ),
                AccountMeta::new(self.token_vault, false),
                AccountMeta::new(self.quote_vault, false),
                AccountMeta::new_readonly(self.token_program, false),
                AccountMeta::new_readonly(self.quote_program, false),
                AccountMeta::new_readonly(config_address(), false),
                AccountMeta::new(*treasury, false),
                AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            ],
        )
    }

    pub fn claim_tax_ix(&self, signer: &Pubkey, destination: &Pubkey) -> Instruction {
        program_ix(
            "claim_tax",
            &(),
            vec![
                AccountMeta::new_readonly(*signer, true),
                AccountMeta::new(self.address, false),
                AccountMeta::new_readonly(self.quote_mint, false),
                AccountMeta::new(self.quote_vault, false),
                AccountMeta::new(*destination, false),
                AccountMeta::new_readonly(self.quote_program, false),
            ],
        )
    }

    pub fn sweep_ix(&self, treasury: &Pubkey, destination: &Pubkey) -> Instruction {
        program_ix(
            "sweep_protocol_fees",
            &(),
            vec![
                AccountMeta::new(self.address, false),
                AccountMeta::new_readonly(config_address(), false),
                AccountMeta::new_readonly(self.quote_mint, false),
                AccountMeta::new(self.quote_vault, false),
                AccountMeta::new_readonly(*treasury, false),
                AccountMeta::new(*destination, false),
                AccountMeta::new_readonly(self.quote_program, false),
            ],
        )
    }

    /// The ten fixed trade accounts and the output vault, as the router passes them.
    pub fn trade_accounts(
        &self,
        side: Side,
        market_signer: Pubkey,
        trader: &Pubkey,
        signer: bool,
    ) -> Vec<AccountMeta> {
        let legs = self.legs(side);
        vec![
            AccountMeta::new_readonly(market_signer, signer),
            AccountMeta::new(self.address, false),
            AccountMeta::new_readonly(*trader, false),
            AccountMeta::new(
                pda::associated_token(trader, &legs.input_mint, &legs.input_program),
                false,
            ),
            AccountMeta::new(
                pda::associated_token(trader, &legs.output_mint, &legs.output_program),
                false,
            ),
            AccountMeta::new(legs.input_vault, false),
            AccountMeta::new_readonly(legs.input_mint, false),
            AccountMeta::new_readonly(legs.output_mint, false),
            AccountMeta::new_readonly(legs.input_program, false),
            AccountMeta::new_readonly(legs.output_program, false),
            AccountMeta::new(legs.output_vault, false),
        ]
    }

    /// A swap through the router, from and to `trader`'s associated token accounts.
    pub fn swap_ix(&self, trader: &Pubkey, side: Side, args: &client::SwapArgs) -> Instruction {
        self.swap_ix_with_hooks(trader, side, args, vec![], vec![])
    }

    /// A swap with transfer-hook accounts: the output mint's go after the strategy's own
    /// accounts, the input mint's are the router's `input_hook_accounts`.
    pub fn swap_ix_with_hooks(
        &self,
        trader: &Pubkey,
        side: Side,
        args: &client::SwapArgs,
        output_hooks: Vec<AccountMeta>,
        input_hooks: Vec<AccountMeta>,
    ) -> Instruction {
        let legs = self.legs(side);
        let mut strategy_accounts = vec![AccountMeta::new(legs.output_vault, false)];
        strategy_accounts.extend(output_hooks);
        let accounts = client::SwapAccounts {
            trader: *trader,
            strategy_program: PROGRAM_ID,
            market_state: self.address,
            trader_input: pda::associated_token(trader, &legs.input_mint, &legs.input_program),
            trader_output: pda::associated_token(trader, &legs.output_mint, &legs.output_program),
            input_vault: legs.input_vault,
            input_mint: legs.input_mint,
            output_mint: legs.output_mint,
            input_token_program: legs.input_program,
            output_token_program: legs.output_program,
            integrator_fee_account: None,
            strategy_accounts,
            input_hook_accounts: input_hooks,
        };
        client::swap(&accounts, args)
    }

    /// `pipeline_quote`, for simulation. Only the market signer and the pool are read;
    /// the other fixed accounts are placeholders.
    pub fn quote_ix(
        &self,
        side: Side,
        mode: TradeMode,
        amount: u64,
        trader: Option<Pubkey>,
    ) -> Instruction {
        let legs = self.legs(side);
        let request = psi::TradeRequest {
            mode,
            input_index: legs.input_index,
            output_index: legs.output_index,
            amount,
            trader: trader.map(|t| t.to_bytes()),
            extra: vec![],
        };
        let mut accounts = vec![
            AccountMeta::new_readonly(self.market, false),
            AccountMeta::new_readonly(self.address, false),
        ];
        accounts.extend(std::iter::repeat_n(
            AccountMeta::new_readonly(Pubkey::default(), false),
            8,
        ));
        program_ix("pipeline_quote", &request, accounts)
    }
}

pub fn exact_in(amount_in: u64, min_amount_out: u64) -> client::SwapArgs {
    client::SwapArgs {
        mode: TradeMode::ExactIn,
        amount_in,
        amount_out: 0,
        min_amount_out,
        integrator_fee_bps: 0,
        input_hook_accounts: 0,
        extra: vec![],
    }
}

pub fn exact_out(max_amount_in: u64, amount_out: u64) -> client::SwapArgs {
    client::SwapArgs {
        mode: TradeMode::ExactOut,
        amount_in: max_amount_in,
        amount_out,
        min_amount_out: amount_out,
        integrator_fee_bps: 0,
        input_hook_accounts: 0,
        extra: vec![],
    }
}

// ---------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------

pub struct Env {
    pub svm: LiteSVM,
    /// Pays for everything; upgrade authority of the router and of this program; admin
    /// of both configs.
    pub admin: Keypair,
    /// Receives launch fees and owns the accounts protocol tax is swept to.
    pub treasury: Pubkey,
    pub router_fee_recipient: Pubkey,
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

impl Env {
    /// Router and program deployed, both configs initialised, program registered.
    pub fn new() -> Self {
        let mut env = Self::without_protocol_config();
        let args = env.default_config();
        let ix = initialize_config_ix(&env.admin.pubkey(), &args);
        env.send(&[ix], &[]).expect("initialize_config");
        env
    }

    /// Like [`Env::new`], without this program's config.
    pub fn without_protocol_config() -> Self {
        let mut svm = LiteSVM::new();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000 * SOL).unwrap();
        svm.add_program_from_file(client::PROGRAM_ID, repo_root().join("fixtures/pipeline.so"))
            .expect("router binary: run scripts/fetch-pipeline-router.sh");
        set_upgrade_authority(&mut svm, &client::PROGRAM_ID, Some(&admin.pubkey()));
        svm.add_program_from_file(
            PROGRAM_ID,
            repo_root().join("programs/target/deploy/sniper_tax.so"),
        )
        .expect("program binary: cd programs && cargo build-sbf");
        set_upgrade_authority(&mut svm, &PROGRAM_ID, Some(&admin.pubkey()));
        add_native_mint(&mut svm);

        let mut env = Env {
            svm,
            admin,
            treasury: Pubkey::new_unique(),
            router_fee_recipient: Pubkey::new_unique(),
        };
        env.set_time(LAUNCH_TS - 60);
        let ix = client::initialize_config(
            &env.admin.pubkey(),
            &client::ConfigArgs {
                listing_fee_lamports: ROUTER_LISTING_FEE,
                listing_fee_recipient: env.router_fee_recipient,
                treasury_owner: Pubkey::new_unique(),
            },
        );
        env.send(&[ix], &[]).expect("router initialize_config");
        let admin = env.admin.pubkey();
        let ix = client::register_strategy(
            &admin,
            &admin,
            &PROGRAM_ID,
            &env.router_fee_recipient,
            "https://example.com/sniper-tax.json",
            u64::MAX,
        );
        env.send(&[ix], &[]).expect("register_strategy");
        env
    }

    pub fn default_config(&self) -> ConfigArgs {
        ConfigArgs {
            admin: self.admin.pubkey(),
            treasury: self.treasury,
            protocol_tax_share_bps: PROTOCOL_SHARE_BPS,
            launch_fee_lamports: LAUNCH_FEE,
        }
    }

    // ------------------------------------------------------------------ transactions

    /// Sends a transaction paid for by the admin, with extra signers. Asserts it fits in
    /// a real transaction.
    pub fn send(&mut self, instructions: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let tx = self.transaction(instructions, signers);
        let size = bincode::serialize(&tx)
            .map(|b| b.len())
            .unwrap_or(usize::MAX);
        assert!(
            size <= MAX_TRANSACTION_SIZE,
            "transaction is {size} bytes, over Solana's {MAX_TRANSACTION_SIZE}-byte limit"
        );
        self.svm.send_transaction(tx)
    }

    fn transaction(&mut self, instructions: &[Instruction], signers: &[&Keypair]) -> Transaction {
        self.svm.expire_blockhash();
        let mut all: Vec<&Keypair> = vec![&self.admin];
        all.extend_from_slice(signers);
        Transaction::new_signed_with_payer(
            instructions,
            Some(&self.admin.pubkey()),
            &all,
            self.svm.latest_blockhash(),
        )
    }

    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        clock.slot += 1;
        self.svm.set_sysvar::<Clock>(&clock);
    }

    pub fn funded_keypair(&mut self) -> Keypair {
        let keypair = Keypair::new();
        self.svm.airdrop(&keypair.pubkey(), 100 * SOL).unwrap();
        keypair
    }

    // ------------------------------------------------------------------ reading

    pub fn account_data(&self, address: &Pubkey) -> Vec<u8> {
        self.svm
            .get_account(address)
            .map(|a| a.data)
            .unwrap_or_default()
    }

    pub fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm
            .get_account(address)
            .map(|a| a.lamports)
            .unwrap_or(0)
    }

    pub fn token_balance(&self, account: &Pubkey) -> u64 {
        let data = self.account_data(account);
        if data.len() < 72 {
            return 0;
        }
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }

    pub fn pool_state(&self, pool: &Pool) -> LaunchPool {
        client::decode_account("LaunchPool", &self.account_data(&pool.address))
            .expect("pool account")
    }

    pub fn config_state(&self) -> ProtocolConfig {
        client::decode_account("ProtocolConfig", &self.account_data(&config_address()))
            .expect("config account")
    }

    /// The vaults hold at least what the pool's books say: reserves plus unclaimed tax.
    pub fn assert_solvent(&self, pool: &Pool) {
        let state = self.pool_state(pool);
        assert!(self.token_balance(&pool.token_vault) >= state.reserve_token);
        assert!(
            u128::from(self.token_balance(&pool.quote_vault))
                >= u128::from(state.reserve_quote)
                    + u128::from(state.accrued_tax_quote)
                    + u128::from(state.accrued_protocol_quote)
        );
    }

    // ------------------------------------------------------------------ tokens

    /// Creates a mint whose mint authority is the admin.
    pub fn create_mint(
        &mut self,
        token_program: &Pubkey,
        decimals: u8,
        transfer_fee: Option<(u16, u64)>,
        permanent_delegate: bool,
        freeze_authority: bool,
        transfer_hook: Option<Pubkey>,
    ) -> Pubkey {
        let mint = Keypair::new();
        let mut extensions = vec![];
        if transfer_hook.is_some() {
            extensions.push(ExtensionType::TransferHook);
        }
        if transfer_fee.is_some() {
            extensions.push(ExtensionType::TransferFeeConfig);
        }
        if permanent_delegate {
            extensions.push(ExtensionType::PermanentDelegate);
        }
        let space = if *token_program == client::TOKEN_PROGRAM_ID {
            82
        } else {
            ExtensionType::try_calculate_account_len::<spl_token_2022_interface::state::Mint>(
                &extensions,
            )
            .unwrap()
        };
        let rent = self.svm.minimum_balance_for_rent_exemption(space);
        let authority = self.admin.pubkey();
        let mut ixs = vec![solana_system_interface::instruction::create_account(
            &authority,
            &mint.pubkey(),
            rent,
            space as u64,
            token_program,
        )];
        if let Some((bps, max)) = transfer_fee {
            ixs.push(
                spl_token_2022_interface::extension::transfer_fee::instruction::initialize_transfer_fee_config(
                    token_program,
                    &mint.pubkey(),
                    Some(&authority),
                    Some(&authority),
                    bps,
                    max,
                )
                .unwrap(),
            );
        }
        if let Some(hook) = transfer_hook {
            ixs.push(
                spl_token_2022_interface::extension::transfer_hook::instruction::initialize(
                    token_program,
                    &mint.pubkey(),
                    None,
                    Some(hook),
                )
                .unwrap(),
            );
        }
        if permanent_delegate {
            ixs.push(
                spl_token_2022_interface::instruction::initialize_permanent_delegate(
                    token_program,
                    &mint.pubkey(),
                    &authority,
                )
                .unwrap(),
            );
        }
        ixs.push(
            spl_token_2022_interface::instruction::initialize_mint2(
                token_program,
                &mint.pubkey(),
                &authority,
                freeze_authority.then_some(&authority),
                decimals,
            )
            .unwrap(),
        );
        self.send(&ixs, &[&mint]).expect("create mint");
        if let Some(hook) = transfer_hook {
            let ix = test_hook::initialize_ix(&hook, &self.admin.pubkey(), &mint.pubkey());
            self.send(&[ix], &[]).expect("initialize the test hook");
        }
        mint.pubkey()
    }

    /// Loads the test transfer hook (`test-programs/test-hook`) and returns its ID.
    pub fn load_test_hook(&mut self) -> Pubkey {
        if self.svm.get_account(&test_hook::ID).is_none() {
            self.svm
                .add_program_from_file(
                    test_hook::ID,
                    repo_root().join("test-programs/target/deploy/test_hook.so"),
                )
                .expect("test hook binary: cd test-programs && cargo build-sbf");
        }
        test_hook::ID
    }

    /// How many transfers of `mint` the test hook has seen.
    pub fn hook_count(&self, mint: &Pubkey) -> u64 {
        let data = self.account_data(&test_hook::counter(mint));
        u64::from_le_bytes(data[..8].try_into().expect("hook counter"))
    }

    /// Creates (idempotently) `owner`'s associated token account.
    pub fn create_ata(&mut self, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
        let ix = spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent(
            &self.admin.pubkey(),
            owner,
            mint,
            token_program,
        );
        self.send(&[ix], &[]).expect("create ata");
        pda::associated_token(owner, mint, token_program)
    }

    /// Mints `amount` into `account`, or wraps that many lamports for wrapped SOL.
    pub fn mint_to(
        &mut self,
        mint: &Pubkey,
        token_program: &Pubkey,
        account: &Pubkey,
        amount: u64,
    ) {
        let authority = self.admin.pubkey();
        if client::wallet::is_native(mint, token_program) {
            let ixs = [
                client::wallet::system_transfer(&authority, account, amount),
                client::wallet::sync_native(account),
            ];
            self.send(&ixs, &[]).expect("wrap SOL");
            return;
        }
        let ix = spl_token_2022_interface::instruction::mint_to(
            token_program,
            mint,
            account,
            &authority,
            &[],
            amount,
        )
        .unwrap();
        self.send(&[ix], &[]).expect("mint_to");
    }

    pub fn revoke_mint_authority(&mut self, mint: &Pubkey, token_program: &Pubkey) {
        let ix = spl_token_2022_interface::instruction::set_authority(
            token_program,
            mint,
            None,
            AuthorityType::MintTokens,
            &self.admin.pubkey(),
            &[],
        )
        .unwrap();
        self.send(&[ix], &[]).expect("revoke mint authority");
    }

    /// A new wallet holding `amount` of the pool's quote mint, with an empty token account.
    pub fn buyer(&mut self, pool: &Pool, amount: u64) -> Keypair {
        let trader = self.funded_keypair();
        let quote = self.create_ata(&trader.pubkey(), &pool.quote_mint, &pool.quote_program);
        self.mint_to(&pool.quote_mint, &pool.quote_program, &quote, amount);
        self.create_ata(&trader.pubkey(), &pool.token_mint, &pool.token_program);
        trader
    }

    pub fn quote_account(&self, pool: &Pool, owner: &Pubkey) -> Pubkey {
        pda::associated_token(owner, &pool.quote_mint, &pool.quote_program)
    }

    pub fn token_account(&self, pool: &Pool, owner: &Pubkey) -> Pubkey {
        pda::associated_token(owner, &pool.token_mint, &pool.token_program)
    }

    // ------------------------------------------------------------------ pools

    /// Creates the mints, funds the creator and works out the pool's addresses. Nothing
    /// is created on the router yet.
    pub fn prepare_pool(&mut self, options: PoolOptions) -> Pool {
        let creator = self.funded_keypair();
        let token_mint = self.create_mint(
            &options.token_program,
            6,
            options.token_transfer_fee,
            options.token_permanent_delegate,
            options.token_freeze_authority,
            options.token_transfer_hook,
        );
        let (quote_mint, quote_program) = match options.custom_quote {
            None => (client::wallet::NATIVE_MINT, client::TOKEN_PROGRAM_ID),
            Some(fee) => (
                self.create_mint(
                    &client::TOKEN_2022_PROGRAM_ID,
                    9,
                    fee,
                    false,
                    false,
                    options.quote_transfer_hook,
                ),
                client::TOKEN_2022_PROGRAM_ID,
            ),
        };
        let creator_token = self.create_ata(&creator.pubkey(), &token_mint, &options.token_program);
        // The creator keeps a tenth of the supply outside the pool.
        let supply = options.token_amount + options.token_amount / 10;
        self.mint_to(&token_mint, &options.token_program, &creator_token, supply);
        if options.revoke_mint_authority {
            self.revoke_mint_authority(&token_mint, &options.token_program);
        }
        let creator_quote = self.create_ata(&creator.pubkey(), &quote_mint, &quote_program);
        self.mint_to(
            &quote_mint,
            &quote_program,
            &creator_quote,
            options.quote_amount + 10 * SOL,
        );

        let params = InitParams {
            creator: creator.pubkey(),
            tax_start_bps: options.tax_start_bps,
            tax_end_bps: options.tax_end_bps,
            tax_duration_secs: options.tax_duration_secs,
        };
        let address = pool_address(&token_mint, &quote_mint, &params);
        Pool {
            address,
            market: pda::market(&PROGRAM_ID, &address),
            params,
            token_mint,
            quote_mint,
            token_program: options.token_program,
            quote_program,
            token_vault: pda::associated_token(&address, &token_mint, &options.token_program),
            quote_vault: pda::associated_token(&address, &quote_mint, &quote_program),
            creator_token,
            creator_quote,
            creator,
            options,
        }
    }

    /// `create_market` and both fee accounts, without launching.
    pub fn create_pool(&mut self, options: PoolOptions) -> (Pool, TxResult) {
        let pool = self.prepare_pool(options);
        let admin = self.admin.pubkey();
        let mut ixs = vec![pool.create_market_ix(&admin)];
        ixs.extend(pool.fee_account_ixs(&admin));
        let result = self.send(&ixs, &[]);
        (pool, result)
    }

    pub fn launch(&mut self, pool: &Pool) -> TxResult {
        let ix = pool.launch_ix(
            &pool.creator.pubkey(),
            &self.treasury,
            pool.options.token_amount,
            pool.options.quote_amount,
        );
        let creator = pool.creator.insecure_clone();
        self.send(&[ix], &[&creator])
    }

    /// A pool created and launched at `LAUNCH_TS`: `create_market`, both fee accounts and
    /// `launch` in one transaction, as a front-end would send them.
    pub fn launched_pool(&mut self, options: PoolOptions) -> Pool {
        let pool = self.prepare_pool(options);
        self.set_time(LAUNCH_TS);
        let creator = pool.creator.insecure_clone();
        let mut ixs = vec![pool.create_market_ix(&creator.pubkey())];
        ixs.extend(pool.fee_account_ixs(&creator.pubkey()));
        ixs.push(pool.launch_ix(
            &creator.pubkey(),
            &self.treasury,
            pool.options.token_amount,
            pool.options.quote_amount,
        ));
        self.send(&ixs, &[&creator])
            .expect("create and launch in one transaction");
        pool
    }

    // ------------------------------------------------------------------ trading

    pub fn swap(
        &mut self,
        pool: &Pool,
        trader: &Keypair,
        side: Side,
        args: client::SwapArgs,
    ) -> TxResult {
        let ix = pool.swap_ix(&trader.pubkey(), side, &args);
        let trader = trader.insecure_clone();
        self.send(&[ix], &[&trader])
    }

    /// Simulates `pipeline_quote`, as an SDK would.
    pub fn quote(
        &mut self,
        pool: &Pool,
        side: Side,
        mode: TradeMode,
        amount: u64,
        trader: Option<Pubkey>,
    ) -> Result<psi::QuoteResult, String> {
        self.simulate_quote(pool, side, mode, amount, trader)
            .map(|(quote, _)| quote)
    }

    /// Simulates `pipeline_quote` and also returns the compute units it used.
    pub fn simulate_quote(
        &mut self,
        pool: &Pool,
        side: Side,
        mode: TradeMode,
        amount: u64,
        trader: Option<Pubkey>,
    ) -> Result<(psi::QuoteResult, u64), String> {
        let ix = pool.quote_ix(side, mode, amount, trader);
        let tx = self.transaction(&[ix], &[]);
        match self.svm.simulate_transaction(tx) {
            Ok(info) => psi::QuoteResult::try_from_slice(&info.meta.return_data.data)
                .map(|quote| (quote, info.meta.compute_units_consumed))
                .map_err(|e| e.to_string()),
            Err(failed) => Err(failed.meta.logs.join("\n")),
        }
    }
}

/// Adds the wrapped-SOL mint as it exists on every cluster: SPL Token, 9 decimals, no
/// authorities.
fn add_native_mint(svm: &mut LiteSVM) {
    let mut data = vec![0u8; 82];
    data[44] = 9;
    data[45] = 1;
    let account = solana_account::Account {
        lamports: svm.minimum_balance_for_rent_exemption(82),
        data,
        owner: client::TOKEN_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    };
    svm.set_account(client::wallet::NATIVE_MINT, account)
        .expect("native mint");
}

/// Rewrites the upgrade authority in a loader-v3 program's ProgramData header.
pub fn set_upgrade_authority(svm: &mut LiteSVM, program: &Pubkey, authority: Option<&Pubkey>) {
    let program_data = pda::program_data(program);
    let mut account = svm.get_account(&program_data).expect("program data");
    match authority {
        Some(key) => {
            account.data[12] = 1;
            account.data[13..45].copy_from_slice(key.as_ref());
        }
        None => {
            account.data[12] = 0;
            account.data[13..45].fill(0);
        }
    }
    svm.set_account(program_data, account).unwrap();
}

/// Asserts a transaction failed and that its logs or error mention `needle`.
pub fn assert_fails_with(result: TxResult, needle: &str) {
    match result {
        Ok(meta) => panic!(
            "expected failure containing {needle:?}, but succeeded:\n{}",
            meta.logs.join("\n")
        ),
        Err(failed) => {
            let logs = failed.meta.logs.join("\n");
            assert!(
                logs.contains(needle) || format!("{:?}", failed.err).contains(needle),
                "expected failure containing {needle:?}, got {:?}:\n{logs}",
                failed.err
            );
        }
    }
}

/// `ceil(amount × bps / 10,000)`.
pub fn ceil_bps(amount: u64, bps: u16) -> u64 {
    (u128::from(amount) * u128::from(bps)).div_ceil(10_000) as u64
}

/// Addresses and instructions of the test transfer hook (`test-programs/test-hook`), which
/// counts every transfer of its mint in a counter account listed as its extra account.
pub mod test_hook {
    use super::*;

    pub const ID: Pubkey = Pubkey::new_from_array([0x7e; 32]);

    pub fn validation(mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &ID).0
    }

    pub fn counter(mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"counter", mint.as_ref()], &ID).0
    }

    pub fn initialize_ix(hook: &Pubkey, payer: &Pubkey, mint: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            *hook,
            b"cnthkini",
            vec![
                AccountMeta::new(*payer, true),
                AccountMeta::new(validation(mint), false),
                AccountMeta::new(counter(mint), false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
            ],
        )
    }

    /// The accounts Token-2022 needs to run the hook for `mint`.
    pub fn accounts(mint: &Pubkey) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(ID, false),
            AccountMeta::new_readonly(validation(mint), false),
            AccountMeta::new(counter(mint), false),
        ]
    }
}
