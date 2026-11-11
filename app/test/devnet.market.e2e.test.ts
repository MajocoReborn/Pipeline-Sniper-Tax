// Read-only, on devnet: every pool Pipeline's API lists for our program verifies on the chain,
// and the tax of every listed trade can be worked out exactly. Off by default; it spends
// nothing.
//
//   DEVNET_E2E=1 npx vitest run test/devnet.market.e2e.test.ts
//
// With DEVNET_E2E_KEYPAIR (a funded throwaway key, see devnet.e2e.test.ts) it also simulates
// a buy, once as quoted and once with an impossible minimum, without sending either.

import { readFileSync } from 'node:fs';

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { createRpc, simulate } from '../src/launch/chain.js';
import { launchMessage } from '../src/launch/transactions.js';
import { getTrades, listMarkets } from '../src/market/api.js';
import { taxHistory } from '../src/market/history.js';
import { chainNow, clockOffset, readVerifiedPools } from '../src/market/pools.js';
import { quoteTrade, tradeInstructions } from '../src/market/trade.js';

describe.skipIf(!process.env.DEVNET_E2E)("the site's devnet markets", () => {
    it('verify on chain, with an exact tax for every trade', { timeout: 120_000 }, async () => {
        const rpc = createRpc();
        const markets = await listMarkets('newest', 50);
        expect(markets.length).toBeGreaterThan(0);
        const pools = await readVerifiedPools(
            rpc,
            markets.map((m) => m.pool),
        );
        for (const market of markets) {
            const verified = pools.get(market.pool);
            expect(verified, `pool ${market.pool} verifies`).toBeDefined();
            expect(verified!.keys.market).toBe(market.address);
            const history = taxHistory(verified!.pool, verified!.keys, await getTrades(market.address));
            console.log(
                market.address,
                market.mints[0].symbol,
                history.trades.map((t) => `${t.side} ${t.taxBps ?? '?'} bps (block time says ${t.estimatedTaxBps})`),
            );
            expect(history.complete, `history of ${market.address}`).toBe(true);
        }
    });

    it.skipIf(!process.env.DEVNET_E2E_KEYPAIR)(
        'simulate a buy as quoted, and refuse one past its minimum',
        { timeout: 60_000 },
        async () => {
            const rpc = createRpc();
            const trader = await createKeyPairSignerFromBytes(
                Uint8Array.from(JSON.parse(readFileSync(process.env.DEVNET_E2E_KEYPAIR!, 'utf8'))),
            );
            const [market] = await listMarkets('newest', 1);
            const verified = (await readVerifiedPools(rpc, [market!.pool])).get(market!.pool)!;
            const now = chainNow(await clockOffset(rpc));
            const quote = quoteTrade(verified, 'buy', trader.address, 1_000_000n, now, 100);
            if ('error' in quote) {
                throw new Error(quote.error);
            }
            const { value: lifetime } = await rpc.getLatestBlockhash().send();
            for (const [minAmountOut, ok] of [
                [quote.minAmountOut, true],
                [quote.quote.amountOut * 2n, false],
            ] as const) {
                const instructions = await tradeInstructions({
                    trader,
                    verified,
                    side: 'buy',
                    amountIn: 1_000_000n,
                    minAmountOut,
                    closeQuoteAccount: true,
                });
                const simulation = await simulate(rpc, launchMessage(trader, instructions, lifetime), trader.address);
                console.log({
                    minAmountOut,
                    ok: simulation.ok,
                    error: simulation.error,
                    logs: simulation.logs.slice(-6),
                });
                expect(simulation.ok).toBe(ok);
            }
        },
    );
});
