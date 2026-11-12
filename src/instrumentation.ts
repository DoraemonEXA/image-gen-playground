export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
        const { initializeRuntime } = await import('./modules/multi-user/startup');
        initializeRuntime();
    }
}
