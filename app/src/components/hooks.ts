// Small hooks the pages share: the cluster's clock, and data that reloads on an interval.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBase58Decoder, signAndSendTransactionMessageWithSigners, signature as toSignature } from '@solana/kit';

import { createRpc } from '../launch/chain.js';
import type { Sender } from '../launch/run.js';
import { chainNow, clockOffset } from '../market/pools.js';

/** One RPC client for the whole site. */
export const siteRpc = createRpc();

/** Signs and sends with the connected wallet (any extra signers, such as a new mint, sign first). */
export const sendWithWallet: Sender = async (message) =>
    toSignature(getBase58Decoder().decode(await signAndSendTransactionMessageWithSigners(message)));

let sharedOffset: Promise<number> | null = null;

/** The cluster's time in Unix seconds, ticking every second. */
export function useChainNow(): bigint {
    const [offset, setOffset] = useState(0);
    const [now, setNow] = useState(() => chainNow(0));
    useEffect(() => {
        let cancelled = false;
        sharedOffset ??= clockOffset(siteRpc).catch(() => 0);
        void sharedOffset.then((o) => !cancelled && setOffset(o));
        return () => {
            cancelled = true;
        };
    }, []);
    useEffect(() => {
        setNow(chainNow(offset));
        const timer = setInterval(() => setNow(chainNow(offset)), 1_000);
        return () => clearInterval(timer);
    }, [offset]);
    return now;
}

export type Loaded<T> = { data: T | undefined; error: string | null; reload: () => void };

/**
 * `load()` now, again every `intervalMs` (if given) and on `reload()`. Keeps the last data
 * while reloading, and after a failed reload.
 */
export function usePolled<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs?: number): Loaded<T> {
    const [data, setData] = useState<T | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);
    const loadRef = useRef(load);
    loadRef.current = load;
    useEffect(() => {
        setData(undefined);
        setError(null);
    }, deps);
    useEffect(() => {
        let cancelled = false;
        const run = () =>
            loadRef.current().then(
                (value) => {
                    if (!cancelled) {
                        setData(value);
                        setError(null);
                    }
                },
                (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
            );
        void run();
        const timer = intervalMs ? setInterval(run, intervalMs) : undefined;
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [...deps, tick, intervalMs]);
    const reload = useCallback(() => setTick((t) => t + 1), []);
    return { data, error, reload };
}
