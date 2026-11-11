// The static host's response headers (public/_headers) against the page's own policy.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The headers of the `/*` rule: indented `Name: value` lines under it. */
function headersForAllPaths(file: string): Map<string, string> {
    const headers = new Map<string, string>();
    let inRule = false;
    for (const line of file.split('\n')) {
        if (!line.startsWith(' ') && line.trim() !== '' && !line.startsWith('#')) {
            inRule = line.trim() === '/*';
        } else if (inRule && line.trim() !== '') {
            const colon = line.indexOf(':');
            headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
    }
    return headers;
}

describe('response headers', () => {
    const headers = headersForAllPaths(read('../public/_headers'));
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(read('../index.html'))?.[1];

    it("send the page's own Content-Security-Policy, plus a ban on framing", () => {
        expect(meta).toBeDefined();
        expect(headers.get('content-security-policy')).toBe(`${meta}; frame-ancestors 'none'`);
        expect(headers.get('x-frame-options')).toBe('DENY');
    });

    it('keep browsers on https for a year', () => {
        expect(headers.get('strict-transport-security')).toMatch(/^max-age=(\d+)$/);
        expect(Number(/\d+/.exec(headers.get('strict-transport-security')!)![0])).toBeGreaterThanOrEqual(31_536_000);
    });

    it('allow scripts, styles and connections only from the site and its two data sources', () => {
        const directives = new Map(
            meta!.split(';').map((d) => {
                const [name, ...values] = d.trim().split(/\s+/);
                return [name!, values] as const;
            }),
        );
        expect(directives.get('default-src')).toEqual(["'self'"]);
        expect(directives.get('script-src')).toEqual(["'self'"]);
        expect(directives.get('style-src')).toEqual(["'self'"]);
        expect(directives.get('object-src')).toEqual(["'none'"]);
        expect(directives.get('base-uri')).toEqual(["'none'"]);
        expect(directives.get('form-action')).toEqual(["'none'"]);
        // Every host the page may send data to. A new one must be a deliberate change, here too.
        expect(directives.get('connect-src')).toEqual([
            "'self'",
            'https://api.devnet.solana.com',
            'https://pipeline-devnet.up.railway.app',
        ]);
        expect(meta).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    });

    it('stop content sniffing and referrers', () => {
        expect(headers.get('x-content-type-options')).toBe('nosniff');
        expect(headers.get('referrer-policy')).toBe('no-referrer');
    });
});
