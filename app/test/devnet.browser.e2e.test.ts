// The built site in Chromium on devnet, with a stand-in Wallet Standard wallet that signs in
// Node.js: a launch through the launch page, a sniper buy and a sell by someone else through
// the token page, and the creator's claim through the dashboard. Every transaction is the one
// the page built; the wallet only checks it, signs it and sends it. Off by default: it spends
// about 0.09 devnet SOL (0.05 of it stays in the new pool) and takes about a minute.
//
//   npm run build
//   DEVNET_E2E=1 DEVNET_E2E_KEYPAIR=<keypair.json> npx vitest run test/devnet.browser.e2e.test.ts --silent=false
//
// The creator is the keypair file, a throwaway key funded with devnet SOL and kept outside the
// repository. The buyer is made in memory; what it has left goes back to the creator at the
// end. The same pages against a stand-in chain, without a network: browser.e2e.test.ts.

import { readFileSync } from 'node:fs';

import {
    createKeyPairSignerFromBytes,
    generateKeyPairSigner,
    getBase58Encoder,
    getBase64EncodedWireTransaction,
    getTransactionDecoder,
    isAddress,
    partiallySignTransaction,
    signTransactionMessageWithSigners,
    type Address,
    type KeyPairSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import type { BrowserContext, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { INSTRUCTION_DISCRIMINATORS, PROGRAM_ID } from '../src/client/index.js';
import { SIGNATURE_FEE, balance, confirm, tokenBalance, type Rpc } from '../src/launch/chain.js';
import { launchMessage } from '../src/launch/transactions.js';
import { readVerifiedPool, withRetryWhileBehind } from '../src/market/pools.js';
import { traderAccounts } from '../src/market/trade.js';
import { PIPELINE_PROGRAM_ADDRESS } from '../src/vendor/pipeline/index.js';

import { readTransaction, type SeenTransaction } from './browser/fake-chain.js';
import { installWallet, launchBrowser, serveSite, watchPage } from './browser/site.js';
import { patientRpc } from './helpers.js';

const SOL = 1_000_000_000n;

/** A wallet for `signer` in `context`: checks each transaction the page hands it, signs and sends it. */
async function standInWallet(rpc: Rpc, context: BrowserContext, signer: KeyPairSigner, page: () => Page) {
    const seen: SeenTransaction[] = [];
    const signatures: string[] = [];
    await installWallet(context, signer.address, async ({ transaction }) => {
        const read = readTransaction(transaction);
        seen.push(read);
        // What a careful user checks before approving: the page simulated first, and they pay.
        await page()
            .getByText(/Simulated\..*Approve it in your wallet\./)
            .first()
            .waitFor({ timeout: 10_000 });
        expect(read.feePayer).toBe(signer.address);
        const signed = await partiallySignTransaction([signer.keyPair], getTransactionDecoder().decode(transaction));
        const signature = await rpc
            .sendTransaction(getBase64EncodedWireTransaction(signed), {
                encoding: 'base64',
                preflightCommitment: 'confirmed',
            })
            .send();
        signatures.push(signature);
        return new Uint8Array(getBase58Encoder().encode(signature));
    });
    return { seen, signatures };
}

/** Clicks `button` and waits for `done`; the public RPC sometimes rate-limits, so a failure is tried again. */
async function clickUntil(page: Page, button: string, done: string | RegExp) {
    for (let attempt = 1; ; attempt++) {
        await page.getByRole('button', { name: button, exact: true }).click();
        const outcome = await Promise.race([
            page
                .getByText(done)
                .first()
                .waitFor({ timeout: 120_000 })
                .then(() => 'done' as const),
            page
                .locator('.failure .error')
                .first()
                .waitFor({ timeout: 120_000 })
                .then(() => 'failed' as const),
        ]);
        if (outcome === 'done') {
            return;
        }
        const message = await page.locator('.failure .error').first().innerText();
        if (attempt >= 3 || !/429|Too Many Requests|fetch/i.test(message)) {
            throw new Error(`"${button}" failed on the page: ${message}`);
        }
        await page.waitForTimeout(5_000 * attempt);
    }
}

describe.skipIf(!process.env.DEVNET_E2E || !process.env.DEVNET_E2E_KEYPAIR)('the site in Chromium on devnet', () => {
    it('launches, buys, sells and claims through the pages, with a stand-in wallet', { timeout: 600_000 }, async () => {
        const rpc = patientRpc();
        const creator = await createKeyPairSignerFromBytes(
            Uint8Array.from(JSON.parse(readFileSync(process.env.DEVNET_E2E_KEYPAIR!, 'utf8'))),
        );
        const buyer = await generateKeyPairSigner();
        const started = await balance(rpc, creator.address);
        expect(started, `fund ${creator.address} with devnet SOL`).toBeGreaterThan(SOL / 5n);

        const send = async (payer: KeyPairSigner, to: Address, amount: bigint) => {
            const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
            const message = launchMessage(
                payer,
                [getTransferSolInstruction({ source: payer, destination: to, amount })],
                lifetime,
            );
            const signed = await signTransactionMessageWithSigners(message);
            const signature = await rpc
                .sendTransaction(getBase64EncodedWireTransaction(signed), {
                    encoding: 'base64',
                    preflightCommitment: 'confirmed',
                })
                .send();
            return confirm(rpc, signature, lifetime.lastValidBlockHeight);
        };
        // Fund the buyer first, so the buy can follow the launch within the sniper window.
        await send(creator, buyer.address, SOL / 20n);

        const site = await serveSite();
        const browser = await launchBrowser({ network: true });
        try {
            const symbol = `BT${Date.now().toString(36).toUpperCase().slice(-6)}`;
            const name = `Browser Test ${symbol}`;

            // The creator launches through the launch page.
            const creatorContext = await browser.newContext();
            const creatorWatch = await watchPage(creatorContext);
            let creatorPage: Page;
            const creatorWallet = await standInWallet(rpc, creatorContext, creator, () => creatorPage);
            creatorPage = await creatorContext.newPage();
            await creatorPage.goto(`${site.url}/#/launch`);
            await creatorPage.getByRole('button', { name: 'Stand-in Wallet' }).click();
            await creatorPage.getByLabel('Name').fill(name);
            await creatorPage.getByLabel('Symbol').fill(symbol);
            await creatorPage
                .getByLabel('Image link')
                .fill('https://raw.githubusercontent.com/MajocoReborn/Pipeline-Sniper-Tax/main/README.md');
            await creatorPage.getByLabel('Fee after the window').selectOption('100');
            await creatorPage.getByLabel('SOL into the pool').fill('0.05');
            await clickUntil(creatorPage, 'Launch', `${name} (${symbol}) is live`);
            const link = await creatorPage.getByRole('link', { name: 'Open the token page' }).getAttribute('href');
            const pool = link!.replace('#/pool/', '');
            expect(isAddress(pool)).toBe(true);
            // Two requests: the token (the new mint has signed already), then the pool.
            expect(creatorWallet.seen.map((t) => [t.signers, t.signed])).toEqual([
                [2, 1],
                [1, 0],
            ]);
            console.log('launched', { name, pool, signatures: creatorWallet.signatures });

            // Someone else buys within the sniper window, then sells, through the token page.
            const buyerContext = await browser.newContext();
            const buyerWatch = await watchPage(buyerContext);
            let buyerPage: Page;
            const buyerWallet = await standInWallet(rpc, buyerContext, buyer, () => buyerPage);
            buyerPage = await buyerContext.newPage();
            await buyerPage.goto(`${site.url}/#/pool/${pool}`);
            await buyerPage.getByRole('button', { name: 'Stand-in Wallet' }).click();
            await buyerPage.getByText(name).first().waitFor({ timeout: 60_000 });
            await buyerPage.locator('.trade input').fill('0.01');
            await buyerPage.getByText('Sniper tax now').waitFor({ timeout: 30_000 });
            await clickUntil(buyerPage, `Buy ${symbol}`, 'Done.');
            const buy = buyerWallet.seen.at(-1)!;
            expect(buy.instructions.filter((ix) => ix.program === PIPELINE_PROGRAM_ADDRESS)).toHaveLength(1);

            const verified = (await readVerifiedPool(rpc, pool as Address))!;
            const accounts = await traderAccounts(verified, buyer.address);
            const bought = await withRetryWhileBehind(() => tokenBalance(rpc, accounts.token));
            expect(bought, 'tokens bought').toBeGreaterThan(0n);
            expect(verified.pool.accruedTaxQuote, 'the buy paid sniper tax').toBeGreaterThan(0n);
            console.log('bought', {
                tokens: bought,
                tax: verified.pool.accruedTaxQuote,
                signature: buyerWallet.signatures.at(-1),
            });

            await buyerPage.getByRole('tab', { name: 'Sell' }).click();
            await buyerPage.getByText(/You have [1-9]/).waitFor({ timeout: 60_000 });
            await buyerPage.getByRole('button', { name: 'Max' }).click();
            await buyerPage.getByText('You receive about').waitFor({ timeout: 30_000 });
            await clickUntil(buyerPage, `Sell ${symbol}`, 'Done.');
            await expect
                .poll(() => tokenBalance(rpc, accounts.token), { timeout: 30_000, interval: 2_000 })
                .toBeLessThan(bought / 1_000n + 1n);
            console.log('sold', { signature: buyerWallet.signatures.at(-1) });

            // The creator claims the tax through the dashboard.
            const claimable = (await readVerifiedPool(rpc, pool as Address))!.pool.accruedTaxQuote;
            const beforeClaim = await balance(rpc, creator.address);
            await creatorPage.goto(`${site.url}/#/creator`);
            const row = creatorPage.locator('.creator-row', { hasText: name });
            await row.waitFor({ timeout: 60_000 });
            await row.getByRole('button', { name: 'Claim', exact: true }).click();
            await row.getByText('Claimed').waitFor({ timeout: 120_000 });
            const claim = creatorWallet.seen.at(-1)!;
            const ours = claim.instructions.filter((ix) => ix.program === PROGRAM_ID);
            expect(ours).toHaveLength(1);
            expect([...ours[0]!.data]).toEqual([...INSTRUCTION_DISCRIMINATORS.claimTax]);
            await expect
                .poll(async () => (await readVerifiedPool(rpc, pool as Address))!.pool.accruedTaxQuote, {
                    timeout: 30_000,
                    interval: 2_000,
                })
                .toBe(0n);
            await expect
                .poll(() => balance(rpc, creator.address), { timeout: 30_000, interval: 2_000 })
                .toBe(beforeClaim + claimable - SIGNATURE_FEE);
            console.log('claimed', { lamports: claimable, signature: creatorWallet.signatures.at(-1) });

            // The pages stayed inside their Content-Security-Policy the whole time.
            expect([...creatorWatch.violations, ...buyerWatch.violations]).toEqual([]);
        } finally {
            await browser.close();
            await site.close();
            // What the buyer has left goes back to the creator.
            const left = await balance(rpc, buyer.address);
            if (left > SIGNATURE_FEE) {
                await send(buyer, creator.address, left - SIGNATURE_FEE);
            }
            console.log('spent', { lamports: started - (await balance(rpc, creator.address)) });
        }
    });
});
