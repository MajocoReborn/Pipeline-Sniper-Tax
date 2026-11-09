//! Devnet helper for the sniper-tax program. It uses the same instruction builders as the
//! integration tests, and talks to the cluster through `curl`.
//!
//! The program must already be deployed (`solana program deploy`) with `KEYPAIR` as its
//! upgrade authority.
//!
//! ```sh
//! # Register with the Pipeline router and create the protocol config (once).
//! KEYPAIR=deployer.json TREASURY=<address> cargo run -p sniper-tax-devnet -- setup
//! # Launch a demo token, snipe it at launch, then claim and sweep the tax.
//! KEYPAIR=deployer.json cargo run -p sniper-tax-devnet -- demo [--wait]
//! # Hand the config to a new admin and treasury (signed by the current admin).
//! KEYPAIR=admin.json ADMIN=<address> TREASURY=<address> cargo run -p sniper-tax-devnet -- config
//! ```
//!
//! `RPC_URL` defaults to `https://api.devnet.solana.com`. `--wait` also buys again after
//! the 90-second tax window, to show the tax gone.

use std::process::Command;
use std::str::FromStr;
use std::thread::sleep;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use sniper_tax_tests::*;
use solana_hash::Hash;
use solana_transaction::Transaction;
use spl_token_2022_interface::instruction::AuthorityType;

const DEFAULT_RPC: &str = "https://api.devnet.solana.com";
const METADATA_URI: &str =
    "https://raw.githubusercontent.com/MajocoReborn/Pipeline-Sniper-Tax/main/metadata/sniper-tax.devnet.json";
/// Refuse to register if the router's listing fee is above this.
const MAX_LISTING_FEE: u64 = 20_000_000;

const TOKEN_DECIMALS: u8 = 6;
const TOKEN_SUPPLY: u64 = 1_000_000_000 * 1_000_000;
const POOL_TOKENS: u64 = 800_000_000 * 1_000_000;
const POOL_QUOTE: u64 = SOL / 5;
const SNIPE: u64 = SOL / 20;

type Result<T> = std::result::Result<T, String>;

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let rpc = Rpc {
        url: std::env::var("RPC_URL").unwrap_or_else(|_| DEFAULT_RPC.to_string()),
    };
    let keypair_path = std::env::var("KEYPAIR").map_err(|_| "set KEYPAIR".to_string())?;
    let payer = read_keypair(&keypair_path)?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("setup") => {
            let treasury = std::env::var("TREASURY").map_err(|_| "set TREASURY".to_string())?;
            let treasury = Pubkey::from_str(&treasury).map_err(|e| e.to_string())?;
            setup(&rpc, &payer, treasury)
        }
        Some("demo") => demo(&rpc, &payer, args.iter().any(|a| a == "--wait")),
        Some("config") => {
            let admin = wallet_from_env("ADMIN")?;
            let treasury = wallet_from_env("TREASURY")?;
            hand_over_config(&rpc, &payer, admin, treasury)
        }
        _ => Err("usage: sniper-tax-devnet setup | demo [--wait] | config".into()),
    }
}

fn read_keypair(path: &str) -> Result<Keypair> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let bytes: Vec<u8> = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    Keypair::try_from(bytes.as_slice()).map_err(|e| format!("{path}: {e}"))
}

fn explorer(signature: &str) -> String {
    format!("https://explorer.solana.com/tx/{signature}?cluster=devnet")
}

// ---------------------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------------------

fn setup(rpc: &Rpc, payer: &Keypair, treasury: Pubkey) -> Result<()> {
    let admin = payer.pubkey();
    println!("program   {PROGRAM_ID}");
    println!("authority {admin}");
    println!("treasury  {treasury}");
    rpc.account(&PROGRAM_ID)?
        .ok_or("the program is not deployed yet: run `solana program deploy` first")?;

    if rpc.account(&pda::strategy(&PROGRAM_ID))?.is_some() {
        println!("already registered with the Pipeline router");
    } else {
        let config = rpc
            .account(&pda::config())?
            .ok_or("the Pipeline router has no config on this cluster")?;
        let router = client::decode_config(&config.1).ok_or("unreadable router config")?;
        println!(
            "registering with the router (listing fee {} lamports)",
            router.listing_fee_lamports
        );
        let ix = client::register_strategy(
            &admin,
            &admin,
            &PROGRAM_ID,
            &router.listing_fee_recipient,
            METADATA_URI,
            MAX_LISTING_FEE,
        );
        let signature = rpc.send(&[ix], payer, &[])?;
        println!("registered: {}", explorer(&signature));
    }

    if rpc.account(&config_address())?.is_some() {
        println!("protocol config already exists");
    } else {
        let args = ConfigArgs {
            admin,
            treasury,
            protocol_tax_share_bps: PROTOCOL_SHARE_BPS,
            launch_fee_lamports: LAUNCH_FEE,
        };
        let signature = rpc.send(&[initialize_config_ix(&admin, &args)], payer, &[])?;
        println!("config created: {}", explorer(&signature));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------

/// An address from the environment that a wallet can sign for. A program address (off the
/// ed25519 curve) could never sign, so handing it control would lose that control for good.
fn wallet_from_env(name: &str) -> Result<Pubkey> {
    let value = std::env::var(name).map_err(|_| format!("set {name}"))?;
    let key = Pubkey::from_str(&value).map_err(|e| format!("{name}: {e}"))?;
    if !key.is_on_curve() {
        return Err(format!("{name} {key} is not a wallet address"));
    }
    Ok(key)
}

/// Moves the config's admin and treasury, keeping its fees.
fn hand_over_config(rpc: &Rpc, admin: &Keypair, new_admin: Pubkey, treasury: Pubkey) -> Result<()> {
    let account = rpc
        .account(&config_address())?
        .ok_or("no protocol config")?;
    let config: ProtocolConfig =
        client::decode_account("ProtocolConfig", &account.1).ok_or("unreadable config")?;
    let args = ConfigArgs {
        admin: new_admin,
        treasury,
        protocol_tax_share_bps: config.protocol_tax_share_bps,
        launch_fee_lamports: config.launch_fee_lamports,
    };
    let signature = rpc.send(&[update_config_ix(&admin.pubkey(), &args)], admin, &[])?;
    let account = rpc
        .account(&config_address())?
        .ok_or("no protocol config")?;
    let config: ProtocolConfig =
        client::decode_account("ProtocolConfig", &account.1).ok_or("unreadable config")?;
    if (config.admin, config.treasury) != (new_admin, treasury) {
        return Err("the config did not change".into());
    }
    println!(
        "config admin {new_admin}, treasury {treasury}: {}",
        explorer(&signature)
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------
// demo
// ---------------------------------------------------------------------------------------

fn demo(rpc: &Rpc, creator: &Keypair, wait: bool) -> Result<()> {
    let config = rpc
        .account(&config_address())?
        .ok_or("no protocol config: run `setup` first")?;
    let config: ProtocolConfig =
        client::decode_account("ProtocolConfig", &config.1).ok_or("unreadable config")?;
    let me = creator.pubkey();
    let token_program = client::TOKEN_PROGRAM_ID;
    let quote_mint = client::wallet::NATIVE_MINT;

    // A new launch token: full supply to the creator, then no more minting.
    let mint = Keypair::new();
    let creator_token = pda::associated_token(&me, &mint.pubkey(), &token_program);
    let creator_quote = pda::associated_token(&me, &quote_mint, &token_program);
    let mint_rent = rpc.rent(82)?;
    let ixs = vec![
        solana_system_interface::instruction::create_account(
            &me,
            &mint.pubkey(),
            mint_rent,
            82,
            &token_program,
        ),
        spl_token_2022_interface::instruction::initialize_mint2(
            &token_program,
            &mint.pubkey(),
            &me,
            None,
            TOKEN_DECIMALS,
        )
        .map_err(|e| e.to_string())?,
        ata_ix(&me, &me, &mint.pubkey(), &token_program),
        spl_token_2022_interface::instruction::mint_to(
            &token_program,
            &mint.pubkey(),
            &creator_token,
            &me,
            &[],
            TOKEN_SUPPLY,
        )
        .map_err(|e| e.to_string())?,
        spl_token_2022_interface::instruction::set_authority(
            &token_program,
            &mint.pubkey(),
            None,
            AuthorityType::MintTokens,
            &me,
            &[],
        )
        .map_err(|e| e.to_string())?,
        ata_ix(&me, &me, &quote_mint, &token_program),
        client::wallet::system_transfer(&me, &creator_quote, POOL_QUOTE),
        client::wallet::sync_native(&creator_quote),
    ];
    let signature = rpc.send(&ixs, creator, &[&mint])?;
    println!("token {} created: {}", mint.pubkey(), explorer(&signature));

    // Create the pool through Pipeline and launch it, in one transaction.
    let params = InitParams {
        creator: me,
        tax_start_bps: 9_900,
        tax_end_bps: 0,
        tax_duration_secs: 90,
    };
    let address = pool_address(&mint.pubkey(), &quote_mint, &params);
    let pool = Pool {
        address,
        market: pda::market(&PROGRAM_ID, &address),
        creator: creator.insecure_clone(),
        params,
        token_mint: mint.pubkey(),
        quote_mint,
        token_program,
        quote_program: token_program,
        token_vault: pda::associated_token(&address, &mint.pubkey(), &token_program),
        quote_vault: pda::associated_token(&address, &quote_mint, &token_program),
        creator_token,
        creator_quote,
        options: PoolOptions {
            token_amount: POOL_TOKENS,
            quote_amount: POOL_QUOTE,
            ..PoolOptions::default()
        },
    };
    let mut ixs = vec![pool.create_market_ix(&me)];
    ixs.extend(pool.fee_account_ixs(&me));
    ixs.push(pool.launch_ix(&me, &config.treasury, POOL_TOKENS, POOL_QUOTE));
    let signature = rpc.send(&ixs, creator, &[])?;
    println!(
        "pool {address} created and launched: {}",
        explorer(&signature)
    );

    // A sniper buys right after the launch.
    let sniper = Keypair::new();
    let sniper_quote = pda::associated_token(&sniper.pubkey(), &quote_mint, &token_program);
    let ixs = vec![
        client::wallet::system_transfer(&me, &sniper.pubkey(), SOL / 100),
        ata_ix(&me, &sniper.pubkey(), &quote_mint, &token_program),
        client::wallet::system_transfer(&me, &sniper_quote, SNIPE * 2),
        client::wallet::sync_native(&sniper_quote),
        ata_ix(&me, &sniper.pubkey(), &mint.pubkey(), &token_program),
    ];
    rpc.send(&ixs, creator, &[])?;
    let quoted = rpc.quote(&pool, creator, SNIPE, Some(sniper.pubkey()))?;
    let as_creator = rpc.quote(&pool, creator, SNIPE, Some(me))?;
    println!(
        "quote for {} lamports: sniper gets {} tokens, the creator would get {}",
        SNIPE, quoted.amount_out, as_creator.amount_out
    );
    let before = pool_state(rpc, &pool)?;
    let ix = pool.swap_ix(
        &sniper.pubkey(),
        Side::Buy,
        &exact_in(SNIPE, quoted.amount_out),
    );
    let signature = rpc.send(&[ix], creator, &[&sniper])?;
    let after = pool_state(rpc, &pool)?;
    let tax = (after.accrued_tax_quote - before.accrued_tax_quote)
        + (after.accrued_protocol_quote - before.accrued_protocol_quote);
    println!(
        "sniper bought: {} of {} lamports was tax ({:.1}%): {}",
        tax,
        SNIPE,
        tax as f64 * 100.0 / SNIPE as f64,
        explorer(&signature)
    );

    if wait {
        let launched = after.launch_ts;
        println!("waiting for the 90-second window to pass...");
        let deadline = Instant::now() + Duration::from_secs(150);
        while rpc.cluster_time()? < launched + 91 {
            if Instant::now() > deadline {
                return Err("the cluster clock did not pass the window".into());
            }
            sleep(Duration::from_secs(5));
        }
        let before = pool_state(rpc, &pool)?;
        let ix = pool.swap_ix(&sniper.pubkey(), Side::Buy, &exact_in(SNIPE / 2, 1));
        let signature = rpc.send(&[ix], creator, &[&sniper])?;
        let after = pool_state(rpc, &pool)?;
        let tax = (after.accrued_tax_quote - before.accrued_tax_quote)
            + (after.accrued_protocol_quote - before.accrued_protocol_quote);
        println!(
            "bought again after the window: tax {tax}: {}",
            explorer(&signature)
        );
    }

    // The creator claims their part; anyone sweeps the protocol's part to the treasury.
    let state = pool_state(rpc, &pool)?;
    let signature = rpc.send(&[pool.claim_tax_ix(&me, &creator_quote)], creator, &[])?;
    println!(
        "creator claimed {} lamports of tax: {}",
        state.accrued_tax_quote,
        explorer(&signature)
    );
    let treasury_quote = pda::associated_token(&config.treasury, &quote_mint, &token_program);
    let ixs = [
        ata_ix(&me, &config.treasury, &quote_mint, &token_program),
        pool.sweep_ix(&config.treasury, &treasury_quote),
    ];
    let signature = rpc.send(&ixs, creator, &[])?;
    println!(
        "swept {} lamports to the treasury: {}",
        state.accrued_protocol_quote,
        explorer(&signature)
    );
    Ok(())
}

fn ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Instruction {
    spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent(
        payer,
        owner,
        mint,
        token_program,
    )
}

fn pool_state(rpc: &Rpc, pool: &Pool) -> Result<LaunchPool> {
    let account = rpc.account(&pool.address)?.ok_or("pool not found")?;
    client::decode_account("LaunchPool", &account.1).ok_or_else(|| "unreadable pool".into())
}

// ---------------------------------------------------------------------------------------
// JSON-RPC over curl
// ---------------------------------------------------------------------------------------

struct Rpc {
    url: String,
}

impl Rpc {
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body =
            json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
        for attempt in 0..8 {
            // The HTTP status goes on its own last line, so only a real rate limit or
            // server error is retried.
            let output = Command::new("curl")
                .args(["-sS", "-m", "60", "-X", "POST", &self.url])
                .args([
                    "-H",
                    "Content-Type: application/json",
                    "--data-binary",
                    &body,
                    "-w",
                    "\n%{http_code}",
                ])
                .output()
                .map_err(|e| format!("curl: {e}"))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let (text, status) = stdout.rsplit_once('\n').unwrap_or(("", &stdout));
            if status == "429" || status.starts_with('5') || text.trim().is_empty() {
                sleep(Duration::from_millis(500 << attempt));
                continue;
            }
            let reply: Value =
                serde_json::from_str(text).map_err(|e| format!("{method}: {e}: {text}"))?;
            if let Some(error) = reply.get("error") {
                return Err(format!("{method}: {error}"));
            }
            return Ok(reply["result"].clone());
        }
        Err(format!("{method}: no answer from {}", self.url))
    }

    fn blockhash(&self) -> Result<Hash> {
        let result = self.call("getLatestBlockhash", json!([{"commitment": "confirmed"}]))?;
        let hash = result["value"]["blockhash"]
            .as_str()
            .ok_or("no blockhash")?;
        Hash::from_str(hash).map_err(|e| e.to_string())
    }

    fn rent(&self, len: usize) -> Result<u64> {
        self.call("getMinimumBalanceForRentExemption", json!([len]))?
            .as_u64()
            .ok_or_else(|| "bad rent".into())
    }

    /// The cluster's clock, as programs see it: the Clock sysvar's Unix timestamp.
    fn cluster_time(&self) -> Result<i64> {
        let clock = Pubkey::from_str("SysvarC1ock11111111111111111111111111111111")
            .map_err(|e| e.to_string())?;
        let (_, data) = self.account(&clock)?.ok_or("no clock sysvar")?;
        let timestamp = data.get(32..40).ok_or("short clock sysvar")?;
        Ok(i64::from_le_bytes(timestamp.try_into().unwrap()))
    }

    /// `(lamports, data)` of an account, if it exists.
    fn account(&self, address: &Pubkey) -> Result<Option<(u64, Vec<u8>)>> {
        let result = self.call(
            "getAccountInfo",
            json!([address.to_string(), {"encoding": "base64", "commitment": "confirmed"}]),
        )?;
        let value = &result["value"];
        if value.is_null() {
            return Ok(None);
        }
        let data = value["data"][0].as_str().ok_or("no account data")?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?;
        Ok(Some((value["lamports"].as_u64().unwrap_or(0), data)))
    }

    fn transaction(
        &self,
        ixs: &[Instruction],
        payer: &Keypair,
        signers: &[&Keypair],
    ) -> Result<String> {
        let mut all = vec![payer];
        all.extend_from_slice(signers);
        let tx =
            Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, self.blockhash()?);
        let bytes = bincode::serialize(&tx).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_TRANSACTION_SIZE {
            return Err(format!("transaction is {} bytes", bytes.len()));
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    /// Sends a transaction and waits until it is confirmed.
    fn send(&self, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<String> {
        let tx = self.transaction(ixs, payer, signers)?;
        let signature = self.call(
            "sendTransaction",
            json!([tx, {"encoding": "base64", "preflightCommitment": "confirmed"}]),
        )?;
        let signature = signature.as_str().ok_or("no signature")?.to_string();
        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            let statuses = self.call("getSignatureStatuses", json!([[signature]]))?;
            let status = &statuses["value"][0];
            if !status.is_null() {
                if !status["err"].is_null() {
                    return Err(format!("{signature} failed: {}", status["err"]));
                }
                if matches!(
                    status["confirmationStatus"].as_str(),
                    Some("confirmed" | "finalized")
                ) {
                    return Ok(signature);
                }
            }
            sleep(Duration::from_secs(1));
        }
        Err(format!("{signature} was not confirmed in time"))
    }

    /// Simulates `pipeline_quote` for a buy of `amount`.
    fn quote(
        &self,
        pool: &Pool,
        payer: &Keypair,
        amount: u64,
        trader: Option<Pubkey>,
    ) -> Result<psi::QuoteResult> {
        let ix = pool.quote_ix(Side::Buy, TradeMode::ExactIn, amount, trader);
        let tx = self.transaction(&[ix], payer, &[])?;
        let result = self.call(
            "simulateTransaction",
            json!([tx, {"encoding": "base64", "commitment": "confirmed"}]),
        )?;
        let value = &result["value"];
        if !value["err"].is_null() {
            return Err(format!("quote failed: {} {}", value["err"], value["logs"]));
        }
        let data = value["returnData"]["data"][0]
            .as_str()
            .ok_or("no return data")?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?;
        borsh::from_slice(&data).map_err(|e| e.to_string())
    }
}
