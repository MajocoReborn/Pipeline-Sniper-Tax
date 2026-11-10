// SOL amounts as text, exactly: lamports are integers, so no floating point is involved.

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** "1.5" → 1_500_000_000n. `null` for anything that isn't a plain amount with at most 9 decimals. */
export function parseSol(text: string): bigint | null {
    const match = /^\s*(\d{1,12})(?:[.,](\d{1,9}))?\s*$/.exec(text);
    if (!match) {
        return null;
    }
    const whole = BigInt(match[1]!);
    const fraction = BigInt((match[2] ?? '').padEnd(9, '0'));
    return whole * LAMPORTS_PER_SOL + fraction;
}

/** 1_500_000_000n → "1.5", with at most `decimals` decimals (rounded down). */
export function formatSol(lamports: bigint, decimals = 9): string {
    const sign = lamports < 0n ? '-' : '';
    const value = lamports < 0n ? -lamports : lamports;
    const whole = value / LAMPORTS_PER_SOL;
    const fraction = (value % LAMPORTS_PER_SOL).toString().padStart(9, '0').slice(0, decimals).replace(/0+$/, '');
    return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** 250 → "2.5%". */
export function formatBps(bps: number): string {
    return `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/** A shortened address for display: first and last four characters. */
export function shortAddress(address: string): string {
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
