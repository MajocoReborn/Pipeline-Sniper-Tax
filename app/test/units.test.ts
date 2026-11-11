import { describe, expect, it } from 'vitest';

import {
    formatAge,
    formatBps,
    formatDuration,
    formatSignificant,
    formatSol,
    formatUnits,
    parseSol,
    parseUnits,
    shortAddress,
} from '../src/launch/units.js';

describe('SOL amounts', () => {
    it('parse exactly, with a dot or a comma', () => {
        expect(parseSol('1')).toBe(1_000_000_000n);
        expect(parseSol('1.5')).toBe(1_500_000_000n);
        expect(parseSol('0,25')).toBe(250_000_000n);
        expect(parseSol('0.000000001')).toBe(1n);
        expect(parseSol(' 2 ')).toBe(2_000_000_000n);
    });

    it('refuse anything else', () => {
        for (const text of ['', '.5', '1.', '1.0000000001', '-1', '1e3', 'abc', '1 000', '0x10']) {
            expect(parseSol(text), text).toBeNull();
        }
    });

    it('format without trailing zeros, rounding down', () => {
        expect(formatSol(1_500_000_000n)).toBe('1.5');
        expect(formatSol(1n)).toBe('0.000000001');
        expect(formatSol(1_234_567_891n, 4)).toBe('1.2345');
        expect(formatSol(0n)).toBe('0');
        expect(formatSol(-2_000_000_000n)).toBe('-2');
        expect(parseSol(formatSol(123_456_789_012n))).toBe(123_456_789_012n);
    });
});

describe('display helpers', () => {
    it('format basis points and addresses', () => {
        expect(formatBps(9_900)).toBe('99%');
        expect(formatBps(250)).toBe('2.5%');
        expect(shortAddress('CUiq3QQbXMsrgCpiN423zr2NTrdfPRuGUy9EQKQ6CGap')).toBe('CUiq…CGap');
    });
});

describe('token amounts', () => {
    it('parse and format with any number of decimals', () => {
        expect(parseUnits('42.857142', 6)).toBe(42_857_142n);
        expect(parseUnits('1', 0)).toBe(1n);
        expect(parseUnits('1.5', 0)).toBeNull();
        expect(parseUnits('1.0000001', 6)).toBeNull();
        expect(parseUnits('', 6)).toBeNull();
        expect(formatUnits(42_857_142_857_142n, 6, 2, true)).toBe('42,857,142.85');
        expect(formatUnits(1_000_000_000_000_000n, 6, 6, true)).toBe('1,000,000,000');
        expect(formatUnits(123n, 6)).toBe('0.000123');
        expect(formatUnits(5n, 0, 0, true)).toBe('5');
        for (const raw of [0n, 1n, 999_999n, 123_456_789_012_345n]) {
            expect(parseUnits(formatUnits(raw, 6), 6)).toBe(raw);
        }
    });

    it('format durations, ages and small prices', () => {
        expect(formatDuration(42)).toBe('42s');
        expect(formatDuration(90)).toBe('1:30');
        expect(formatDuration(-3)).toBe('0s');
        expect(formatAge(59)).toBe('59s');
        expect(formatAge(3_599)).toBe('59 min');
        expect(formatAge(7_200)).toBe('2 h');
        expect(formatAge(200_000)).toBe('2 d');
        expect(formatSignificant(0.000000000111111)).toBe('0.0000000001111');
        expect(formatSignificant(0.11)).toBe('0.11');
        expect(formatSignificant(1234.5678)).toBe('1,234.568');
        expect(formatSignificant(0)).toBe('0');
    });
});
