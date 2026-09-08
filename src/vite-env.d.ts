/// <reference types="vite/client" />

import type { VaporApi } from './types';

declare global {
    interface Window {
        vaporApi: VaporApi;
    }
}

export {};
