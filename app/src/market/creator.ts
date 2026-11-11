// The creator's side: their pools, found on the chain by the creator field, and claiming
// their part of the tax. `claim_tax` pays the whole unclaimed amount into a token account of
// the quote mint; for a pool against SOL the site makes that the creator's wrapped-SOL account
// and, if it had to create it, closes it again so the tax arrives as plain SOL.

import type { Address, Base58EncodedBytes, Instruction, Signature, TransactionSigner } from '@solana/kit';
import {
    getCloseAccountInstruction,
    getCreateAssociatedTokenIdempotentInstruction as getCreateClassicAtaInstruction,
} from '@solana-program/token';

import { NATIVE_MINT, PROGRAM_ID, claimTaxIx, creatorQuoteAccount } from '../client/index.js';
import { SIGNATURE_FEE, SPACE, accountExists, balance, confirm, simulate, type Rpc } from '../launch/chain.js';
import { LaunchError, explainSimulationError, type Sender } from '../launch/run.js';
import { launchMessage } from '../launch/transactions.js';
import { formatSol } from '../launch/units.js';
import { readVerifiedPools, withRetryWhileBehind, type VerifiedPool } from './pools.js';

/** Where `creator` sits in a pool account: after the discriminator, `version`, `status` and `bump`. */
export const POOL_CREATOR_OFFSET = 8 + 1 + 1 + 1;

/**
 * Every verified pool whose creator is `creator`, newest launch first. The chain is asked
 * directly (by account size and the creator field), so a pool the API hasn't indexed shows too.
 */
export async function creatorPools(rpc: Rpc, creator: Address, minContextSlot?: bigint): Promise<VerifiedPool[]> {
    const accounts = await withRetryWhileBehind(() =>
        rpc
            .getProgramAccounts(PROGRAM_ID, {
                encoding: 'base64',
                commitment: 'confirmed',
                dataSlice: { offset: 0, length: 0 },
                filters: [
                    { dataSize: BigInt(SPACE.pool) },
                    {
                        memcmp: {
                            offset: BigInt(POOL_CREATOR_OFFSET),
                            // An address is the base-58 form of its 32 bytes.
                            bytes: creator as string as Base58EncodedBytes,
                            encoding: 'base58',
                        },
                    },
                ],
                ...(minContextSlot ? { minContextSlot } : {}),
            })
            .send(),
    );
    const pools = await readVerifiedPools(
        rpc,
        accounts.map((a) => a.pubkey),
        minContextSlot,
    );
    return [...pools.values()]
        .filter((v) => v.pool.creator === creator)
        .sort((a, b) => (a.pool.launchTs === b.pool.launchTs ? 0 : a.pool.launchTs > b.pool.launchTs ? -1 : 1));
}

/** Why `creator` can't claim on `verified` from the site; `null` when they can. */
export function claimProblem(verified: VerifiedPool, creator: Address): string | null {
    if (verified.pool.creator !== creator) {
        return 'Only the creator of this pool can claim its tax.';
    }
    if (verified.keys.quoteMint !== NATIVE_MINT) {
        return 'The site claims only from pools against SOL.';
    }
    if (verified.pool.accruedTaxQuote === 0n) {
        return 'Nothing to claim yet.';
    }
    return null;
}

/**
 * The claim's instructions: the creator's wrapped-SOL account (created if needed), `claim_tax`
 * into it and, with `unwrap`, closing it so the tax arrives as SOL along with the account's rent.
 */
export async function claimInstructions(input: {
    creator: TransactionSigner;
    verified: VerifiedPool;
    unwrap: boolean;
}): Promise<Instruction[]> {
    const { creator, verified, unwrap } = input;
    const { keys } = verified;
    const destination = await creatorQuoteAccount(keys);
    const instructions: Instruction[] = [
        getCreateClassicAtaInstruction({
            payer: creator,
            ata: destination,
            owner: creator.address,
            mint: keys.quoteMint,
            tokenProgram: keys.quoteProgram,
        }),
        await claimTaxIx(keys, destination),
    ];
    if (unwrap) {
        instructions.push(
            getCloseAccountInstruction({ account: destination, destination: creator.address, owner: creator }),
        );
    }
    return instructions;
}

/**
 * Why a simulated claim must not be sent although it succeeded; `null` when it may be. With
 * `unwrap`, the creator's SOL must grow by at least the unclaimed tax less the fee; without it
 * the tax stays wrapped, and the creator's SOL may only pay the fee.
 */
export function claimSpendProblem(input: {
    before: bigint;
    after: bigint | null;
    claimable: bigint;
    unwrap: boolean;
}): string | null {
    const { before, after, claimable, unwrap } = input;
    if (after === null) {
        return "The claim's effect on your SOL could not be read from the simulation. Nothing was sent.";
    }
    const least = unwrap ? before + claimable - SIGNATURE_FEE : before - SIGNATURE_FEE;
    if (after < least) {
        return (
            `The claim would leave you ${formatSol(after, 9)} SOL, ` +
            `less than the ${formatSol(least, 9)} SOL expected. Nothing was sent.`
        );
    }
    return null;
}

export type ClaimProgress =
    | { step: 'simulated'; lamportsGained: bigint | null }
    | { step: 'sent'; signature: Signature }
    | { step: 'confirmed'; signature: Signature };

export type ClaimResult = {
    signature: Signature;
    /** The slot it landed in: read the pool with this as `minContextSlot` to see the claim. */
    slot: bigint;
    /** Whether the tax arrived as SOL (`true`) or stayed in the creator's wrapped-SOL account. */
    unwrapped: boolean;
};

/**
 * Claims the creator's unclaimed tax on `verified`: simulated first, and not sent if the
 * simulation fails or would leave the creator with less than expected.
 */
export async function runClaim(input: {
    rpc: Rpc;
    creator: TransactionSigner;
    verified: VerifiedPool;
    send: Sender;
    onProgress?: (progress: ClaimProgress) => void;
}): Promise<ClaimResult> {
    const { rpc, creator, verified, send } = input;
    const onProgress = input.onProgress ?? (() => {});
    const problem = claimProblem(verified, creator.address);
    if (problem) {
        throw new LaunchError(problem);
    }
    const destination = await creatorQuoteAccount(verified.keys);
    const unwrap = !(await accountExists(rpc, destination));
    const instructions = await claimInstructions({ creator, verified, unwrap });
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = launchMessage(creator, instructions, lifetime);
    const before = await balance(rpc, creator.address);
    const simulation = await simulate(rpc, message, creator.address);
    const after = simulation.lamportsAfter;
    onProgress({ step: 'simulated', lamportsGained: after === null ? null : after - before });
    if (!simulation.ok) {
        const reason = explainSimulationError(simulation.error ?? '', simulation.logs);
        throw new LaunchError(
            `The claim would fail${reason ? `: ${reason}` : ''} (${simulation.error}). Nothing was sent.`,
            simulation.logs,
        );
    }
    const spend = claimSpendProblem({ before, after, claimable: verified.pool.accruedTaxQuote, unwrap });
    if (spend) {
        throw new LaunchError(spend, simulation.logs);
    }
    const signature = await send(message);
    onProgress({ step: 'sent', signature });
    const slot = await confirm(rpc, signature, lifetime.lastValidBlockHeight);
    onProgress({ step: 'confirmed', signature });
    return { signature, slot, unwrapped: unwrap };
}
