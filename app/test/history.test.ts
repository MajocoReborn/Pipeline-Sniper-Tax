// The tax each trade paid, worked back from the pool's reserves: against a real devnet trade,
// and against simulated trading with the pool's own maths.

import { address, type Address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';

import {
    NATIVE_MINT,
    poolKeys,
    quoteExactIn,
    quoteExactOut,
    taxBpsAt,
    type LaunchPool,
    type PoolKeys,
} from '../src/client/index.js';
import type { ApiTrade } from '../src/market/api.js';
import { taxHistory } from '../src/market/history.js';

const CREATOR = address('5frqE7XgGfsz6bmjCK4ABpkChuGJEsFcZSURNxL53vve');
const MINT = address('FvwwZZNuXmuCXEhP7y8Zsr9i7WYwL9Z7GvVMEFsPxxcw');
const SNIPER = address('3u344KkiHJsJF5xucdH5dDHsbHuCL3NtQbdPUKxjn3Zt');
const OTHER = address('GuoMTwRcXWzFkWkdjZ3qAYGLc14UFYLfHtk4njwKTvQT');

function pool(fields: Partial<LaunchPool>): LaunchPool {
    return {
        version: 1,
        status: 'live',
        bump: 255,
        creator: CREATOR,
        tokenMint: MINT,
        quoteMint: NATIVE_MINT,
        tokenVault: CREATOR,
        quoteVault: CREATOR,
        marketSigner: CREATOR,
        reserveToken: 0n,
        reserveQuote: 0n,
        accruedTaxQuote: 0n,
        accruedProtocolQuote: 0n,
        taxStartBps: 9_900,
        taxEndBps: 0,
        taxDurationSecs: 90,
        protocolTaxShareBps: 1_000,
        launchFeeLamports: 10_000_000n,
        launchTs: 0n,
        reserved: new Uint8Array(64),
        ...fields,
    };
}

function keysFor(p: LaunchPool): Promise<PoolKeys> {
    return poolKeys(
        { creator: p.creator, taxStartBps: p.taxStartBps, taxEndBps: p.taxEndBps, taxDurationSecs: p.taxDurationSecs },
        p.tokenMint,
        TOKEN_2022_PROGRAM_ADDRESS,
        p.quoteMint,
        TOKEN_PROGRAM_ADDRESS,
    );
}

function trade(fields: Partial<ApiTrade> & Pick<ApiTrade, 'netSent' | 'received' | 'blockTime'>): ApiTrade {
    return {
        signature: '5kDYYNwt1poZiNZDJtJogPoKL7XcMCPp7E1RFaq1wZ4fHTiMoEf9KMNhZqsvWg9Qp5dKPp5VuCUZLbbfR4qiBiLK',
        slot: 1n,
        trader: SNIPER,
        inputMint: NATIVE_MINT,
        outputMint: MINT,
        mode: 'exact_in',
        pipelineFee: 0n,
        integratorFee: 0n,
        ...fields,
    };
}

describe('the tax each trade paid', () => {
    it('matches the buy from the devnet end-to-end test', async () => {
        // Pool GAw4Zbn3… after the buy, and the buy as Pipeline's API reports it (10 November).
        const p = pool({ reserveToken: 897_129_186_602_871n, reserveQuote: 100_320_000n, launchTs: 1_794_346_050n });
        const buy = trade({
            netSent: 10_000_000n,
            received: 2_870_813_397_129n,
            blockTime: Date.parse('2026-11-10T21:27:33Z') / 1000,
            slot: 520_877_620n,
        });
        const history = taxHistory(p, await keysFor(p), [buy]);
        expect(history.complete).toBe(true);
        expect(history.trades[0]).toMatchObject({ side: 'buy', byCreator: false, taxBps: 9_680, tax: 9_680_000n });
        // The block time is a second off the program's clock here: the walk finds the rate it paid.
        expect(history.trades[0]!.estimatedTaxBps).toBe(9_570);
        // Back to the pool as launched: 900 million tokens against 0.1 SOL.
        expect(history.oldestReserves).toEqual({ quote: 100_000_000n, token: 900_000_000_000_000n });
        expect(history.trades[0]!.reservesAfter).toEqual({ quote: p.reserveQuote, token: p.reserveToken });
    });

    it('accounts for a simulated sniper rush, sells, the creator and exact-out trades', async () => {
        const launchTs = 1_800_000_000n;
        let seed = 7;
        const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
        const start = pool({ launchTs, taxEndBps: 100 });
        let reserves = { quote: 100_000_000n, token: 900_000_000_000_000n };
        const truth = new Map<string, number>();
        const trades: ApiTrade[] = [];
        let accrued = 0n;
        for (let n = 0; n < 40; n++) {
            // Five buys in the launch slot, then trades over two and a half minutes.
            const slot = n < 5 ? 100n : 100n + BigInt(n) * 10n;
            const blockTime = Number(launchTs) + (n < 5 ? 0 : n * 4);
            const clock = BigInt(blockTime + Math.floor(random() * 3) - 1); // the program's clock, ±1 s
            const sell = n >= 5 && random() < 0.3;
            const byCreator = !sell && random() < 0.1;
            const exactOut = random() < 0.3;
            const rate =
                sell || byCreator ? 0 : taxBpsAt({ startBps: 9_900, endBps: 100, durationSecs: 90 }, launchTs, clock);
            const pricing = {
                reserveIn: sell ? reserves.token : reserves.quote,
                reserveOut: sell ? reserves.quote : reserves.token,
                taxBps: rate,
                protocolShareBps: 1_000,
            };
            const amount = sell
                ? BigInt(Math.floor(random() * 5e12)) + 1n
                : exactOut
                  ? BigInt(Math.floor(random() * 2e12)) + 1n
                  : BigInt(Math.floor(random() * 3e7)) + 1n;
            const result = exactOut && !sell ? quoteExactOut(pricing, amount) : quoteExactIn(pricing, amount);
            if (!result.ok) {
                throw new Error(result.error);
            }
            const q = result.quote;
            reserves = sell
                ? { quote: q.newReserveOut, token: q.newReserveIn }
                : { quote: q.newReserveIn, token: q.newReserveOut };
            accrued += q.creatorTax + q.protocolFee;
            const signature = `${'1'.repeat(60)}${String(n).padStart(4, 'A')}`;
            truth.set(signature, rate);
            trades.push(
                trade({
                    signature,
                    slot,
                    blockTime,
                    trader: byCreator ? CREATOR : n % 2 ? SNIPER : OTHER,
                    inputMint: sell ? MINT : NATIVE_MINT,
                    outputMint: sell ? NATIVE_MINT : MINT,
                    mode: exactOut && !sell ? 'exact_out' : 'exact_in',
                    netSent: q.amountIn,
                    received: q.amountOut,
                }),
            );
        }
        const p = { ...start, reserveQuote: reserves.quote, reserveToken: reserves.token };
        // Newest first, as the API lists them, but the launch slot oldest first: the walk
        // has to find the order in which those trades really happened.
        const listed = [...trades.filter((t) => t.slot !== 100n).reverse(), ...trades.filter((t) => t.slot === 100n)];
        const history = taxHistory(p, await keysFor(p), listed);
        expect(history.complete).toBe(true);
        expect(history.trades).toHaveLength(40);
        for (const t of history.trades) {
            expect(t.taxBps, t.trade.signature).toBe(truth.get(t.trade.signature));
        }
        expect(history.trades.reduce((sum, t) => sum + (t.tax ?? 0n), 0n)).toBe(accrued);
        expect(history.oldestReserves).toEqual({ quote: 100_000_000n, token: 900_000_000_000_000n });
        // Each trade's reserves after are the next older trade's reserves before, checked by the walk itself.
        expect(history.trades.every((t) => t.reservesAfter !== null)).toBe(true);
        // The case covers what it should: snipers in the launch slot, the creator, sells, exact-out.
        const rush = history.trades.filter((t) => t.trade.slot === 100n && !t.byCreator);
        expect(rush.length).toBeGreaterThanOrEqual(3);
        expect(rush.every((t) => t.taxBps! >= 9_790)).toBe(true);
        expect(history.trades.some((t) => t.byCreator && t.side === 'buy' && t.taxBps === 0)).toBe(true);
        expect(history.trades.some((t) => t.side === 'sell')).toBe(true);
        expect(history.trades.some((t) => t.trade.mode === 'exact_out')).toBe(true);
    });

    it('says so when the chain has a trade the API has not listed yet', async () => {
        const p = pool({
            reserveToken: 897_129_186_602_871n - 1_000n,
            reserveQuote: 100_320_000n + 50n,
            launchTs: 1_794_346_050n,
        });
        const buy = trade({ netSent: 10_000_000n, received: 2_870_813_397_129n, blockTime: 1_794_346_053 });
        const history = taxHistory(p, await keysFor(p), [buy]);
        expect(history.complete).toBe(false);
        expect(history.trades[0]).toMatchObject({ taxBps: null, tax: null, estimatedTaxBps: 9_570 });
    });

    it('ignores trades in other mints', async () => {
        const p = pool({ reserveToken: 1n, reserveQuote: 1n });
        const foreign: Address = address('So11111111111111111111111111111111111111112');
        const history = taxHistory(p, await keysFor(p), [
            trade({ netSent: 1n, received: 1n, blockTime: 0, inputMint: foreign, outputMint: foreign }),
        ]);
        expect(history.trades).toHaveLength(0);
        expect(history.complete).toBe(true);
    });
});
