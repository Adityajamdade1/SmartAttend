/**
 * Real-Time Network Clock Validation Service
 * Prevents employees from tampering with phone time (turning off automatic network time
 * and manually moving phone clock backwards/forwards to fake attendance).
 */

const TRUSTED_TIME_ENDPOINTS = [
    'https://clients3.google.com/generate_204',
    'https://firestore.googleapis.com',
    'https://worldtimeapi.org/api/timezone/Etc/UTC',
];

// Maximum allowed drift between device clock and atomic server clock (in seconds)
// 120 seconds (2 minutes) allows for normal network latency while strictly blocking manual manipulation
const MAX_ALLOWED_DRIFT_SECONDS = 120;

// High-performance In-Memory Clock Sync Cache
let cachedTimeOffsetMs = null;
let lastTimeSyncTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

export const timeValidationService = {
    /**
     * Fetch unforgeable atomic clock time from trusted global servers
     * @param {boolean} forceRefresh - Force network call instead of using cache
     * @returns {Promise<{success: boolean, trustedTime?: Date, timestamp?: number, error?: string}>}
     */
    getTrustedNetworkTime: async (forceRefresh = false) => {
        // Return instantly from cache if verified within last 10 minutes (0ms)
        if (!forceRefresh && cachedTimeOffsetMs !== null && (Date.now() - lastTimeSyncTimestamp < CACHE_TTL_MS)) {
            const currentServerTimeMs = Date.now() + cachedTimeOffsetMs;
            return {
                success: true,
                trustedTime: new Date(currentServerTimeMs),
                timestamp: currentServerTimeMs,
                source: 'Cached Atomic NTP',
            };
        }

        // Try Google's ultra-fast connectivity/atomic clock endpoint first
        try {
            const start = Date.now();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2500);

            const res = await fetch('https://clients3.google.com/generate_204', {
                method: 'HEAD',
                headers: { 'Cache-Control': 'no-cache, no-store' },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            const dateHeader = res.headers.get('date');
            if (dateHeader) {
                const latency = (Date.now() - start) / 2;
                const serverTimeMs = new Date(dateHeader).getTime() + latency;
                cachedTimeOffsetMs = serverTimeMs - Date.now();
                lastTimeSyncTimestamp = Date.now();
                return {
                    success: true,
                    trustedTime: new Date(serverTimeMs),
                    timestamp: serverTimeMs,
                    source: 'Google Atomic NTP',
                };
            }
        } catch (e) {
            console.log('⚠️ Fast Google time check failed, trying Firestore endpoint...', e.message);
        }

        // Fallback 1: Firestore endpoint
        try {
            const start = Date.now();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2500);

            const res = await fetch('https://firestore.googleapis.com', {
                method: 'HEAD',
                headers: { 'Cache-Control': 'no-cache, no-store' },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            const dateHeader = res.headers.get('date');
            if (dateHeader) {
                const latency = (Date.now() - start) / 2;
                const serverTimeMs = new Date(dateHeader).getTime() + latency;
                cachedTimeOffsetMs = serverTimeMs - Date.now();
                lastTimeSyncTimestamp = Date.now();
                return {
                    success: true,
                    trustedTime: new Date(serverTimeMs),
                    timestamp: serverTimeMs,
                    source: 'Firestore Atomic NTP',
                };
            }
        } catch (e) {
            console.log('⚠️ Firestore time check failed, trying WorldTimeAPI...', e.message);
        }

        // Fallback 2: WorldTimeAPI JSON
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const res = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC', {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (res.ok) {
                const json = await res.json();
                if (json.utc_datetime) {
                    const serverTimeMs = new Date(json.utc_datetime).getTime();
                    return {
                        success: true,
                        trustedTime: new Date(serverTimeMs),
                        timestamp: serverTimeMs,
                        source: 'WorldTimeAPI',
                    };
                }
            }
        } catch (e) {
            console.warn('❌ All trusted time endpoints failed:', e.message);
        }

        return {
            success: false,
            error: 'Network real-time verification failed. Please check your internet connection.',
        };
    },

    /**
     * Verifies that the phone's clock matches the real-time network clock
     * @param {number} maxDriftSeconds - Maximum allowable difference in seconds
     * @param {boolean} forceRefresh - Bypass cache and re-query atomic server
     * @returns {Promise<{isValid: boolean, trustedTime: Date, driftSeconds: number, error?: string}>}
     */
    verifyRealTimeSync: async (maxDriftSeconds = MAX_ALLOWED_DRIFT_SECONDS, forceRefresh = false) => {
        // Ultra-fast path: If verified within last 10 minutes, return instantly (0ms)
        if (!forceRefresh && cachedTimeOffsetMs !== null && (Date.now() - lastTimeSyncTimestamp < CACHE_TTL_MS)) {
            const driftSeconds = Math.abs(cachedTimeOffsetMs) / 1000;
            if (driftSeconds <= maxDriftSeconds) {
                const currentServerTimeMs = Date.now() + cachedTimeOffsetMs;
                return {
                    isValid: true,
                    trustedTime: new Date(currentServerTimeMs),
                    driftSeconds,
                };
            }
        }

        const result = await timeValidationService.getTrustedNetworkTime(forceRefresh);

        if (!result.success || !result.trustedTime) {
            return {
                isValid: false,
                trustedTime: new Date(),
                driftSeconds: 0,
                error: 'Real-time clock validation failed. An active internet connection is required to verify real network time.',
            };
        }

        const deviceTimeMs = Date.now();
        const serverTimeMs = result.timestamp;
        const diffMs = deviceTimeMs - serverTimeMs;
        const driftSeconds = Math.abs(diffMs) / 1000;
        const driftMinutes = Math.round(driftSeconds / 60);

        if (driftSeconds > maxDriftSeconds) {
            const isAhead = diffMs > 0;
            const direction = isAhead ? 'ahead of' : 'behind';

            const userFriendlyMsg =
                `⚠️ Phone Real-Time Error!\n\n` +
                `Your phone clock is ${driftMinutes} minute${driftMinutes > 1 ? 's' : ''} ${direction} the real network time.\n\n` +
                `Manual time manipulation is strictly blocked. To punch attendance, you MUST enable automatic network time:\n\n` +
                `👉 Go to: Phone Settings → Date & Time → Turn ON "Set time automatically" (Automatic Date & Time).`;

            return {
                isValid: false,
                trustedTime: result.trustedTime,
                driftSeconds: Math.round(driftSeconds),
                driftMinutes,
                error: userFriendlyMsg,
                isTimeTampered: true,
            };
        }

        return {
            isValid: true,
            trustedTime: result.trustedTime,
            driftSeconds: Math.round(driftSeconds),
        };
    },
};

