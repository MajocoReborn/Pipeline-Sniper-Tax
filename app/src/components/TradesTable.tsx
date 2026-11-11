// The pool's recent trades with the tax each one paid, worked out exactly from the pool's
// reserves (`market/history.ts`). A rate the walk could not confirm is marked ≈.

import type { Address } from '@solana/kit';

import { explorerUrl } from '../config.js';
import { formatAge, formatSol, formatUnits, shortAddress } from '../launch/units.js';
import type { TaxHistory } from '../market/history.js';
import { ExternalLink, Tax } from './common.js';

export function TradesTable({
    history,
    launchTs,
    decimals,
    now,
    me,
}: {
    history: TaxHistory | undefined;
    launchTs: bigint;
    decimals: number;
    now: bigint;
    me: Address | null;
}) {
    if (!history) {
        return <p className="muted">Reading trades…</p>;
    }
    if (history.trades.length === 0) {
        return <p className="muted">No trades yet.</p>;
    }
    return (
        <>
            <div className="table-scroll">
                <table className="trades">
                    <thead>
                        <tr>
                            <th>When</th>
                            <th>Trade</th>
                            <th>Trader</th>
                            <th>SOL</th>
                            <th>Tokens</th>
                            <th>Tax</th>
                        </tr>
                    </thead>
                    <tbody>
                        {history.trades.map(({ trade, side, byCreator, taxBps, tax, estimatedTaxBps }) => {
                            const sol = side === 'buy' ? trade.netSent : trade.received;
                            const tokens = side === 'buy' ? trade.received : trade.netSent;
                            const afterLaunch = trade.blockTime - Number(launchTs);
                            return (
                                <tr key={trade.signature}>
                                    <td title={new Date(trade.blockTime * 1000).toLocaleString()}>
                                        <ExternalLink href={explorerUrl('tx', trade.signature)}>
                                            {afterLaunch >= 0 && afterLaunch < 3_600
                                                ? `${formatAge(afterLaunch)} after launch`
                                                : `${formatAge(Number(now) - trade.blockTime)} ago`}
                                        </ExternalLink>
                                    </td>
                                    <td className={side === 'buy' ? 'buy' : 'sell'}>
                                        {side === 'buy' ? 'Buy' : 'Sell'}
                                    </td>
                                    <td>
                                        <code title={trade.trader}>{shortAddress(trade.trader)}</code>
                                        {byCreator ? <span className="badge">creator</span> : null}
                                        {me === trade.trader ? <span className="badge">you</span> : null}
                                    </td>
                                    <td>{formatSol(sol, 4)}</td>
                                    <td>{formatUnits(tokens, decimals, 0, true)}</td>
                                    <td>
                                        {side === 'sell' ? (
                                            <span className="muted">none</span>
                                        ) : taxBps === null ? (
                                            <Tax bps={estimatedTaxBps} approximate />
                                        ) : (
                                            <>
                                                <Tax bps={taxBps} />
                                                {tax !== null && tax > 0n ? (
                                                    <span className="muted"> {formatSol(tax, 4)} SOL</span>
                                                ) : null}
                                            </>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <p className="muted">
                {history.complete
                    ? 'Each rate is worked out exactly from the pool’s reserves, so it is the rate the program charged.'
                    : 'Pipeline’s API is catching up with the chain; rates marked ≈ follow from the block time and may be a second off.'}
            </p>
        </>
    );
}
