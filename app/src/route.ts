// The site's pages, in the URL's hash so a static host can serve every page from one file.

import { useMemo, useSyncExternalStore } from 'react';
import { isAddress, type Address } from '@solana/kit';

export type Route =
    | { page: 'launches' }
    | { page: 'launch' }
    | { page: 'creator' }
    | { page: 'pool'; pool: Address }
    | { page: 'missing' };

export function parseRoute(hash: string): Route {
    const path = hash.replace(/^#/, '') || '/';
    if (path === '/') {
        return { page: 'launches' };
    }
    if (path === '/launch') {
        return { page: 'launch' };
    }
    if (path === '/creator') {
        return { page: 'creator' };
    }
    const pool = /^\/pool\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path)?.[1];
    return pool && isAddress(pool) ? { page: 'pool', pool } : { page: 'missing' };
}

export const href = {
    launches: '#/',
    launch: '#/launch',
    creator: '#/creator',
    pool: (pool: Address) => `#/pool/${pool}`,
};

function subscribe(onChange: () => void): () => void {
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
    const hash = useSyncExternalStore(subscribe, () => window.location.hash);
    return useMemo(() => parseRoute(hash), [hash]);
}
