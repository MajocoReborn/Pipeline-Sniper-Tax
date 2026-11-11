// The built site in Chromium, with a stand-in Wallet Standard wallet, against a stand-in RPC
// and API (test/browser/fake-chain.ts): no network, no keys, no SOL. It covers what unit tests
// can't see: what the real page does with hostile data, that the wallet is asked only after a
// simulation and only for the transaction the page described, and that the page runs under its
// Content-Security-Policy without a violation. The same flows against devnet are in
// devnet.browser.e2e.test.ts.
//
//   npm run build && BROWSER_E2E=1 npx vitest run test/browser.e2e.test.ts

import { generateKeyPairSigner, getU64Codec, type Address } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { INSTRUCTION_DISCRIMINATORS, PROGRAM_ID, createMarketIx } from '../src/client/index.js';
import { SIGNATURE_FEE } from '../src/launch/chain.js';
import { sitePoolKeys } from '../src/launch/transactions.js';
import { maxSellable, quoteTrade, traderAccounts } from '../src/market/trade.js';
import { PIPELINE_PROGRAM_ADDRESS, feeAccountPda, pipelineFee } from '../src/vendor/pipeline/index.js';

import {
    FakeChain,
    poolAccount,
    poolState,
    readTransaction,
    rentFor,
    tokenAccount,
    type FakeMarket,
} from './browser/fake-chain.js';
import { installWallet, launchBrowser, serveSite, watchPage, type SignRequest, type Site } from './browser/site.js';

const RPC_HOST = 'api.devnet.solana.com';
const API_HOST = 'pipeline-devnet.up.railway.app';
const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
};
const SOL = 1_000_000_000n;
/** Where the test tokens keep their image, and the one-pixel image it serves. */
const IMAGE_HOST = 'images.example.org';
const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

const newAddress = async () => (await generateKeyPairSigner()).address;

describe.skipIf(!process.env.BROWSER_E2E)('the site in Chromium, with a stand-in wallet', () => {
    let site: Site;
    let browser: Browser;
    let context: BrowserContext;
    let chain: FakeChain;
    /** Hosts the page asked for besides its own. */
    let asked: string[];
    let watched: { violations: string[]; errors: string[] };
    /** Every request the page made of the wallet. */
    let signRequests: SignRequest[];
    /** Set to decline the next request, as a user would in their wallet. */
    let sign: (request: SignRequest) => Promise<Uint8Array>;

    beforeAll(async () => {
        site = await serveSite();
        browser = await launchBrowser();
    });

    afterAll(async () => {
        await browser?.close();
        await site?.close();
    });

    afterEach(async () => {
        await context?.close();
    });

    /** A fresh browser profile on a fresh chain; `wallet` connects the stand-in wallet as that address. */
    async function open(hash: string, wallet?: Address): Promise<Page> {
        context = await browser.newContext();
        asked = [];
        signRequests = [];
        sign = async () => {
            const signature = crypto.getRandomValues(new Uint8Array(64));
            chain.confirm(signature);
            return signature;
        };
        watched = await watchPage(context);
        await context.route('**/*', async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin === site.url) {
                return route.continue();
            }
            asked.push(url.host);
            if (request.method() === 'OPTIONS') {
                return route.fulfill({ status: 204, headers: CORS });
            }
            if (url.host === RPC_HOST) {
                const { id, method, params } = request.postDataJSON();
                const body = JSON.stringify({ jsonrpc: '2.0', id, result: chain.rpc(method, params ?? []) });
                return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body });
            }
            if (url.host === API_HOST) {
                const body = chain.api(url.pathname + url.search);
                return route.fulfill({
                    status: body === null ? 404 : 200,
                    contentType: 'application/json',
                    headers: CORS,
                    body: JSON.stringify(body ?? { error: 'not found' }),
                });
            }
            if (url.host === IMAGE_HOST) {
                return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
            }
            return route.abort();
        });
        let page: Page | undefined;
        if (wallet) {
            await installWallet(context, wallet, async (request) => {
                chain.events.push('wallet');
                signRequests.push(request);
                // While the wallet has the request, the page says what it did first.
                await page!
                    .getByText(/Simulated\..*Approve it in your wallet\./)
                    .first()
                    .waitFor({ timeout: 5_000 });
                return sign(request);
            });
        }
        page = await context.newPage();
        await page.goto(`${site.url}/${hash}`);
        if (wallet) {
            await page.getByRole('button', { name: 'Stand-in Wallet' }).click();
        }
        return page;
    }

    /** The page stayed inside its policy, logged no error, and asked only its three hosts. */
    function expectCleanPage() {
        expect(watched.violations).toEqual([]);
        expect(watched.errors).toEqual([]);
        expect(asked.filter((host) => host !== RPC_HOST && host !== API_HOST && host !== IMAGE_HOST)).toEqual([]);
    }

    /** The wallet was asked once, and only after the last simulation (`open` checks the page said so). */
    function expectAskedAfterSimulation() {
        expect(signRequests).toHaveLength(1);
        expect(chain.events.filter((e) => e === 'wallet')).toHaveLength(1);
        expect(chain.events.lastIndexOf('simulateTransaction')).toBeGreaterThan(-1);
        expect(chain.events.lastIndexOf('simulateTransaction')).toBeLessThan(chain.events.indexOf('wallet'));
    }

    async function fairPool(creator: Address, accruedTaxQuote = 0n): Promise<FakeMarket> {
        return chain.addPool({
            creator,
            tokenMint: await newAddress(),
            name: 'Fair Token',
            symbol: 'FAIR',
            uri: `https://${IMAGE_HOST}/fair.png`,
            accruedTaxQuote,
        });
    }

    const verified = (market: FakeMarket) => ({ address: market.keys.address, ...market, mint: null });

    it('lists only pools it can verify against SOL, and shows hostile metadata as plain text', async () => {
        chain = await FakeChain.create();
        const creator = await newAddress();
        const fair = await fairPool(creator);
        // A token whose name tries markup and a direction override, whose symbol hides a
        // character to read as SOL, and whose image points into the visitor's own network.
        await chain.addPool({
            creator,
            tokenMint: await newAddress(),
            name: '‮Official <img src=x onerror="window.__xss=1"><script>window.__xss=1</script>',
            symbol: 'S​OL',
            uri: 'https://192.168.1.1/pixel.gif',
        });
        // A real pool of our program, but against a token of the creator's making: its reserves
        // of that token must not show as SOL.
        await chain.addPool({
            creator,
            tokenMint: await newAddress(),
            name: 'Billion SOL Pool',
            symbol: 'RICH',
            quoteMint: await newAddress(),
            quoteProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        // An account that reads like a pool but belongs to another program.
        await chain.addPool({
            creator,
            tokenMint: await newAddress(),
            name: 'Not Ours',
            symbol: 'FAKE',
            owner: SYSTEM_PROGRAM_ADDRESS,
        });
        // The fair pool again under a market address that isn't its own, and plain nonsense.
        chain.listed.push({ ...(chain.apiMarket(fair) as object), address: await newAddress() }, 'nonsense', {
            markets: '<script>window.__xss=1</script>',
        });

        const page = await open('#/');
        await page.getByText('Fair Token').waitFor();
        const rows = await page.locator('.launch-row').allInnerTexts();
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('Fair Token');
        expect(rows[0]).toContain('All checks pass');
        // The markup arrives as text, without the override; the long name is cut short.
        expect(rows[1]).toContain('Official <img src=x onerror="window.__x…');
        expect(rows[1]).not.toContain('‮');
        expect(rows[1]).toMatch(/\bSOL\b/);
        expect(await page.getByText('3 markets left out').count()).toBe(1);
        expect(await page.getByText('Billion SOL Pool').count()).toBe(0);
        expect(await page.getByText('Not Ours').count()).toBe(0);

        expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
        // One image: the fair token's. The other link points into a private network and is never asked for.
        expect(
            await page.locator('.launch-row img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src'))),
        ).toEqual([`https://${IMAGE_HOST}/fair.png`]);
        expect(asked).toContain(IMAGE_HOST);
        expect(asked).not.toContain('192.168.1.1');
        expectCleanPage();
    }, 60_000);

    it('does not show or trade a pool against another token, even by its address', async () => {
        chain = await FakeChain.create();
        const creator = await newAddress();
        const rich = await chain.addPool({
            creator,
            tokenMint: await newAddress(),
            name: 'Billion SOL Pool',
            symbol: 'RICH',
            quoteMint: await newAddress(),
            quoteProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        const fake = await chain.addPool({
            creator,
            tokenMint: await newAddress(),
            name: 'Not Ours',
            symbol: 'FAKE',
            owner: SYSTEM_PROGRAM_ADDRESS,
        });
        const page = await open(`#/pool/${rich.keys.address}`);
        await page.getByText('Not a pool against SOL').waitFor();
        expect(await page.getByText('Billion SOL Pool').count()).toBe(0);
        expect(await page.getByRole('button', { name: /Buy|Sell/ }).count()).toBe(0);

        await page.goto(`${site.url}/#/pool/${fake.keys.address}`);
        await page.getByText('Not a pool this site can verify').waitFor();
        expect(await page.getByRole('button', { name: /Buy|Sell/ }).count()).toBe(0);
        expectCleanPage();
    }, 60_000);

    it('buys: simulates first, then asks the wallet once, for the trade the page described', async () => {
        chain = await FakeChain.create();
        const trader = await newAddress();
        const fair = await fairPool(await newAddress());
        chain.fund(trader, 5n * SOL);
        const amountIn = SOL / 10n;
        const tokenRent = rentFor(170);
        chain.simulate = (_, balance) => ({
            err: null,
            lamportsAfter: balance - amountIn - pipelineFee(amountIn) - tokenRent - SIGNATURE_FEE,
        });

        const page = await open(`#/pool/${fair.keys.address}`, trader);
        await page.getByRole('button', { name: 'Buy FAIR' }).click();
        await page.getByText('Done.').waitFor();
        expectAskedAfterSimulation();

        const seen = readTransaction(signRequests[0]!.transaction);
        expect(seen).toEqual(chain.simulated.at(-1));
        expect(seen.feePayer).toBe(trader);
        expect([seen.signers, seen.signed]).toEqual([1, 0]);
        // Wrapped-SOL account, wrap, sync, token account, the router's swap, unwrap.
        expect(seen.instructions.map((ix) => ix.program)).toEqual([
            ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
            SYSTEM_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
            ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
            PIPELINE_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
        ]);
        // The SOL leaves the wallet only for the trader's own wrapped-SOL account: the amount and Pipeline's fee.
        const mine = await traderAccounts(verified(fair), trader);
        const [, wrap, , , swap, close] = seen.instructions;
        expect(wrap!.accounts).toEqual([trader, mine.quote]);
        expect(getU64Codec().decode(wrap!.data, 4)).toBe(amountIn + pipelineFee(amountIn));
        expect(close!.accounts).toEqual([mine.quote, trader, trader]);
        // The swap names this pool and its vaults, and carries the minimum the page showed.
        const quote = quoteTrade(verified(fair), 'buy', trader, amountIn, BigInt(chain.now), 100);
        if ('error' in quote) {
            throw new Error(quote.error);
        }
        const { keys } = fair;
        for (const expected of [trader, keys.address, keys.market, keys.quoteVault, keys.tokenVault, mine.token]) {
            expect(swap!.accounts, expected).toContain(expected);
        }
        const u64 = (value: bigint) => [...getU64Codec().encode(value)].join(',');
        expect(swap!.data.join(',')).toContain(u64(amountIn));
        expect(swap!.data.join(',')).toContain(u64(quote.minAmountOut));
        // Nothing in the transaction goes to an address the page didn't derive for this pool and wallet.
        const known = new Set<string>([
            trader,
            mine.quote,
            mine.token,
            keys.tokenMint,
            keys.quoteMint,
            keys.tokenVault,
            keys.quoteVault,
            SYSTEM_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
            TOKEN_2022_PROGRAM_ADDRESS,
            'SysvarRent111111111111111111111111111111111',
        ]);
        for (const ix of seen.instructions.filter((i) => i.program !== PIPELINE_PROGRAM_ADDRESS)) {
            expect(ix.accounts.filter((a) => !known.has(a))).toEqual([]);
        }
        expectCleanPage();
    }, 60_000);

    it('does not ask the wallet when the simulation fails or costs more than the page showed', async () => {
        chain = await FakeChain.create();
        const trader = await newAddress();
        const fair = await fairPool(await newAddress());
        chain.fund(trader, 5n * SOL);
        // The transaction would take a whole SOL more than the buy the page described.
        chain.simulate = (_, balance) => ({ err: null, lamportsAfter: balance - SOL / 10n - SOL });
        const page = await open(`#/pool/${fair.keys.address}`, trader);
        await page.getByRole('button', { name: 'Buy FAIR' }).click();
        await page.getByText(/more than the .* SOL shown\. Nothing was sent\./).waitFor();
        expect(signRequests).toEqual([]);

        // The cost can't be read from the simulation at all.
        chain.simulate = () => ({ err: null, lamportsAfter: null });
        await page.getByRole('button', { name: 'Buy FAIR' }).click();
        await page.getByText('could not be read from the simulation. Nothing was sent.').waitFor();
        expect(signRequests).toEqual([]);

        // The simulation fails; its logs are text, whatever they hold.
        chain.simulate = (_, balance) => ({
            err: { InstructionError: [4, { Custom: 6021 }] },
            logs: ['Program log: <img src=x onerror="window.__xss=1">', 'Program log: Error Code: InsufficientOutput'],
            lamportsAfter: balance,
        });
        await page.getByRole('button', { name: 'Buy FAIR' }).click();
        await page.getByText('the price moved past your slippage').waitFor();
        await page.getByText('Program logs').click();
        expect(await page.locator('pre').innerText()).toContain('<img src=x onerror=');
        expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
        expect(signRequests).toEqual([]);
        expect(chain.events).not.toContain('wallet');
        expectCleanPage();
    }, 60_000);

    it('says so when the user declines in the wallet, and sends nothing', async () => {
        chain = await FakeChain.create();
        const trader = await newAddress();
        const fair = await fairPool(await newAddress());
        chain.fund(trader, 5n * SOL);
        chain.simulate = (_, balance) => ({ err: null, lamportsAfter: balance - SOL / 10n });
        const page = await open(`#/pool/${fair.keys.address}`, trader);
        sign = async () => {
            throw new Error('User rejected the request.');
        };
        await page.getByRole('button', { name: 'Buy FAIR' }).click();
        await page.getByText('User rejected the request.').waitFor();
        expect(chain.signatures.size).toBe(0);
        expect(await page.getByText('Done.').count()).toBe(0);
    }, 60_000);

    it('sells everything the wallet can: the tokens to the pool, the SOL back to the wallet', async () => {
        chain = await FakeChain.create();
        const trader = await newAddress();
        const fair = await fairPool(await newAddress());
        const mine = await traderAccounts(verified(fair), trader);
        const held = 1_000_000_000_000n;
        chain.fund(trader, SOL);
        chain.accounts.set(mine.token, tokenAccount(held));
        const amountIn = maxSellable(held);
        const quote = quoteTrade(verified(fair), 'sell', trader, amountIn, BigInt(chain.now), 100);
        if ('error' in quote) {
            throw new Error(quote.error);
        }
        chain.simulate = (_, balance) => ({
            err: null,
            lamportsAfter: balance + quote.quote.amountOut - SIGNATURE_FEE,
        });

        const page = await open(`#/pool/${fair.keys.address}`, trader);
        await page.getByRole('tab', { name: 'Sell' }).click();
        await page.getByRole('button', { name: 'Max' }).click();
        await page.getByRole('button', { name: 'Sell FAIR' }).click();
        await page.getByText('Done.').waitFor();
        expectAskedAfterSimulation();

        const seen = readTransaction(signRequests[0]!.transaction);
        expect(seen.feePayer).toBe(trader);
        // Wrapped-SOL account for the proceeds, the router's swap, unwrap.
        expect(seen.instructions.map((ix) => ix.program)).toEqual([
            ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
            PIPELINE_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
        ]);
        const [, swap, close] = seen.instructions;
        const u64 = (value: bigint) => [...getU64Codec().encode(value)].join(',');
        expect(amountIn + pipelineFee(amountIn)).toBeLessThanOrEqual(held);
        expect(swap!.data.join(',')).toContain(u64(amountIn));
        expect(swap!.data.join(',')).toContain(u64(quote.minAmountOut));
        expect(close!.accounts).toEqual([mine.quote, trader, trader]);

        // A sell that would pay out less than the minimum the page showed is not sent.
        chain.simulate = (_, balance) => ({
            err: null,
            lamportsAfter: balance + quote.minAmountOut - SIGNATURE_FEE - 1n,
        });
        await page.getByRole('button', { name: 'Sell FAIR' }).click();
        await page.getByText(/less than the .* SOL expected\. Nothing was sent\./).waitFor();
        expect(signRequests).toHaveLength(1);
        expectCleanPage();
    }, 60_000);

    it("claims the creator's tax: only their own pools, paid to their own wallet", async () => {
        chain = await FakeChain.create();
        const creator = await newAddress();
        const claimable = 8_118_000n;
        const fair = await fairPool(creator, claimable);
        // Someone else's pool, which a dashboard must not list or claim.
        await chain.addPool({
            creator: await newAddress(),
            tokenMint: await newAddress(),
            name: 'Somebody Else',
            symbol: 'ELSE',
            accruedTaxQuote: 5n * SOL,
        });
        chain.fund(creator, SOL);
        chain.simulate = (_, balance) => ({ err: null, lamportsAfter: balance + claimable - SIGNATURE_FEE });

        const page = await open('#/creator', creator);
        await page.getByText('Fair Token').waitFor();
        expect(await page.locator('.creator-row').count()).toBe(1);
        expect(await page.getByText('Somebody Else').count()).toBe(0);
        await page.getByRole('button', { name: 'Claim', exact: true }).click();
        await page.getByText('Claimed 0.008118 SOL').waitFor();
        expectAskedAfterSimulation();

        const seen = readTransaction(signRequests[0]!.transaction);
        expect(seen.feePayer).toBe(creator);
        // Wrapped-SOL account, our program's claim, unwrap.
        expect(seen.instructions.map((ix) => ix.program)).toEqual([
            ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
            PROGRAM_ID,
            TOKEN_PROGRAM_ADDRESS,
        ]);
        const [, claim, close] = seen.instructions;
        const wrapped = (await traderAccounts(verified(fair), creator)).quote;
        expect([...claim!.data]).toEqual([...INSTRUCTION_DISCRIMINATORS.claimTax]);
        expect(claim!.accounts).toEqual([
            creator,
            fair.keys.address,
            fair.keys.quoteMint,
            fair.keys.quoteVault,
            wrapped,
            TOKEN_PROGRAM_ADDRESS,
        ]);
        expect(close!.accounts).toEqual([wrapped, creator, creator]);

        // A claim that would pay the creator less than the page showed is not sent.
        chain.simulate = (_, balance) => ({ err: null, lamportsAfter: balance + claimable - SIGNATURE_FEE - 1n });
        await page.getByRole('button', { name: 'Claim', exact: true }).click();
        await page.getByText(/less than the .* SOL expected\. Nothing was sent\./).waitFor();
        expect(signRequests).toHaveLength(1);
        expectCleanPage();
    }, 60_000);

    it('launches although a stranger created the pool between the two transactions', async () => {
        chain = await FakeChain.create();
        const creator = await newAddress();
        chain.fund(creator, 5n * SOL);
        const form = {
            name: 'Grief Proof',
            symbol: 'GRIEF',
            uri: `https://${IMAGE_HOST}/grief.png`,
            preset: 'normal' as const,
            permanentFeeBps: 0,
            creatorShareBps: 0,
            liquidityLamports: SOL,
        };
        const page = await open('#/launch', creator);
        const accept = sign;
        let keys: Awaited<ReturnType<typeof sitePoolKeys>> | undefined;
        sign = async (request) => {
            if (signRequests.length === 1) {
                // The token transaction: the new mint signs with the creator. A stranger who
                // sees it creates the creator's pool and one fee account before the creator can.
                const token = readTransaction(request.transaction);
                expect([token.signers, token.signed]).toEqual([2, 1]);
                expect(new Set(token.instructions.map((ix) => ix.program))).toEqual(
                    new Set([SYSTEM_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS]),
                );
                const mint = token.instructions[0]!.accounts[1]!;
                keys = await sitePoolKeys(creator, mint, form);
                chain.accounts.set(
                    keys.address,
                    poolAccount(poolState(keys, { status: 'pending', reserveToken: 0n, reserveQuote: 0n })),
                );
                chain.accounts.set(
                    await feeAccountPda(keys.market, keys.tokenMint, keys.tokenProgram),
                    tokenAccount(0n),
                );
            }
            return accept(request);
        };
        await page.getByLabel('Name').fill(form.name);
        await page.getByLabel('Symbol').fill(form.symbol);
        await page.getByLabel('Image link').fill(form.uri);
        await page.getByRole('button', { name: 'Launch', exact: true }).click();
        await page.getByText('Grief Proof (GRIEF) is live').waitFor({ timeout: 30_000 });

        expect(signRequests).toHaveLength(2);
        const pool = readTransaction(signRequests[1]!.transaction);
        expect(pool.feePayer).toBe(creator);
        const router = pool.instructions.filter((ix) => ix.program === PIPELINE_PROGRAM_ADDRESS);
        const createMarket = await createMarketIx(keys!, creator);
        // Only the fee account that is still missing; `create_market` would have failed.
        expect(router).toHaveLength(1);
        expect([...router[0]!.data]).not.toEqual([...createMarket.data!]);
        const ours = pool.instructions.filter((ix) => ix.program === PROGRAM_ID);
        expect(ours).toHaveLength(1);
        expect([...ours[0]!.data.slice(0, 8)]).toEqual([...INSTRUCTION_DISCRIMINATORS.launch]);
        expect(ours[0]!.accounts[0]).toBe(creator);
        expect(ours[0]!.accounts[1]).toBe(keys!.address);
        expectCleanPage();
    }, 90_000);

    it('refuses to be framed by another site', async () => {
        chain = await FakeChain.create();
        const page = await open('#/');
        await page.locator('#root h1').waitFor();
        // The same site inside a frame on another origin: Chromium shows an error page instead.
        const outside = await context.newPage();
        await outside.setContent(`<iframe src="${site.url}/" width="800" height="600"></iframe>`);
        await outside.waitForTimeout(1_500);
        const frame = outside.frames().find((f) => f !== outside.mainFrame());
        expect(frame).toBeDefined();
        expect(frame!.url()).not.toContain(site.url);
        expect(await frame!.locator('#root').count()).toBe(0);
    }, 60_000);
});
