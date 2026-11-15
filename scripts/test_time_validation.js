const assert = require('assert');

function simulateTimeSyncCheck(deviceTimeMs, serverTimeMs, maxAllowedDriftSeconds = 120) {
    const diffMs = deviceTimeMs - serverTimeMs;
    const driftSeconds = Math.abs(diffMs) / 1000;
    const driftMinutes = Math.round(driftSeconds / 60);

    if (driftSeconds > maxAllowedDriftSeconds) {
        const isAhead = diffMs > 0;
        const direction = isAhead ? 'ahead of' : 'behind';

        const userFriendlyMsg =
            `⚠️ Phone Real-Time Error!\n\n` +
            `Your phone clock is ${driftMinutes} minute${driftMinutes > 1 ? 's' : ''} ${direction} the real network time.\n\n` +
            `Manual time manipulation is strictly blocked. To punch attendance, you MUST enable automatic network time:\n\n` +
            `👉 Go to: Phone Settings → Date & Time → Turn ON "Set time automatically" (Automatic Date & Time).`;

        return {
            isValid: false,
            trustedTime: new Date(serverTimeMs),
            driftSeconds: Math.round(driftSeconds),
            driftMinutes,
            error: userFriendlyMsg,
            isTimeTampered: true,
        };
    }

    return {
        isValid: true,
        trustedTime: new Date(serverTimeMs),
        driftSeconds: Math.round(driftSeconds),
    };
}

console.log('================================================================');
console.log('🧪 RUNNING ANTI-TAMPER REAL-TIME NETWORK CLOCK TESTS');
console.log('================================================================\n');

const trueServerTime = 1794695000000; // Reference atomic server time

// Test 1: Phone is on Automatic Network Time (synced within 5 seconds)
console.log('▶ Test 1: Phone on Automatic Time (5 seconds difference)');
const normalPhoneTime = trueServerTime + 5000; // 5s difference
const res1 = simulateTimeSyncCheck(normalPhoneTime, trueServerTime);
console.log('   Result valid:', res1.isValid);
assert.strictEqual(res1.isValid, true, 'Synchronized clock should be accepted');
console.log('   ✅ Test 1 Passed!\n');

// Test 2: Employee manually changes phone clock forward by 1 hour (Fake late Punch Out)
console.log('▶ Test 2: Employee turns off automatic time and moves clock forward by 60 mins');
const manipulatedAheadTime = trueServerTime + (60 * 60 * 1000); // 1 hour ahead
const res2 = simulateTimeSyncCheck(manipulatedAheadTime, trueServerTime);
console.log('   Result valid:', res2.isValid);
console.log('   Drift detected:', res2.driftMinutes, 'minutes');
console.log('   Tamper detected:', res2.isTimeTampered);
assert.strictEqual(res2.isValid, false, 'Manipulated clock ahead should be BLOCKED');
assert.strictEqual(res2.isTimeTampered, true, 'Tamper flag must be true');
assert.strictEqual(res2.driftMinutes, 60, 'Should detect exactly 60 minutes drift');
console.log('   Error displayed to user:\n', res2.error);
console.log('   ✅ Test 2 Passed!\n');

// Test 3: Employee manually changes phone clock backward by 30 mins (Fake early Punch In)
console.log('▶ Test 3: Employee turns off automatic time and moves clock backward by 30 mins');
const manipulatedBehindTime = trueServerTime - (30 * 60 * 1000); // 30 mins behind
const res3 = simulateTimeSyncCheck(manipulatedBehindTime, trueServerTime);
console.log('   Result valid:', res3.isValid);
console.log('   Drift detected:', res3.driftMinutes, 'minutes');
console.log('   Tamper detected:', res3.isTimeTampered);
assert.strictEqual(res3.isValid, false, 'Manipulated clock behind should be BLOCKED');
assert.strictEqual(res3.isTimeTampered, true, 'Tamper flag must be true');
assert.strictEqual(res3.driftMinutes, 30, 'Should detect exactly 30 minutes drift');
console.log('   Error displayed to user:\n', res3.error);
console.log('   ✅ Test 3 Passed!\n');

console.log('================================================================');
console.log('🎉 ALL REAL-TIME ANTI-TAMPER TESTS PASSED SUCCESSFULLY!');
console.log('================================================================');

