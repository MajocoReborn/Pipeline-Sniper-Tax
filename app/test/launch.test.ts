// The launch form's rules and the two launch transactions, without a network.

import {
    address,
    createNoopSigner,
    generateKeyPairSigner,
    getBase64Decoder,
    getU64Codec,
    type Instruction,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';

import {
    ACCOUNT_DISCRIMINATORS,
    INSTRUCTION_DISCRIMINATORS,
    NATIVE_MINT,
    PROGRAM_ID,
    getLaunchPoolCodec,
    type LaunchPool,
} from '../src/client/index.js';
import {
    MAX_NAME_BYTES,
    MAX_URI_BYTES,
    MIN_LIQUIDITY_LAMPORTS,
    TOKEN_SUPPLY,
    initParams,
    launchAmounts,
    normalizeForm,
    validateForm,
    type LaunchForm,
} from '../src/launch/form.js';
import {
    MAX_TRANSACTION_SIZE,
    NOTHING_SET_UP,
    mintSizes,
    poolInstructions,
    sitePoolKeys,
    tokenInstructions,
    transactionSize,
    type PoolSetup,
} from '../src/launch/transactions.js';
import { launchCosts, readPoolSetup, transactionCost, type Rpc } from '../src/launch/chain.js';
import { explainSimulationError, spendProblem } from '../src/launch/run.js';
import { PIPELINE_PROGRAM_ADDRESS, feeAccountPda } from '../src/vendor/pipeline/index.js';

import { poolFromVector, vectors } from './helpers.js';

const creator = createNoopSigner(address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'));
const treasury = address('CUiq3QQbXMsrgCpiN423zr2NTrdfPRuGUy9EQKQ6CGap');

const goodForm: LaunchForm = {
    name: 'Fair Launch Token',
    symbol: 'FAIR',
    uri: 'https://example.com/fair.png',
    preset: 'normal',
    permanentFeeBps: 0,
    creatorShareBps: 0,
    liquidityLamports: 1_000_000_000n,
};

/** The longest metadata the form allows: multi-byte name, full symbol and link. */
const largestForm: LaunchForm = {
    ...goodForm,
    name: 'é'.repeat(MAX_NAME_BYTES / 2),
    symbol: 'ABCDEFGHIJ',
    uri: 'https://' + 'a'.repeat(MAX_URI_BYTES - 'https://'.length),
};

describe('the launch form', () => {
    it('accepts a normal launch and the largest one', () => {
        expect(validateForm(goodForm)).toEqual([]);
        expect(validateForm(largestForm)).toEqual([]);
    });

    it('refuses what the site or the program would refuse', () => {
        const bad: [Partial<LaunchForm>, string][] = [
            [{ name: '' }, 'name'],
            [{ name: 'x'.repeat(MAX_NAME_BYTES + 1) }, 'name'],
            [{ name: 'é'.repeat(MAX_NAME_BYTES / 2 + 1) }, 'name'],
            [{ name: 'bad\u0007name' }, 'control'],
            // A right-to-left override and a zero-width space: invisible, and they change what is read.
            [{ name: 'Fair \u202Enekot' }, 'invisible'],
            [{ name: 'Fa\u200Bir' }, 'invisible'],
            [{ name: 'Fair  Token' }, 'space'],
            [{ symbol: '' }, 'symbol'],
            [{ symbol: 'ABCDEFGHIJK' }, 'symbol'],
            [{ symbol: 'FA$R' }, 'symbol'],
            [{ uri: 'http://example.com/a.png' }, 'https'],
            [{ uri: 'not a link' }, 'https'],
            [{ uri: 'https://' + 'a'.repeat(MAX_URI_BYTES) }, 'https'],
            [{ preset: 'none' as LaunchForm['preset'] }, 'strength'],
            [{ permanentFeeBps: 501 }, 'permanent fee'],
            [{ permanentFeeBps: -1 }, 'permanent fee'],
            [{ permanentFeeBps: 1.5 }, 'permanent fee'],
            [{ creatorShareBps: 2_001 }, 'supply'],
            [{ creatorShareBps: -1 }, 'supply'],
            [{ liquidityLamports: MIN_LIQUIDITY_LAMPORTS - 1n }, 'SOL'],
        ];
        for (const [change, word] of bad) {
            const errors = validateForm({ ...goodForm, ...change });
            expect(
                errors.join(' '),
                JSON.stringify(change, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)),
            ).toContain(word);
        }
    });

    it('trims the text fields and capitalises the symbol', () => {
        expect(
            normalizeForm({ ...goodForm, name: '  Fair  ', symbol: ' fair ', uri: ' https://x.io/a ' }),
        ).toMatchObject({
            name: 'Fair',
            symbol: 'FAIR',
            uri: 'https://x.io/a',
        });
    });

    it('splits the supply between the pool and the creator', () => {
        expect(launchAmounts({ creatorShareBps: 0 })).toEqual({ poolTokens: TOKEN_SUPPLY, creatorTokens: 0n });
        expect(launchAmounts({ creatorShareBps: 2_000 })).toEqual({
            poolTokens: (TOKEN_SUPPLY * 8n) / 10n,
            creatorTokens: (TOKEN_SUPPLY * 2n) / 10n,
        });
    });

    it('turns each strength into its schedule', () => {
        expect(initParams(creator.address, { preset: 'strong', permanentFeeBps: 0 })).toMatchObject({
            taxStartBps: 9_900,
            taxEndBps: 0,
            taxDurationSecs: 600,
        });
        expect(initParams(creator.address, { preset: 'normal', permanentFeeBps: 300 })).toMatchObject({
            taxStartBps: 9_900,
            taxEndBps: 300,
            taxDurationSecs: 90,
        });
        expect(initParams(creator.address, { preset: 'mild', permanentFeeBps: 0 })).toMatchObject({
            taxStartBps: 5_000,
            taxEndBps: 0,
            taxDurationSecs: 60,
        });
    });
});

describe('the token transaction', () => {
    it('creates, describes, mints and locks the token, and fits in one transaction', async () => {
        const mint = await generateKeyPairSigner();
        for (const form of [goodForm, largestForm]) {
            const sizes = mintSizes(mint.address, creator.address, form);
            expect(sizes.full).toBeGreaterThan(sizes.space);
            const instructions = await tokenInstructions({ creator, mint, form, mintLamports: 5_000_000n });
            // System: create the account. Token-2022: metadata pointer, mint, metadata, freeze
            // the metadata. Associated token program: the creator's account. Token-2022: mint
            // the supply, revoke the mint authority.
            expect(instructions.map((ix) => ix.programAddress)).toEqual([
                address('11111111111111111111111111111111'),
                TOKEN_2022_PROGRAM_ADDRESS,
                TOKEN_2022_PROGRAM_ADDRESS,
                TOKEN_2022_PROGRAM_ADDRESS,
                TOKEN_2022_PROGRAM_ADDRESS,
                address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
                TOKEN_2022_PROGRAM_ADDRESS,
                TOKEN_2022_PROGRAM_ADDRESS,
            ]);
            const size = transactionSize(creator, instructions);
            expect(size, `token transaction for ${form.name}`).toBeLessThanOrEqual(MAX_TRANSACTION_SIZE);
        }
    });

    it('signs with the creator and the new mint only', async () => {
        const mint = await generateKeyPairSigner();
        const instructions = await tokenInstructions({ creator, mint, form: goodForm, mintLamports: 5_000_000n });
        const signers = new Set(
            instructions.flatMap((ix) => (ix.accounts ?? []).filter((a) => a.role >= 2).map((a) => a.address)),
        );
        expect([...signers].sort()).toEqual([creator.address, mint.address].sort());
    });
});

describe('the pool transaction', () => {
    const launchData = (instructions: Instruction[]) =>
        instructions.find((ix) => ix.programAddress === PROGRAM_ID)!.data!;

    it('wraps the SOL, creates the market and launches, in one transaction', async () => {
        const mint = (await generateKeyPairSigner()).address;
        for (const closeQuoteAccount of [true, false]) {
            const { keys, instructions } = await poolInstructions({
                creator,
                mint,
                form: largestForm,
                treasury,
                closeQuoteAccount,
            });
            expect(keys).toEqual(await sitePoolKeys(creator.address, mint, largestForm));
            expect(keys.tokenProgram).toBe(TOKEN_2022_PROGRAM_ADDRESS);
            expect(keys.quoteMint).toBe(NATIVE_MINT);
            expect(keys.quoteProgram).toBe(TOKEN_PROGRAM_ADDRESS);
            expect(instructions.filter((ix) => ix.programAddress === PIPELINE_PROGRAM_ADDRESS)).toHaveLength(3);
            expect(instructions).toHaveLength(closeQuoteAccount ? 8 : 7);
            const size = transactionSize(creator, instructions);
            expect(size, `pool transaction, close ${closeQuoteAccount}`).toBeLessThanOrEqual(MAX_TRANSACTION_SIZE);
        }
    });

    it('leaves out the setup someone else already sent, and still launches', async () => {
        const mint = (await generateKeyPairSigner()).address;
        const build = (existing: PoolSetup) =>
            poolInstructions({ creator, mint, form: goodForm, treasury, closeQuoteAccount: true, existing });
        const router = (instructions: Instruction[]) =>
            instructions.filter((ix) => ix.programAddress === PIPELINE_PROGRAM_ADDRESS);
        const all = await build(NOTHING_SET_UP);
        const [createMarket, tokenFee, quoteFee] = router(all.instructions);

        // A stranger created the market: `create_market` would fail, so it is left out.
        const marketTaken = await build({ ...NOTHING_SET_UP, market: true });
        expect(router(marketTaken.instructions)).toEqual([tokenFee, quoteFee]);
        // One fee account taken: only the other is created.
        const feeTaken = await build({ ...NOTHING_SET_UP, tokenFeeAccount: true });
        expect(router(feeTaken.instructions)).toEqual([createMarket, quoteFee]);
        // Everything taken: wrap, launch and unwrap remain.
        const allTaken = await build({ market: true, tokenFeeAccount: true, quoteFeeAccount: true });
        expect(router(allTaken.instructions)).toEqual([]);
        expect(allTaken.instructions).toHaveLength(5);

        for (const { instructions } of [all, marketTaken, feeTaken, allTaken]) {
            // Our program's one instruction is always the launch, signed by the creator.
            const ours = instructions.filter((ix) => ix.programAddress === PROGRAM_ID);
            expect(ours).toHaveLength(1);
            expect([...ours[0]!.data!.slice(0, 8)]).toEqual([...INSTRUCTION_DISCRIMINATORS.launch]);
            expect(ours[0]!.accounts![0]!.address).toBe(creator.address);
        }
    });

    it('reads from the chain what of the setup exists', async () => {
        const mint = (await generateKeyPairSigner()).address;
        const keys = await sitePoolKeys(creator.address, mint, goodForm);
        const tokenFee = await feeAccountPda(keys.market, keys.tokenMint, keys.tokenProgram);
        const poolData = (status: LaunchPool['status']) =>
            new Uint8Array([
                ...ACCOUNT_DISCRIMINATORS.LaunchPool,
                ...getLaunchPoolCodec().encode({ ...poolFromVector(vectors.pools[0]).pool, status }),
            ]);
        const chain = (accounts: Map<string, Uint8Array>) =>
            ({
                getAccountInfo: (at: string) => ({
                    send: async () => {
                        const data = accounts.get(at);
                        return { value: data ? { data: [getBase64Decoder().decode(data), 'base64'] } : null };
                    },
                }),
            }) as unknown as Rpc;

        expect(await readPoolSetup(chain(new Map()), keys)).toEqual({ ...NOTHING_SET_UP, launched: false });
        expect(await readPoolSetup(chain(new Map([[keys.address as string, poolData('pending')]])), keys)).toEqual({
            ...NOTHING_SET_UP,
            market: true,
            launched: false,
        });
        expect(
            await readPoolSetup(
                chain(
                    new Map([
                        [keys.address as string, poolData('live')],
                        [tokenFee as string, new Uint8Array(165)],
                    ]),
                ),
                keys,
            ),
        ).toEqual({ market: true, launched: true, tokenFeeAccount: true, quoteFeeAccount: false });
        // Lamports sent to the pool's address make an account there, but not a pool.
        expect(await readPoolSetup(chain(new Map([[keys.address as string, new Uint8Array(0)]])), keys)).toEqual({
            ...NOTHING_SET_UP,
            launched: false,
        });
    });

    it('deposits the pool share of the supply and the chosen SOL', async () => {
        const mint = (await generateKeyPairSigner()).address;
        const form = { ...goodForm, creatorShareBps: 1_500, liquidityLamports: 2_500_000_000n };
        const { instructions } = await poolInstructions({ creator, mint, form, treasury, closeQuoteAccount: true });
        const data = launchData(instructions);
        const u64 = getU64Codec();
        expect([...data.slice(0, 8)]).toEqual([...INSTRUCTION_DISCRIMINATORS.launch]);
        expect(u64.decode(data.slice(8, 16))).toBe(launchAmounts(form).poolTokens);
        expect(u64.decode(data.slice(16, 24))).toBe(2_500_000_000n);
    });
});

describe('simulation errors', () => {
    it('are explained in plain words where we can', () => {
        expect(explainSimulationError('"AccountNotFound"')).toMatch(/no SOL/);
        expect(explainSimulationError('"InsufficientFundsForFee"')).toMatch(/not enough SOL/);
        expect(explainSimulationError('{"InstructionError":[2,{"Custom":1}]}')).toMatch(/not enough/);
        // As the RPC client reports them, with bigints serialized as strings.
        expect(explainSimulationError('{"InstructionError":["2",{"Custom":"1"}]}')).toMatch(/not enough/);
        const slipped = [
            'Program log: AnchorError occurred. Error Code: InsufficientOutput. Error Number: 6021. Error Message: Trader received less than the minimum.',
        ];
        expect(explainSimulationError('{"InstructionError":["4",{"Custom":"6021"}]}', slipped)).toMatch(/slippage/);
        expect(explainSimulationError('{"InstructionError":["4",{"Custom":"6021"}]}')).toBeNull();
        expect(explainSimulationError('{"InstructionError":[6,{"Custom":6010}]}')).toBeNull();
        expect(explainSimulationError('{"InstructionError":[6,{"Custom":10}]}')).toBeNull();
    });
});

describe('the cost preview', () => {
    // Rent as the cluster computes it: (128 + bytes) * 6,960 lamports.
    const rpc = {
        getMinimumBalanceForRentExemption: (space: bigint) => ({ send: async () => (128n + space) * 6_960n }),
    } as unknown as Rpc;
    const config = {
        admin: treasury,
        treasury,
        protocolTaxShareBps: 1_000,
        launchFeeLamports: 10_000_000n,
        bump: 255,
        pendingAdmin: null,
        reserved: new Uint8Array(0),
    };

    it('splits into the two transactions and leaves out the refunded account', async () => {
        const costs = await launchCosts(rpc, {
            creator: creator.address,
            mint: creator.address,
            form: goodForm,
            config,
        });
        const token = transactionCost(costs, 'token');
        const pool = transactionCost(costs, 'pool');
        expect(token + pool).toBe(costs.total);
        expect(costs.items.filter((i) => i.refundable)).toHaveLength(1);
        expect(costs.items.some((i) => i.lamports === config.launchFeeLamports && i.transaction === 'pool')).toBe(true);
        // Two signatures on the token transaction, one on the pool's.
        expect(costs.items.filter((i) => i.label.includes('fee') && i.transaction === 'token')[0]!.lamports).toBe(
            10_000n,
        );
    });

    it('stops a transaction that would spend more than shown', () => {
        expect(spendProblem('token', 100n, 100n)).toBeNull();
        expect(spendProblem('token', 99n, 100n)).toBeNull();
        expect(spendProblem('pool', 101n, 100n)).toMatch(/more than/);
        expect(spendProblem('pool', null, 100n)).toMatch(/could not be read/);
    });
});
