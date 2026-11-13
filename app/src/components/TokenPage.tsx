// One launch: the live tax, price and chart, the trades with the tax each paid, buying and
// selling, and what the chain says about the token. The pool is read from the chain and
// verified first; a pool that doesn't verify is not shown or traded.

import { useMemo, useRef } from 'react';
import type { Address } from '@solana/kit';
import type { UiWalletAccount } from '@wallet-standard/react';
import { PROGRAM_ID, creatorTokenAccount, currentTaxBps, secondsUntilWindowEnds } from '@majocoreborn/sniper-tax-sdk';
import { inspectProgram, marketPda } from '@pipeline-sol/sdk';

import { tokenBalance } from '../launch/chain.js';
import { formatBps, formatDuration, formatSignificant, formatSol } from '../launch/units.js';
import { getTrades } from '../market/api.js';
import { taxHistory } from '../market/history.js';
import { readVerifiedPool } from '../market/pools.js';
import { tokenView, valueSeries } from '../market/view.js';
import { href } from '../route.js';
import { AddressLink, Loading, Tax, TokenImage } from './common.js';
import { siteRpc, useChainNow, usePolled } from './hooks.js';
import { PriceChart } from './PriceChart.js';
import { TradePanel } from './TradePanel.js';
import { TradesTable } from './TradesTable.js';
import { Transparency } from './Transparency.js';

/**
 * The trades first, then the pool: a trade the API has and the pool hasn't can't happen this
 * way round. After the visitor's own trade, the pool is read as of the slot it landed in
 * (`minSlot`), so the next quote starts from reserves that include it.
 */
async function loadState(pool: Address, minSlot: bigint) {
    const market = await marketPda(PROGRAM_ID, pool);
    const trades = await getTrades(market).catch(() => null);
    const verified = await readVerifiedPool(siteRpc, pool, minSlot > 0n ? minSlot : undefined);
    return { market, trades, verified };
}

export function TokenPage({ pool, account }: { pool: Address; account: UiWalletAccount | null }) {
    const now = useChainNow();
    const minSlot = useRef(0n);
    const state = usePolled(() => loadState(pool, minSlot.current), [pool], 5_000);
    const market = state.data?.market;
    const program = usePolled(() => inspectProgram(siteRpc, PROGRAM_ID, { hashExecutable: false }), []);
    const verified = state.data?.verified ?? null;
    const creatorTokens = usePolled(
        async () => (verified ? tokenBalance(siteRpc, await creatorTokenAccount(verified.keys)) : 0n),
        [verified?.address],
        30_000,
    );
    const history = useMemo(
        () =>
            verified && state.data?.trades ? taxHistory(verified.pool, verified.keys, state.data.trades) : undefined,
        [verified, state.data?.trades],
    );

    if (state.error && !state.data) {
        return <p className="error card">Could not read this pool: {state.error}</p>;
    }
    if (!state.data) {
        return <Loading what="the pool from the chain" />;
    }
    if (!verified) {
        return (
            <section className="card">
                <h2>Not a pool this site can verify</h2>
                <p>
                    <code>{pool}</code> is not a sniper-tax pool at the address its own fields derive, so the site
                    doesn't show or trade it.
                </p>
                <a href={href.launches}>Back to the launches</a>
            </section>
        );
    }

    const view = tokenView(verified);
    const tax = currentTaxBps(verified.pool, now);
    const left = Number(secondsUntilWindowEnds(verified.pool, now));
    const me = (account?.address as Address | undefined) ?? null;

    return (
        <div className="token-page">
            <div className="token-main">
                <section className="card">
                    <div className="token-head">
                        <TokenImage uri={view.uri} symbol={view.symbol} size={56} />
                        <div>
                            <h2>
                                {view.name} <span className="muted">{view.symbol}</span>
                            </h2>
                            <p className="muted">
                                <AddressLink address={verified.keys.tokenMint} /> · created by{' '}
                                <AddressLink address={verified.pool.creator} />
                                {me === verified.pool.creator ? ' (you)' : ''}
                            </p>
                        </div>
                    </div>
                    <div className="token-stats">
                        <div className="stat">
                            <span className="muted">Tax on a buy now</span>
                            <span className="big">
                                <Tax bps={tax} />
                            </span>
                            <span className="muted">
                                {verified.pool.status !== 'live'
                                    ? 'not live yet'
                                    : left > 0
                                      ? `${formatBps(verified.pool.taxEndBps)} in ${formatDuration(left)}`
                                      : 'for good'}
                            </span>
                        </div>
                        <div className="stat">
                            <span className="muted">Market value</span>
                            <span className="big">{formatSol(view.marketValue, 3)} SOL</span>
                            <span className="muted">{formatSignificant(view.price)} SOL per token</span>
                        </div>
                        <div className="stat">
                            <span className="muted">In the pool</span>
                            <span className="big">{formatSol(verified.pool.reserveQuote, 3)} SOL</span>
                            <span className="muted">and {formatBps(view.inPoolBps)} of the supply</span>
                        </div>
                    </div>
                    <PriceChart points={history ? valueSeries(verified, history, now) : undefined} />
                </section>
                <section className="card">
                    <h3>Trades</h3>
                    {state.data.trades === null ? (
                        <p className="error">Pipeline's API did not answer; trades will show when it does.</p>
                    ) : (
                        <TradesTable
                            history={history}
                            launchTs={verified.pool.launchTs}
                            decimals={view.decimals}
                            now={now}
                            me={me}
                        />
                    )}
                </section>
            </div>
            <div className="token-side">
                <TradePanel
                    verified={verified}
                    view={view}
                    account={account}
                    now={now}
                    onTraded={(slot) => {
                        if (slot !== null && slot > minSlot.current) {
                            minSlot.current = slot;
                        }
                        state.reload();
                    }}
                />
                <Transparency
                    verified={verified}
                    view={view}
                    creatorTokens={creatorTokens.data}
                    program={program.data}
                />
            </div>
        </div>
    );
}
