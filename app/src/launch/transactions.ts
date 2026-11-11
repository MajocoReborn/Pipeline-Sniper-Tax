// The two transactions of a launch, built from the form. Plain functions without RPC calls:
// the caller passes in what must be read from the chain (rent, the treasury).
//
// 1. Token: a Token-2022 mint with its metadata inside it. The metadata pointer and the
//    metadata itself get no update authority, so the name, symbol and image can't change
//    after launch (review finding L3). There is no freeze authority. The whole supply is
//    minted to the creator, then the mint authority is revoked.
// 2. Pool: wrap the SOL for the pool, the router's `create_market`, both fee accounts and our
//    `launch`. One transaction, so nobody can trade between creating and launching.

import {
    appendTransactionMessageInstructions,
    blockhash,
    compileTransaction,
    createTransactionMessage,
    getTransactionEncoder,
    none,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    some,
    type Address,
    type Instruction,
    type TransactionSigner,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
    getCloseAccountInstruction,
    getCreateAssociatedTokenIdempotentInstruction as getCreateClassicAtaInstruction,
    getSyncNativeInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
    AuthorityType,
    extension,
    getCreateAssociatedTokenIdempotentInstruction,
    getInitializeMetadataPointerInstruction,
    getInitializeMint2Instruction,
    getInitializeTokenMetadataInstruction,
    getMintSize,
    getMintToCheckedInstruction,
    getSetAuthorityInstruction,
    getUpdateTokenMetadataUpdateAuthorityInstruction,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';

import {
    NATIVE_MINT,
    createMarketIx,
    creatorQuoteAccount,
    creatorTokenAccount,
    feeAccountIxs,
    launchIx,
    poolKeys,
    type PoolKeys,
} from '../client/index.js';
import { TOKEN_DECIMALS, TOKEN_SUPPLY, initParams, launchAmounts, type LaunchForm } from './form.js';

/** Solana's limit for a serialised transaction. */
export const MAX_TRANSACTION_SIZE = 1_232;

/**
 * The mint account's size: `space` is allocated by `createAccount` (mint plus metadata
 * pointer); Token-2022 grows it to `full` when the metadata is written, so the account must
 * be funded for `full` from the start.
 */
export function mintSizes(mint: Address, creator: Address, form: Pick<LaunchForm, 'name' | 'symbol' | 'uri'>) {
    const pointer = extension('MetadataPointer', { authority: none(), metadataAddress: some(mint) });
    const metadata = extension('TokenMetadata', {
        updateAuthority: some(creator),
        mint,
        name: form.name,
        symbol: form.symbol,
        uri: form.uri,
        additionalMetadata: new Map(),
    });
    return { space: getMintSize([pointer]), full: getMintSize([pointer, metadata]) };
}

/** Transaction 1: the token. `mintLamports` is the rent for `mintSizes(...).full`. */
export async function tokenInstructions(input: {
    creator: TransactionSigner;
    mint: TransactionSigner;
    form: LaunchForm;
    mintLamports: bigint;
}): Promise<Instruction[]> {
    const { creator, mint, form } = input;
    const { space } = mintSizes(mint.address, creator.address, form);
    const keys = await poolKeys(
        initParams(creator.address, form),
        mint.address,
        TOKEN_2022_PROGRAM_ADDRESS,
        NATIVE_MINT,
        TOKEN_PROGRAM_ADDRESS,
    );
    const creatorToken = await creatorTokenAccount(keys);
    return [
        getCreateAccountInstruction({
            payer: creator,
            newAccount: mint,
            lamports: input.mintLamports,
            space,
            programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        }),
        getInitializeMetadataPointerInstruction({ mint: mint.address, authority: null, metadataAddress: mint.address }),
        getInitializeMint2Instruction({
            mint: mint.address,
            decimals: TOKEN_DECIMALS,
            mintAuthority: creator.address,
            freezeAuthority: null,
        }),
        getInitializeTokenMetadataInstruction({
            metadata: mint.address,
            updateAuthority: creator.address,
            mint: mint.address,
            mintAuthority: creator,
            name: form.name,
            symbol: form.symbol,
            uri: form.uri,
        }),
        getUpdateTokenMetadataUpdateAuthorityInstruction({
            metadata: mint.address,
            updateAuthority: creator,
            newUpdateAuthority: null,
        }),
        getCreateAssociatedTokenIdempotentInstruction({
            payer: creator,
            ata: creatorToken,
            owner: creator.address,
            mint: mint.address,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        }),
        getMintToCheckedInstruction({
            mint: mint.address,
            token: creatorToken,
            mintAuthority: creator,
            amount: TOKEN_SUPPLY,
            decimals: TOKEN_DECIMALS,
        }),
        getSetAuthorityInstruction({
            owned: mint.address,
            owner: creator,
            authorityType: AuthorityType.MintTokens,
            newAuthority: null,
        }),
    ];
}

/** The pool's addresses for a token launched from the site (Token-2022 against wrapped SOL). */
export function sitePoolKeys(creator: Address, mint: Address, form: LaunchForm): Promise<PoolKeys> {
    return poolKeys(initParams(creator, form), mint, TOKEN_2022_PROGRAM_ADDRESS, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS);
}

/**
 * Transaction 2: the pool. `treasury` is the config's current treasury. With
 * `closeQuoteAccount`, the creator's wrapped-SOL account is closed afterwards and its rent
 * returned; pass `false` if the creator already had one, so their own wrapped SOL stays.
 */
export async function poolInstructions(input: {
    creator: TransactionSigner;
    mint: Address;
    form: LaunchForm;
    treasury: Address;
    closeQuoteAccount: boolean;
}): Promise<{ keys: PoolKeys; instructions: Instruction[] }> {
    const { creator, form } = input;
    const keys = await sitePoolKeys(creator.address, input.mint, form);
    const creatorQuote = await creatorQuoteAccount(keys);
    const { poolTokens } = launchAmounts(form);
    const instructions: Instruction[] = [
        getCreateClassicAtaInstruction({
            payer: creator,
            ata: creatorQuote,
            owner: creator.address,
            mint: NATIVE_MINT,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
        }),
        getTransferSolInstruction({ source: creator, destination: creatorQuote, amount: form.liquidityLamports }),
        getSyncNativeInstruction({ account: creatorQuote }),
        await createMarketIx(keys, creator.address),
        ...(await feeAccountIxs(keys, creator.address)),
        await launchIx(keys, input.treasury, poolTokens, form.liquidityLamports),
    ];
    if (input.closeQuoteAccount) {
        instructions.push(
            getCloseAccountInstruction({ account: creatorQuote, destination: creator.address, owner: creator }),
        );
    }
    return { keys, instructions };
}

/** A transaction message for `instructions`, paid by `feePayer`. */
export function launchMessage(
    feePayer: TransactionSigner,
    instructions: Instruction[],
    lifetime: { blockhash: string; lastValidBlockHeight: bigint },
) {
    return pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayerSigner(feePayer, message),
        (message) =>
            setTransactionMessageLifetimeUsingBlockhash(
                { blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: lifetime.lastValidBlockHeight },
                message,
            ),
        (message) => appendTransactionMessageInstructions(instructions, message),
    );
}

/** The serialised size of a transaction with these instructions, signatures included. */
export function transactionSize(feePayer: TransactionSigner, instructions: Instruction[]): number {
    const message = launchMessage(feePayer, instructions, {
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 0n,
    });
    return getTransactionEncoder().encode(compileTransaction(message)).length;
}
