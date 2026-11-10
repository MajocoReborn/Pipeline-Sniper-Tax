// Wallet selection through the Wallet Standard: any wallet that can sign and send on devnet.

import { useConnect, useDisconnect, useWallets, type UiWallet, type UiWalletAccount } from '@wallet-standard/react';

import { CHAIN } from '../config.js';
import { shortAddress } from '../launch/units.js';

const SIGN_AND_SEND = 'solana:signAndSendTransaction';

function usableWallets(wallets: readonly UiWallet[]): UiWallet[] {
    return wallets.filter((wallet) => wallet.chains.includes(CHAIN) && wallet.features.includes(SIGN_AND_SEND));
}

function ConnectButton({ wallet, onAccount }: { wallet: UiWallet; onAccount: (account: UiWalletAccount) => void }) {
    const [isConnecting, connect] = useConnect(wallet);
    return (
        <button
            type="button"
            disabled={isConnecting}
            onClick={async () => {
                const accounts = await connect();
                const account = accounts.find((a) => a.chains.includes(CHAIN)) ?? accounts[0];
                if (account) {
                    onAccount(account);
                }
            }}
        >
            {wallet.icon ? <img className="wallet-icon" src={wallet.icon} alt="" /> : null}
            {isConnecting ? 'Connecting…' : wallet.name}
        </button>
    );
}

function DisconnectButton({ wallet, onDisconnected }: { wallet: UiWallet; onDisconnected: () => void }) {
    const [isDisconnecting, disconnect] = useDisconnect(wallet);
    return (
        <button
            type="button"
            className="secondary"
            disabled={isDisconnecting}
            onClick={async () => {
                await disconnect();
                onDisconnected();
            }}
        >
            Disconnect
        </button>
    );
}

export function WalletBar({
    account,
    onAccount,
}: {
    account: UiWalletAccount | null;
    onAccount: (account: UiWalletAccount | null) => void;
}) {
    const wallets = usableWallets(useWallets());
    if (account) {
        const wallet = wallets.find((w) => w.accounts.some((a) => a.address === account.address));
        return (
            <div className="wallet">
                <span className="address" title={account.address}>
                    {shortAddress(account.address)}
                </span>
                {wallet ? <DisconnectButton wallet={wallet} onDisconnected={() => onAccount(null)} /> : null}
            </div>
        );
    }
    if (wallets.length === 0) {
        return <p className="muted">No Solana wallet found. Install one, such as Phantom or Solflare.</p>;
    }
    return (
        <div className="wallet">
            {wallets.map((wallet) => (
                <ConnectButton key={wallet.name} wallet={wallet} onAccount={onAccount} />
            ))}
        </div>
    );
}
