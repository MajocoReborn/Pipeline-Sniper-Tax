// What the browser tests share: the built site served with the host's own headers, a Chromium
// to open it in, and a stand-in Wallet Standard wallet whose signing happens in Node.js.

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAddressEncoder, type Address } from '@solana/kit';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

/** `dist/_headers` as Cloudflare reads it: for each path pattern, the headers under it. */
function headerRules(file: string): { pattern: RegExp; headers: [string, string][] }[] {
    const rules: { pattern: RegExp; headers: [string, string][] }[] = [];
    for (const line of file.split('\n')) {
        if (line.trim() === '' || line.startsWith('#')) {
            continue;
        }
        if (!line.startsWith(' ')) {
            const pattern = line
                .trim()
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            rules.push({ pattern: new RegExp(`^${pattern}$`), headers: [] });
        } else {
            const colon = line.indexOf(':');
            rules.at(-1)?.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
        }
    }
    return rules;
}

export type Site = { url: string; close: () => Promise<void> };

/**
 * Serves `dist/` (run `npm run build` first) the way the host does: `index.html` at `/`, a
 * 404 for anything that isn't a file, and the response headers of `_headers`, so the page runs
 * under the same Content-Security-Policy as the live site.
 */
export async function serveSite(): Promise<Site> {
    if (!existsSync(join(DIST, 'index.html'))) {
        throw new Error('app/dist is missing: run `npm run build` before the browser tests.');
    }
    const rules = headerRules(readFileSync(join(DIST, '_headers'), 'utf8'));
    const server: Server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        for (const rule of rules) {
            if (rule.pattern.test(path)) {
                for (const [name, value] of rule.headers) {
                    response.setHeader(name, value);
                }
            }
        }
        const file = join(DIST, normalize(path === '/' ? '/index.html' : path));
        if (!file.startsWith(DIST) || path === '/_headers' || !existsSync(file) || extname(file) === '') {
            response.writeHead(404).end('Not found');
            return;
        }
        response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
        response.end(readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        // `localhost` is a secure context, which the page's key derivation needs.
        url: `http://localhost:${port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

/**
 * Chromium: the one at `BROWSER_E2E_CHROME`, else Playwright's own if it is installed, else
 * the computer's Chrome (which GitHub's runners have). With `network`, pages reach the real
 * devnet RPC and API, through the proxy in `HTTPS_PROXY` if this computer needs one.
 */
export async function launchBrowser(options: { network?: boolean } = {}): Promise<Browser> {
    const server = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    const proxy = options.network && server ? { proxy: { server } } : {};
    if (options.network && server) {
        // Playwright sends even localhost through a proxy unless told not to; the site is served here.
        process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
    }
    const executablePath = process.env.BROWSER_E2E_CHROME;
    if (executablePath) {
        return chromium.launch({ executablePath, ...proxy });
    }
    try {
        return await chromium.launch(proxy);
    } catch {
        return chromium.launch({ channel: 'chrome', ...proxy });
    }
}

/**
 * The wallet, as the page sees it: it registers through the Wallet Standard like an extension
 * does, has one devnet account, and hands every transaction to Node.js (`__standInWallet`)
 * along with the page's text at that moment, so the test can check what the page had told the
 * user before it asked. Plain JavaScript in a string, because it runs in the page.
 */
const WALLET_SCRIPT = `(({ address, publicKey }) => {
    const account = {
        address,
        publicKey: new Uint8Array(publicKey),
        chains: ['solana:devnet'],
        features: ['solana:signAndSendTransaction'],
    };
    let accounts = [];
    const listeners = new Set();
    const change = (next) => {
        accounts = next;
        listeners.forEach((listener) => listener({ accounts }));
    };
    const wallet = {
        version: '1.0.0',
        name: 'Stand-in Wallet',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
        chains: ['solana:devnet'],
        get accounts() {
            return accounts;
        },
        features: {
            'standard:connect': {
                version: '1.0.0',
                connect: async () => {
                    change([account]);
                    return { accounts };
                },
            },
            'standard:disconnect': { version: '1.0.0', disconnect: async () => change([]) },
            'standard:events': {
                version: '1.0.0',
                on: (event, listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
            'solana:signAndSendTransaction': {
                version: '1.0.0',
                supportedTransactionVersions: ['legacy', 0],
                signAndSendTransaction: async (...inputs) => {
                    const outputs = [];
                    for (const input of inputs) {
                        const signature = await window.__standInWallet(
                            Array.from(input.transaction),
                            document.body.innerText,
                        );
                        outputs.push({ signature: new Uint8Array(signature) });
                    }
                    return outputs;
                },
            },
        },
    };
    const register = (api) => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
})`;

/** A request to sign: the wire transaction, and what the page showed when it asked. */
export type SignRequest = { transaction: Uint8Array; pageText: string };

/**
 * Puts the stand-in wallet for `account` into every page of `context`. `sign` gets each
 * request and returns the transaction's signature (after sending it, if the test is on
 * devnet), or throws to decline like a user would.
 */
export async function installWallet(
    context: BrowserContext,
    account: Address,
    sign: (request: SignRequest) => Promise<Uint8Array>,
): Promise<void> {
    await context.exposeFunction('__standInWallet', async (transaction: number[], pageText: string) =>
        Array.from(await sign({ transaction: Uint8Array.from(transaction), pageText })),
    );
    const publicKey = Array.from(getAddressEncoder().encode(account));
    await context.addInitScript({ content: `${WALLET_SCRIPT}(${JSON.stringify({ address: account, publicKey })});` });
}

/**
 * Collects what must stay empty while a page runs: Content-Security-Policy violations, and
 * errors the page logs or throws.
 */
export async function watchPage(context: BrowserContext): Promise<{ violations: string[]; errors: string[] }> {
    const seen = { violations: [] as string[], errors: [] as string[] };
    await context.exposeFunction('__cspViolation', (text: string) => {
        seen.violations.push(text);
    });
    await context.addInitScript({
        content: `document.addEventListener('securitypolicyviolation', (e) =>
            window.__cspViolation(e.violatedDirective + ' ' + e.blockedURI));`,
    });
    context.on('page', (page) => {
        page.on('pageerror', (error) => seen.errors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') {
                seen.errors.push(message.text());
            }
        });
    });
    return seen;
}
