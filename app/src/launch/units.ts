// Token amounts as text, exactly: amounts are integers in the smallest unit, so no floating
// point is involved.

const LAMPORTS_PER_SOL = 1_000_000_000n;
export const SOL_DECIMALS = 9;

/** "1.5" with 6 decimals → 1_500_000n. `null` for anything that isn't a plain amount with at most `decimals` decimals. */
export function parseUnits(text: string, decimals: number): bigint | null {
    const pattern = decimals > 0 ? `^\\s*(\\d{1,15})(?:[.,](\\d{1,${decimals}}))?\\s*$` : '^\\s*(\\d{1,20})\\s*$';
    const match = new RegExp(pattern).exec(text);
    if (!match) {
        return null;
    }
    const whole = BigInt(match[1]!);
    const fraction = BigInt((match[2] ?? '').padEnd(decimals, '0') || '0');
    return whole * 10n ** BigInt(decimals) + fraction;
}

/**
 * 1_500_000n with 6 decimals → "1.5", with at most `maxDecimals` decimals (rounded down) and,
 * with `group`, thousands separated by commas.
 */
export function formatUnits(amount: bigint, decimals: number, maxDecimals = decimals, group = false): string {
    const sign = amount < 0n ? '-' : '';
    const value = amount < 0n ? -amount : amount;
    const unit = 10n ** BigInt(decimals);
    const whole = (value / unit).toString();
    const fraction = (value % unit).toString().padStart(decimals, '0').slice(0, maxDecimals).replace(/0+$/, '');
    const wholeText = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
    return `${sign}${wholeText}${fraction ? `.${fraction}` : ''}`;
}

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
    return formatUnits(lamports, SOL_DECIMALS, decimals);
}

/** 250 → "2.5%". */
export function formatBps(bps: number): string {
    return `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/** A shortened address for display: first and last four characters. */
export function shortAddress(address: string): string {
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** 0:42, 1:30, 12:05 for a countdown in seconds. */
export function formatDuration(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) {
        return `${s}s`;
    }
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How long ago, roughly: "12s", "5 min", "3 h", "2 d". */
export function formatAge(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) {
        return `${s}s`;
    }
    if (s < 3_600) {
        return `${Math.floor(s / 60)} min`;
    }
    if (s < 86_400) {
        return `${Math.floor(s / 3_600)} h`;
    }
    return `${Math.floor(s / 86_400)} d`;
}

/** A small positive number with `digits` significant digits, without exponent notation. */
export function formatSignificant(value: number, digits = 4): string {
    if (!Number.isFinite(value) || value <= 0) {
        return '0';
    }
    if (value >= 1) {
        return value.toLocaleString('en-US', { maximumFractionDigits: Math.max(0, digits - 1) });
    }
    const decimals = Math.min(20, digits - 1 - Math.floor(Math.log10(value)));
    return value.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}
