import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        environment: 'node',
    },
    resolve: {
        alias: {
            sqlite: 'node:sqlite',
        },
    },
    ssr: {
        external: ['node:sqlite'],
    },
});
