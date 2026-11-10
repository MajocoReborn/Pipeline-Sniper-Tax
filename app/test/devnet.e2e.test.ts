// End to end on devnet: a launch built by the site's own code, then a buy by someone else
// through the Pipeline router. Off by default; it spends about 0.2 devnet SOL.
//
//   DEVNET_E2E=1 DEVNET_E2E_KEYPAIR=<keypair.json> npx vitest run test/devnet.e2e.test.ts
//
// The creator is the keypair file, a throwaway key funded with devnet SOL and kept outside the
// repository (the public RPC's airdrop is switched off on devnet). The buyer is made in memory
// and thrown away.

import { readFileSync } from 'node:fs';

import {
    createKeyPairSignerFromBytes,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    isSome,
    lamports,
    signTransactionMessageWithSigners,
    type Signature,
    type TransactionSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    getCreateAssociatedTokenIdempotentInstruction as getCreateClassicAtaInstruction,
    getSyncNativeInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
    fetchMint,
    getCreateAssociatedTokenIdempotentInstruction,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';

import { NATIVE_MINT, currentTaxBps, decodeLaunchPool, exactIn, swapIx } from '../src/client/index.js';
import { associatedTokenAddress } from '../src/vendor/pipeline/index.js';
import { balance, confirm, createRpc, launchCosts, readConfig, type Rpc } from '../src/launch/chain.js';
import { launchAmounts, type LaunchForm } from '../src/launch/form.js';
import { runLaunch, type LaunchMessage, type LaunchProgress } from '../src/launch/run.js';
import { launchMessage } from '../src/launch/transactions.js';

const SOL = 1_000_000_000n;

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

describe.skipIf(!process.env.DEVNET_E2E)('a launch from the site on devnet', () => {
    it('launches a token and trades it through Pipeline, with the sniper tax', { timeout: 240_000 }, async () => {
        const rpc = createRpc();
        const creator = await fundedCreator(rpc);
        const buyer = await generateKeyPairSigner();
        expect(await balance(rpc, creator.address), `fund ${creator.address} with devnet SOL`).toBeGreaterThan(
            SOL / 5n,
        );

        const form: LaunchForm = {
            name: 'Site E2E Test',
            symbol: 'SITETEST',
            uri: 'https://raw.githubusercontent.com/MajocoReborn/Pipeline-Sniper-Tax/main/metadata/sniper-tax.devnet.json',
            preset: 'normal',
            permanentFeeBps: 0,
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

        // The pool: live, with the pool's share of the supply and the SOL.
        const poolInfo = await rpc.getAccountInfo(result.keys.address, { encoding: 'base64' }).send();
        const pool = decodeLaunchPool(new Uint8Array(Buffer.from(poolInfo.value!.data[0], 'base64')))!;
        expect(pool.status).toBe('live');
        expect(pool.reserveToken).toBe(launchAmounts(form).poolTokens);
        expect(pool.reserveQuote).toBe(form.liquidityLamports);
        expect(pool.creator).toBe(creator.address);

        // Someone else buys right after launch, through the router, and pays the sniper tax.
        await sendInstructions(rpc, creator, [
            getTransferSolInstruction({ source: creator, destination: buyer.address, amount: SOL / 20n }),
        ]);
        const buyerQuote = await associatedTokenAddress(buyer.address, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS);
        const buyerToken = await associatedTokenAddress(buyer.address, result.mint, TOKEN_2022_PROGRAM_ADDRESS);
        const spend = SOL / 100n;
        const taxAtBuy = currentTaxBps(pool, BigInt(Math.floor(Date.now() / 1000)));
        await sendInstructions(rpc, buyer, [
            getCreateClassicAtaInstruction({
                payer: buyer,
                ata: buyerQuote,
                owner: buyer.address,
                mint: NATIVE_MINT,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
            getTransferSolInstruction({ source: buyer, destination: buyerQuote, amount: spend * 2n }),
            getSyncNativeInstruction({ account: buyerQuote }),
            getCreateAssociatedTokenIdempotentInstruction({
                payer: buyer,
                ata: buyerToken,
                owner: buyer.address,
                mint: result.mint,
                tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            }),
            await swapIx(result.keys, buyer.address, 'buy', exactIn(spend, 1n)),
        ]);
        const after = await rpc.getAccountInfo(result.keys.address, { encoding: 'base64' }).send();
        const poolAfter = decodeLaunchPool(new Uint8Array(Buffer.from(after.value!.data[0], 'base64')))!;
        const tokens = await rpc.getTokenAccountBalance(buyerToken).send();
        console.log('buy', {
            taxBpsAtBuy: taxAtBuy,
            tokensReceived: tokens.value.amount,
            accruedTaxQuote: poolAfter.accruedTaxQuote.toString(),
            accruedProtocolQuote: poolAfter.accruedProtocolQuote.toString(),
            reserveQuote: poolAfter.reserveQuote.toString(),
        });
        expect(BigInt(tokens.value.amount)).toBeGreaterThan(0n);
        expect(poolAfter.accruedTaxQuote + poolAfter.accruedProtocolQuote).toBeGreaterThan(0n);
        expect(
            poolAfter.reserveQuote - pool.reserveQuote + poolAfter.accruedTaxQuote + poolAfter.accruedProtocolQuote,
        ).toBe(spend);
    });
});
