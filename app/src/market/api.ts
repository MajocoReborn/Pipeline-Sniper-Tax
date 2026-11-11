// Pipeline's hosted API, read as untrusted data. Every field is checked; amounts stay exact
// (bigints from decimal strings); an entry that doesn't parse is dropped rather than shown.
// The site uses the API to find markets and their history. Everything that decides what a
// trade does (the pool, its tax, its addresses) is read from the chain instead.

import { isAddress, type Address } from '@solana/kit';

import { PROGRAM_ID } from '../client/index.js';
import { PIPELINE_API_URL } from '../config.js';
import { boundedFetch } from '../vendor/pipeline/http.js';

const MAX_RESPONSE_BYTES = 4_000_000;
const TIMEOUT_MS = 10_000;
const U64_MAX = (1n << 64n) - 1n;

class ParseError extends Error {}

type Json = unknown;

function field(value: Json, key: string): Json {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ParseError(`expected an object with "${key}"`);
    }
    return (value as Record<string, Json>)[key];
}

function str(value: Json): string {
    if (typeof value !== 'string') {
        throw new ParseError('expected a string');
    }
    return value;
}

function addr(value: Json): Address {
    const text = str(value);
    if (!isAddress(text)) {
        throw new ParseError(`not an address: ${text.slice(0, 50)}`);
    }
    return text;
}

function addrOrNull(value: Json): Address | null {
    return value === null || value === undefined ? null : addr(value);
}

function u64(value: Json): bigint {
    const text = str(value);
    if (!/^\d{1,20}$/.test(text) || BigInt(text) > U64_MAX) {
        throw new ParseError(`not a u64: ${text.slice(0, 30)}`);
    }
    return BigInt(text);
}

function int(value: Json): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new ParseError('expected a non-negative integer');
    }
    return value;
}

/** Unix seconds from an ISO timestamp. */
function time(value: Json): number {
    const ms = Date.parse(str(value));
    if (!Number.isFinite(ms)) {
        throw new ParseError('not a timestamp');
    }
    return Math.floor(ms / 1000);
}

function list(value: Json): Json[] {
    if (!Array.isArray(value)) {
        throw new ParseError('expected a list');
    }
    return value;
}

/** The items of `values` that parse; the rest are dropped. */
function each<T>(values: Json[], parse: (value: Json) => T): T[] {
    const out: T[] = [];
    for (const value of values) {
        try {
            out.push(parse(value));
        } catch (error) {
            if (!(error instanceof ParseError)) {
                throw error;
            }
        }
    }
    return out;
}

export type ApiMint = {
    mint: Address;
    decimals: number;
    supply: bigint;
    tokenProgram: Address;
    vault: Address;
    /** The vault's balance, which includes unclaimed tax. */
    vaultBalance: bigint;
    name: string | null;
    symbol: string | null;
    uri: string | null;
};

export type ApiMarket = {
    address: Address;
    /** The strategy's market state: our pool account. */
    pool: Address;
    createdAt: number;
    createdBy: Address;
    flags: string[];
    mints: [ApiMint, ApiMint];
    trades24h: number;
    /** 24-hour volume by input mint, in its smallest unit. */
    volume24h: Map<Address, bigint>;
    lastTradeAt: number | null;
};

export type ApiTrade = {
    signature: string;
    slot: bigint;
    blockTime: number;
    trader: Address;
    inputMint: Address;
    outputMint: Address;
    mode: 'exact_in' | 'exact_out';
    /** Input the strategy received. */
    netSent: bigint;
    /** Output the trader received. */
    received: bigint;
    pipelineFee: bigint;
    integratorFee: bigint;
};

function parseMint(value: Json): ApiMint {
    const metadata = field(field(value, 'extensions'), 'token_metadata');
    const meta = metadata === undefined || metadata === null ? null : metadata;
    const decimals = int(field(value, 'decimals'));
    if (decimals > 18) {
        throw new ParseError('decimals out of range');
    }
    return {
        mint: addr(field(value, 'mint')),
        decimals,
        supply: u64(field(value, 'supply')),
        tokenProgram: addr(field(value, 'token_program')),
        vault: addr(field(value, 'vault')),
        vaultBalance: u64(field(value, 'liquidity')),
        name: meta ? str(field(meta, 'name')) : null,
        symbol: meta ? str(field(meta, 'symbol')) : null,
        uri: meta ? str(field(meta, 'uri')) : null,
    };
}

export function parseMarket(value: Json): ApiMarket {
    if (addr(field(value, 'strategy_program')) !== PROGRAM_ID) {
        throw new ParseError('not one of our markets');
    }
    const mints = list(field(value, 'mints')).map(parseMint);
    if (mints.length !== 2) {
        throw new ParseError('expected two mints');
    }
    const stats = field(value, 'stats_24h');
    const volumes = new Map<Address, bigint>();
    const byMint = field(stats, 'volume_by_input_mint');
    if (typeof byMint === 'object' && byMint !== null) {
        for (const [mint, amount] of Object.entries(byMint)) {
            if (isAddress(mint)) {
                volumes.set(mint, u64(amount));
            }
        }
    }
    const last = field(stats, 'last_trade_at');
    return {
        address: addr(field(value, 'address')),
        pool: addr(field(value, 'market_state')),
        createdAt: time(field(value, 'created_at')),
        createdBy: addr(field(value, 'created_by')),
        flags: list(field(value, 'flags')).map(str),
        mints: [mints[0]!, mints[1]!],
        trades24h: int(field(stats, 'trades')),
        volume24h: volumes,
        lastTradeAt: last === null || last === undefined ? null : time(last),
    };
}

export function parseTrade(value: Json): ApiTrade {
    const mode = str(field(value, 'mode'));
    if (mode !== 'exact_in' && mode !== 'exact_out') {
        throw new ParseError('unknown mode');
    }
    const signature = str(field(value, 'signature'));
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
        throw new ParseError('not a signature');
    }
    return {
        signature,
        slot: BigInt(int(field(value, 'slot'))),
        blockTime: time(field(value, 'block_time')),
        trader: addr(field(value, 'trader')),
        inputMint: addr(field(value, 'input_mint')),
        outputMint: addr(field(value, 'output_mint')),
        mode,
        netSent: u64(field(value, 'net_sent')),
        received: u64(field(value, 'received')),
        pipelineFee: u64(field(value, 'pipeline_fee')),
        integratorFee: u64(field(value, 'integrator_fee')),
    };
}

async function getJson(path: string): Promise<Json> {
    const result = await boundedFetch(`${PIPELINE_API_URL}${path}`, {
        maxBytes: MAX_RESPONSE_BYTES,
        timeoutMs: TIMEOUT_MS,
    });
    if (!result.ok) {
        throw new Error(`Pipeline's API: ${result.message}`);
    }
    return JSON.parse(new TextDecoder().decode(result.body));
}

export type MarketSort = 'newest' | 'trades_24h';

/** Our markets, newest or most traded first. */
export async function listMarkets(sort: MarketSort, limit = 50): Promise<ApiMarket[]> {
    const body = await getJson(`/v1/markets?strategy=${PROGRAM_ID}&sort=${sort}&limit=${limit}`);
    // No more than was asked for, whatever the API sends: every market costs reads from the chain.
    return each(list(field(body, 'markets')).slice(0, limit), parseMarket);
}

/** One market, or `null` if the API doesn't know it (or it isn't ours). */
export async function getMarket(market: Address): Promise<ApiMarket | null> {
    const body = await getJson(`/v1/markets/${market}`);
    return each([field(body, 'market')], parseMarket)[0] ?? null;
}

/** A market's trades, newest first. */
export async function getTrades(market: Address, limit = 100): Promise<ApiTrade[]> {
    const body = await getJson(`/v1/markets/${market}/trades?limit=${limit}`);
    // A stable sort: trades in the same slot keep the API's order.
    return each(list(field(body, 'trades')).slice(0, limit), parseTrade).sort((a, b) =>
        a.slot === b.slot ? 0 : a.slot > b.slot ? -1 : 1,
    );
}
