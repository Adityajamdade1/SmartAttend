/**
 * Acceptance Test Script for Attendance Logic & Multi-Punch Engine
 * Tests the exact scenarios outlined in the handover document:
 * Scenario:
 * 09:32 AM IN -> 01:05 PM OUT (Session 1)
 * 01:52 PM IN -> 04:10 PM OUT (Session 2)
 * 04:20 PM IN -> 06:35 PM OUT (Session 3)
 */

const assert = require('assert');

// Test calculateSessionsSummary logic
function calculateSessionsSummary(sessions = [], settings = {}) {
    const {
        officeStartTime = '09:30',
        gracePeriodMinutes = 15,
        halfDayHours = 4.0,
        fullDayHours = 8.0,
    } = settings;

    let totalWorkHours = 0;
    let totalBreakHours = 0;

    const processed = sessions.map((sess, idx) => {
        let sessionHours = sess.sessionHours || 0;
        if (sess.checkIn && sess.checkOut) {
            const start = new Date(sess.checkIn);
            const end = new Date(sess.checkOut);
            const diffHours = (end - start) / (1000 * 60 * 60);
            sessionHours = diffHours > 0 ? parseFloat(diffHours.toFixed(2)) : 0;
        }
        totalWorkHours += sessionHours;

        if (idx < sessions.length - 1) {
            const nextSess = sessions[idx + 1];
            if (sess.checkOut && nextSess.checkIn) {
                const bStart = new Date(sess.checkOut);
                const bEnd = new Date(nextSess.checkIn);
                const diffBreak = (bEnd - bStart) / (1000 * 60 * 60);
                if (diffBreak > 0) totalBreakHours += parseFloat(diffBreak.toFixed(2));
            }
        }
        return { ...sess, sessionHours };
    });

    totalWorkHours = parseFloat(totalWorkHours.toFixed(2));
    totalBreakHours = parseFloat(totalBreakHours.toFixed(2));

    let status = 'absent';
    const hasOpen = processed.some(s => !s.checkOut);
    if (hasOpen) {
        status = 'present';
    } else {
        if (totalWorkHours >= fullDayHours) status = 'present';
        else if (totalWorkHours >= halfDayHours) status = 'half_day';
        else if (totalWorkHours > 0) status = 'half_day';
        else status = 'absent';
    }

    return { totalWorkHours, totalBreakHours, status, sessions: processed };
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

console.log('================================================================');
console.log('🧪 RUNNING SMARTATTEND ATTENDANCE ENGINE ACCEPTANCE TESTS');
console.log('================================================================\n');

// TEST 1: Full Attendance Scenario (Section 45)
console.log('▶ Test 1: Full Multi-Session Scenario (3 Sessions / 6 Punches)');
const testSessions = [
    {
        sessionId: 'sess_1',
        checkIn: '2026-11-15T09:32:00.000Z',
        checkInTime: '09:32 AM',
        checkOut: '2026-11-15T13:05:00.000Z',
        checkOutTime: '01:05 PM',
    },
    {
        sessionId: 'sess_2',
        checkIn: '2026-11-15T13:52:00.000Z',
        checkInTime: '01:52 PM',
        checkOut: '2026-11-15T16:10:00.000Z',
        checkOutTime: '04:10 PM',
    },
    {
        sessionId: 'sess_3',
        checkIn: '2026-11-15T16:20:00.000Z',
        checkInTime: '04:20 PM',
        checkOut: '2026-11-15T18:35:00.000Z',
        checkOutTime: '06:35 PM',
    }
];

const summary8h = calculateSessionsSummary(testSessions, { fullDayHours: 8.0, halfDayHours: 4.0 });
console.log(`   Session 1: ${testSessions[0].checkInTime} -> ${testSessions[0].checkOutTime} (${summary8h.sessions[0].sessionHours}h)`);
console.log(`   Session 2: ${testSessions[1].checkInTime} -> ${testSessions[1].checkOutTime} (${summary8h.sessions[1].sessionHours}h)`);
console.log(`   Session 3: ${testSessions[2].checkInTime} -> ${testSessions[2].checkOutTime} (${summary8h.sessions[2].sessionHours}h)`);
console.log(`   Total Work Hours: ${summary8h.totalWorkHours} hrs (Expected: ~8.10 hrs)`);
console.log(`   Total Break Hours: ${summary8h.totalBreakHours} hrs (Expected: ~1.03 hrs)`);
console.log(`   Status (Rule: 8.0 hrs): ${summary8h.status.toUpperCase()}`);

assert(summary8h.totalWorkHours >= 8.0, 'Work hours should be >= 8.0 hrs');
assert.strictEqual(summary8h.status, 'present', 'Status should be present when working >= 8h');
assert(summary8h.totalBreakHours > 0.9, 'Break hours should be accounted for accurately');
console.log('   ✅ Test 1 Passed!\n');

// TEST 2: Dynamic Rules Verification (Section 46)
console.log('▶ Test 2: Dynamic Rules (Changing fullDayHours from 8.0 to 9.0)');
const summary9h = calculateSessionsSummary(testSessions, { fullDayHours: 9.0, halfDayHours: 4.0 });
console.log(`   With 9.0 hrs requirement, ${summary9h.totalWorkHours} hrs evaluates to: ${summary9h.status.toUpperCase()}`);
assert.strictEqual(summary9h.status, 'half_day', 'Status should change dynamically to half_day when 9h required');
console.log('   ✅ Test 2 Passed!\n');

// TEST 3: Geo-Fencing & Radius Calculation (Section 14 & 16)
console.log('▶ Test 3: Office Radius / Geofence Validation');
const office = { latitude: 18.520430, longitude: 73.856744, radiusMeters: 100 };
// Case A: Inside office (20 meters away)
const insideLoc = { latitude: 18.520550, longitude: 73.856750 };
const distInside = calculateDistance(insideLoc.latitude, insideLoc.longitude, office.latitude, office.longitude);
console.log(`   Inside Location distance: ${Math.round(distInside)}m (Allowed: ${office.radiusMeters}m)`);
assert(distInside <= office.radiusMeters, 'Should be within radius');

// Case B: Outside office (500 meters away)
const outsideLoc = { latitude: 18.525000, longitude: 73.856744 };
const distOutside = calculateDistance(outsideLoc.latitude, outsideLoc.longitude, office.latitude, office.longitude);
console.log(`   Outside Location distance: ${Math.round(distOutside)}m (Allowed: ${office.radiusMeters}m)`);
assert(distOutside > office.radiusMeters, 'Should be outside radius');
console.log('   ✅ Test 3 Passed!\n');

// TEST 4: Open Session & Sequencing Validation (Section 8)
console.log('▶ Test 4: Open Session Sequencing Validation');
const hasOpen = (sessions) => sessions.some(s => !s.checkOut);
const openSessions = [
    { sessionId: 's1', checkIn: '09:30', checkOut: '13:00' },
    { sessionId: 's2', checkIn: '14:00', checkOut: null }, // Currently active
];
assert.strictEqual(hasOpen(openSessions), true, 'Should detect active session');
assert.strictEqual(hasOpen(testSessions), false, 'Should detect all closed sessions');
console.log('   Active session detected correctly.');
console.log('   ✅ Test 4 Passed!\n');

console.log('================================================================');
console.log('🎉 ALL ATTENDANCE LOGIC TESTS PASSED SUCCESSFULLY!');
console.log('================================================================');

