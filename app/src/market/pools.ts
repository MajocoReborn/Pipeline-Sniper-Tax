// Pools read from the chain and checked before the site shows or trades them: the account is
// owned by our program, decodes as a `LaunchPool`, and sits at the address its own fields
// derive, with the vaults they derive. The API only says where to look.

import {
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
    getBase64Encoder,
    isSolanaError,
    type Address,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

import {
    NATIVE_MINT,
    PROGRAM_ID,
    decodeLaunchPool,
    poolKeys,
    type LaunchPool,
    type PoolKeys,
} from '../client/index.js';
import type { Rpc } from '../launch/chain.js';
import { decodeMint, type MintInspection } from '../vendor/pipeline/index.js';

export type VerifiedPool = {
    address: Address;
    pool: LaunchPool;
    keys: PoolKeys;
    /** The launch token, decoded from the chain; `null` if it isn't a readable mint. */
    mint: MintInspection | null;
};

/**
 * Whether the pool trades against SOL. The program takes any quote mint, but every figure the
 * pages show is in SOL, so a pool against another token is left out: its reserves of a
 * worthless token would otherwise read as a market value in SOL.
 */
export function isSolPool(verified: Pick<VerifiedPool, 'keys'>): boolean {
    return verified.keys.quoteMint === NATIVE_MINT && verified.keys.quoteProgram === TOKEN_PROGRAM_ADDRESS;
}

const TOKEN_PROGRAMS = [TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS] as const;
const BATCH = 100;
/** How often, and how far apart, to ask again while the RPC node is behind `minContextSlot`. */
const BEHIND_ATTEMPTS = 10;
const BEHIND_WAIT_MS = 500;
const base64 = getBase64Encoder();

/** The pool's keys if `address` is the address its fields derive, with matching vaults. */
export async function verifyPoolKeys(address: Address, pool: LaunchPool): Promise<PoolKeys | null> {
    const params = {
        creator: pool.creator,
        taxStartBps: pool.taxStartBps,
        taxEndBps: pool.taxEndBps,
        taxDurationSecs: pool.taxDurationSecs,
    };
    for (const tokenProgram of TOKEN_PROGRAMS) {
        for (const quoteProgram of TOKEN_PROGRAMS) {
            const keys = await poolKeys(params, pool.tokenMint, tokenProgram, pool.quoteMint, quoteProgram);
            if (keys.address !== address) {
                return null;
            }
            if (keys.tokenVault === pool.tokenVault && keys.quoteVault === pool.quoteVault) {
                return keys;
            }
        }
    }
    return null;
}

type Raw = { owner: Address; data: Uint8Array };

/**
 * The accounts at `addresses`, as of `minContextSlot` or later. The public RPC spreads requests
 * over nodes that can be a few slots apart, so right after a trade a plain read may come from
 * a node that hasn't seen it yet; with `minContextSlot`, a node that is behind refuses and we
 * ask again.
 */
async function readAccounts(
    rpc: Rpc,
    addresses: readonly Address[],
    minContextSlot?: bigint,
): Promise<Map<Address, Raw>> {
    const out = new Map<Address, Raw>();
    const config = {
        encoding: 'base64',
        commitment: 'confirmed',
        ...(minContextSlot ? { minContextSlot } : {}),
    } as const;
    for (let i = 0; i < addresses.length; i += BATCH) {
        const batch = addresses.slice(i, i + BATCH);
        const { value } = await withRetryWhileBehind(() => rpc.getMultipleAccounts(batch, config).send());
        value.forEach((account, j) => {
            if (account) {
                out.set(batch[j]!, { owner: account.owner, data: new Uint8Array(base64.encode(account.data[0])) });
            }
        });
    }
    return out;
}

/** `read()`, asked again while the RPC node is behind the `minContextSlot` it was given. */
export async function withRetryWhileBehind<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await read();
        } catch (error) {
            const behind = isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED);
            if (!behind || attempt >= BEHIND_ATTEMPTS) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, BEHIND_WAIT_MS));
        }
    }
}

/**
 * The pools at `addresses` that pass every check, with their launch tokens. After a trade,
 * pass the slot it landed in as `minContextSlot`, so the pools include it.
 */
export async function readVerifiedPools(
    rpc: Rpc,
    addresses: readonly Address[],
    minContextSlot?: bigint,
): Promise<Map<Address, VerifiedPool>> {
    const unique = [...new Set(addresses)];
    const accounts = await readAccounts(rpc, unique, minContextSlot);
    const pools: { address: Address; pool: LaunchPool; keys: PoolKeys }[] = [];
    for (const address of unique) {
        const account = accounts.get(address);
        const pool = account && account.owner === PROGRAM_ID ? decodeLaunchPool(account.data) : null;
        const keys = pool ? await verifyPoolKeys(address, pool) : null;
        if (pool && keys) {
            pools.push({ address, pool, keys });
        }
    }
    const mints = await readAccounts(rpc, [...new Set(pools.map((p) => p.pool.tokenMint))]);
    const epoch = pools.length > 0 ? (await rpc.getEpochInfo({ commitment: 'confirmed' }).send()).epoch : 0n;
    const out = new Map<Address, VerifiedPool>();
    for (const { address, pool, keys } of pools) {
        const raw = mints.get(pool.tokenMint);
        const mint =
            raw && raw.owner === keys.tokenProgram ? decodeMint(pool.tokenMint, raw.owner, raw.data, epoch) : null;
        out.set(address, { address, pool, keys, mint });
    }
    return out;
}

export async function readVerifiedPool(
    rpc: Rpc,
    address: Address,
    minContextSlot?: bigint,
): Promise<VerifiedPool | null> {
    return (await readVerifiedPools(rpc, [address], minContextSlot)).get(address) ?? null;
}

/**
 * The cluster's clock minus this computer's, in seconds, from the latest block's time. The
 * tax follows the cluster's clock, so countdowns and quotes add this to `Date.now()`.
 */
export async function clockOffset(rpc: Rpc): Promise<number> {
    const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
    // Our time when that slot was the latest, so a slow `getBlockTime` doesn't count as offset.
    const local = Date.now() / 1000;
    const blockTime = await rpc.getBlockTime(slot).send();
    return blockTime === null ? 0 : Math.round(Number(blockTime) - local);
}

/** The cluster's time now, in Unix seconds, given `offset` from `clockOffset`. */
export function chainNow(offset: number): bigint {
    return BigInt(Math.floor(Date.now() / 1000) + offset);
}
