// What the pages show about a pool: token details, trust checks and the value series.

import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { NATIVE_MINT } from '../src/client/index.js';
import type { ApiTrade } from '../src/market/api.js';
import { taxHistory } from '../src/market/history.js';
import { isSolPool } from '../src/market/pools.js';
import {
    MAX_SHOWN_NAME,
    MAX_SHOWN_SYMBOL,
    displayText,
    imageUrl,
    tokenView,
    trustChecks,
    valueSeries,
} from '../src/market/view.js';
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

describe("a token's own text and image, which anyone can set", () => {
    it('shows a name without the characters that hide or reorder text', () => {
        expect(displayText('Fair Token', MAX_SHOWN_NAME)).toBe('Fair Token');
        expect(displayText('Ünïcödé 日本語 🚀', MAX_SHOWN_NAME)).toBe('Ünïcödé 日本語 🚀');
        // A right-to-left override would show the text after it backwards, into the page's own.
        expect(displayText('Safe \u202Egnp.exe', MAX_SHOWN_NAME)).toBe('Safe gnp.exe');
        expect(displayText('\u2066US\u200BDC\u2069\uFEFF', MAX_SHOWN_NAME)).toBe('USDC');
        // Line breaks, tabs and wide spaces can't push the page's own text around.
        expect(displayText('  Line one\n\n\tLine\u2028two\u3000\u00A0end ', MAX_SHOWN_NAME)).toBe(
            'Line one Line two end',
        );
        expect(displayText('\u0000\u0007\u001B[31mred', MAX_SHOWN_NAME)).toBe('[31mred');
        // Stacked combining marks ("Zalgo") are cut to two per letter.
        expect(displayText('Z\u0351\u0351\u0351\u0351\u0351\u0351a', MAX_SHOWN_NAME)).toBe('Z\u0351\u0351a');
        expect(displayText('\u200B\u202E ', MAX_SHOWN_NAME)).toBe('');
    });

    it('cuts a long name or symbol short, by characters', () => {
        expect(displayText('x'.repeat(5_000), MAX_SHOWN_NAME)).toBe(`${'x'.repeat(MAX_SHOWN_NAME - 1)}…`);
        expect([...displayText('🚀'.repeat(50), MAX_SHOWN_SYMBOL)]).toHaveLength(MAX_SHOWN_SYMBOL);
        expect(displayText('x'.repeat(MAX_SHOWN_NAME), MAX_SHOWN_NAME)).toBe('x'.repeat(MAX_SHOWN_NAME));
    });

    it('loads an image only from an https address on a public host', () => {
        expect(imageUrl('https://example.com/fair.png')).toBe('https://example.com/fair.png');
        expect(imageUrl('https://arweave.net/abc?ext=png')).toBe('https://arweave.net/abc?ext=png');
        const refused = [
            null,
            '',
            'not a link',
            'http://example.com/a.png',
            'javascript:alert(1)',
            'data:image/svg+xml,<svg onload=alert(1)>',
            'blob:https://example.com/1',
            '//example.com/a.png',
            'https://user:secret@example.com/a.png',
            'https://example.com:8443/a.png',
            // This computer and private networks, however the address is written.
            'https://localhost/a.png',
            'https://router.local/a.png',
            'https://wiki.internal/a.png',
            'https://printer/a.png',
            'https://127.0.0.1/a.png',
            'https://2130706433/a.png',
            'https://0x7f.0.0.1/a.png',
            'https://192.168.1.1/admin',
            'https://[::1]/a.png',
            'https://[fd00::1]/a.png',
            `https://example.com/${'a'.repeat(600)}`,
        ];
        for (const uri of refused) {
            expect(imageUrl(uri), String(uri)).toBeNull();
        }
    });

    it('reach the page cleaned', async () => {
        const hostile = mint();
        hostile.extensions.tokenMetadata = {
            ...hostile.extensions.tokenMetadata!,
            name: '\u202EOfficial\n<img src=x onerror=alert(1)>' + 'A'.repeat(500),
            symbol: 'S\u200BOL\u202E',
            uri: 'https://127.0.0.1/track.gif',
        };
        const view = tokenView({ ...(await verifiedFromVector(0)), mint: hostile });
        // Markup stays text (React escapes it); only the invisible characters and the length go.
        expect(view.name).toBe(`${'Official <img src=x onerror=alert(1)>AA'.slice(0, MAX_SHOWN_NAME - 1)}…`);
        expect(view.symbol).toBe('SOL');
        expect(view.uri).toBeNull();

        const blank = mint();
        blank.extensions.tokenMetadata = { ...blank.extensions.tokenMetadata!, name: '\u200B', symbol: ' ' };
        const fallback = tokenView({ ...(await verifiedFromVector(0)), mint: blank });
        expect(fallback.name).toBe('Unnamed token');
        expect(fallback.symbol).toMatch(/^.{4}….{4}$/);
    });
});

describe('pools against another token than SOL', () => {
    it('are told apart, so their reserves are never shown as SOL', async () => {
        expect(isSolPool(await verifiedFromVector(0))).toBe(true);
        // The second vector pool trades against a Token-2022 mint of the creator's making.
        const other = await verifiedFromVector(1);
        expect(other.keys.quoteMint).not.toBe(NATIVE_MINT);
        expect(isSolPool(other)).toBe(false);
    });
});

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

    it('flags metadata that wallets read from somewhere else', async () => {
        const base = await verifiedFromVector(0);
        const failing = (m: MintInspection) =>
            trustChecks({ ...base, mint: m })
                .filter((c) => !c.ok)
                .map((c) => c.label);
        // The mint's own metadata is fixed, but the pointer sends wallets to another account.
        const elsewhere = mint();
        elsewhere.extensions.metadataPointer = { authority: null, metadataAddress: NATIVE_MINT };
        expect(failing(elsewhere)).toEqual(['Name and image fixed']);
        const unset = mint();
        unset.extensions.metadataPointer = { authority: null, metadataAddress: null };
        expect(failing(unset)).toEqual(['Name and image fixed']);
        const movable = mint();
        movable.extensions.metadataPointer = { authority: someone, metadataAddress: someone };
        expect(failing(movable)).toEqual(['Name and image fixed']);
    });

    it('flags extensions that change the balance a wallet shows (review finding L3)', async () => {
        const base = await verifiedFromVector(0);
        const check = (m: MintInspection) =>
            trustChecks({ ...base, mint: m }).find((c) => c.label === 'Balances shown as held')!;
        expect(check(mint()).ok).toBe(true);

        const scaled = mint();
        scaled.extensions.scaledUiAmount = {
            authority: someone,
            multiplier: 1_000,
            newMultiplierEffectiveTimestamp: 0n,
            newMultiplier: 1_000,
        };
        expect(check(scaled)).toMatchObject({ ok: false });
        expect(check(scaled).detail).toMatch(/multiplies.*someone can change/);
        scaled.extensions.scaledUiAmount.authority = null;
        expect(check(scaled).ok).toBe(false);
        expect(check(scaled).detail).not.toMatch(/someone can change/);

        const interest = mint();
        interest.extensions.interestBearing = {
            rateAuthority: null,
            initializationTimestamp: 0n,
            preUpdateAverageRateBps: 0,
            lastUpdateTimestamp: 0n,
            currentRateBps: 500,
        };
        expect(check(interest)).toMatchObject({ ok: false });
        expect(check(interest).detail).toMatch(/interest/);
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
