// The program's addresses: the config, a pool and everything around it. Mirrors
// `config_address`, `pool_address` and `PoolKeys` in `crates/sniper-tax-client`.

import { getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';

import { CONFIG_SEED, POOL_SEED, PROGRAM_ID, QUOTE_INDEX, TOKEN_INDEX } from './constants.js';
import { encodeInitParams, type InitParams } from './codecs.js';
import { associatedTokenAddress, marketPda } from '../vendor/pipeline/index.js';

export async function configAddress(): Promise<Address> {
    const [config] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [CONFIG_SEED] });
    return config;
}

/** A pool's address: `["launch", token_mint, quote_mint, creator, schedule]`. */
export async function poolAddress(tokenMint: Address, quoteMint: Address, params: InitParams): Promise<Address> {
    const encoded = encodeInitParams(params);
    const addresses = getAddressEncoder();
    const [pool] = await getProgramDerivedAddress({
        programAddress: PROGRAM_ID,
        seeds: [
            POOL_SEED,
            addresses.encode(tokenMint),
            addresses.encode(quoteMint),
            encoded.subarray(0, 32),
            encoded.subarray(32, 40),
        ],
    });
    return pool;
}

/** Every address of one pool. */
export type PoolKeys = {
    address: Address;
    /** The router's market account for this pool. */
    market: Address;
    params: InitParams;
    tokenMint: Address;
    quoteMint: Address;
    tokenProgram: Address;
    quoteProgram: Address;
    tokenVault: Address;
    quoteVault: Address;
};

export async function poolKeys(
    params: InitParams,
    tokenMint: Address,
    tokenProgram: Address,
    quoteMint: Address,
    quoteProgram: Address,
): Promise<PoolKeys> {
    const address = await poolAddress(tokenMint, quoteMint, params);
    return {
        address,
        market: await marketPda(PROGRAM_ID, address),
        params,
        tokenMint,
        quoteMint,
        tokenProgram,
        quoteProgram,
        tokenVault: await associatedTokenAddress(address, tokenMint, tokenProgram),
        quoteVault: await associatedTokenAddress(address, quoteMint, quoteProgram),
    };
}

/** The creator's associated token account for the launch token. */
export function creatorTokenAccount(keys: PoolKeys): Promise<Address> {
    return associatedTokenAddress(keys.params.creator, keys.tokenMint, keys.tokenProgram);
}

/** The creator's associated token account for the quote mint. */
export function creatorQuoteAccount(keys: PoolKeys): Promise<Address> {
    return associatedTokenAddress(keys.params.creator, keys.quoteMint, keys.quoteProgram);
}

/** Buy: quote in, launch token out. Sell: launch token in, quote out. */
export type Side = 'buy' | 'sell';

/** One direction of a trade through a pool. */
export type Legs = {
    inputMint: Address;
    outputMint: Address;
    inputProgram: Address;
    outputProgram: Address;
    inputVault: Address;
    outputVault: Address;
    inputIndex: number;
    outputIndex: number;
};

export function legs(keys: PoolKeys, side: Side): Legs {
    return side === 'buy'
        ? {
              inputMint: keys.quoteMint,
              outputMint: keys.tokenMint,
              inputProgram: keys.quoteProgram,
              outputProgram: keys.tokenProgram,
              inputVault: keys.quoteVault,
              outputVault: keys.tokenVault,
              inputIndex: QUOTE_INDEX,
              outputIndex: TOKEN_INDEX,
          }
        : {
              inputMint: keys.tokenMint,
              outputMint: keys.quoteMint,
              inputProgram: keys.tokenProgram,
              outputProgram: keys.quoteProgram,
              inputVault: keys.tokenVault,
              outputVault: keys.quoteVault,
              inputIndex: TOKEN_INDEX,
              outputIndex: QUOTE_INDEX,
          };
}
