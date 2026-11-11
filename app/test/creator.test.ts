// The creator dashboard: finding a creator's pools on the chain, and the claim transaction.

import {
    address,
    createNoopSigner,
    getAddressEncoder,
    getBase64Decoder,
    type Address,
    type Instruction,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';

import {
    ACCOUNT_DISCRIMINATORS,
    NATIVE_MINT,
    PROGRAM_ID,
    claimTaxIx,
    creatorQuoteAccount,
    getLaunchPoolCodec,
    type LaunchPool,
} from '../src/client/index.js';
import { SIGNATURE_FEE, SPACE, type Rpc } from '../src/launch/chain.js';
import {
    POOL_CREATOR_OFFSET,
    claimInstructions,
    claimProblem,
    claimSpendProblem,
    creatorPools,
} from '../src/market/creator.js';

import { poolFromVector, vectors, verifiedFromVector } from './helpers.js';

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const someoneElse = address('GuoMTwRcXWzFkWkdjZ3qAYGLc14UFYLfHtk4njwKTvQT');

describe("a creator's pools", () => {
    it('find the creator at the offset the program writes it to', () => {
        for (const vector of vectors.accounts.launch_pools) {
            const data = fromHex(vector.data);
            expect(data.length).toBe(SPACE.pool);
            const creator = data.slice(POOL_CREATOR_OFFSET, POOL_CREATOR_OFFSET + 32);
            expect(creator).toEqual(new Uint8Array(getAddressEncoder().encode(address(vector.decoded.creator))));
        }
    });

    it("ask the chain by size and creator, and keep only the creator's verified pools", async () => {
        const mine = poolFromVector(vectors.pools[0]);
        const theirs = poolFromVector(vectors.pools[1]);
        const creator = mine.pool.creator;
        expect(theirs.pool.creator).not.toBe(creator);
        const encode = (pool: LaunchPool) =>
            getBase64Decoder().decode(
                new Uint8Array([...ACCOUNT_DISCRIMINATORS.LaunchPool, ...getLaunchPoolCodec().encode(pool)]),
            );
        const stored = new Map<Address, string>([
            [mine.address, encode({ ...mine.pool, launchTs: 1n })],
            // A node that ignores the filter must not slip another creator's pool in.
            [theirs.address, encode(theirs.pool)],
        ]);
        const asked: unknown[] = [];
        const rpc = {
            getProgramAccounts: (program: Address, config: unknown) => {
                asked.push({ program, config });
                return { send: async () => [...stored.keys()].map((pubkey) => ({ pubkey })) };
            },
            getMultipleAccounts: (addresses: Address[]) => ({
                send: async () => ({
                    value: addresses.map((a) => {
                        const data = stored.get(a);
                        return data ? { owner: PROGRAM_ID, data: [data, 'base64'] } : null;
                    }),
                }),
            }),
            getEpochInfo: () => ({ send: async () => ({ epoch: 0n }) }),
        } as unknown as Rpc;

        const pools = await creatorPools(rpc, creator, 42n);
        expect(pools.map((p) => p.address)).toEqual([mine.address]);
        expect(asked).toEqual([
            {
                program: PROGRAM_ID,
                config: {
                    encoding: 'base64',
                    commitment: 'confirmed',
                    dataSlice: { offset: 0, length: 0 },
                    filters: [
                        { dataSize: BigInt(SPACE.pool) },
                        { memcmp: { offset: BigInt(POOL_CREATOR_OFFSET), bytes: creator, encoding: 'base58' } },
                    ],
                    minContextSlot: 42n,
                },
            },
        ]);
    });
});

describe('claiming tax', () => {
    const withTax = { accruedTaxQuote: 8_118_000n };

    it('is only for the creator, on a pool against SOL, with tax to claim', async () => {
        const verified = await verifiedFromVector(0, withTax);
        const creator = verified.pool.creator;
        expect(verified.keys.quoteMint).toBe(NATIVE_MINT);
        expect(claimProblem(verified, creator)).toBeNull();
        expect(claimProblem(verified, someoneElse)).toMatch(/Only the creator/);
        expect(claimProblem(await verifiedFromVector(0), creator)).toMatch(/Nothing to claim/);
        const otherQuote = await verifiedFromVector(1, withTax);
        expect(otherQuote.keys.quoteMint).not.toBe(NATIVE_MINT);
        expect(claimProblem(otherQuote, otherQuote.pool.creator)).toMatch(/against SOL/);
    });

    it("claims into the creator's wrapped-SOL account, and unwraps when the site created it", async () => {
        const verified = await verifiedFromVector(0, withTax);
        const creator = createNoopSigner(verified.pool.creator);
        const destination = await creatorQuoteAccount(verified.keys);
        const claim = await claimTaxIx(verified.keys, destination);
        const programs = (ixs: Instruction[]) => ixs.map((ix) => ix.programAddress);

        const unwrapped = await claimInstructions({ creator, verified, unwrap: true });
        expect(programs(unwrapped)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, PROGRAM_ID, TOKEN_PROGRAM_ADDRESS]);
        expect(unwrapped[0]!.accounts!.map((a) => a.address)).toContain(destination);
        expect(unwrapped[1]!.data).toEqual(claim.data);
        expect(unwrapped[1]!.accounts!.map((a) => a.address)).toEqual(claim.accounts.map((a) => a.address));
        // Close the account, paying out to the creator, signed by the creator.
        expect(unwrapped[2]!.accounts!.map((a) => a.address)).toEqual([destination, creator.address, creator.address]);

        const kept = await claimInstructions({ creator, verified, unwrap: false });
        expect(programs(kept)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, PROGRAM_ID]);
    });

    it('is not sent if the simulation pays the creator less than expected', () => {
        const before = 1_000_000_000n;
        const claimable = 8_118_000n;
        const ok = (after: bigint | null, unwrap: boolean) =>
            claimSpendProblem({ before, after, claimable, unwrap }) === null;
        // Unwrapped: the tax arrives as SOL, less the signature fee; more tax since is fine.
        expect(ok(before + claimable - SIGNATURE_FEE, true)).toBe(true);
        expect(ok(before + claimable + 100_000n - SIGNATURE_FEE, true)).toBe(true);
        expect(ok(before + claimable - SIGNATURE_FEE - 1n, true)).toBe(false);
        expect(ok(before - SIGNATURE_FEE, true)).toBe(false);
        // Kept wrapped: the creator's SOL only pays the fee.
        expect(ok(before - SIGNATURE_FEE, false)).toBe(true);
        expect(ok(before - SIGNATURE_FEE - 1n, false)).toBe(false);
        expect(ok(null, false)).toBe(false);
    });
});
