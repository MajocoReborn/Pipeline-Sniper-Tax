// Pipeline's API as untrusted input: real responses parse; anything malformed is dropped.

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NATIVE_MINT } from '../src/client/index.js';
import { getTrades, listMarkets, parseMarket, parseTrade } from '../src/market/api.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/pipeline-api.json', import.meta.url), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function serve(body: unknown) {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Pipeline's API", () => {
    it('parses real markets and trades', () => {
        const market = parseMarket(fixture.markets.markets[0]);
        expect(market.mints[0].symbol).toBeTypeOf('string');
        expect(market.mints[1].mint).toBe(NATIVE_MINT);
        expect(market.mints[0].supply).toBe(10n ** 15n);
        expect(market.createdAt).toBeGreaterThan(1_790_000_000);

        const trade = parseTrade(fixture.trades.trades[0]);
        expect(trade).toMatchObject({
            netSent: 10_000_000n,
            received: 2_870_813_397_129n,
            pipelineFee: 25_000n,
            mode: 'exact_in',
            inputMint: NATIVE_MINT,
        });
        expect(trade.blockTime).toBe(Date.parse('2026-11-10T21:27:33Z') / 1000);
    });

    it('drops markets that are malformed or not ours', async () => {
        const good = fixture.markets.markets[0];
        const bad = [
            { ...clone(good), strategy_program: 'PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34' },
            { ...clone(good), market_state: 'not an address' },
            { ...clone(good), mints: [clone(good.mints[0])] },
            (() => {
                const m = clone(good);
                m.mints[0].supply = '-1';
                return m;
            })(),
            (() => {
                const m = clone(good);
                m.mints[0].supply = '18446744073709551616';
                return m;
            })(),
            (() => {
                const m = clone(good);
                m.mints[0].decimals = 1e9;
                return m;
            })(),
            'just a string',
        ];
        serve({ markets: [...bad, good] });
        const markets = await listMarkets('newest');
        expect(markets).toHaveLength(1);
        expect(markets[0]!.address).toBe(good.address);
    });

    it('drops malformed trades and lists the rest newest first', async () => {
        const t = fixture.trades.trades[0];
        const older = { ...clone(t), slot: t.slot - 10 };
        serve({
            trades: [
                older,
                { ...clone(t), net_sent: 10_000_000 },
                { ...clone(t), mode: 'exact_sideways' },
                { ...clone(t), signature: '<script>' },
                { ...clone(t), trader: 'x' },
                t,
            ],
        });
        const trades = await getTrades(t.market);
        expect(trades.map((x) => x.slot)).toEqual([BigInt(t.slot), BigInt(t.slot - 10)]);
    });

    it('fails clearly when the API is down or answers nonsense', async () => {
        vi.stubGlobal('fetch', async () => new Response('busy', { status: 503 }));
        await expect(listMarkets('newest')).rejects.toThrow(/HTTP 503/);
        serve({ nope: [] });
        await expect(listMarkets('newest')).rejects.toThrow();
    });
});
