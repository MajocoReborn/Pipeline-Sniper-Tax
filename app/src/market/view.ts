// What the pages show about a verified pool, derived from the chain only: the token's name and
// image from its own metadata, price and market value from the reserves, and the checks a
// buyer cares about from the mint's authorities and extensions.

import { shortAddress } from '../launch/units.js';
import { EXTENSION_TYPES, FLAG_DESCRIPTIONS, type Flag } from '../vendor/pipeline/index.js';
import type { Reserves, TaxHistory } from './history.js';
import type { VerifiedPool } from './pools.js';

const SOL_DECIMALS = 9;

export type TokenView = {
    name: string;
    symbol: string;
    /** The metadata's link: an image, or a JSON document with one. */
    uri: string | null;
    decimals: number;
    supply: bigint;
    /** SOL per whole token at the pool's price. */
    price: number;
    /** The whole supply at the pool's price, in lamports. */
    marketValue: bigint;
    /** The share of the supply in the pool, in basis points. */
    inPoolBps: number;
};

export function tokenView(v: VerifiedPool): TokenView {
    const metadata = v.mint?.extensions.tokenMetadata;
    const decimals = v.mint?.decimals ?? 0;
    const supply = v.mint?.supply ?? 0n;
    const { reserveQuote, reserveToken } = v.pool;
    const price =
        reserveToken > 0n ? (Number(reserveQuote) / Number(reserveToken)) * 10 ** (decimals - SOL_DECIMALS) : 0;
    return {
        name: metadata?.name || 'Unnamed token',
        symbol: metadata?.symbol || shortAddress(v.pool.tokenMint),
        uri: metadata?.uri || null,
        decimals,
        supply,
        price,
        marketValue: reserveToken > 0n ? (reserveQuote * supply) / reserveToken : 0n,
        inPoolBps: supply > 0n ? Number((reserveToken * 10_000n) / supply) : 0,
    };
}

export type TrustCheck = { label: string; ok: boolean; detail: string };

const EXTENSION_NAMES = new Map<number, string>(Object.entries(EXTENSION_TYPES).map(([name, type]) => [type, name]));

/** The token's names for its Token-2022 extensions, in account order. */
export function extensionNames(v: VerifiedPool): string[] {
    return (v.mint?.extensionTypes ?? []).map((type) => EXTENSION_NAMES.get(type) ?? `unknown (${type})`);
}

/** What a buyer should know about the token, each as passed or not. */
export function trustChecks(v: VerifiedPool): TrustCheck[] {
    const mint = v.mint;
    if (!mint) {
        return [{ label: 'Readable token', ok: false, detail: 'The token mint could not be read from the chain.' }];
    }
    const metadata = mint.extensions.tokenMetadata;
    const pointer = mint.extensions.metadataPointer;
    const checks: TrustCheck[] = [
        {
            label: 'Fixed supply',
            ok: mint.mintAuthority === null,
            detail:
                mint.mintAuthority === null
                    ? 'Nobody can mint more.'
                    : `${mint.mintAuthority} can mint more tokens at any time.`,
        },
        {
            label: 'No freezing',
            ok: mint.freezeAuthority === null,
            detail:
                mint.freezeAuthority === null
                    ? 'Nobody can freeze token accounts.'
                    : `${mint.freezeAuthority} can freeze any holder's tokens.`,
        },
        {
            label: 'Name and image fixed',
            ok: metadata !== undefined && metadata.updateAuthority === null && (!pointer || pointer.authority === null),
            detail: !metadata
                ? 'The mint holds no metadata. It may use a separate metadata account, which this site does not read.'
                : metadata.updateAuthority !== null
                  ? `${metadata.updateAuthority} can change the name, symbol and image.`
                  : 'Nobody can change the name, symbol or image.',
        },
    ];
    // Every other flag the SDK raises for the mint is a risk to name, except plain Token-2022.
    const risks = mint.flags.filter(
        (flag: Flag) => flag !== 'token-2022' && flag !== 'mint-authority' && flag !== 'freeze-authority',
    );
    checks.push({
        label: 'No risky extensions',
        ok: risks.length === 0,
        detail:
            risks.length === 0
                ? 'No transfer fee, hook, delegate or pause.'
                : risks.map((f) => FLAG_DESCRIPTIONS[f]).join(' '),
    });
    return checks;
}

export type ValuePoint = { time: number; value: bigint };

/**
 * The market value (whole supply at the pool's price, in lamports) over time: before the
 * oldest trade accounted for, after each trade, and now. Prices come from the reserves the
 * walk in `history.ts` worked out, not from what each trader paid, which a sniper tax inflates.
 */
export function valueSeries(v: VerifiedPool, history: TaxHistory, now: bigint): ValuePoint[] {
    const supply = v.mint?.supply ?? 0n;
    const value = (r: Reserves) => (r.token > 0n ? (r.quote * supply) / r.token : 0n);
    const accounted = history.trades.filter((t) => t.reservesAfter !== null).reverse();
    const start = accounted.length > 0 ? accounted[0]!.trade.blockTime : Number(v.pool.launchTs);
    const points: ValuePoint[] = [{ time: start, value: value(history.oldestReserves) }];
    for (const t of accounted) {
        points.push({ time: t.trade.blockTime, value: value(t.reservesAfter!) });
    }
    points.push({
        time: Math.max(Number(now), points.at(-1)!.time),
        value: value({ quote: v.pool.reserveQuote, token: v.pool.reserveToken }),
    });
    return points;
}
