// Shared fixtures for the tests: the Rust client's vectors, and pools built from them.

import { readFileSync } from 'node:fs';

import { address, type Address } from '@solana/kit';

import type { LaunchPool } from '../src/client/index.js';
import { verifyPoolKeys, type VerifiedPool } from '../src/market/pools.js';

export const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));

export function poolFromVector(v: (typeof vectors.pools)[number]): { address: Address; pool: LaunchPool } {
    return {
        address: address(v.keys.address),
        pool: {
            version: 1,
            status: 'live',
            bump: 255,
            creator: address(v.params.creator),
            tokenMint: address(v.token_mint),
            quoteMint: address(v.quote_mint),
            tokenVault: address(v.keys.token_vault),
            quoteVault: address(v.keys.quote_vault),
            marketSigner: address(v.params.creator),
            reserveToken: 1n,
            reserveQuote: 1n,
            accruedTaxQuote: 0n,
            accruedProtocolQuote: 0n,
            taxStartBps: v.params.tax_start_bps,
            taxEndBps: v.params.tax_end_bps,
            taxDurationSecs: v.params.tax_duration_secs,
            protocolTaxShareBps: 1_000,
            launchFeeLamports: 0n,
            launchTs: 0n,
            reserved: new Uint8Array(64),
        },
    };
}

/** A verified pool from the vectors (token-2022 against wrapped SOL by default), with `fields` changed. */
export async function verifiedFromVector(index = 0, fields: Partial<LaunchPool> = {}): Promise<VerifiedPool> {
    const { address: at, pool } = poolFromVector(vectors.pools[index]);
    const keys = await verifyPoolKeys(at, pool);
    if (!keys) {
        throw new Error('the vector pool does not verify');
    }
    return { address: at, pool: { ...pool, ...fields }, keys, mint: null };
}
