// A pool is only shown or traded if it sits at the address its own fields derive.

import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { chainNow, verifyPoolKeys } from '../src/market/pools.js';

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
});
