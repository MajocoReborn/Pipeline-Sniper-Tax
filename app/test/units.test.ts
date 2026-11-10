import { describe, expect, it } from 'vitest';

import { formatBps, formatSol, parseSol, shortAddress } from '../src/launch/units.js';

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
