// Everything a launch reads from or sends to the chain: the config, rent, simulation and
// confirmation. The transactions themselves come from `transactions.ts`.

import {
    compileTransaction,
    createSolanaRpc,
    devnet,
    getBase64Decoder,
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    type Address,
    type Signature,
} from '@solana/kit';
import { extension, getTokenSize } from '@solana-program/token-2022';

import {
    configAddress,
    decodeLaunchPool,
    decodeProtocolConfig,
    type LaunchPool,
    type ProtocolConfig,
} from '../client/index.js';
import { RPC_URL } from '../config.js';
import { mintSizes, type launchMessage } from './transactions.js';
import type { LaunchForm } from './form.js';

/** A devnet RPC: the site runs on devnet only for now. */
export function createRpc(url: string = RPC_URL) {
    return createSolanaRpc(devnet(url));
}

export type Rpc = ReturnType<typeof createRpc>;

/** Bytes of each account a launch creates. */
export const SPACE = {
    /** `LaunchPool`: 8-byte discriminator plus its fields. */
    pool: 325,
    /** The router's market account for a market of two mints (measured on devnet). */
    routerMarket: 372,
    /** A classic token account, such as wrapped SOL. */
    classicTokenAccount: 165,
    /** A Token-2022 associated token account: the base layout plus `ImmutableOwner`. */
    token2022Account: getTokenSize([extension('ImmutableOwner', {})]),
} as const;

/** Lamports per signature, Solana's base fee. */
export const SIGNATURE_FEE = 5_000n;

async function accountData(rpc: Rpc, address: Address): Promise<Uint8Array | null> {
    const { value } = await rpc.getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed' }).send();
    return value ? new Uint8Array(getBase64Encoder().encode(value.data[0])) : null;
}

/** A token account's balance (SPL Token or Token-2022), 0 if the account doesn't exist. */
export async function tokenBalance(rpc: Rpc, account: Address): Promise<bigint> {
    const data = await accountData(rpc, account);
    if (!data || data.length < 72) {
        return 0n;
    }
    return new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true);
}

export async function accountExists(rpc: Rpc, address: Address): Promise<boolean> {
    const { value } = await rpc
        .getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })
        .send();
    return value !== null;
}

/** The program's config, read from the chain; it names the treasury the launch fee goes to. */
export async function readConfig(rpc: Rpc): Promise<ProtocolConfig> {
    const data = await accountData(rpc, await configAddress());
    const config = data ? decodeProtocolConfig(data) : null;
    if (!config) {
        throw new Error('The program config was not found on this cluster.');
    }
    return config;
}

/** A pool account, decoded; `null` if it doesn't exist or isn't a pool. */
export async function readPool(rpc: Rpc, address: Address): Promise<LaunchPool | null> {
    const data = await accountData(rpc, address);
    return data ? decodeLaunchPool(data) : null;
}

async function rent(rpc: Rpc, space: number): Promise<bigint> {
    return rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
}

export type CostItem = {
    label: string;
    lamports: bigint;
    /** The transaction that pays it. */
    transaction: 'token' | 'pool';
    /** Created and closed in the same transaction, so it costs nothing in the end. */
    refundable?: boolean;
};

export type LaunchCosts = { items: CostItem[]; total: bigint };

/**
 * What a launch costs the creator, besides the SOL that goes into the pool. Rent is read
 * from the cluster, so the figures hold on any cluster. The simulation before each
 * transaction shows the exact amount, and a transaction that would spend more than its share
 * of this preview is not sent (see `run.ts`).
 */
export async function launchCosts(
    rpc: Rpc,
    input: {
        creator: Address;
        mint: Address;
        form: Pick<LaunchForm, 'name' | 'symbol' | 'uri'>;
        config: ProtocolConfig;
    },
): Promise<LaunchCosts> {
    const { full } = mintSizes(input.mint, input.creator, input.form);
    const [mint, t22Account, classicAccount, pool, market] = await Promise.all([
        rent(rpc, full),
        rent(rpc, SPACE.token2022Account),
        rent(rpc, SPACE.classicTokenAccount),
        rent(rpc, SPACE.pool),
        rent(rpc, SPACE.routerMarket),
    ]);
    const items: CostItem[] = [
        { label: 'Token mint, with its name, symbol and image', lamports: mint, transaction: 'token' },
        { label: 'Your token account', lamports: t22Account, transaction: 'token' },
        { label: 'Token transaction fee (you and the mint sign)', lamports: 2n * SIGNATURE_FEE, transaction: 'token' },
        { label: 'Pool account', lamports: pool, transaction: 'pool' },
        { label: 'Pool vaults (token and SOL)', lamports: t22Account + classicAccount, transaction: 'pool' },
        { label: "Pipeline's market account", lamports: market, transaction: 'pool' },
        {
            label: "Pipeline's fee accounts (token and SOL)",
            lamports: t22Account + classicAccount,
            transaction: 'pool',
        },
        { label: 'Launch fee', lamports: input.config.launchFeeLamports, transaction: 'pool' },
        { label: 'Pool transaction fee', lamports: SIGNATURE_FEE, transaction: 'pool' },
        {
            label: 'Wrapped-SOL account, returned in the same transaction',
            lamports: classicAccount,
            transaction: 'pool',
            refundable: true,
        },
    ];
    return { items, total: sumCosts(items) };
}

/** The lamports `items` cost in the end, leaving out what is refunded. */
export function sumCosts(items: readonly CostItem[]): bigint {
    return items.reduce((sum, item) => (item.refundable ? sum : sum + item.lamports), 0n);
}

/** What one transaction of the launch should cost, besides the pool's SOL. */
export function transactionCost(costs: LaunchCosts, transaction: 'token' | 'pool'): bigint {
    return sumCosts(costs.items.filter((item) => item.transaction === transaction));
}

export type Simulation = {
    ok: boolean;
    error: string | null;
    logs: readonly string[];
    unitsConsumed: bigint | null;
    /** The watched account's lamports after the transaction, if it still exists. */
    lamportsAfter: bigint | null;
};

/**
 * Simulates a transaction before anything is signed. Signatures aren't checked and the
 * blockhash is replaced, so an unsigned message can be simulated as it is.
 */
export async function simulate(
    rpc: Rpc,
    message: ReturnType<typeof launchMessage>,
    watch: Address,
): Promise<Simulation> {
    const wire = getBase64EncodedWireTransaction(compileTransaction(message));
    const { value } = await rpc
        .simulateTransaction(wire, {
            encoding: 'base64',
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: 'confirmed',
            accounts: { addresses: [watch], encoding: 'base64' },
        })
        .send();
    const watched = value.accounts?.[0];
    return {
        ok: value.err === null,
        error: value.err === null ? null : JSON.stringify(value.err, (_, v) => (typeof v === 'bigint' ? `${v}` : v)),
        logs: value.logs ?? [],
        unitsConsumed: value.unitsConsumed ?? null,
        lamportsAfter: watched ? watched.lamports : null,
    };
}

export async function balance(rpc: Rpc, address: Address): Promise<bigint> {
    const { value } = await rpc.getBalance(address, { commitment: 'confirmed' }).send();
    return value;
}

/** Waits until `signature` is confirmed, or fails once its blockhash has expired. */
export async function confirm(rpc: Rpc, signature: Signature, lastValidBlockHeight: bigint): Promise<void> {
    for (;;) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const status = value[0];
        if (status?.err) {
            throw new Error(
                `The transaction failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}`,
            );
        }
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            return;
        }
        const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
        if (height > lastValidBlockHeight) {
            throw new Error('The transaction expired before it was confirmed. Nothing was spent; try again.');
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
}

/** A base64 helper for logs and tests. */
export const toBase64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
