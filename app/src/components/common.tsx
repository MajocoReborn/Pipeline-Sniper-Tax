// Small pieces the pages share. Anything that came from the chain or the API is shown as
// text; links are built from addresses only.

import { useState, type ReactNode } from 'react';

import { explorerUrl } from '../config.js';
import { formatBps, shortAddress } from '../launch/units.js';

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
    return (
        <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
        </a>
    );
}

/** A short address that links to the explorer, with the full address on hover. */
export function AddressLink({ address, label }: { address: string; label?: string }) {
    return (
        <a href={explorerUrl('address', address)} target="_blank" rel="noreferrer noopener" title={address}>
            <code>{label ?? shortAddress(address)}</code>
        </a>
    );
}

/**
 * The token's image from its metadata link, if that link is an https image. Links to JSON
 * documents aren't fetched (the page's CSP allows images from anywhere, but data only from
 * known hosts), so those show the symbol's first letter instead.
 */
export function TokenImage({ uri, symbol, size = 40 }: { uri: string | null; symbol: string; size?: number }) {
    const [failed, setFailed] = useState(false);
    const usable = uri !== null && uri.startsWith('https://') && !failed;
    return usable ? (
        <img
            className="token-image"
            src={uri}
            alt=""
            width={size}
            height={size}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
        />
    ) : (
        <span className="token-image placeholder" style={{ width: size, height: size }} aria-hidden="true">
            {symbol.slice(0, 1)}
        </span>
    );
}

/** A tax rate, highlighted while it is high. */
export function Tax({ bps, approximate = false }: { bps: number; approximate?: boolean }) {
    const level = bps >= 5_000 ? 'tax high' : bps > 0 ? 'tax some' : 'tax none';
    return (
        <span className={level}>
            {approximate ? '≈' : ''}
            {formatBps(bps)}
        </span>
    );
}

export function Loading({ what }: { what: string }) {
    return <p className="muted">Reading {what}…</p>;
}
