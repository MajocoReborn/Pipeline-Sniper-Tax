// The hash routes: every page, and anything else is "missing".

import { describe, expect, it } from 'vitest';

import { href, parseRoute } from '../src/route.js';

describe('routes', () => {
    it('find every page from its link', () => {
        const pool = 'Hvn2LMdgdmdcrZeGz22qRd6LU2qU8xP5D7nHsNWRChku';
        expect(parseRoute('')).toEqual({ page: 'launches' });
        expect(parseRoute(href.launches)).toEqual({ page: 'launches' });
        expect(parseRoute(href.launch)).toEqual({ page: 'launch' });
        expect(parseRoute(href.creator)).toEqual({ page: 'creator' });
        expect(parseRoute(href.pool(pool as never))).toEqual({ page: 'pool', pool });
    });

    it('send anything else to "missing"', () => {
        for (const hash of ['#/creator/x', '#/pool/', '#/pool/not-an-address', '#/pool/0OIl', '#/admin']) {
            expect(parseRoute(hash), hash).toEqual({ page: 'missing' });
        }
    });
});
