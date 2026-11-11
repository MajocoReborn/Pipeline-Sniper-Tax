import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Vite's dev server injects CSS as inline styles, which the page's CSP blocks. Allow them on
 * the dev server only; the built site keeps the strict policy from `index.html`.
 */
function devInlineStyles(): Plugin {
    return {
        name: 'dev-inline-styles',
        apply: 'serve',
        transformIndexHtml: (html) => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
    };
}

export default defineConfig({
    plugins: [react(), devInlineStyles()],
    build: {
        // No source maps in the published site; the source is public in the repository.
        sourcemap: false,
    },
});
