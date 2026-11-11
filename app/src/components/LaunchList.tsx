// Every launch Pipeline's API lists for our program, checked on the chain first: a market
// whose pool doesn't verify, or that trades against another token than SOL, is left out. Tax,
// price and the token's checks come from the chain; the API adds only trades and volume.

import { useState } from 'react';

import { NATIVE_MINT, currentTaxBps, secondsUntilWindowEnds } from '../client/index.js';
import { formatAge, formatDuration, formatSignificant, formatSol } from '../launch/units.js';
import { listMarkets, type ApiMarket, type MarketSort } from '../market/api.js';
import { isSolPool, readVerifiedPools, type VerifiedPool } from '../market/pools.js';
import { tokenView, trustChecks } from '../market/view.js';
import { href } from '../route.js';
import { Loading, Tax, TokenImage } from './common.js';
import { siteRpc, useChainNow, usePolled } from './hooks.js';

type Filter = 'newest' | 'taxed' | 'traded';

const FILTERS: { id: Filter; label: string }[] = [
    { id: 'newest', label: 'New' },
    { id: 'taxed', label: 'Tax still running' },
    { id: 'traded', label: 'Most traded (24 h)' },
];

type Row = { market: ApiMarket; verified: VerifiedPool };

async function loadRows(sort: MarketSort): Promise<{ rows: Row[]; hidden: number }> {
    const markets = await listMarkets(sort, 50);
    const pools = await readVerifiedPools(
        siteRpc,
        markets.map((m) => m.pool),
    );
    const rows: Row[] = [];
    for (const market of markets) {
        const verified = pools.get(market.pool);
        if (verified && verified.keys.market === market.address && isSolPool(verified)) {
            rows.push({ market, verified });
        }
    }
    return { rows, hidden: markets.length - rows.length };
}

function LaunchRow({ row, now }: { row: Row; now: bigint }) {
    const { market, verified } = row;
    const view = tokenView(verified);
    const tax = currentTaxBps(verified.pool, now);
    const left = Number(secondsUntilWindowEnds(verified.pool, now));
    const failing = trustChecks(verified).filter((c) => !c.ok);
    const volume = market.volume24h.get(NATIVE_MINT) ?? 0n;
    return (
        <li>
            <a className="launch-row" href={href.pool(verified.address)}>
                <TokenImage uri={view.uri} symbol={view.symbol} />
                <span className="launch-name">
                    <strong>
                        <bdi>{view.name}</bdi>
                    </strong>
                    <span className="muted">
                        <bdi>{view.symbol}</bdi> · {formatAge(Number(now) - market.createdAt)} old
                    </span>
                </span>
                <span className="launch-tax">
                    <Tax bps={tax} />
                    <span className="muted">
                        {left > 0
                            ? `for ${formatDuration(left)}`
                            : verified.pool.status === 'live'
                              ? 'for good'
                              : 'not live'}
                    </span>
                </span>
                <span className="launch-stat">
                    <span>{formatSol(view.marketValue, 2)} SOL</span>
                    <span className="muted">{formatSignificant(view.price)} per token</span>
                </span>
                <span className="launch-stat">
                    <span>
                        {market.trades24h} trade{market.trades24h === 1 ? '' : 's'}
                    </span>
                    <span className="muted">{formatSol(volume, 3)} SOL, 24 h</span>
                </span>
                <span className={failing.length === 0 ? 'checks ok' : 'checks warn'}>
                    {failing.length === 0 ? 'All checks pass' : failing.map((c) => c.label).join(', ') + ': no'}
                </span>
            </a>
        </li>
    );
}

export function LaunchList() {
    const [filter, setFilter] = useState<Filter>('newest');
    const now = useChainNow();
    const sort: MarketSort = filter === 'traded' ? 'trades_24h' : 'newest';
    const { data, error } = usePolled(() => loadRows(sort), [sort], 15_000);
    const rows =
        data?.rows.filter((r) => filter !== 'taxed' || secondsUntilWindowEnds(r.verified.pool, now) > 0n) ?? [];
    return (
        <section className="card">
            <div className="list-head">
                <h2>Launches</h2>
                <div className="tabs" role="tablist">
                    {FILTERS.map((f) => (
                        <button
                            key={f.id}
                            type="button"
                            role="tab"
                            aria-selected={filter === f.id}
                            className={filter === f.id ? 'tab selected' : 'tab'}
                            onClick={() => setFilter(f.id)}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>
            {error && !data ? <p className="error">Could not load the launches: {error}</p> : null}
            {!data && !error ? <Loading what="launches from Pipeline and the chain" /> : null}
            {data ? (
                rows.length > 0 ? (
                    <ul className="launches">
                        {rows.map((row) => (
                            <LaunchRow key={row.market.address} row={row} now={now} />
                        ))}
                    </ul>
                ) : (
                    <p className="muted">
                        {filter === 'taxed' ? 'No launch has its sniper tax running right now.' : 'No launches yet.'}
                    </p>
                )
            ) : null}
            {data && data.hidden > 0 ? (
                <p className="muted">
                    {data.hidden} market{data.hidden === 1 ? '' : 's'} left out: the pool did not verify on the chain,
                    or trades against another token than SOL.
                </p>
            ) : null}
            <p className="muted">
                Tax, price and checks are read from the chain; trades and volume from Pipeline's API.
            </p>
        </section>
    );
}
