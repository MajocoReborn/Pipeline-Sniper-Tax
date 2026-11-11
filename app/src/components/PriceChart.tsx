// The market value over time: a step line through the pool's price after each trade
// (`valueSeries`), with a dot per trade. The labels are HTML, so they stay readable at any width.

import { formatSol } from '../launch/units.js';
import type { ValuePoint } from '../market/view.js';

const W = 640;
const H = 180;
const PAD = 6;

export function PriceChart({ points }: { points: readonly ValuePoint[] | undefined }) {
    if (points === undefined) {
        return <p className="muted">Reading the price history…</p>;
    }
    const values = points.map((p) => Number(p.value));
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || max || 1;
    const first = points[0]!.time;
    const lastTrade = points.length > 2 ? points.at(-2)!.time : first;
    // The line ends a little after the last trade: the value doesn't change until the next one.
    const end = Math.max(Math.min(points.at(-1)!.time, lastTrade + Math.max(60, (lastTrade - first) * 0.2)), first + 1);
    const x = (t: number) => PAD + ((Math.min(t, end) - first) / (end - first)) * (W - 2 * PAD);
    const y = (v: number) => PAD + ((max - v) / span) * (H - 2 * PAD);
    let path = `M ${x(first)} ${y(values[0]!)}`;
    for (let i = 1; i < points.length; i++) {
        path += ` H ${x(points[i]!.time)} V ${y(values[i]!)}`;
    }
    const sol = (v: number) => `${formatSol(BigInt(Math.round(v)), 4)} SOL`;
    return (
        <div className="chart">
            <div className="chart-head">
                <h3>Market value</h3>
                <span className="muted">{max === min ? sol(max) : `${sol(min)} to ${sol(max)}`}</span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Market value after each trade">
                <path d={path} className="chart-line" />
                {points.slice(1, -1).map((p, i) => (
                    <circle key={i} cx={x(p.time)} cy={y(Number(p.value))} r={4} className="chart-dot" />
                ))}
            </svg>
            <div className="chart-axis muted">
                <span>{new Date(first * 1000).toLocaleString()}</span>
                <span>{end < points.at(-1)!.time ? new Date(end * 1000).toLocaleString() : 'now'}</span>
            </div>
            <p className="muted">
                From the pool's reserves after each trade, not the price each trader paid: during the sniper window that
                includes the tax.
            </p>
        </div>
    );
}
