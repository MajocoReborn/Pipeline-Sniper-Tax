// What a creator fills in, its rules, and the amounts that follow from it. Plain functions,
// so the launch page and the tests share exactly the same logic.

import type { Address } from '@solana/kit';

import { MAX_END_BPS, isValidSchedule, type InitParams, type TaxSchedule } from '../client/index.js';

/** Every launch on the site has a sniper tax (decision S8); the creator picks its strength. */
export const PRESETS = {
    strong: { label: 'Strong', description: '99% falling to 0% over 10 minutes', startBps: 9_900, durationSecs: 600 },
    normal: { label: 'Normal', description: '99% falling to 0% over 90 seconds', startBps: 9_900, durationSecs: 90 },
    mild: { label: 'Mild', description: '50% falling to 0% over 60 seconds', startBps: 5_000, durationSecs: 60 },
} as const;

export type PresetId = keyof typeof PRESETS;

/** Every token launched from the site: a fixed supply of one billion, six decimals. */
export const TOKEN_DECIMALS = 6;
export const TOKEN_SUPPLY = 1_000_000_000n * 10n ** BigInt(TOKEN_DECIMALS);

/** The creator may keep at most this share of the supply outside the pool (decision S6). */
export const MAX_CREATOR_SHARE_BPS = 2_000;
/** The least SOL a pool starts with, so a launch isn't a dust pool. */
export const MIN_LIQUIDITY_LAMPORTS = 50_000_000n;

/** Lengths in UTF-8 bytes, the usual limits for token metadata. */
export const MAX_NAME_BYTES = 32;
export const MAX_SYMBOL_BYTES = 10;
export const MAX_URI_BYTES = 200;

export type LaunchForm = {
    name: string;
    symbol: string;
    /** HTTPS link to the token's image, or to a metadata JSON document with an `image`. */
    uri: string;
    preset: PresetId;
    /** The tax after the window, for good: 0 to 5%. */
    permanentFeeBps: number;
    /** The share of the supply the creator keeps outside the pool: 0 to 20%. */
    creatorShareBps: number;
    /** The SOL the creator puts into the pool. */
    liquidityLamports: bigint;
};

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** The form with surrounding whitespace removed and the symbol in capitals. */
export function normalizeForm(form: LaunchForm): LaunchForm {
    return { ...form, name: form.name.trim(), symbol: form.symbol.trim().toUpperCase(), uri: form.uri.trim() };
}

export function taxSchedule(form: Pick<LaunchForm, 'preset' | 'permanentFeeBps'>): TaxSchedule {
    const preset = PRESETS[form.preset];
    return { startBps: preset.startBps, endBps: form.permanentFeeBps, durationSecs: preset.durationSecs };
}

/** What is wrong with a (normalized) form, as messages for the creator. Empty when it is fine. */
export function validateForm(form: LaunchForm): string[] {
    const errors: string[] = [];
    if (form.name.length === 0 || utf8Length(form.name) > MAX_NAME_BYTES) {
        errors.push(`The name must be 1 to ${MAX_NAME_BYTES} bytes.`);
    }
    if (/\p{Cc}/u.test(form.name)) {
        errors.push('The name may not contain control characters.');
    }
    if (!/^[A-Z0-9]{1,10}$/.test(form.symbol) || utf8Length(form.symbol) > MAX_SYMBOL_BYTES) {
        errors.push(`The symbol must be 1 to ${MAX_SYMBOL_BYTES} letters or digits.`);
    }
    let url: URL | null = null;
    try {
        url = new URL(form.uri);
    } catch {
        url = null;
    }
    if (url === null || url.protocol !== 'https:' || utf8Length(form.uri) > MAX_URI_BYTES) {
        errors.push(`The image link must be an https:// address of at most ${MAX_URI_BYTES} bytes.`);
    }
    if (!(form.preset in PRESETS)) {
        errors.push('Pick a tax strength.');
    } else if (
        !Number.isInteger(form.permanentFeeBps) ||
        form.permanentFeeBps < 0 ||
        form.permanentFeeBps > MAX_END_BPS
    ) {
        errors.push(`The permanent fee must be 0 to ${MAX_END_BPS / 100}%.`);
    } else if (!isValidSchedule(taxSchedule(form))) {
        errors.push('That tax schedule is not allowed.');
    }
    if (
        !Number.isInteger(form.creatorShareBps) ||
        form.creatorShareBps < 0 ||
        form.creatorShareBps > MAX_CREATOR_SHARE_BPS
    ) {
        errors.push(`You can keep 0 to ${MAX_CREATOR_SHARE_BPS / 100}% of the supply.`);
    }
    if (form.liquidityLamports < MIN_LIQUIDITY_LAMPORTS) {
        errors.push(`The pool needs at least ${Number(MIN_LIQUIDITY_LAMPORTS) / 1e9} SOL.`);
    }
    return errors;
}

/** How the supply splits between the pool and the creator. */
export function launchAmounts(form: Pick<LaunchForm, 'creatorShareBps'>): {
    poolTokens: bigint;
    creatorTokens: bigint;
} {
    const creatorTokens = (TOKEN_SUPPLY * BigInt(form.creatorShareBps)) / 10_000n;
    return { poolTokens: TOKEN_SUPPLY - creatorTokens, creatorTokens };
}

export function initParams(creator: Address, form: Pick<LaunchForm, 'preset' | 'permanentFeeBps'>): InitParams {
    const schedule = taxSchedule(form);
    return {
        creator,
        taxStartBps: schedule.startBps,
        taxEndBps: schedule.endBps,
        taxDurationSecs: schedule.durationSecs,
    };
}
