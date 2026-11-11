// A whole launch, step by step: check the form, create the token, then create and launch the
// pool. Each transaction is simulated before it is signed, and nothing is sent if the
// simulation fails. Signing and sending is the caller's: a wallet on the site, a local key in
// the devnet test.
//
// The two transactions are separate, so the second can fail (or the creator can turn it down
// in their wallet) after the token exists. `LaunchError.tokenMint` then names the token, and
// `createPool` can be run again for it with the same form.

import { generateKeyPairSigner, type Address, type Signature, type TransactionSigner } from '@solana/kit';

import { creatorQuoteAccount, type PoolKeys, type ProtocolConfig } from '../client/index.js';
import {
    accountExists,
    balance,
    confirm,
    launchCosts,
    readConfig,
    readPoolSetup,
    simulate,
    transactionCost,
    type Rpc,
    type Simulation,
} from './chain.js';
import { normalizeForm, validateForm, type LaunchForm } from './form.js';
import { launchMessage, mintSizes, poolInstructions, sitePoolKeys, tokenInstructions } from './transactions.js';
import { formatSol } from './units.js';

export type LaunchMessage = ReturnType<typeof launchMessage>;

/** Signs and sends a transaction message, returning its signature. */
export type Sender = (message: LaunchMessage) => Promise<Signature>;

export type LaunchProgress =
    | { step: 'simulated'; transaction: 'token' | 'pool'; simulation: Simulation; lamportsSpent: bigint | null }
    | { step: 'sent'; transaction: 'token' | 'pool'; signature: Signature }
    | { step: 'confirmed'; transaction: 'token' | 'pool'; signature: Signature };

export type LaunchResult = {
    mint: Address;
    keys: PoolKeys;
    signatures: { token: Signature; pool: Signature };
};

export class LaunchError extends Error {
    constructor(
        message: string,
        readonly logs: readonly string[] = [],
        /** Set when the token was created but its pool was not. */
        readonly tokenMint: Address | null = null,
    ) {
        super(message);
    }
}

type Steps = {
    rpc: Rpc;
    creator: TransactionSigner;
    send: Sender;
    onProgress?: (progress: LaunchProgress) => void;
};

/** The normalized form, or a `LaunchError` listing what is wrong with it. */
function checkedForm(form: LaunchForm): LaunchForm {
    const normalized = normalizeForm(form);
    const errors = validateForm(normalized);
    if (errors.length > 0) {
        throw new LaunchError(errors.join(' '));
    }
    return normalized;
}

/** Plain words for the simulation errors a creator is likely to meet; `null` for the rest. */
export function explainSimulationError(error: string, logs: readonly string[] = []): string | null {
    if (error === '"AccountNotFound"') {
        return 'your wallet has no SOL on this cluster yet';
    }
    if (error.includes('InsufficientFunds')) {
        return 'not enough SOL';
    }
    // Custom codes come as numbers, or as strings once the RPC's bigints are serialized.
    const custom = /"Custom":"?(\d+)"?\}/.exec(error)?.[1];
    // Error 1 of the System and Token programs: a transfer of more than the account holds.
    if (custom === '1') {
        return 'not enough SOL or tokens for a transfer';
    }
    // The router's `InsufficientOutput`. Its number, 6021, is also one of ours, so go by the log.
    if (logs.some((line) => line.includes('Error Code: InsufficientOutput'))) {
        return 'the price moved past your slippage';
    }
    return null;
}

/**
 * Why a simulated transaction must not be sent although it succeeded: it spends more than the
 * preview showed, or its cost couldn't be read. `null` when it may be sent.
 */
export function spendProblem(
    transaction: 'token' | 'pool',
    lamportsSpent: bigint | null,
    expectedLamports: bigint,
): string | null {
    if (lamportsSpent === null) {
        return `The ${transaction} transaction's cost could not be read from the simulation. Nothing was sent.`;
    }
    if (lamportsSpent > expectedLamports) {
        return (
            `The ${transaction} transaction would cost ${formatSol(lamportsSpent)} SOL, ` +
            `more than the ${formatSol(expectedLamports)} SOL shown. Nothing was sent.`
        );
    }
    return null;
}

/**
 * Simulates, then sends and confirms. Stops before sending if the simulation fails or spends
 * more than `expectedLamports`, this transaction's share of the preview.
 */
async function simulateSendConfirm(
    steps: Steps,
    transaction: 'token' | 'pool',
    message: LaunchMessage,
    lastValidBlockHeight: bigint,
    expectedLamports: bigint,
): Promise<Signature> {
    const { rpc, creator, send } = steps;
    const onProgress = steps.onProgress ?? (() => {});
    const before = await balance(rpc, creator.address);
    const simulation = await simulate(rpc, message, creator.address);
    const lamportsSpent = simulation.lamportsAfter === null ? null : before - simulation.lamportsAfter;
    onProgress({ step: 'simulated', transaction, simulation, lamportsSpent });
    if (!simulation.ok) {
        const reason = explainSimulationError(simulation.error ?? '', simulation.logs);
        throw new LaunchError(
            `The ${transaction} transaction would fail${reason ? `: ${reason}` : ''} (${simulation.error}). Nothing was sent.`,
            simulation.logs,
        );
    }
    const problem = spendProblem(transaction, lamportsSpent, expectedLamports);
    if (problem) {
        throw new LaunchError(problem, simulation.logs);
    }
    const signature = await send(message);
    onProgress({ step: 'sent', transaction, signature });
    await confirm(rpc, signature, lastValidBlockHeight);
    onProgress({ step: 'confirmed', transaction, signature });
    return signature;
}

/** Transaction 1: a new token with the whole supply in the creator's wallet. */
export async function createToken(
    input: Steps & { form: LaunchForm; config?: ProtocolConfig },
): Promise<{ mint: Address; signature: Signature }> {
    const { rpc, creator } = input;
    const form = checkedForm(input.form);
    const config = input.config ?? (await readConfig(rpc));
    const mint = await generateKeyPairSigner();
    const costs = await launchCosts(rpc, { creator: creator.address, mint: mint.address, form, config });
    const mintLamports = await rpc
        .getMinimumBalanceForRentExemption(BigInt(mintSizes(mint.address, creator.address, form).full))
        .send();
    const instructions = await tokenInstructions({ creator, mint, form, mintLamports });
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = launchMessage(creator, instructions, lifetime);
    const signature = await simulateSendConfirm(
        input,
        'token',
        message,
        lifetime.lastValidBlockHeight,
        transactionCost(costs, 'token'),
    );
    return { mint: mint.address, signature };
}

/**
 * Transaction 2: the pool for `mint`, launched. Keeps the creator's wrapped SOL if they
 * already had an account for it. Run it with the same form as the token.
 *
 * Anyone can create a creator's pool or its fee accounts before the creator does (they need no
 * signature of the creator's), and each of those instructions fails if its account exists. So
 * the chain is read first and the transaction holds only what is still missing; the launch
 * itself is always the creator's. The preview stays the upper bound of the cost.
 */
export async function createPool(
    input: Steps & { form: LaunchForm; mint: Address; config?: ProtocolConfig },
): Promise<{ keys: PoolKeys; signature: Signature }> {
    const { rpc, creator } = input;
    const form = checkedForm(input.form);
    const config = input.config ?? (await readConfig(rpc));
    const costs = await launchCosts(rpc, { creator: creator.address, mint: input.mint, form, config });
    const keys = await sitePoolKeys(creator.address, input.mint, form);
    const existing = await readPoolSetup(rpc, keys);
    if (existing.launched) {
        throw new LaunchError(`This token already has a live pool with these settings, at ${keys.address}.`);
    }
    const hadQuoteAccount = await accountExists(rpc, await creatorQuoteAccount(keys));
    const pool = await poolInstructions({
        creator,
        mint: input.mint,
        form,
        treasury: config.treasury,
        closeQuoteAccount: !hadQuoteAccount,
        existing,
    });
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = launchMessage(creator, pool.instructions, lifetime);
    const signature = await simulateSendConfirm(
        input,
        'pool',
        message,
        lifetime.lastValidBlockHeight,
        transactionCost(costs, 'pool') + form.liquidityLamports,
    );
    return { keys: pool.keys, signature };
}

export async function runLaunch(input: Steps & { form: LaunchForm }): Promise<LaunchResult> {
    const form = checkedForm(input.form);
    // Read the config first, so a cluster without the program stops before anything is spent.
    const config = await readConfig(input.rpc);
    const token = await createToken({ ...input, form, config });
    try {
        const pool = await createPool({ ...input, form, mint: token.mint, config });
        return { mint: token.mint, keys: pool.keys, signatures: { token: token.signature, pool: pool.signature } };
    } catch (error) {
        const logs = error instanceof LaunchError ? error.logs : [];
        const message = error instanceof Error ? error.message : String(error);
        throw new LaunchError(message, logs, token.mint);
    }
}
