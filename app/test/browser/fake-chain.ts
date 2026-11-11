// A stand-in for the devnet RPC and Pipeline's API, so the browser test runs the real site
// without a network: accounts held in memory, answered in the RPC's own JSON shapes. It also
// plays the hostile roles the security review names (docs/SITE-SECURITY-REVIEW.md): an API that
// lists pools that are not ours, a token with misleading metadata, a simulation that reports a
// higher cost than the page showed.

import {
    address,
    getAddressEncoder,
    getBase58Decoder,
    getBase64Decoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    none,
    some,
    type Address,
} from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS, extension, getMintEncoder } from '@solana-program/token-2022';

import {
    ACCOUNT_DISCRIMINATORS,
    NATIVE_MINT,
    PROGRAM_ID,
    configAddress,
    getLaunchPoolCodec,
    getProtocolConfigCodec,
    poolKeys,
    type LaunchPool,
    type PoolKeys,
} from '../../src/client/index.js';
import { LOADER_ADDRESSES } from '../../src/vendor/pipeline/index.js';

export type FakeAccount = { lamports: bigint; owner: Address; data: Uint8Array; executable?: boolean };

/** A wire transaction, taken apart far enough to say who pays and which programs it calls. */
export type SeenTransaction = {
    feePayer: Address;
    /** How many signatures the transaction needs, and how many it already carries. */
    signers: number;
    signed: number;
    instructions: { program: Address; accounts: Address[]; data: Uint8Array }[];
};

export function readTransaction(wire: Uint8Array): SeenTransaction {
    const transaction = getTransactionDecoder().decode(wire);
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (!('staticAccounts' in message) || !('instructions' in message)) {
        throw new Error('expected a transaction message with its accounts listed');
    }
    const accounts = message.staticAccounts;
    return {
        feePayer: accounts[0]!,
        signers: message.header.numSignerAccounts,
        signed: Object.values(transaction.signatures).filter((s) => s !== null).length,
        instructions: message.instructions.map((ix) => ({
            program: accounts[ix.programAddressIndex]!,
            accounts: (ix.accountIndices ?? []).map((i) => accounts[i]!),
            data: new Uint8Array(ix.data ?? []),
        })),
    };
}

const base64 = { decode: getBase64Decoder(), encode: getBase64Encoder() };
const toBytes = (text: string) => new Uint8Array(base64.encode.encode(text));

/** Solana's rent-exempt minimum for an account of `space` bytes. */
export function rentFor(space: number): bigint {
    return BigInt((128 + space) * 6_960);
}

export function poolAccount(pool: LaunchPool): FakeAccount {
    const data = new Uint8Array([...ACCOUNT_DISCRIMINATORS.LaunchPool, ...getLaunchPoolCodec().encode(pool)]);
    return { lamports: rentFor(data.length), owner: PROGRAM_ID, data };
}

/** A Token-2022 mint with its metadata inside it, as the site's own launches make them. */
export function mintAccount(mint: Address, metadata: { name: string; symbol: string; uri: string }): FakeAccount {
    const data = new Uint8Array(
        getMintEncoder().encode({
            mintAuthority: none(),
            supply: 10n ** 15n,
            decimals: 6,
            isInitialized: true,
            freezeAuthority: none(),
            extensions: some([
                extension('MetadataPointer', { authority: none(), metadataAddress: some(mint) }),
                extension('TokenMetadata', {
                    updateAuthority: none(),
                    mint,
                    ...metadata,
                    additionalMetadata: new Map(),
                }),
            ]),
        }),
    );
    return { lamports: rentFor(data.length), owner: TOKEN_2022_PROGRAM_ADDRESS, data };
}

/** A token account holding `amount`: the site reads only the amount and whether it exists. */
export function tokenAccount(amount: bigint, tokenProgram: Address = TOKEN_2022_PROGRAM_ADDRESS): FakeAccount {
    const data = new Uint8Array(tokenProgram === TOKEN_PROGRAM_ADDRESS ? 165 : 170);
    new DataView(data.buffer).setBigUint64(64, amount, true);
    data[108] = 1;
    return { lamports: rentFor(data.length), owner: tokenProgram, data };
}

/** A live pool's account contents for `keys`, with `fields` changed. */
export function poolState(keys: PoolKeys, fields: Partial<LaunchPool> = {}): LaunchPool {
    return {
        version: 1,
        status: 'live',
        bump: 255,
        creator: keys.params.creator,
        tokenMint: keys.tokenMint,
        quoteMint: keys.quoteMint,
        tokenVault: keys.tokenVault,
        quoteVault: keys.quoteVault,
        marketSigner: keys.market,
        reserveToken: 800_000_000_000_000n,
        reserveQuote: 2_000_000_000n,
        accruedTaxQuote: 0n,
        accruedProtocolQuote: 0n,
        taxStartBps: keys.params.taxStartBps,
        taxEndBps: keys.params.taxEndBps,
        taxDurationSecs: keys.params.taxDurationSecs,
        protocolTaxShareBps: 1_000,
        launchFeeLamports: 10_000_000n,
        launchTs: 0n,
        reserved: new Uint8Array(64),
        ...fields,
    };
}

export type FakeMarket = { keys: PoolKeys; pool: LaunchPool; name: string; symbol: string; uri: string };

type Simulated = { err: unknown; logs?: string[]; lamportsAfter: bigint | null };

export class FakeChain {
    readonly accounts = new Map<Address, FakeAccount>();
    /** What Pipeline's API lists, in order. */
    readonly listed: unknown[] = [];
    /** Every RPC method the page called, and `wallet` each time the wallet was asked. */
    readonly events: string[] = [];
    readonly simulated: SeenTransaction[] = [];
    readonly signatures = new Set<string>();
    slot = 520_000_000;
    readonly now = Math.floor(Date.now() / 1000);
    /** What a simulation reports; the default leaves the fee payer's balance as it is. */
    simulate: (transaction: SeenTransaction, balance: bigint) => Simulated = (_, balance) => ({
        err: null,
        lamportsAfter: balance,
    });

    /** The program, its config and wrapped SOL: what every scenario needs. */
    static async create(): Promise<FakeChain> {
        const chain = new FakeChain();
        const admin = address('CUiq3QQbXMsrgCpiN423zr2NTrdfPRuGUy9EQKQ6CGap');
        const programData = address('GuoMTwRcXWzFkWkdjZ3qAYGLc14UFYLfHtk4njwKTvQT');
        const addresses = getAddressEncoder();
        // UpgradeableLoaderState::Program, then ProgramData with a slot and an upgrade authority.
        chain.accounts.set(PROGRAM_ID, {
            lamports: 1_141_440n,
            owner: LOADER_ADDRESSES.upgradeable,
            data: new Uint8Array([2, 0, 0, 0, ...addresses.encode(programData)]),
            executable: true,
        });
        const header = new Uint8Array(45);
        new DataView(header.buffer).setUint32(0, 3, true);
        new DataView(header.buffer).setBigUint64(4, 520_838_510n, true);
        header[12] = 1;
        header.set(addresses.encode(admin), 13);
        chain.accounts.set(programData, { lamports: 1n, owner: LOADER_ADDRESSES.upgradeable, data: header });
        const config = new Uint8Array([
            ...ACCOUNT_DISCRIMINATORS.ProtocolConfig,
            ...getProtocolConfigCodec().encode({
                admin,
                treasury: admin,
                protocolTaxShareBps: 1_000,
                launchFeeLamports: 10_000_000n,
                bump: 255,
                pendingAdmin: null,
                reserved: new Uint8Array(32),
            }),
        ]);
        chain.accounts.set(await configAddress(), {
            lamports: rentFor(config.length),
            owner: PROGRAM_ID,
            data: config,
        });
        chain.accounts.set(NATIVE_MINT, {
            lamports: 1n,
            owner: TOKEN_PROGRAM_ADDRESS,
            data: new Uint8Array(
                getMintEncoder().encode({
                    mintAuthority: none(),
                    supply: 0n,
                    decimals: 9,
                    isInitialized: true,
                    freezeAuthority: none(),
                    extensions: none(),
                }),
            ).slice(0, 82),
        });
        return chain;
    }

    fund(wallet: Address, lamports: bigint): void {
        this.accounts.set(wallet, { lamports, owner: SYSTEM_PROGRAM_ADDRESS, data: new Uint8Array() });
    }

    /**
     * A live pool of `creator`'s against `quoteMint`, an hour after launch, with its token's
     * metadata. With `list`, Pipeline's API lists it; `owner` puts the pool account under
     * another program, as an API that lies about a market would need.
     */
    async addPool(input: {
        creator: Address;
        tokenMint: Address;
        name: string;
        symbol: string;
        uri?: string;
        quoteMint?: Address;
        quoteProgram?: Address;
        accruedTaxQuote?: bigint;
        owner?: Address;
        list?: boolean;
    }): Promise<FakeMarket> {
        const params = { creator: input.creator, taxStartBps: 9_900, taxEndBps: 100, taxDurationSecs: 90 };
        const quoteMint = input.quoteMint ?? NATIVE_MINT;
        const quoteProgram = input.quoteProgram ?? TOKEN_PROGRAM_ADDRESS;
        const keys = await poolKeys(params, input.tokenMint, TOKEN_2022_PROGRAM_ADDRESS, quoteMint, quoteProgram);
        const pool = poolState(keys, {
            accruedTaxQuote: input.accruedTaxQuote ?? 0n,
            launchTs: BigInt(this.now - 3_600),
        });
        const market = { keys, pool, name: input.name, symbol: input.symbol, uri: input.uri ?? '' };
        this.accounts.set(keys.address, { ...poolAccount(pool), owner: input.owner ?? PROGRAM_ID });
        this.accounts.set(input.tokenMint, mintAccount(input.tokenMint, market));
        if (input.list ?? true) {
            this.listed.push(this.apiMarket(market));
        }
        return market;
    }

    /** The market as Pipeline's API describes it; the site takes little of this on trust. */
    apiMarket(market: FakeMarket): unknown {
        const { keys, pool } = market;
        const mint = (at: Address, program: Address, vault: Address, liquidity: bigint, decimals: number) => ({
            decimals,
            extension_types: [],
            extensions: {},
            flags: [],
            freeze_authority: null,
            liquidity: `${liquidity}`,
            mint: at,
            mint_authority: null,
            readable: true,
            supply: '1000000000000000',
            token_program: program,
            vault,
        });
        return {
            address: keys.market,
            created_at: new Date((this.now - 3_600) * 1000).toISOString(),
            created_by: pool.creator,
            flags: ['upgradeable', 'token-2022'],
            market_state: keys.address,
            mints: [
                mint(keys.tokenMint, keys.tokenProgram, keys.tokenVault, pool.reserveToken, 6),
                mint(keys.quoteMint, keys.quoteProgram, keys.quoteVault, pool.reserveQuote, 9),
            ],
            stats_24h: { last_trade_at: null, trades: 0, volume_by_input_mint: {} },
            strategy_program: PROGRAM_ID,
            supports_exact_out: true,
        };
    }

    /** Pipeline's API: the market list, and no trades for any market. */
    api(path: string): unknown {
        if (path.startsWith('/v1/markets?')) {
            return { markets: this.listed };
        }
        if (/^\/v1\/markets\/[^/]+\/trades/.test(path)) {
            return { trades: [] };
        }
        return null;
    }

    private encoded(at: Address, slice?: { offset: number; length: number }): unknown {
        const account = this.accounts.get(at);
        if (!account) {
            return null;
        }
        const data = slice ? account.data.slice(slice.offset, slice.offset + slice.length) : account.data;
        return {
            data: [base64.decode.decode(data), 'base64'],
            executable: account.executable ?? false,
            lamports: Number(account.lamports),
            owner: account.owner,
            rentEpoch: 0,
            space: account.data.length,
        };
    }

    /** One JSON-RPC call, answered the way a devnet node would. */
    rpc(method: string, params: readonly unknown[]): unknown {
        this.events.push(method);
        const context = { apiVersion: '4.0.0', slot: this.slot };
        const config = (index: number) => (params[index] ?? {}) as Record<string, unknown>;
        switch (method) {
            case 'getSlot':
                return this.slot;
            case 'getBlockTime':
                return this.now;
            case 'getBlockHeight':
                return this.slot - 1_000;
            case 'getEpochInfo':
                return {
                    absoluteSlot: this.slot,
                    blockHeight: this.slot - 1_000,
                    epoch: 1_200,
                    slotIndex: 1,
                    slotsInEpoch: 432_000,
                };
            case 'getMinimumBalanceForRentExemption':
                return Number(rentFor(Number(params[0])));
            case 'getLatestBlockhash':
                return {
                    context,
                    value: { blockhash: PROGRAM_ID, lastValidBlockHeight: this.slot - 1_000 + 150 },
                };
            case 'getBalance':
                return { context, value: Number(this.accounts.get(params[0] as Address)?.lamports ?? 0n) };
            case 'getAccountInfo':
                return {
                    context,
                    value: this.encoded(
                        params[0] as Address,
                        config(1).dataSlice as { offset: number; length: number } | undefined,
                    ),
                };
            case 'getMultipleAccounts':
                return { context, value: (params[0] as Address[]).map((at) => this.encoded(at)) };
            case 'getProgramAccounts':
                return this.programAccounts(params[0] as Address, config(1));
            case 'simulateTransaction': {
                const seen = readTransaction(toBytes(params[0] as string));
                this.simulated.push(seen);
                const balance = this.accounts.get(seen.feePayer)?.lamports ?? 0n;
                const result = this.simulate(seen, balance);
                return {
                    context,
                    value: {
                        err: result.err,
                        logs: result.logs ?? [],
                        unitsConsumed: 60_000,
                        returnData: null,
                        accounts: [
                            result.lamportsAfter === null
                                ? null
                                : {
                                      data: ['', 'base64'],
                                      executable: false,
                                      lamports: Number(result.lamportsAfter),
                                      owner: SYSTEM_PROGRAM_ADDRESS,
                                      rentEpoch: 0,
                                      space: 0,
                                  },
                        ],
                    },
                };
            }
            case 'getSignatureStatuses':
                return {
                    context,
                    value: (params[0] as string[]).map((signature) =>
                        this.signatures.has(signature)
                            ? { slot: this.slot, confirmations: 1, err: null, confirmationStatus: 'confirmed' }
                            : null,
                    ),
                };
            default:
                throw new Error(`the stand-in RPC has no ${method}`);
        }
    }

    private programAccounts(program: Address, config: Record<string, unknown>): unknown {
        const filters = (config.filters ?? []) as {
            dataSize?: number;
            memcmp?: { offset: number; bytes: string };
        }[];
        const out: unknown[] = [];
        for (const [at, account] of this.accounts) {
            const matches =
                account.owner === program &&
                filters.every((filter) => {
                    if (filter.dataSize !== undefined) {
                        return account.data.length === Number(filter.dataSize);
                    }
                    const want = getAddressEncoder().encode(filter.memcmp!.bytes as Address);
                    const offset = Number(filter.memcmp!.offset);
                    return want.every((byte, i) => account.data[offset + i] === byte);
                });
            if (matches) {
                out.push({ pubkey: at, account: this.encoded(at, { offset: 0, length: 0 }) });
            }
        }
        return out;
    }

    /** The wallet "sent" a transaction: its signature now reads as confirmed. */
    confirm(signature: Uint8Array): void {
        this.signatures.add(getBase58Decoder().decode(signature));
        this.slot += 2;
    }
}
