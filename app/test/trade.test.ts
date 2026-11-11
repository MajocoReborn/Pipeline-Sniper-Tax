// Quotes and the buy and sell transactions.

import { address, compileTransaction, createNoopSigner, getTransactionEncoder, type Instruction } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';

import { MAX_TRANSACTION_SIZE, launchMessage } from '../src/launch/transactions.js';
import { SIGNATURE_FEE } from '../src/launch/chain.js';
import {
    CLOCK_MARGIN_SECS,
    maxSellable,
    quoteTrade,
    tradeInstructions,
    tradeSpendProblem,
} from '../src/market/trade.js';
import { PIPELINE_PROGRAM_ADDRESS, pipelineFee } from '../src/vendor/pipeline/index.js';

import { verifiedFromVector } from './helpers.js';

const trader = createNoopSigner(address('GuoMTwRcXWzFkWkdjZ3qAYGLc14UFYLfHtk4njwKTvQT'));
const launchTs = 1_800_000_000n;
const reserves = { reserveQuote: 100_000_000n, reserveToken: 900_000_000_000_000n, launchTs };
const lifetime = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0n };

function size(instructions: Instruction[]): number {
    return getTransactionEncoder().encode(compileTransaction(launchMessage(trader, instructions, lifetime))).length;
}

describe('trade quotes', () => {
    it('charge a sniper the schedule, and leave room for the clock', async () => {
        // Vector pool 0: 99% falling to 0% over 90 seconds.
        const verified = await verifiedFromVector(0, reserves);
        const q = quoteTrade(verified, 'buy', trader.address, 10_000_000n, launchTs + 45n, 100);
        if ('error' in q) {
            throw new Error(q.error);
        }
        expect(q.taxBps).toBe(4_950);
        expect(q.quote.creatorTax + q.quote.protocolFee).toBe(4_950_000n);
        expect(q.pipelineFee).toBe(25_000n);
        // The minimum assumes the rate of two seconds earlier, then takes off 1%.
        const earlier = quoteTrade(verified, 'buy', trader.address, 10_000_000n, launchTs + 45n - CLOCK_MARGIN_SECS, 0);
        if ('error' in earlier) {
            throw new Error(earlier.error);
        }
        expect(earlier.quote.amountOut).toBeLessThan(q.quote.amountOut);
        expect(q.minAmountOut).toBe((earlier.quote.amountOut * 9_900n) / 10_000n);
    });

    it('charge no tax after the window, on sells, or to the creator', async () => {
        const verified = await verifiedFromVector(0, reserves);
        const later = quoteTrade(verified, 'buy', trader.address, 10_000_000n, launchTs + 600n, 100);
        const sell = quoteTrade(verified, 'sell', trader.address, 10n ** 12n, launchTs, 100);
        const creator = quoteTrade(verified, 'buy', verified.pool.creator, 10_000_000n, launchTs, 100);
        for (const q of [later, sell, creator]) {
            expect('error' in q ? q.error : q.taxBps).toBe(0);
        }
    });

    it('refuse what cannot trade', async () => {
        const pending = await verifiedFromVector(0, { ...reserves, status: 'pending' });
        const otherQuote = await verifiedFromVector(1, reserves);
        const live = await verifiedFromVector(0, reserves);
        expect(quoteTrade(pending, 'buy', trader.address, 1_000n, launchTs, 100)).toHaveProperty('error');
        expect(quoteTrade(otherQuote, 'buy', trader.address, 1_000n, launchTs, 100)).toHaveProperty('error');
        expect(quoteTrade(live, 'buy', trader.address, 0n, launchTs, 100)).toHaveProperty('error');
        expect(quoteTrade(live, 'buy', trader.address, 1n, launchTs, 100)).toHaveProperty('error');
    });

    it('leave room for the fee when selling everything', () => {
        for (const balance of [0n, 1n, 401n, 10_025n, 123_456_789n, 10n ** 15n]) {
            const amount = maxSellable(balance);
            expect(amount + pipelineFee(amount)).toBeLessThanOrEqual(balance);
            expect(amount + 1n + pipelineFee(amount + 1n)).toBeGreaterThan(balance);
        }
    });
});

describe('trade transactions', () => {
    it('wrap the SOL and fee for a buy, and unwrap what is left', async () => {
        const verified = await verifiedFromVector(0, reserves);
        const ixs = await tradeInstructions({
            trader,
            verified,
            side: 'buy',
            amountIn: 10_000_000n,
            minAmountOut: 123n,
            closeQuoteAccount: true,
        });
        expect(ixs.map((ix) => ix.programAddress)).toEqual([
            ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
            SYSTEM_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
            ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
            PIPELINE_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
        ]);
        // The transfer wraps the input plus Pipeline's fee: system transfer data is [2, u64 LE].
        const transfer = new DataView(ixs[1]!.data!.buffer, ixs[1]!.data!.byteOffset);
        expect(transfer.getBigUint64(4, true)).toBe(10_025_000n);
        expect(size(ixs)).toBeLessThanOrEqual(MAX_TRANSACTION_SIZE);
    });

    it('sell into wrapped SOL and keep an existing wrapped-SOL account', async () => {
        const verified = await verifiedFromVector(0, reserves);
        const base = { trader, verified, side: 'sell' as const, amountIn: 10n ** 12n, minAmountOut: 1n };
        const closing = await tradeInstructions({ ...base, closeQuoteAccount: true });
        const keeping = await tradeInstructions({ ...base, closeQuoteAccount: false });
        expect(closing.map((ix) => ix.programAddress)).toEqual([
            ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
            PIPELINE_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
        ]);
        expect(keeping).toHaveLength(2);
        expect(size(closing)).toBeLessThanOrEqual(MAX_TRANSACTION_SIZE);
    });
});

describe('the check before a trade is sent', () => {
    const before = 1_000_000_000n;
    const amountIn = 10_000_000n;
    const minAmountOut = 9_778_000n;
    // The figures of the buy and the sell through the page on devnet (11 November).
    const rent = 1_513_840n;
    const check = (side: 'buy' | 'sell', after: bigint | null, tokenAccountRent: bigint, unwrap: boolean) =>
        tradeSpendProblem({ side, before, after, amountIn, minAmountOut, tokenAccountRent, unwrap });

    it('lets a buy spend exactly what the page showed, and no more', () => {
        const shown = amountIn + pipelineFee(amountIn) + SIGNATURE_FEE;
        expect(check('buy', before - shown, 0n, true)).toBeNull();
        expect(check('buy', before - shown - rent, rent, true)).toBeNull();
        expect(check('buy', before - shown - 1n, 0n, true)).toMatch(/more than/);
        expect(check('buy', before - shown - rent - 1n, rent, true)).toMatch(/more than/);
        expect(check('buy', null, 0n, true)).toMatch(/could not be read/);
    });

    it('lets a sell pay out at least the minimum, or cost only the fee when it stays wrapped', () => {
        expect(check('sell', before + minAmountOut - SIGNATURE_FEE, 0n, true)).toBeNull();
        expect(check('sell', before + 9_877_328n, 0n, true)).toBeNull();
        expect(check('sell', before + minAmountOut - SIGNATURE_FEE - 1n, 0n, true)).toMatch(/less than/);
        expect(check('sell', before - SIGNATURE_FEE, 0n, false)).toBeNull();
        expect(check('sell', before - SIGNATURE_FEE - 1n, 0n, false)).toMatch(/less than/);
    });
});
