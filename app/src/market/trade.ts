// Buying and selling on a verified pool: the router's swap from and to the trader's own token
// accounts, with SOL wrapped for a buy and unwrapped after a sell. The quote comes from the
// pool's own maths on reserves read from the chain; the router enforces the minimum
// received; the transaction is simulated before the wallet is asked.

import type { Address, Instruction, Signature, TransactionSigner } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    getCloseAccountInstruction,
    getCreateAssociatedTokenIdempotentInstruction as getCreateClassicAtaInstruction,
    getSyncNativeInstruction,
} from '@solana-program/token';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';

import { NATIVE_MINT, exactIn, poolPricing, quoteExactIn, swapIx, type Quote, type Side } from '../client/index.js';
import { SIGNATURE_FEE, SPACE, accountExists, balance, confirm, simulate, type Rpc } from '../launch/chain.js';
import { LaunchError, explainSimulationError, type Sender } from '../launch/run.js';
import { launchMessage } from '../launch/transactions.js';
import { formatSol } from '../launch/units.js';
import { associatedTokenAddress, pipelineFee } from '../vendor/pipeline/index.js';
import type { VerifiedPool } from './pools.js';

/**
 * The quote assumes the cluster's clock may run this far behind ours. A buy during the
 * window only gets cheaper as time passes, so this covers the one way it can get dearer.
 */
export const CLOCK_MARGIN_SECS = 2n;

export type TradeQuote = {
    side: Side;
    /** Input to the pool: SOL for a buy, tokens for a sell. */
    amountIn: bigint;
    /** Pipeline's 0.25%, taken from the same input account on top of `amountIn`. */
    pipelineFee: bigint;
    /** The rate this trade pays now. */
    taxBps: number;
    /** The pool's maths at that rate: output, tax and its split. */
    quote: Quote;
    /** What the router must deliver, or the trade fails: the output at the rate two seconds ago, less slippage. */
    minAmountOut: bigint;
};

export type QuoteError = { error: string };

/** A quote for `amountIn` of input on `verified` at cluster time `now`. */
export function quoteTrade(
    verified: VerifiedPool,
    side: Side,
    trader: Address,
    amountIn: bigint,
    now: bigint,
    slippageBps: number,
): TradeQuote | QuoteError {
    if (verified.pool.status !== 'live') {
        return { error: 'This pool is not live yet.' };
    }
    if (verified.keys.quoteMint !== NATIVE_MINT) {
        return { error: 'The site trades only pools against SOL.' };
    }
    if (amountIn <= 0n) {
        return { error: 'Enter an amount.' };
    }
    const pricing = poolPricing(verified.pool, side, trader, now);
    const expected = quoteExactIn(pricing, amountIn);
    const worst = quoteExactIn(poolPricing(verified.pool, side, trader, now - CLOCK_MARGIN_SECS), amountIn);
    if (!expected.ok || !worst.ok) {
        return { error: 'The pool does not have enough liquidity for that.' };
    }
    const minAmountOut = (worst.quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (minAmountOut <= 0n) {
        return { error: 'That amount is too small to receive anything.' };
    }
    return {
        side,
        amountIn,
        pipelineFee: pipelineFee(amountIn),
        taxBps: pricing.taxBps,
        quote: expected.quote,
        minAmountOut,
    };
}

/** The most tokens a holder of `balance` can sell: Pipeline's fee comes out of the same account. */
export function maxSellable(balance: bigint): bigint {
    let amount = (balance * 10_000n) / 10_025n;
    while (amount > 0n && amount + pipelineFee(amount) > balance) {
        amount -= 1n;
    }
    return amount;
}

export type TradeAccounts = { quote: Address; token: Address };

/** The trader's wrapped-SOL and token accounts for `verified`. */
export async function traderAccounts(verified: VerifiedPool, trader: Address): Promise<TradeAccounts> {
    const { keys } = verified;
    return {
        quote: await associatedTokenAddress(trader, keys.quoteMint, keys.quoteProgram),
        token: await associatedTokenAddress(trader, keys.tokenMint, keys.tokenProgram),
    };
}

/**
 * The instructions of one trade. With `closeQuoteAccount`, the wrapped-SOL account is closed
 * at the end, which unwraps a sell's proceeds and returns its rent; pass `false` when the
 * trader already had one, so their own wrapped SOL stays put.
 */
export async function tradeInstructions(input: {
    trader: TransactionSigner;
    verified: VerifiedPool;
    side: Side;
    amountIn: bigint;
    minAmountOut: bigint;
    closeQuoteAccount: boolean;
}): Promise<Instruction[]> {
    const { trader, verified, side, amountIn } = input;
    const { keys } = verified;
    const accounts = await traderAccounts(verified, trader.address);
    const instructions: Instruction[] = [
        getCreateClassicAtaInstruction({
            payer: trader,
            ata: accounts.quote,
            owner: trader.address,
            mint: keys.quoteMint,
            tokenProgram: keys.quoteProgram,
        }),
    ];
    if (side === 'buy') {
        instructions.push(
            getTransferSolInstruction({
                source: trader,
                destination: accounts.quote,
                amount: amountIn + pipelineFee(amountIn),
            }),
            getSyncNativeInstruction({ account: accounts.quote }),
            getCreateAssociatedTokenIdempotentInstruction({
                payer: trader,
                ata: accounts.token,
                owner: trader.address,
                mint: keys.tokenMint,
                tokenProgram: keys.tokenProgram,
            }),
        );
    }
    instructions.push(await swapIx(keys, trader.address, side, exactIn(amountIn, input.minAmountOut)));
    if (input.closeQuoteAccount) {
        instructions.push(
            getCloseAccountInstruction({ account: accounts.quote, destination: trader.address, owner: trader }),
        );
    }
    return instructions;
}

export type TradeProgress =
    | { step: 'simulated'; lamportsSpent: bigint | null }
    | { step: 'sent'; signature: Signature }
    | { step: 'confirmed'; signature: Signature };

export type TradeResult = {
    signature: Signature;
    /** The slot it landed in: read the pool with this as `minContextSlot` to see the trade. */
    slot: bigint;
};

/**
 * Why a simulated trade must not be sent although it succeeded; `null` when it may be. A buy
 * may spend at most what the page showed: the amount, Pipeline's fee, the token account's
 * rent if it is new, and the signature fee. A sell that unwraps must pay the trader at least
 * the minimum received less the fee; one that keeps the proceeds wrapped may cost only the fee.
 */
export function tradeSpendProblem(input: {
    side: Side;
    before: bigint;
    after: bigint | null;
    amountIn: bigint;
    minAmountOut: bigint;
    /** Rent for the trader's new token account, or 0 if they already have one. */
    tokenAccountRent: bigint;
    unwrap: boolean;
}): string | null {
    const { side, before, after } = input;
    if (after === null) {
        return "The trade's effect on your SOL could not be read from the simulation. Nothing was sent.";
    }
    if (side === 'buy') {
        const most = input.amountIn + pipelineFee(input.amountIn) + input.tokenAccountRent + SIGNATURE_FEE;
        return before - after > most
            ? `The buy would cost ${formatSol(before - after, 9)} SOL, more than the ${formatSol(most, 9)} SOL shown. Nothing was sent.`
            : null;
    }
    const least = input.unwrap ? before + input.minAmountOut - SIGNATURE_FEE : before - SIGNATURE_FEE;
    return after < least
        ? `The sell would leave you ${formatSol(after, 9)} SOL, less than the ${formatSol(least, 9)} SOL expected. Nothing was sent.`
        : null;
}

/**
 * Simulates, sends and confirms one trade. Nothing is sent if the simulation fails, or if it
 * would spend more SOL (or pay out less) than the page showed (`tradeSpendProblem`).
 */
export async function runTrade(input: {
    rpc: Rpc;
    trader: TransactionSigner;
    verified: VerifiedPool;
    side: Side;
    amountIn: bigint;
    minAmountOut: bigint;
    send: Sender;
    onProgress?: (progress: TradeProgress) => void;
}): Promise<TradeResult> {
    const { rpc, trader, send } = input;
    const onProgress = input.onProgress ?? (() => {});
    const accounts = await traderAccounts(input.verified, trader.address);
    const hadQuoteAccount = await accountExists(rpc, accounts.quote);
    const tokenAccountRent =
        input.side === 'buy' && !(await accountExists(rpc, accounts.token))
            ? await rpc.getMinimumBalanceForRentExemption(BigInt(SPACE.token2022Account)).send()
            : 0n;
    const instructions = await tradeInstructions({ ...input, closeQuoteAccount: !hadQuoteAccount });
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = launchMessage(trader, instructions, lifetime);
    const before = await balance(rpc, trader.address);
    const simulation = await simulate(rpc, message, trader.address);
    onProgress({
        step: 'simulated',
        lamportsSpent: simulation.lamportsAfter === null ? null : before - simulation.lamportsAfter,
    });
    if (!simulation.ok) {
        const reason = explainSimulationError(simulation.error ?? '', simulation.logs);
        throw new LaunchError(
            `The trade would fail${reason ? `: ${reason}` : ''} (${simulation.error}). Nothing was sent.`,
            simulation.logs,
        );
    }
    const problem = tradeSpendProblem({
        side: input.side,
        before,
        after: simulation.lamportsAfter,
        amountIn: input.amountIn,
        minAmountOut: input.minAmountOut,
        tokenAccountRent,
        unwrap: !hadQuoteAccount,
    });
    if (problem) {
        throw new LaunchError(problem, simulation.logs);
    }
    const signature = await send(message);
    onProgress({ step: 'sent', signature });
    const slot = await confirm(rpc, signature, lifetime.lastValidBlockHeight);
    onProgress({ step: 'confirmed', signature });
    return { signature, slot };
}
