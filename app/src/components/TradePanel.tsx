// Buying and selling on the token page. The quote follows the pool's own maths at the
// cluster's time and updates every second, since the tax falls every second during the
// window. The transaction is simulated before the wallet is asked.

import { useState, type ReactNode } from 'react';
import type { Address, Signature } from '@solana/kit';
import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import { secondsUntilWindowEnds, type Side } from '@majocoreborn/sniper-tax-sdk';

import { CHAIN, explorerUrl } from '../config.js';
import { SIGNATURE_FEE, SPACE, accountExists, balance, tokenBalance } from '../launch/chain.js';
import { LaunchError } from '../launch/run.js';
import { formatBps, formatDuration, formatSol, formatUnits, parseSol, parseUnits } from '../launch/units.js';
import type { VerifiedPool } from '../market/pools.js';
import { maxSellable, quoteTrade, runTrade, traderAccounts, type TradeProgress } from '../market/trade.js';
import type { TokenView } from '../market/view.js';
import { ExternalLink, Tax } from './common.js';
import { sendWithWallet, siteRpc, usePolled } from './hooks.js';

const SLIPPAGES_BPS = [50, 100, 300] as const;

type Phase =
    | { kind: 'idle' }
    | { kind: 'running'; progress: TradeProgress | null }
    | { kind: 'done'; signature: Signature }
    | { kind: 'failed'; message: string; logs: readonly string[] };

async function loadWallet(verified: VerifiedPool, trader: Address) {
    const accounts = await traderAccounts(verified, trader);
    const [sol, tokens, hasTokenAccount, tokenAccountRent, quoteAccountRent] = await Promise.all([
        balance(siteRpc, trader),
        tokenBalance(siteRpc, accounts.token),
        accountExists(siteRpc, accounts.token),
        siteRpc.getMinimumBalanceForRentExemption(BigInt(SPACE.token2022Account)).send(),
        siteRpc.getMinimumBalanceForRentExemption(BigInt(SPACE.classicTokenAccount)).send(),
    ]);
    return { sol, tokens, hasTokenAccount, tokenAccountRent, quoteAccountRent };
}

function Rows({ rows }: { rows: [string, ReactNode, string?][] }) {
    return (
        <table className="costs">
            <tbody>
                {rows.map(([label, value, className]) => (
                    <tr key={label} className={className}>
                        <td>{label}</td>
                        <td>{value}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function ConnectedTradePanel({
    verified,
    view,
    account,
    now,
    onTraded,
}: {
    verified: VerifiedPool;
    view: TokenView;
    account: UiWalletAccount;
    now: bigint;
    /** After a trade attempt, with the slot the trade landed in, or `null` if it didn't. */
    onTraded: (slot: bigint | null) => void;
}) {
    const signer = useWalletAccountTransactionSendingSigner(account, CHAIN);
    const [side, setSide] = useState<Side>('buy');
    const [text, setText] = useState('0.1');
    const [slippageBps, setSlippageBps] = useState<number>(100);
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    const wallet = usePolled(() => loadWallet(verified, signer.address), [verified.address, signer.address], 15_000);

    const amount = side === 'buy' ? parseSol(text) : parseUnits(text, view.decimals);
    const quote = amount === null ? null : quoteTrade(verified, side, signer.address, amount, now, slippageBps);
    const ok = quote !== null && !('error' in quote) ? quote : null;
    const w = wallet.data;
    const needed =
        ok && w
            ? side === 'buy'
                ? ok.amountIn +
                  ok.pipelineFee +
                  (w.hasTokenAccount ? 0n : w.tokenAccountRent) +
                  w.quoteAccountRent +
                  SIGNATURE_FEE
                : ok.amountIn + ok.pipelineFee
            : null;
    const short = needed !== null && w ? (side === 'buy' ? w.sol < needed : w.tokens < needed) : false;
    const windowLeft = Number(secondsUntilWindowEnds(verified.pool, now));
    const busy = phase.kind === 'running';

    async function trade() {
        if (!ok) {
            return;
        }
        setPhase({ kind: 'running', progress: null });
        let landed: bigint | null = null;
        try {
            const { signature, slot } = await runTrade({
                rpc: siteRpc,
                trader: signer,
                verified,
                side,
                amountIn: ok.amountIn,
                minAmountOut: ok.minAmountOut,
                send: sendWithWallet,
                onProgress: (progress) => setPhase({ kind: 'running', progress }),
            });
            landed = slot;
            setPhase({ kind: 'done', signature });
        } catch (error) {
            setPhase({
                kind: 'failed',
                message: error instanceof Error ? error.message : String(error),
                logs: error instanceof LaunchError ? error.logs : [],
            });
        } finally {
            wallet.reload();
            onTraded(landed);
        }
    }

    const tokenText = (raw: bigint) => `${formatUnits(raw, view.decimals, 2, true)} ${view.symbol}`;

    return (
        <section className="card trade">
            <div className="tabs" role="tablist">
                {(['buy', 'sell'] as const).map((s) => (
                    <button
                        key={s}
                        type="button"
                        role="tab"
                        aria-selected={side === s}
                        className={side === s ? 'tab selected' : 'tab'}
                        disabled={busy}
                        onClick={() => {
                            setSide(s);
                            setText(s === 'buy' ? '0.1' : '');
                            setPhase({ kind: 'idle' });
                        }}
                    >
                        {s === 'buy' ? 'Buy' : 'Sell'}
                    </button>
                ))}
            </div>

            <label className="field">
                <span className="label">{side === 'buy' ? 'SOL to spend' : `${view.symbol} to sell`}</span>
                <span className="input-row">
                    <input value={text} inputMode="decimal" disabled={busy} onChange={(e) => setText(e.target.value)} />
                    {side === 'sell' && w ? (
                        <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => setText(formatUnits(maxSellable(w.tokens), view.decimals))}
                        >
                            Max
                        </button>
                    ) : null}
                </span>
                <span className="hint">
                    {w
                        ? side === 'buy'
                            ? `You have ${formatSol(w.sol, 4)} SOL.`
                            : `You have ${tokenText(w.tokens)}.`
                        : 'Reading your balance…'}
                </span>
            </label>

            {side === 'buy' && ok && ok.taxBps >= 1_000 && windowLeft > 0 ? (
                <p className="warning">
                    Buying now costs {formatBps(ok.taxBps)} in tax. It falls to {formatBps(verified.pool.taxEndBps)} in{' '}
                    {formatDuration(windowLeft)}.
                </p>
            ) : null}

            {quote && 'error' in quote ? <p className="error">{quote.error}</p> : null}
            {amount === null && text.trim() !== '' ? (
                <p className="error">Enter a plain amount, such as 0.25.</p>
            ) : null}

            {ok ? (
                <Rows
                    rows={
                        side === 'buy'
                            ? [
                                  ['Sniper tax now', <Tax key="t" bps={ok.taxBps} />],
                                  ['Tax paid', `${formatSol(ok.quote.creatorTax + ok.quote.protocolFee, 6)} SOL`],
                                  ["Pipeline's fee (0.25%)", `${formatSol(ok.pipelineFee, 6)} SOL`],
                                  ['Site fee', 'none'],
                                  ...(w && !w.hasTokenAccount
                                      ? ([['Your token account (once)', `${formatSol(w.tokenAccountRent, 6)} SOL`]] as [
                                            string,
                                            string,
                                        ][])
                                      : []),
                                  ['You receive about', tokenText(ok.quote.amountOut), 'total'],
                                  ['At least', tokenText(ok.minAmountOut)],
                              ]
                            : [
                                  ['Tax', 'none on sells'],
                                  ["Pipeline's fee (0.25%)", tokenText(ok.pipelineFee)],
                                  ['Site fee', 'none'],
                                  ['You receive about', `${formatSol(ok.quote.amountOut, 6)} SOL`, 'total'],
                                  ['At least', `${formatSol(ok.minAmountOut, 6)} SOL`],
                              ]
                    }
                />
            ) : null}

            <label className="field">
                <span className="label">Slippage</span>
                <select value={slippageBps} disabled={busy} onChange={(e) => setSlippageBps(Number(e.target.value))}>
                    {SLIPPAGES_BPS.map((bps) => (
                        <option key={bps} value={bps}>
                            {formatBps(bps)}
                        </option>
                    ))}
                </select>
            </label>

            {short ? (
                <p className="warning">
                    Not enough {side === 'buy' ? 'SOL' : view.symbol}: you need{' '}
                    {side === 'buy' ? `${formatSol(needed!, 6)} SOL` : tokenText(needed!)}, fees included.
                </p>
            ) : null}

            <button type="button" className="primary" disabled={!ok || short || busy} onClick={() => void trade()}>
                {busy ? 'Trading…' : side === 'buy' ? `Buy ${view.symbol}` : `Sell ${view.symbol}`}
            </button>

            {phase.kind === 'running' ? (
                <p className="muted">
                    {phase.progress === null
                        ? 'Simulating…'
                        : phase.progress.step === 'simulated'
                          ? 'Simulated. Approve it in your wallet.'
                          : 'Sent, confirming…'}
                </p>
            ) : null}
            {phase.kind === 'done' ? (
                <p className="good">
                    Done. <ExternalLink href={explorerUrl('tx', phase.signature)}>View the transaction</ExternalLink>.
                    The trades list shows the tax it paid once Pipeline has indexed it, usually within seconds.
                </p>
            ) : null}
            {phase.kind === 'failed' ? (
                <div className="failure">
                    <p className="error">{phase.message}</p>
                    {phase.logs.length > 0 ? (
                        <details>
                            <summary>Program logs</summary>
                            <pre>{phase.logs.join('\n')}</pre>
                        </details>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}

export function TradePanel(props: {
    verified: VerifiedPool;
    view: TokenView;
    account: UiWalletAccount | null;
    now: bigint;
    onTraded: (slot: bigint | null) => void;
}) {
    if (!props.account) {
        return (
            <section className="card trade">
                <h3>Trade</h3>
                <p className="muted">Connect a wallet to buy or sell.</p>
            </section>
        );
    }
    return <ConnectedTradePanel {...props} account={props.account} />;
}
