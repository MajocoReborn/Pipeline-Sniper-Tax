// The creator dashboard: every pool the connected wallet created, read from the chain, with
// its unclaimed tax and a button to claim it. A claim is simulated first and not sent if the
// simulation would pay the creator less than the page shows.

import { useRef, useState } from 'react';
import type { Signature } from '@solana/kit';
import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import { currentTaxBps, secondsUntilWindowEnds } from '@majocoreborn/sniper-tax-sdk';

import { CHAIN, explorerUrl } from '../config.js';
import { LaunchError } from '../launch/run.js';
import { formatAge, formatBps, formatDuration, formatSol } from '../launch/units.js';
import { claimProblem, creatorPools, runClaim, type ClaimProgress } from '../market/creator.js';
import type { VerifiedPool } from '../market/pools.js';
import { tokenView } from '../market/view.js';
import { href } from '../route.js';
import { ExternalLink, Loading, Tax, TokenImage } from './common.js';
import { sendWithWallet, siteRpc, useChainNow, usePolled } from './hooks.js';

type Phase =
    | { kind: 'idle' }
    | { kind: 'running'; progress: ClaimProgress | null }
    | { kind: 'done'; signature: Signature; amount: bigint; unwrapped: boolean }
    | { kind: 'failed'; message: string; logs: readonly string[] };

function ClaimButton({
    verified,
    signer,
    onClaimed,
}: {
    verified: VerifiedPool;
    signer: ReturnType<typeof useWalletAccountTransactionSendingSigner>;
    onClaimed: (slot: bigint | null) => void;
}) {
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    const problem = claimProblem(verified, signer.address);
    const busy = phase.kind === 'running';

    async function claim() {
        const amount = verified.pool.accruedTaxQuote;
        setPhase({ kind: 'running', progress: null });
        let landed: bigint | null = null;
        try {
            const result = await runClaim({
                rpc: siteRpc,
                creator: signer,
                verified,
                send: sendWithWallet,
                onProgress: (progress) => setPhase({ kind: 'running', progress }),
            });
            landed = result.slot;
            setPhase({ kind: 'done', signature: result.signature, amount, unwrapped: result.unwrapped });
        } catch (error) {
            setPhase({
                kind: 'failed',
                message: error instanceof Error ? error.message : String(error),
                logs: error instanceof LaunchError ? error.logs : [],
            });
        } finally {
            onClaimed(landed);
        }
    }

    return (
        <div className="claim">
            <button
                type="button"
                className="primary"
                disabled={problem !== null || busy}
                title={problem ?? undefined}
                onClick={() => void claim()}
            >
                {busy ? 'Claiming…' : verified.pool.accruedTaxQuote === 0n ? 'Nothing to claim' : 'Claim'}
            </button>
            {problem && verified.pool.accruedTaxQuote > 0n ? <p className="muted">{problem}</p> : null}
            {phase.kind === 'done' ? (
                <p className="good">
                    Claimed {formatSol(phase.amount, 9)} SOL
                    {phase.unwrapped ? '' : ' into your wrapped-SOL account'}.{' '}
                    <ExternalLink href={explorerUrl('tx', phase.signature)}>View the transaction</ExternalLink>
                </p>
            ) : null}
            {phase.kind === 'running' ? (
                <p className="muted">
                    {phase.progress === null
                        ? 'Simulating…'
                        : phase.progress.step === 'simulated'
                          ? 'Simulated. Approve it in your wallet.'
                          : 'Sent, confirming…'}
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
        </div>
    );
}

function CreatorRow({
    verified,
    now,
    signer,
    onClaimed,
}: {
    verified: VerifiedPool;
    now: bigint;
    signer: ReturnType<typeof useWalletAccountTransactionSendingSigner>;
    onClaimed: (slot: bigint | null) => void;
}) {
    const view = tokenView(verified);
    const { pool } = verified;
    const left = Number(secondsUntilWindowEnds(pool, now));
    return (
        <li className="creator-row">
            <TokenImage uri={view.uri} symbol={view.symbol} />
            <span className="launch-name">
                <a href={href.pool(verified.address)}>
                    <strong>{view.name}</strong>
                </a>
                <span className="muted">
                    {view.symbol}
                    {pool.status === 'live'
                        ? ` · launched ${formatAge(Number(now - pool.launchTs))} ago`
                        : ' · not live'}
                </span>
            </span>
            <span className="launch-tax">
                <Tax bps={currentTaxBps(pool, now)} />
                <span className="muted">
                    {left > 0 ? `for ${formatDuration(left)}` : pool.status === 'live' ? 'for good' : 'not live'}
                </span>
            </span>
            <span className="launch-stat">
                <span className="big">{formatSol(pool.accruedTaxQuote, 9)} SOL</span>
                <span className="muted">unclaimed, your {formatBps(10_000 - pool.protocolTaxShareBps)} of the tax</span>
            </span>
            <ClaimButton verified={verified} signer={signer} onClaimed={onClaimed} />
        </li>
    );
}

export function CreatorPage({ account }: { account: UiWalletAccount }) {
    const signer = useWalletAccountTransactionSendingSigner(account, CHAIN);
    const now = useChainNow();
    const minSlot = useRef(0n);
    const pools = usePolled(
        () => creatorPools(siteRpc, signer.address, minSlot.current > 0n ? minSlot.current : undefined),
        [signer.address],
        15_000,
    );
    const onClaimed = (slot: bigint | null) => {
        if (slot !== null && slot > minSlot.current) {
            minSlot.current = slot;
        }
        pools.reload();
    };
    const total = pools.data?.reduce((sum, v) => sum + v.pool.accruedTaxQuote, 0n) ?? 0n;

    return (
        <section className="card">
            <div className="list-head">
                <h2>Your launches</h2>
                {pools.data && pools.data.length > 0 ? (
                    <span>
                        <span className="muted">Unclaimed in total </span>
                        <strong>{formatSol(total, 9)} SOL</strong>
                    </span>
                ) : null}
            </div>
            <p className="muted">
                Your part of the sniper tax collects in each pool until you claim it; a claim sends all of it to your
                wallet as SOL. The protocol's part is kept apart and doesn't come out of yours. The SOL and tokens you
                put in the pool at launch stay there for good.
            </p>
            {pools.error && !pools.data ? <p className="error">Could not read your launches: {pools.error}</p> : null}
            {!pools.data && !pools.error ? <Loading what="your launches from the chain" /> : null}
            {pools.data ? (
                pools.data.length > 0 ? (
                    <ul className="launches">
                        {pools.data.map((verified) => (
                            <CreatorRow
                                key={verified.address}
                                verified={verified}
                                now={now}
                                signer={signer}
                                onClaimed={onClaimed}
                            />
                        ))}
                    </ul>
                ) : (
                    <p>
                        This wallet hasn't launched anything yet. <a href={href.launch}>Launch a token</a>
                    </p>
                )
            ) : null}
        </section>
    );
}
