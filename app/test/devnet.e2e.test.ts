// End to end on devnet: a launch built by the site's own code, then two buys by someone else
// through `market/trade.ts` and the Pipeline router: a sniper buy inside the tax window and a
// buy after it. After each buy, the tax that `market/history.ts` works out for every trade
// Pipeline's API lists must add up, to the lamport, to the tax the pool has accrued. Off by
// default; it spends about 0.15 devnet SOL and takes about two minutes, most of it waiting for
// the 90-second window to end.
//
//   DEVNET_E2E=1 DEVNET_E2E_KEYPAIR=<keypair.json> npx vitest run test/devnet.e2e.test.ts --silent=false
//
// (`--silent=false` prints the addresses and figures; Vitest hides a passing test's output.)
//
// The creator is the keypair file, a throwaway key funded with devnet SOL and kept outside the
// repository (the public RPC's airdrop is switched off on devnet). The buyer is made in memory;
// what it has left goes back to the creator at the end.

import { readFileSync } from 'node:fs';

import {
    createKeyPairSignerFromBytes,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    isSome,
    lamports,
    signTransactionMessageWithSigners,
    type Address,
    type Signature,
    type TransactionSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { fetchMint } from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';

import { poolSchedule, splitGross, splitTax, taxBpsAt, type Side } from '../src/client/index.js';
import { SIGNATURE_FEE, balance, confirm, launchCosts, readConfig, type Rpc } from '../src/launch/chain.js';
import { launchAmounts, type LaunchForm } from '../src/launch/form.js';
import { runLaunch, type LaunchMessage, type LaunchProgress } from '../src/launch/run.js';
import { launchMessage } from '../src/launch/transactions.js';
import { getTrades, type ApiTrade } from '../src/market/api.js';
import { taxHistory, type Reserves } from '../src/market/history.js';
import {
    chainNow,
    clockOffset,
    readVerifiedPool,
    withRetryWhileBehind,
    type VerifiedPool,
} from '../src/market/pools.js';
import { CLOCK_MARGIN_SECS, quoteTrade, runTrade, traderAccounts, type TradeQuote } from '../src/market/trade.js';
import { pipelineFee } from '../src/vendor/pipeline/index.js';
import { patientRpc } from './helpers.js';

const SOL = 1_000_000_000n;
/** How long Pipeline's API may take to list a confirmed trade. */
const INDEX_TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendWithLocalKeys(rpc: Rpc, message: LaunchMessage): Promise<Signature> {
    const signed = await signTransactionMessageWithSigners(message);
    return rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), {
            encoding: 'base64',
            preflightCommitment: 'confirmed',
        })
        .send();
}

async function sendInstructions(rpc: Rpc, payer: TransactionSigner, instructions: Parameters<typeof launchMessage>[1]) {
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const signature = await sendWithLocalKeys(rpc, launchMessage(payer, instructions, lifetime));
    await confirm(rpc, signature, lifetime.lastValidBlockHeight);
    return signature;
}

/** The funded creator from `DEVNET_E2E_KEYPAIR`, or a new key with an airdrop (local validators). */
async function fundedCreator(rpc: Rpc): Promise<TransactionSigner> {
    const path = process.env.DEVNET_E2E_KEYPAIR;
    if (path) {
        return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
    }
    const signer = await generateKeyPairSigner();
    const signature = await rpc.requestAirdrop(signer.address, lamports(SOL), { commitment: 'confirmed' }).send();
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    await confirm(rpc, signature, lifetime.lastValidBlockHeight + 150n);
    return signer;
}

/** The market's trades from Pipeline's API, once it lists every one of `signatures`. */
async function indexedTrades(market: VerifiedPool['keys']['market'], signatures: Signature[]): Promise<ApiTrade[]> {
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    for (;;) {
        const trades = await getTrades(market).catch(() => [] as ApiTrade[]);
        if (signatures.every((s) => trades.some((t) => t.signature === s))) {
            return trades;
        }
        if (Date.now() > deadline) {
            throw new Error(`Pipeline's API did not list ${signatures.join(', ')} within ${INDEX_TIMEOUT_MS} ms`);
        }
        await sleep(2_000);
    }
}

/**
 * The tax history of the pool as it is now. Every listed trade must be accounted for, back to
 * the reserves at launch, and the creator's and protocol's parts of the tax of each trade must
 * add up to exactly what the pool has accrued (nothing has been claimed yet).
 */
function checkHistory(verified: VerifiedPool, trades: ApiTrade[], atLaunch: Reserves) {
    const { pool, keys } = verified;
    const history = taxHistory(pool, keys, trades);
    expect(history.complete, 'every trade accounted for').toBe(true);
    expect(history.oldestReserves).toEqual(atLaunch);
    let creator = 0n;
    let protocol = 0n;
    for (const t of history.trades) {
        expect(t.taxBps, `rate of ${t.trade.signature}`).not.toBeNull();
        const shares = splitTax(t.tax!, pool.protocolTaxShareBps);
        creator += shares.creator;
        protocol += shares.protocol;
    }
    expect(creator, "the creator's accrued tax").toBe(pool.accruedTaxQuote);
    expect(protocol, "the protocol's accrued tax").toBe(pool.accruedProtocolQuote);
    expect(history.trades[0]!.reservesAfter).toEqual({ quote: pool.reserveQuote, token: pool.reserveToken });
    return history;
}

describe.skipIf(!process.env.DEVNET_E2E)('a launch from the site on devnet', () => {
    it(
        'launches a token, and the sniper tax of every buy matches what the pool accrued',
        { timeout: 360_000 },
        async () => {
            const rpc = patientRpc();
            const creator = await fundedCreator(rpc);
            const buyer = await generateKeyPairSigner();
            expect(await balance(rpc, creator.address), `fund ${creator.address} with devnet SOL`).toBeGreaterThan(
                SOL / 5n,
            );

            // Fund the buyer first, so the sniper buy can follow the launch within seconds.
            await sendInstructions(rpc, creator, [
                getTransferSolInstruction({ source: creator, destination: buyer.address, amount: SOL / 20n }),
            ]);

            const form: LaunchForm = {
                name: 'Site E2E Test',
                symbol: 'SITETEST',
                uri: 'https://raw.githubusercontent.com/MajocoReborn/Pipeline-Sniper-Tax/main/metadata/sniper-tax.devnet.json',
                preset: 'normal',
                // A permanent 1% after the window, so the buy after it is taxed too.
                permanentFeeBps: 100,
                creatorShareBps: 1_000,
                liquidityLamports: SOL / 10n,
            };
            const config = await readConfig(rpc);
            const before = await balance(rpc, creator.address);
            const progress: LaunchProgress[] = [];
            const result = await runLaunch({
                rpc,
                creator,
                form,
                send: (message) => sendWithLocalKeys(rpc, message),
                onProgress: (p) => progress.push(p),
            });
            const spent = before - (await balance(rpc, creator.address));
            const estimate = await launchCosts(rpc, { creator: creator.address, mint: result.mint, form, config });
            console.log('launch', {
                mint: result.mint,
                pool: result.keys.address,
                market: result.keys.market,
                signatures: result.signatures,
                spentLamports: spent.toString(),
                estimateLamports: (estimate.total + form.liquidityLamports).toString(),
                simulated: progress
                    .filter((p) => p.step === 'simulated')
                    .map((p) => (p.step === 'simulated' ? `${p.transaction}: ${p.lamportsSpent}` : '')),
            });

            // The preview is exact: the launch cost what the site showed, to the lamport.
            expect(spent).toBe(estimate.total + form.liquidityLamports);

            // The token: fixed supply, no mint or freeze authority, metadata frozen.
            const mint = await fetchMint(rpc, result.mint);
            expect(isSome(mint.data.mintAuthority)).toBe(false);
            expect(isSome(mint.data.freezeAuthority)).toBe(false);
            expect(mint.data.supply).toBe(10n ** 15n);
            const extensions = isSome(mint.data.extensions) ? mint.data.extensions.value : [];
            const metadata = extensions.find((e) => e.__kind === 'TokenMetadata');
            const pointer = extensions.find((e) => e.__kind === 'MetadataPointer');
            expect(metadata && metadata.__kind === 'TokenMetadata' && isSome(metadata.updateAuthority)).toBe(false);
            expect(metadata && metadata.__kind === 'TokenMetadata' && metadata.name).toBe(form.name);
            expect(pointer && pointer.__kind === 'MetadataPointer' && isSome(pointer.authority)).toBe(false);

            // The pool: live and verified the way the site checks it, with the pool's share of
            // the supply and the SOL.
            const launched = await readVerifiedPool(rpc, result.keys.address);
            expect(launched, 'the new pool verifies').not.toBeNull();
            expect(launched!.keys).toEqual(result.keys);
            const { pool } = launched!;
            expect(pool.status).toBe('live');
            expect(pool.reserveToken).toBe(launchAmounts(form).poolTokens);
            expect(pool.reserveQuote).toBe(form.liquidityLamports);
            expect(pool.creator).toBe(creator.address);
            expect(pool.taxEndBps).toBe(form.permanentFeeBps);
            const atLaunch: Reserves = { quote: pool.reserveQuote, token: pool.reserveToken };
            const offset = await clockOffset(rpc);
            const accounts = await traderAccounts(launched!, buyer.address);

            /** One buy by `buyer` through `market/trade.ts`, as the token page makes it. */
            async function buy(
                spend: bigint,
            ): Promise<{ quote: TradeQuote; signature: Signature; slot: bigint; now: bigint }> {
                const verified = (await readVerifiedPool(rpc, result.keys.address))!;
                const now = chainNow(offset);
                const quote = quoteTrade(verified, 'buy' satisfies Side, buyer.address, spend, now, 100);
                if ('error' in quote) {
                    throw new Error(quote.error);
                }
                const { signature, slot } = await runTrade({
                    rpc,
                    trader: buyer,
                    verified,
                    side: 'buy',
                    amountIn: quote.amountIn,
                    minAmountOut: quote.minAmountOut,
                    send: (message) => sendWithLocalKeys(rpc, message),
                });
                return { quote, signature, slot, now };
            }

            /** The buy as Pipeline's API lists it, and the tax history it is part of. */
            async function afterBuy(bought: { signature: Signature; slot: bigint }, all: Signature[], spend: bigint) {
                const { signature } = bought;
                const verified = (await readVerifiedPool(rpc, result.keys.address, bought.slot))!;
                const trades = await indexedTrades(verified.keys.market, all);
                const history = checkHistory(verified, trades, atLaunch);
                const taxed = history.trades.find((t) => t.trade.signature === signature)!;
                expect(taxed.side).toBe('buy');
                expect(taxed.byCreator).toBe(false);
                expect(taxed.trade.trader).toBe(buyer.address);
                expect(taxed.trade.netSent).toBe(spend);
                expect(taxed.trade.pipelineFee).toBe(pipelineFee(spend));
                expect(taxed.tax).toBe(splitGross(spend, taxed.taxBps!).tax);
                return { verified, history, taxed };
            }

            // Reads as of a trade's slot: the public RPC's nodes can be a few slots apart.
            const tokensAt = (slot: bigint) =>
                withRetryWhileBehind(async () => {
                    const { value } = await rpc
                        .getAccountInfo(accounts.token, {
                            encoding: 'base64',
                            commitment: 'confirmed',
                            minContextSlot: slot,
                        })
                        .send();
                    // A token account's amount is the u64 after its mint and owner.
                    const data = Buffer.from(value!.data[0], 'base64');
                    return data.readBigUInt64LE(64);
                });
            const lamportsAt = (account: Address, slot: bigint) =>
                withRetryWhileBehind(
                    async () =>
                        (await rpc.getBalance(account, { commitment: 'confirmed', minContextSlot: slot }).send()).value,
                );

            // A sniper buy, seconds after the launch.
            const spend = SOL / 100n;
            const sniper = await buy(spend);
            const tokensAfterSniper = await tokensAt(sniper.slot);
            const first = await afterBuy(sniper, [sniper.signature], spend);
            const schedule = poolSchedule(pool);
            console.log('sniper buy', {
                signature: sniper.signature,
                quotedTaxBps: sniper.quote.taxBps,
                paidTaxBps: first.taxed.taxBps,
                blockTimeTaxBps: first.taxed.estimatedTaxBps,
                taxLamports: first.taxed.tax!.toString(),
                tokensReceived: tokensAfterSniper.toString(),
                minAmountOut: sniper.quote.minAmountOut.toString(),
                accruedTaxQuote: first.verified.pool.accruedTaxQuote.toString(),
                accruedProtocolQuote: first.verified.pool.accruedProtocolQuote.toString(),
            });
            // Inside the window, at no more than the quote allowed for, and at least what it promised.
            expect(first.taxed.taxBps!).toBeGreaterThan(pool.taxEndBps);
            expect(first.taxed.taxBps!).toBeLessThanOrEqual(
                taxBpsAt(schedule, pool.launchTs, sniper.now - CLOCK_MARGIN_SECS),
            );
            expect(tokensAfterSniper).toBeGreaterThanOrEqual(sniper.quote.minAmountOut);
            expect(tokensAfterSniper).toBe(first.taxed.trade.received);
            // The wrapped-SOL account was the buyer's first, so the trade closed it again.
            expect(await lamportsAt(accounts.quote, sniper.slot)).toBe(0n);

            // Wait for the window to end, by the cluster's clock.
            const windowEnd = pool.launchTs + BigInt(pool.taxDurationSecs);
            while (chainNow(await clockOffset(rpc)) <= windowEnd + 2n) {
                await sleep(5_000);
            }

            // A buy after the window: the permanent rate, and exactly the quoted output.
            const late = await buy(spend);
            const tokensAfterLate = await tokensAt(late.slot);
            const second = await afterBuy(late, [sniper.signature, late.signature], spend);
            console.log('buy after the window', {
                signature: late.signature,
                quotedTaxBps: late.quote.taxBps,
                paidTaxBps: second.taxed.taxBps,
                taxLamports: second.taxed.tax!.toString(),
                tokensReceived: (tokensAfterLate - tokensAfterSniper).toString(),
                accruedTaxQuote: second.verified.pool.accruedTaxQuote.toString(),
                accruedProtocolQuote: second.verified.pool.accruedProtocolQuote.toString(),
            });
            expect(late.quote.taxBps).toBe(pool.taxEndBps);
            expect(second.taxed.taxBps).toBe(pool.taxEndBps);
            expect(tokensAfterLate - tokensAfterSniper).toBe(late.quote.quote.amountOut);
            expect(second.verified.pool.accruedTaxQuote + second.verified.pool.accruedProtocolQuote).toBe(
                first.taxed.tax! + second.taxed.tax!,
            );
            // The sniper buy kept its rate in the longer history.
            expect(second.history.trades.find((t) => t.trade.signature === sniper.signature)!.taxBps).toBe(
                first.taxed.taxBps,
            );

            // What the buyer has left goes back to the creator.
            const left = await balance(rpc, buyer.address);
            if (left > SIGNATURE_FEE) {
                await sendInstructions(rpc, buyer, [
                    getTransferSolInstruction({
                        source: buyer,
                        destination: creator.address,
                        amount: left - SIGNATURE_FEE,
                    }),
                ]);
            }
        },
    );
});
