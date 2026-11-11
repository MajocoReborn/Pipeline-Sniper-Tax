// The tax each trade paid, worked out exactly. The program keeps only running totals, so
// the site walks back from the pool's current reserves through its trades, newest first.
// For each trade it finds the rate (from the pool's schedule, near the trade's block time)
// at which the pool's own maths turns the reserves before the trade into the reserves after
// it, with exactly the trade's amounts. Claims and sweeps don't touch the reserves, so they
// don't get in the way.

import {
    poolSchedule,
    quoteExactIn,
    quoteExactOut,
    splitGross,
    taxBpsAt,
    type LaunchPool,
    type PoolKeys,
    type Side,
} from '../client/index.js';
import type { ApiTrade } from './api.js';

/** The program's clock and the block time the API reports can differ by a second or two. */
const CLOCK_SLACK_SECS = 5;
/** Trades in one slot (snipers often share the launch slot) may come in any order. */
const MAX_SLOT_GROUP = 6;

export type TaxedTrade = {
    trade: ApiTrade;
    side: Side;
    byCreator: boolean;
    /** The rate it paid, exactly; `null` when the walk couldn't account for it. */
    taxBps: number | null;
    /** The tax, in the quote mint's smallest unit; `null` like `taxBps`. */
    tax: bigint | null;
    /** The schedule's rate at its block time: what to show, marked as approximate, without `taxBps`. */
    estimatedTaxBps: number;
    /** The pool's reserves right after it, when the walk accounted for it. */
    reservesAfter: Reserves | null;
};

export type TaxHistory = {
    trades: TaxedTrade[];
    /** Every trade was accounted for. `false` usually means the API hasn't caught up with the chain yet. */
    complete: boolean;
    /** The reserves before the oldest trade accounted for (at launch, if every trade is listed). */
    oldestReserves: Reserves;
};

export type Reserves = { quote: bigint; token: bigint };

function sideOf(trade: ApiTrade, keys: PoolKeys): Side | null {
    if (trade.inputMint === keys.quoteMint && trade.outputMint === keys.tokenMint) {
        return 'buy';
    }
    if (trade.inputMint === keys.tokenMint && trade.outputMint === keys.quoteMint) {
        return 'sell';
    }
    return null;
}

type Item = { trade: ApiTrade; side: Side; byCreator: boolean; rates: number[] };

/** Rates to try, nearest the block time first. Sells and the creator's buys pay none. */
function candidateRates(pool: LaunchPool, trade: ApiTrade, side: Side, byCreator: boolean): number[] {
    if (side === 'sell' || byCreator) {
        return [0];
    }
    const schedule = poolSchedule(pool);
    const rates: number[] = [];
    for (let d = 0; d <= CLOCK_SLACK_SECS; d++) {
        for (const t of d === 0 ? [trade.blockTime] : [trade.blockTime - d, trade.blockTime + d]) {
            const rate = taxBpsAt(schedule, pool.launchTs, BigInt(t));
            if (!rates.includes(rate)) {
                rates.push(rate);
            }
        }
    }
    return rates;
}

/** The reserves before `item`'s trade at `taxBps`, if the pool's maths gives exactly `after`. */
export function reservesBefore(
    pool: LaunchPool,
    item: Pick<Item, 'trade' | 'side'>,
    after: Reserves,
    taxBps: number,
): Reserves | null {
    const { trade, side } = item;
    const buy = side === 'buy';
    const { effective } = splitGross(trade.netSent, taxBps);
    const inAfter = buy ? after.quote : after.token;
    const outAfter = buy ? after.token : after.quote;
    const reserveIn = inAfter - effective;
    const reserveOut = outAfter + trade.received;
    if (reserveIn <= 0n) {
        return null;
    }
    const pricing = { reserveIn, reserveOut, taxBps, protocolShareBps: pool.protocolTaxShareBps };
    const result =
        trade.mode === 'exact_in' ? quoteExactIn(pricing, trade.netSent) : quoteExactOut(pricing, trade.received);
    if (
        !result.ok ||
        result.quote.amountIn !== trade.netSent ||
        result.quote.amountOut !== trade.received ||
        result.quote.newReserveIn !== inAfter ||
        result.quote.newReserveOut !== outAfter
    ) {
        return null;
    }
    return buy ? { quote: reserveIn, token: reserveOut } : { quote: reserveOut, token: reserveIn };
}

type Walk = { rates: number[]; befores: Reserves[] };

/**
 * Rates for `order` (newest first) that lead back from `after`, by depth-first search, with
 * the reserves before each trade.
 */
function walk(pool: LaunchPool, order: Item[], after: Reserves, i = 0): Walk | null {
    if (i === order.length) {
        return { rates: [], befores: [] };
    }
    for (const rate of order[i]!.rates) {
        const before = reservesBefore(pool, order[i]!, after, rate);
        const rest = before && walk(pool, order, before, i + 1);
        if (rest) {
            return { rates: [rate, ...rest.rates], befores: [before, ...rest.befores] };
        }
    }
    return null;
}

/** Every order of `items`, the given one first. */
function* orders<T>(items: T[]): Generator<T[]> {
    if (items.length <= 1) {
        yield items;
        return;
    }
    for (let i = 0; i < items.length; i++) {
        const rest = [...items.slice(0, i), ...items.slice(i + 1)];
        for (const tail of orders(rest)) {
            yield [items[i]!, ...tail];
        }
    }
}

/** `trades` (newest first, from the API) with the tax each one paid on `pool`. */
export function taxHistory(pool: LaunchPool, keys: PoolKeys, trades: readonly ApiTrade[]): TaxHistory {
    const items: Item[] = [];
    for (const trade of trades) {
        const side = sideOf(trade, keys);
        if (side) {
            const byCreator = trade.trader === pool.creator;
            items.push({ trade, side, byCreator, rates: candidateRates(pool, trade, side, byCreator) });
        }
    }
    const exact = new Map<ApiTrade, { rate: number; after: Reserves }>();
    let after: Reserves = { quote: pool.reserveQuote, token: pool.reserveToken };
    let complete = pool.status === 'live';
    for (let i = 0; complete && i < items.length;) {
        let j = i;
        while (j < items.length && items[j]!.trade.slot === items[i]!.trade.slot) {
            j++;
        }
        const group = items.slice(i, j);
        let solved: (Walk & { order: Item[] }) | null = null;
        for (const order of group.length <= MAX_SLOT_GROUP ? orders(group) : [group]) {
            const result = walk(pool, order, after);
            if (result) {
                solved = { ...result, order };
                break;
            }
        }
        if (!solved) {
            complete = false;
            break;
        }
        const groupAfter = after;
        solved.order.forEach((item, k) =>
            exact.set(item.trade, { rate: solved.rates[k]!, after: k === 0 ? groupAfter : solved.befores[k - 1]! }),
        );
        after = solved.befores.at(-1) ?? after;
        i = j;
    }
    const schedule = poolSchedule(pool);
    return {
        complete,
        oldestReserves: after,
        trades: items.map(({ trade, side, byCreator }) => {
            const found = exact.get(trade);
            const taxBps = found?.rate ?? null;
            return {
                trade,
                side,
                byCreator,
                taxBps,
                tax: taxBps === null ? null : side === 'buy' ? splitGross(trade.netSent, taxBps).tax : 0n,
                estimatedTaxBps:
                    side === 'sell' || byCreator ? 0 : taxBpsAt(schedule, pool.launchTs, BigInt(trade.blockTime)),
                reservesAfter: found?.after ?? null,
            };
        }),
    };
}
