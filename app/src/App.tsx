import { useState } from 'react';
import type { UiWalletAccount } from '@wallet-standard/react';

import { LaunchPage } from './components/LaunchPage.js';
import { WalletBar } from './components/WalletBar.js';

export function App() {
    const [account, setAccount] = useState<UiWalletAccount | null>(null);
    return (
        <div className="page">
            <header className="header">
                <div>
                    <h1>Sniper Tax Launch</h1>
                    <p className="tagline">Launch a token where snipers pay, not win. Devnet.</p>
                </div>
                <WalletBar account={account} onAccount={setAccount} />
            </header>
            <main>
                {account ? (
                    <LaunchPage key={account.address} account={account} />
                ) : (
                    <section className="card">
                        <h2>Connect a wallet to launch</h2>
                        <p>
                            Every launch here has a sniper tax: buys right after launch pay up to 99%, falling to 0%
                            within minutes. The tax goes to you, the creator. The token can never be minted again or
                            frozen, and its name and image are fixed for good.
                        </p>
                        <p className="muted">Set your wallet to devnet. This site uses devnet SOL only.</p>
                    </section>
                )}
            </main>
        </div>
    );
}
