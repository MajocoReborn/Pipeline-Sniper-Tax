// What the chain says about a launch, for a buyer to check before trading: who created it,
// where the supply is, the tax schedule, the token's authorities and extensions, and whether
// the program can still change. All of it is read from the chain, not from the API.

import { formatBps, formatDuration, formatSol, formatUnits } from '../launch/units.js';
import type { VerifiedPool } from '../market/pools.js';
import { extensionNames, trustChecks, type TokenView } from '../market/view.js';
import type { ProgramInspection } from '../vendor/pipeline/index.js';
import { AddressLink, ExternalLink } from './common.js';

const REPOSITORY = 'https://github.com/MajocoReborn/Pipeline-Sniper-Tax';

export function Transparency({
    verified,
    view,
    creatorTokens,
    program,
}: {
    verified: VerifiedPool;
    view: TokenView;
    creatorTokens: bigint | undefined;
    program: ProgramInspection | undefined;
}) {
    const { pool, keys } = verified;
    const share = (raw: bigint) => (view.supply > 0n ? formatBps(Number((raw * 10_000n) / view.supply)) : '?');
    const outside = view.supply - pool.reserveToken;
    const tokens = (raw: bigint) => `${formatUnits(raw, view.decimals, 0, true)} (${share(raw)})`;
    const launched = pool.status === 'live' ? new Date(Number(pool.launchTs) * 1000) : null;
    return (
        <section className="card transparency">
            <h3>What the chain says</h3>
            <ul className="checks-list">
                {trustChecks(verified).map((check) => (
                    <li key={check.label} className={check.ok ? 'ok' : 'warn'}>
                        <strong>
                            {check.ok ? '✓' : '!'} {check.label}.
                        </strong>{' '}
                        {check.detail}
                    </li>
                ))}
            </ul>
            <dl className="facts">
                <dt>Creator</dt>
                <dd>
                    <AddressLink address={pool.creator} />
                </dd>
                <dt>In the pool</dt>
                <dd>{tokens(pool.reserveToken)}</dd>
                <dt>Outside the pool</dt>
                <dd>{tokens(outside)}: what the creator kept, plus everything bought since</dd>
                <dt>Creator's wallet</dt>
                <dd>{creatorTokens === undefined ? '…' : tokens(creatorTokens)}</dd>
                <dt>Sniper tax</dt>
                <dd>
                    {formatBps(pool.taxStartBps)} falling to {formatBps(pool.taxEndBps)} over{' '}
                    {formatDuration(pool.taxDurationSecs)}
                    {launched ? `, from ${launched.toLocaleString()}` : ', from launch'}
                </dd>
                <dt>After that</dt>
                <dd>{formatBps(pool.taxEndBps)} on buys, for good; sells and the creator's own buys pay none</dd>
                <dt>Tax split</dt>
                <dd>{formatBps(10_000 - pool.protocolTaxShareBps)} to the creator, the rest to the protocol</dd>
                <dt>Unclaimed tax</dt>
                <dd>
                    {formatSol(pool.accruedTaxQuote, 6)} SOL for the creator, {formatSol(pool.accruedProtocolQuote, 6)}{' '}
                    SOL for the protocol
                </dd>
                <dt>Token</dt>
                <dd>
                    <AddressLink address={keys.tokenMint} /> {extensionNames(verified).join(', ') || 'no extensions'}
                </dd>
                <dt>Pool</dt>
                <dd>
                    <AddressLink address={verified.address} />, market <AddressLink address={keys.market} />
                </dd>
                <dt>Program</dt>
                <dd>
                    {program === undefined ? (
                        '…'
                    ) : program.upgradeable ? (
                        <>
                            Can still be upgraded by <AddressLink address={program.upgradeAuthority ?? ''} /> (devnet).
                            Last deployed at slot {program.lastDeploySlot?.toString() ?? '?'}.
                        </>
                    ) : program.flags.includes('frozen') ? (
                        'Frozen: it can never change.'
                    ) : (
                        'Its upgrade authority could not be read from the chain.'
                    )}{' '}
                    <ExternalLink href={`${REPOSITORY}/blob/main/docs/SECURITY-REVIEW.md`}>
                        Security review
                    </ExternalLink>
                </dd>
            </dl>
        </section>
    );
}
