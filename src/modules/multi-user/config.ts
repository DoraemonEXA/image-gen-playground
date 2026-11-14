import path from 'node:path';

export function isMultiUser() {
    const mode = process.env.APP_MODE ?? 'multi-user';
    if (mode !== 'multi-user' && mode !== 'single-user') throw new Error('Invalid APP_MODE');
    return mode === 'multi-user';
}

export function config() {
    const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:3000');
    if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
        throw new Error('APP_ORIGIN must be an origin without a path or credentials');
    }
    if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('Invalid APP_ORIGIN protocol');
    if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
        throw new Error('APP_ORIGIN must use HTTPS outside localhost');
    }
    const encodedKey = process.env.AUTH_ENCRYPTION_KEY || '';
    if (!/^[a-f0-9]{64}$/i.test(encodedKey))
        throw new Error('AUTH_ENCRYPTION_KEY must contain 64 hexadecimal characters');
    const positive = (name: string, fallback: number) => {
        const value = Number(process.env[name] ?? fallback);
        if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
        return value;
    };
    const autoReconcile = process.env.AUTO_RECONCILE_INVALID_REQUESTS ?? 'false';
    if (autoReconcile !== 'true' && autoReconcile !== 'false')
        throw new Error('AUTO_RECONCILE_INVALID_REQUESTS must be true or false');
    return {
        origin: origin.origin,
        secure: origin.protocol === 'https:',
        key: Buffer.from(encodedKey, 'hex'),
        dataDir: path.resolve(/* turbopackIgnore: true */ process.env.APP_DATA_DIR || './data'),
        perUser: positive('MAX_ACTIVE_PER_USER', 1),
        global: positive('MAX_ACTIVE_GLOBAL', 4),
        autoReconcileInvalidRequests: autoReconcile === 'true',
        trustProxy: process.env.TRUST_PROXY === 'true'
    };
}

export class AppError extends Error {
    constructor(
        public status: number,
        message: string
    ) {
        super(message);
    }
}

export function assert(condition: unknown, status: number, message: string): asserts condition {
    if (!condition) throw new AppError(status, message);
}

export const privateHeaders = {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff'
};
