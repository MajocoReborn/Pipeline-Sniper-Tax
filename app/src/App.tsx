import { useState } from 'react';
import type { Address } from '@solana/kit';
import type { UiWalletAccount } from '@wallet-standard/react';

import { LaunchList } from './components/LaunchList.js';
import { LaunchPage } from './components/LaunchPage.js';
import { TokenPage } from './components/TokenPage.js';
import { WalletBar } from './components/WalletBar.js';
import { href, useRoute } from './route.js';

function ConnectFirst() {
    return (
        <section className="card">
            <h2>Connect a wallet to launch</h2>
            <p>
                Every launch here has a sniper tax: buys right after launch pay up to 99%, falling to 0% within minutes.
                The tax goes to you, the creator. The token can never be minted again or frozen, and its name and image
                are fixed for good.
            </p>
            <p className="muted">Set your wallet to devnet. This site uses devnet SOL only.</p>
        </section>
    );
}

export function App() {
    const [account, setAccount] = useState<UiWalletAccount | null>(null);
    const route = useRoute();
    return (
        <div className="page">
            <header className="header">
                <div>
                    <h1>
                        <a href={href.launches} className="home">
                            Sniper Tax Launch
                        </a>
                    </h1>
                    <p className="tagline">Launch a token where snipers pay, not win. Devnet.</p>
                </div>
                <nav className="nav">
                    <a href={href.launches} aria-current={route.page === 'launches' ? 'page' : undefined}>
                        Launches
                    </a>
                    <a href={href.launch} aria-current={route.page === 'launch' ? 'page' : undefined}>
                        Launch a token
                    </a>
                </nav>
                <WalletBar account={account} onAccount={setAccount} />
            </header>
            <main>
                {route.page === 'launches' ? <LaunchList /> : null}
                {route.page === 'launch' ? (
                    account ? (
                        <LaunchPage key={account.address} account={account} />
                    ) : (
                        <ConnectFirst />
                    )
                ) : null}
                {route.page === 'pool' ? (
                    <TokenPage key={route.pool} pool={route.pool as Address} account={account} />
                ) : null}
                {route.page === 'missing' ? (
                    <section className="card">
                        <h2>Nothing here</h2>
                        <a href={href.launches}>See the launches</a>
                    </section>
                ) : null}
            </main>
        </div>
    );
}
