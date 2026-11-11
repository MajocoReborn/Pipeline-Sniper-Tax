// What the pages show about a pool: token details, trust checks and the value series.

import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { NATIVE_MINT } from '../src/client/index.js';
import type { ApiTrade } from '../src/market/api.js';
import { taxHistory } from '../src/market/history.js';
import { tokenView, trustChecks, valueSeries } from '../src/market/view.js';
import type { MintInspection } from '../src/vendor/pipeline/index.js';

import { verifiedFromVector } from './helpers.js';

const someone = address('GuoMTwRcXWzFkWkdjZ3qAYGLc14UFYLfHtk4njwKTvQT');

function mint(fields: Partial<MintInspection> = {}): MintInspection {
    return {
        mint: someone,
        tokenProgram: someone,
        decimals: 6,
        supply: 10n ** 15n,
        mintAuthority: null,
        freezeAuthority: null,
        extensions: {
            metadataPointer: { authority: null, metadataAddress: someone },
            tokenMetadata: {
                updateAuthority: null,
                mint: someone,
                name: 'Fair Token',
                symbol: 'FAIR',
                uri: 'https://example.com/fair.png',
                additionalMetadata: [],
            },
        },
        extensionTypes: [18, 19],
        unknownExtensions: [],
        flags: ['token-2022'],
        ...fields,
    };
}

describe('the token view', () => {
    it('takes the name and price from the chain', async () => {
        const v = {
            ...(await verifiedFromVector(0, { reserveQuote: 100_000_000n, reserveToken: 900_000_000_000_000n })),
            mint: mint(),
        };
        const view = tokenView(v);
        expect(view).toMatchObject({ name: 'Fair Token', symbol: 'FAIR', decimals: 6, inPoolBps: 9_000 });
        expect(view.marketValue).toBe(111_111_111n);
        expect(view.price).toBeCloseTo(1.111e-10, 13);
    });

    it('passes a site launch and flags what a buyer should know', async () => {
        const base = await verifiedFromVector(0);
        const labels = (m: MintInspection | null) =>
            trustChecks({ ...base, mint: m })
                .filter((c) => !c.ok)
                .map((c) => c.label);
        expect(labels(mint())).toEqual([]);
        expect(labels(mint({ mintAuthority: someone }))).toEqual(['Fixed supply']);
        expect(labels(mint({ freezeAuthority: someone }))).toEqual(['No freezing']);
        const editable = mint();
        editable.extensions.tokenMetadata!.updateAuthority = someone;
        expect(labels(editable)).toEqual(['Name and image fixed']);
        expect(labels(mint({ flags: ['token-2022', 'transfer-fee', 'permanent-delegate'] }))).toEqual([
            'No risky extensions',
        ]);
        expect(labels(null)).toEqual(['Readable token']);
        expect(labels(mint({ extensions: {} }))).toEqual(['Name and image fixed']);
    });

    it('charts the value from the reserves, not the taxed price the sniper paid', async () => {
        const launchTs = 1_794_346_050n;
        const v = {
            ...(await verifiedFromVector(0, {
                reserveQuote: 100_320_000n,
                reserveToken: 897_129_186_602_871n,
                launchTs,
            })),
            mint: mint(),
        };
        const buy: ApiTrade = {
            signature: '5kDYYNwt1poZiNZDJtJogPoKL7XcMCPp7E1RFaq1wZ4fHTiMoEf9KMNhZqsvWg9Qp5dKPp5VuCUZLbbfR4qiBiLK',
            slot: 1n,
            blockTime: 1_794_346_053,
            trader: someone,
            inputMint: NATIVE_MINT,
            outputMint: v.keys.tokenMint,
            mode: 'exact_in',
            netSent: 10_000_000n,
            received: 2_870_813_397_129n,
            pipelineFee: 25_000n,
            integratorFee: 0n,
        };
        const points = valueSeries(v, taxHistory(v.pool, v.keys, [buy]), launchTs + 100n);
        expect(points.map((p) => p.time)).toEqual([1_794_346_053, 1_794_346_053, 1_794_346_150]);
        expect(points[0]!.value).toBe(111_111_111n);
        // About 0.1118 SOL after the buy; the price the sniper paid would put it at 3.48 SOL.
        expect(points[1]!.value).toBe((100_320_000n * 10n ** 15n) / 897_129_186_602_871n);
        expect(points[2]!.value).toBe(points[1]!.value);
    });
});
