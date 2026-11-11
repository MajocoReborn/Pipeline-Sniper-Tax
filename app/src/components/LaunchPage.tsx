// The launch form, a preview of what the launch does and costs, the launch itself, and the
// result. Everything the creator types is shown as text only; links are built from addresses.

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { Address, Signature } from '@solana/kit';
import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';

import {
    currentTaxBps,
    secondsUntilWindowEnds,
    taxBpsAt,
    type LaunchPool,
    type PoolKeys,
    type ProtocolConfig,
} from '../client/index.js';
import { CHAIN, PIPELINE_API_URL, explorerUrl } from '../config.js';
import { balance, createRpc, launchCosts, readConfig, readPool, type LaunchCosts, type Rpc } from '../launch/chain.js';
import {
    MAX_NAME_BYTES,
    MAX_SYMBOL_BYTES,
    MAX_URI_BYTES,
    PRESETS,
    TOKEN_DECIMALS,
    TOKEN_SUPPLY,
    launchAmounts,
    normalizeForm,
    taxSchedule,
    validateForm,
    type LaunchForm,
    type PresetId,
} from '../launch/form.js';
import { LaunchError, createPool, runLaunch, type LaunchProgress } from '../launch/run.js';
import { formatBps, formatDuration, formatSol, parseSol, shortAddress } from '../launch/units.js';
import { href } from '../route.js';
import { sendWithWallet as send } from './hooks.js';

const PERMANENT_FEES_BPS = [0, 50, 100, 200, 300, 500] as const;
const CREATOR_SHARES_BPS = [0, 500, 1_000, 1_500, 2_000] as const;

type Draft = Omit<LaunchForm, 'liquidityLamports'> & { liquidity: string };

const INITIAL_DRAFT: Draft = {
    name: '',
    symbol: '',
    uri: '',
    preset: 'normal',
    permanentFeeBps: 0,
    creatorShareBps: 0,
    liquidity: '1',
};

type Done = { mint: Address; keys: PoolKeys; tokenSignature: Signature | null; poolSignature: Signature };

type Phase =
    | { kind: 'editing' }
    | { kind: 'running'; form: LaunchForm; progress: readonly LaunchProgress[] }
    | {
          kind: 'failed';
          form: LaunchForm;
          progress: readonly LaunchProgress[];
          message: string;
          logs: readonly string[];
          tokenMint: Address | null;
      }
    | { kind: 'done'; form: LaunchForm; done: Done };

type Confirmed = Extract<LaunchProgress, { step: 'confirmed' }>;

function toForm(draft: Draft): LaunchForm {
    const { liquidity, ...rest } = draft;
    return normalizeForm({ ...rest, liquidityLamports: parseSol(liquidity) ?? 0n });
}

function formErrors(draft: Draft, form: LaunchForm): string[] {
    const errors = validateForm(form);
    return parseSol(draft.liquidity) === null
        ? ['Enter the SOL for the pool as a number, such as 1.5.', ...errors]
        : errors;
}

function failure(
    form: LaunchForm,
    progress: readonly LaunchProgress[],
    error: unknown,
    tokenMint: Address | null = null,
): Phase {
    const launchError = error instanceof LaunchError ? error : null;
    return {
        kind: 'failed',
        form,
        progress,
        message: error instanceof Error ? error.message : String(error),
        logs: launchError?.logs ?? [],
        tokenMint: launchError?.tokenMint ?? tokenMint,
    };
}

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

/** Whole tokens: every share on the site leaves a whole number of tokens. */
function formatTokens(amount: bigint): string {
    return (amount / 10n ** BigInt(TOKEN_DECIMALS)).toLocaleString('en-US');
}

const sol = (lamports: bigint, decimals = 6) => `${formatSol(lamports, decimals)} SOL`;

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
    return (
        <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
        </a>
    );
}

// ---------------------------------------------------------------------------------------------
// The form.

type Control = { id: string; 'aria-describedby'?: string };

/** A labelled control; the hint is linked to it, so screen readers read it after the label. */
function Field({ label, hint, children }: { label: string; hint?: string; children: (control: Control) => ReactNode }) {
    const id = useId();
    return (
        <div className="field">
            <label className="label" htmlFor={id}>
                {label}
            </label>
            {children(hint ? { id, 'aria-describedby': `${id}-hint` } : { id })}
            {hint ? (
                <span className="hint" id={`${id}-hint`}>
                    {hint}
                </span>
            ) : null}
        </div>
    );
}

function FormFields({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
    const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });
    return (
        <>
            <Field label="Name" hint={`Up to ${MAX_NAME_BYTES} characters. Fixed for good after launch.`}>
                {(control) => (
                    <input
                        {...control}
                        value={draft.name}
                        maxLength={MAX_NAME_BYTES}
                        onChange={(e) => set('name', e.target.value)}
                    />
                )}
            </Field>
            <Field label="Symbol" hint={`Up to ${MAX_SYMBOL_BYTES} letters or digits.`}>
                {(control) => (
                    <input
                        {...control}
                        value={draft.symbol}
                        maxLength={MAX_SYMBOL_BYTES}
                        onChange={(e) => set('symbol', e.target.value.toUpperCase())}
                    />
                )}
            </Field>
            <Field
                label="Image link"
                hint="An https:// link to the image, or to a JSON file with name, symbol, description and image."
            >
                {(control) => (
                    <input
                        {...control}
                        value={draft.uri}
                        maxLength={MAX_URI_BYTES}
                        inputMode="url"
                        placeholder="https://"
                        onChange={(e) => set('uri', e.target.value)}
                    />
                )}
            </Field>

            <fieldset className="presets">
                <legend>Sniper tax</legend>
                {(Object.keys(PRESETS) as PresetId[]).map((id) => (
                    <label key={id} className={`preset${draft.preset === id ? ' selected' : ''}`}>
                        <input
                            type="radio"
                            name="preset"
                            checked={draft.preset === id}
                            onChange={() => set('preset', id)}
                        />
                        <span className="preset-name">{PRESETS[id].label}</span>
                        <span className="hint">{PRESETS[id].description}</span>
                    </label>
                ))}
            </fieldset>

            <div className="row">
                <Field label="Fee after the window" hint="On buys, for good. Goes to you, like the tax.">
                    {(control) => (
                        <select
                            {...control}
                            value={draft.permanentFeeBps}
                            onChange={(e) => set('permanentFeeBps', Number(e.target.value))}
                        >
                            {PERMANENT_FEES_BPS.map((bps) => (
                                <option key={bps} value={bps}>
                                    {formatBps(bps)}
                                </option>
                            ))}
                        </select>
                    )}
                </Field>
                <Field label="You keep" hint="Share of the supply outside the pool. Buyers see it.">
                    {(control) => (
                        <select
                            {...control}
                            value={draft.creatorShareBps}
                            onChange={(e) => set('creatorShareBps', Number(e.target.value))}
                        >
                            {CREATOR_SHARES_BPS.map((bps) => (
                                <option key={bps} value={bps}>
                                    {formatBps(bps)}
                                </option>
                            ))}
                        </select>
                    )}
                </Field>
                <Field label="SOL into the pool" hint="Sets the starting price.">
                    {(control) => (
                        <input
                            {...control}
                            value={draft.liquidity}
                            inputMode="decimal"
                            onChange={(e) => set('liquidity', e.target.value)}
                        />
                    )}
                </Field>
            </div>
        </>
    );
}

// ---------------------------------------------------------------------------------------------
// The preview: what the launch does and what it costs.

function TaxTable({ form }: { form: LaunchForm }) {
    const schedule = taxSchedule(form);
    const points = [0, 0.25, 0.5, 0.75].map((f) => Math.round(schedule.durationSecs * f));
    return (
        <table className="tax-table">
            <thead>
                <tr>
                    <th>After launch</th>
                    <th>Tax on a buy</th>
                </tr>
            </thead>
            <tbody>
                {points.map((t) => (
                    <tr key={t}>
                        <td>{formatDuration(t)}</td>
                        <td>{formatBps(taxBpsAt(schedule, 0n, BigInt(t)))}</td>
                    </tr>
                ))}
                <tr>
                    <td>{formatDuration(schedule.durationSecs)} and later</td>
                    <td>{formatBps(schedule.endBps)}</td>
                </tr>
            </tbody>
        </table>
    );
}

function Preview({
    form,
    config,
    costs,
    lamports,
}: {
    form: LaunchForm;
    config: ProtocolConfig | null;
    costs: LaunchCosts | null;
    lamports: bigint | null;
}) {
    const { poolTokens, creatorTokens } = launchAmounts(form);
    const refundable = costs ? costs.items.reduce((sum, i) => (i.refundable ? sum + i.lamports : sum), 0n) : 0n;
    const needed = costs ? form.liquidityLamports + costs.total + refundable : null;
    const startValue = poolTokens > 0n ? (form.liquidityLamports * TOKEN_SUPPLY) / poolTokens : 0n;
    return (
        <section className="card preview">
            <h2>What happens</h2>
            <dl className="facts">
                <dt>Supply</dt>
                <dd>{formatTokens(TOKEN_SUPPLY)}, fixed: nobody can mint more or freeze accounts</dd>
                <dt>Into the pool</dt>
                <dd>
                    {formatTokens(poolTokens)} tokens and {sol(form.liquidityLamports)}
                </dd>
                <dt>You keep</dt>
                <dd>{formatTokens(creatorTokens)} tokens</dd>
                <dt>Starting value</dt>
                <dd>{sol(startValue, 2)} for the whole supply, at the pool's opening price</dd>
            </dl>

            <h3>Sniper tax</h3>
            <TaxTable form={form} />
            <p className="muted">
                Buys pay the tax; sells and your own buys don't.
                {config
                    ? ` ${formatBps(config.protocolTaxShareBps)} of the tax goes to the protocol, the rest to you.`
                    : null}
            </p>

            <h3>Costs</h3>
            {costs ? (
                <table className="costs">
                    <tbody>
                        {costs.items.map((item) => (
                            <tr key={item.label} className={item.refundable ? 'refundable' : undefined}>
                                <td>{item.label}</td>
                                <td>{sol(item.lamports)}</td>
                            </tr>
                        ))}
                        <tr className="total">
                            <td>Costs</td>
                            <td>{sol(costs.total)}</td>
                        </tr>
                        <tr className="total">
                            <td>Costs and the pool's SOL</td>
                            <td>{sol(costs.total + form.liquidityLamports)}</td>
                        </tr>
                    </tbody>
                </table>
            ) : (
                <p className="muted">Reading rent from devnet…</p>
            )}
            <p className="muted">
                Each transaction is simulated before your wallet is asked, and shows its exact cost.
            </p>
            {lamports !== null ? (
                <p className={needed !== null && lamports < needed ? 'warning' : 'muted'}>
                    Your balance: {sol(lamports)}
                    {needed !== null && lamports < needed ? `. You need about ${sol(needed)}.` : null}
                </p>
            ) : null}
        </section>
    );
}

// ---------------------------------------------------------------------------------------------
// Progress and result.

const STEP_LABELS = { token: '1. Create the token', pool: '2. Create and launch the pool' } as const;

function StepStatus({
    transaction,
    progress,
    running,
}: {
    transaction: 'token' | 'pool';
    progress: readonly LaunchProgress[];
    running: boolean;
}) {
    const mine = progress.filter((p) => p.transaction === transaction);
    const last = mine.at(-1);
    const simulated = mine.find((p) => p.step === 'simulated');
    const cost =
        simulated && simulated.step === 'simulated' && simulated.lamportsSpent !== null
            ? ` Costs ${sol(simulated.lamportsSpent)}.`
            : '';
    const tokenDone = progress.some((p) => p.transaction === 'token' && p.step === 'confirmed');
    let status: ReactNode;
    if (!last) {
        status = running && (transaction === 'token' || tokenDone) ? 'Preparing and simulating…' : 'Waiting';
    } else if (last.step === 'simulated') {
        if (!last.simulation.ok) {
            status = 'The simulation failed, so nothing was sent.';
        } else {
            status = running ? `Simulated.${cost} Approve it in your wallet.` : `Simulated.${cost} Not sent.`;
        }
    } else {
        status = (
            <>
                {last.step === 'sent'
                    ? running
                        ? 'Sent, confirming… '
                        : 'Sent, not confirmed. '
                    : `Confirmed.${cost} `}
                <ExternalLink href={explorerUrl('tx', last.signature)}>View</ExternalLink>
            </>
        );
    }
    return (
        <li className={last?.step === 'confirmed' ? 'step done' : 'step'}>
            <span className="step-name">{STEP_LABELS[transaction]}</span>
            <span className="step-status">{status}</span>
        </li>
    );
}

function Steps({ progress, running }: { progress: readonly LaunchProgress[]; running: boolean }) {
    return (
        <ol className="steps">
            <StepStatus transaction="token" progress={progress} running={running} />
            <StepStatus transaction="pool" progress={progress} running={running} />
        </ol>
    );
}

function LiveTax({ rpc, pool: poolAddress }: { rpc: Rpc; pool: Address }) {
    const [pool, setPool] = useState<LaunchPool | null>(null);
    const [now, setNow] = useState(nowSeconds);
    useEffect(() => {
        let cancelled = false;
        readPool(rpc, poolAddress).then(
            (p) => !cancelled && setPool(p),
            () => {},
        );
        const timer = setInterval(() => setNow(nowSeconds()), 1_000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [rpc, poolAddress]);
    if (!pool) {
        return <p className="muted">Reading the pool…</p>;
    }
    const left = Number(secondsUntilWindowEnds(pool, now));
    return (
        <p className="live-tax">
            Tax on a buy now: <strong>{formatBps(currentTaxBps(pool, now))}</strong>
            {left > 0
                ? `, ${formatBps(pool.taxEndBps)} in ${formatDuration(left)} (by your clock).`
                : '. The window is over.'}
        </p>
    );
}

function Result({ rpc, form, done, onAgain }: { rpc: Rpc; form: LaunchForm; done: Done; onAgain: () => void }) {
    return (
        <section className="card result">
            <h2>
                {form.name} ({form.symbol}) is live
            </h2>
            <LiveTax rpc={rpc} pool={done.keys.address} />
            <dl className="facts">
                <dt>Token</dt>
                <dd>
                    <code>{done.mint}</code>{' '}
                    <ExternalLink href={explorerUrl('address', done.mint)}>Explorer</ExternalLink>
                </dd>
                <dt>Pool</dt>
                <dd>
                    <code>{done.keys.address}</code>{' '}
                    <ExternalLink href={explorerUrl('address', done.keys.address)}>Explorer</ExternalLink>
                </dd>
                <dt>Pipeline market</dt>
                <dd>
                    <code>{shortAddress(done.keys.market)}</code>{' '}
                    <ExternalLink href={`${PIPELINE_API_URL}/v1/markets/${done.keys.market}`}>API</ExternalLink>
                </dd>
                <dt>Transactions</dt>
                <dd>
                    {done.tokenSignature ? (
                        <ExternalLink href={explorerUrl('tx', done.tokenSignature)}>Token</ExternalLink>
                    ) : null}{' '}
                    <ExternalLink href={explorerUrl('tx', done.poolSignature)}>Pool</ExternalLink>
                </dd>
            </dl>
            <p className="muted">
                Anyone can trade it now through the Pipeline router. Your tax builds up in the pool; claiming it from
                the site comes next.
            </p>
            <div className="actions">
                <a className="button primary" href={href.pool(done.keys.address)}>
                    Open the token page
                </a>
                <button type="button" className="secondary" onClick={onAgain}>
                    Launch another token
                </button>
            </div>
        </section>
    );
}

// ---------------------------------------------------------------------------------------------
// The page.

export function LaunchPage({ account }: { account: UiWalletAccount }) {
    const signer = useWalletAccountTransactionSendingSigner(account, CHAIN);
    const rpc = useMemo(() => createRpc(), []);
    const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
    const [attempted, setAttempted] = useState(false);
    const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
    const [config, setConfig] = useState<ProtocolConfig | null>(null);
    const [configError, setConfigError] = useState<string | null>(null);
    const [costs, setCosts] = useState<LaunchCosts | null>(null);
    const [lamports, setLamports] = useState<bigint | null>(null);

    const form = useMemo(() => toForm(draft), [draft]);
    const errors = useMemo(() => formErrors(draft, form), [draft, form]);
    const shown = phase.kind === 'editing' ? form : phase.form;

    const refreshBalance = useCallback(() => {
        balance(rpc, signer.address).then(setLamports, () => setLamports(null));
    }, [rpc, signer.address]);
    useEffect(refreshBalance, [refreshBalance]);

    useEffect(() => {
        let cancelled = false;
        readConfig(rpc).then(
            (c) => !cancelled && setConfig(c),
            (e: unknown) => !cancelled && setConfigError(e instanceof Error ? e.message : String(e)),
        );
        return () => {
            cancelled = true;
        };
    }, [rpc]);

    // Rent depends only on the metadata's length, so read it again only when that changes.
    const { name, symbol, uri } = shown;
    useEffect(() => {
        if (!config) {
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            launchCosts(rpc, {
                creator: signer.address,
                mint: signer.address,
                form: { name, symbol, uri },
                config,
            }).then(
                (c) => !cancelled && setCosts(c),
                () => {},
            );
        }, 400);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [rpc, config, signer.address, name, symbol, uri]);

    async function launch() {
        setAttempted(true);
        if (errors.length > 0) {
            return;
        }
        const snapshot = form;
        let progress: readonly LaunchProgress[] = [];
        const onProgress = (p: LaunchProgress) => {
            progress = [...progress, p];
            setPhase({ kind: 'running', form: snapshot, progress });
        };
        setPhase({ kind: 'running', form: snapshot, progress });
        try {
            const result = await runLaunch({ rpc, creator: signer, form: snapshot, send, onProgress });
            setPhase({
                kind: 'done',
                form: snapshot,
                done: {
                    mint: result.mint,
                    keys: result.keys,
                    tokenSignature: result.signatures.token,
                    poolSignature: result.signatures.pool,
                },
            });
        } catch (error) {
            setPhase(failure(snapshot, progress, error));
        } finally {
            refreshBalance();
        }
    }

    async function retryPool(snapshot: LaunchForm, mint: Address, earlier: readonly LaunchProgress[]) {
        let progress = earlier.filter((p) => p.transaction === 'token');
        const onProgress = (p: LaunchProgress) => {
            progress = [...progress, p];
            setPhase({ kind: 'running', form: snapshot, progress });
        };
        setPhase({ kind: 'running', form: snapshot, progress });
        try {
            const pool = await createPool({
                rpc,
                creator: signer,
                form: snapshot,
                mint,
                send,
                onProgress,
                config: config ?? undefined,
            });
            const token = progress.find((p): p is Confirmed => p.transaction === 'token' && p.step === 'confirmed');
            setPhase({
                kind: 'done',
                form: snapshot,
                done: {
                    mint,
                    keys: pool.keys,
                    tokenSignature: token?.signature ?? null,
                    poolSignature: pool.signature,
                },
            });
        } catch (error) {
            setPhase(failure(snapshot, progress, error, mint));
        } finally {
            refreshBalance();
        }
    }

    function startOver() {
        setPhase({ kind: 'editing' });
        setDraft(INITIAL_DRAFT);
        setAttempted(false);
    }

    if (configError) {
        return (
            <section className="card">
                <h2>The program isn't reachable</h2>
                <p>Its config could not be read from devnet: {configError}</p>
            </section>
        );
    }

    if (phase.kind === 'done') {
        return <Result rpc={rpc} form={phase.form} done={phase.done} onAgain={startOver} />;
    }

    const busy = phase.kind === 'running';
    return (
        <div className="layout">
            <section className="card">
                <h2>Your token</h2>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        void launch();
                    }}
                >
                    <fieldset className="plain" disabled={phase.kind !== 'editing'}>
                        <FormFields draft={draft} onChange={setDraft} />
                    </fieldset>
                    {attempted && errors.length > 0 && phase.kind === 'editing' ? (
                        <ul className="errors">
                            {errors.map((error) => (
                                <li key={error}>{error}</li>
                            ))}
                        </ul>
                    ) : null}
                    {phase.kind === 'editing' ? (
                        <button type="submit" className="primary" disabled={!config}>
                            Launch
                        </button>
                    ) : null}
                </form>

                {phase.kind !== 'editing' ? (
                    <div className="progress">
                        <p className="muted">Your wallet asks twice: first for the token, then for the pool.</p>
                        <Steps progress={phase.progress} running={busy} />
                    </div>
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
                        {phase.tokenMint ? (
                            <>
                                <p>
                                    Your token <code>{shortAddress(phase.tokenMint)}</code> was created and its whole
                                    supply is in your wallet, but the pool was not. Try the pool again: it uses the same
                                    settings.
                                </p>
                                <div className="actions">
                                    <button
                                        type="button"
                                        className="primary"
                                        onClick={() => void retryPool(phase.form, phase.tokenMint!, phase.progress)}
                                    >
                                        Create the pool
                                    </button>
                                    <button type="button" className="secondary" onClick={startOver}>
                                        Leave it and start over
                                    </button>
                                </div>
                            </>
                        ) : (
                            <div className="actions">
                                <button type="button" className="primary" onClick={() => setPhase({ kind: 'editing' })}>
                                    Back to the form
                                </button>
                            </div>
                        )}
                    </div>
                ) : null}
            </section>

            <Preview form={shown} config={config} costs={costs} lamports={lamports} />
        </div>
    );
}
