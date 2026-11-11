// Where the site runs. Devnet only for now; mainnet needs its own RPC, program address and
// a security review.

export const CHAIN = 'solana:devnet' as const;
export const RPC_URL = 'https://api.devnet.solana.com';
export const PIPELINE_API_URL = 'https://pipeline-devnet.up.railway.app';

export function explorerUrl(kind: 'address' | 'tx', id: string): string {
    return `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
}
