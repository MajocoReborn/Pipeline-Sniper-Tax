// A pool is only shown or traded if it sits at the address its own fields derive.

import { SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, SolanaError, address } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Rpc } from '../src/launch/chain.js';
import { chainNow, readVerifiedPools, verifyPoolKeys, withRetryWhileBehind } from '../src/market/pools.js';

import { poolFromVector, vectors } from './helpers.js';

describe('verified pools', () => {
    it('accepts a pool at its own address, with either token program', async () => {
        for (const v of vectors.pools) {
            const { address: at, pool } = poolFromVector(v);
            const keys = await verifyPoolKeys(at, pool);
            expect(keys?.market, v.name).toBe(v.keys.market);
            expect(keys?.tokenProgram, v.name).toBe(v.token_program);
            expect(keys?.quoteProgram, v.name).toBe(v.quote_program);
        }
    });

    it('refuses a pool whose fields or vaults do not match its address', async () => {
        const { address: at, pool } = poolFromVector(vectors.pools[0]);
        const other = address(vectors.pools[1].keys.address);
        expect(await verifyPoolKeys(other, pool)).toBeNull();
        expect(await verifyPoolKeys(at, { ...pool, taxStartBps: pool.taxStartBps - 1 })).toBeNull();
        expect(await verifyPoolKeys(at, { ...pool, creator: other })).toBeNull();
        expect(await verifyPoolKeys(at, { ...pool, tokenVault: other })).toBeNull();
        expect(await verifyPoolKeys(at, { ...pool, quoteVault: pool.tokenVault })).toBeNull();
    });

    it('adds the clock offset to the local time', () => {
        const now = BigInt(Math.floor(Date.now() / 1000));
        expect(chainNow(0) - now).toBeLessThanOrEqual(1n);
        expect(chainNow(-30) - now).toBeLessThanOrEqual(-29n);
    });

    it('reads as of a slot, so a trade that just landed is included', async () => {
        const configs: unknown[] = [];
        const rpc = {
            getMultipleAccounts: (_addresses: unknown, config: unknown) => {
                configs.push(config);
                return { send: async () => ({ value: [null] }) };
            },
        } as unknown as Rpc;
        const at = address(vectors.pools[0].keys.address);
        expect((await readVerifiedPools(rpc, [at], 520_929_434n)).size).toBe(0);
        expect((await readVerifiedPools(rpc, [at])).size).toBe(0);
        expect(configs).toEqual([
            { encoding: 'base64', commitment: 'confirmed', minContextSlot: 520_929_434n },
            { encoding: 'base64', commitment: 'confirmed' },
        ]);
    });
});

describe('reading after a trade', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const behind = () =>
        new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, { contextSlot: 1n });

    it('asks again while the node is behind the slot', async () => {
        vi.useFakeTimers();
        let calls = 0;
        const result = withRetryWhileBehind(async () => {
            calls++;
            if (calls < 3) {
                throw behind();
            }
            return 'fresh';
        });
        await vi.runAllTimersAsync();
        expect(await result).toBe('fresh');
        expect(calls).toBe(3);
    });

    it('gives up after ten tries, and never retries other errors', async () => {
        vi.useFakeTimers();
        let calls = 0;
        const stuck = withRetryWhileBehind(async () => {
            calls++;
            throw behind();
        });
        const caught = stuck.catch((error: unknown) => error);
        await vi.runAllTimersAsync();
        expect(await caught).toBeInstanceOf(SolanaError);
        expect(calls).toBe(10);

        let other = 0;
        await expect(
            withRetryWhileBehind(async () => {
                other++;
                throw new Error('HTTP 500');
            }),
        ).rejects.toThrow('HTTP 500');
        expect(other).toBe(1);
    });
});
