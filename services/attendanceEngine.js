import { db } from './firebaseConfig';
import { getAttendanceSettings } from './attendanceConfigService';
import { timeValidationService } from './timeValidationService';
import {
    formatDate,
    formatTime,
    calculateDistance,
    calculateSessionsSummary,
    isOpenSession,
    getActiveSession
} from '../utils/attendance';

// Concurrency Locks to prevent double-tap / duplicate punch race conditions
const activeLocks = new Set();

export const attendanceEngine = {
    /**
     * Get active attendance record for a user today
     * @param {string} userId - User UID
     * @param {string} companyId - Company ID
     * @param {string} targetDate - Optional date (defaults to today YYYY-MM-DD)
     */
    getTodayRecord: async (userId, companyId = null, targetDate = null) => {
        try {
            const today = targetDate || formatDate(new Date());
            const docId = `att_${userId}_${today}`;
            const docSnap = await db.collection('attendance').doc(docId).get();

            if (docSnap.exists) {
                const data = docSnap.data();
                return {
                    exists: true,
                    data: normalizeRecord(data),
                };
            }

            // Direct doc lookup succeeded and confirms no punch exists yet today (instant response)
            return { exists: false, data: null };
        } catch (error) {
            console.error('Error fetching today attendance record:', error);
            return { exists: false, data: null, error: error.message };
        }
    },

    /**
     * Validate whether a punch can be performed based on business rules
     */
    validatePunch: ({ user, action, mode = 'OFFICE', location, wifiSSID, faceVerified, settings, todayRecord }) => {
        const isWFH = mode === 'WFH';
        const hasOpen = isOpenSession(todayRecord);

        // 1. Session Sequencing Validation
        if (action === 'check-in') {
            if (hasOpen) {
                const active = getActiveSession(todayRecord);
                const inTime = active?.checkInTime || 'earlier';
                return {
                    valid: false,
                    reason: `You already have an active Punch In session (started at ${inTime}). Please Punch Out before Punching In again.`,
                };
            }
        } else if (action === 'check-out') {
            if (!hasOpen) {
                return {
                    valid: false,
                    reason: 'No active Punch In session found. Please Punch In first.',
                };
            }
        } else {
            return { valid: false, reason: 'Invalid punch action.' };
        }

        // 2. WFH Policy Check
        if (isWFH && settings.allowWFH === false) {
            return {
                valid: false,
                reason: 'Work From Home (WFH) attendance is disabled by company policy.',
            };
        }

        // 3. Location Validation (Mandatory for Office punches when locationRequired is true)
        if (!isWFH && settings.locationRequired) {
            if (!location || location.latitude === undefined || location.longitude === undefined) {
                return {
                    valid: false,
                    reason: 'Valid GPS location is required before punch can be recorded. Please ensure location services are enabled and permissions are granted.',
                };
            }

            // Check Geofence / Office Radius
            const officeLoc = settings.officeLocation;
            if (officeLoc && officeLoc.latitude && officeLoc.longitude) {
                const distance = calculateDistance(
                    location.latitude,
                    location.longitude,
                    officeLoc.latitude,
                    officeLoc.longitude
                );
                const allowedRadius = Number(officeLoc.radiusMeters) > 0 ? Number(officeLoc.radiusMeters) : 100;
                const accuracyBuffer = location.accuracy ? Math.min(location.accuracy, 50) : 0;
                const effectiveDistance = Math.max(0, distance - accuracyBuffer);

                if (effectiveDistance > allowedRadius) {
                    return {
                        valid: false,
                        reason: `You are outside the allowed office location.\nCurrent distance: ${Math.round(distance)}m from office (Allowed: within ${allowedRadius}m).`,
                        distance: Math.round(distance),
                        allowedRadius,
                    };
                }
            }
        }

        // 4. WiFi Validation (if enabled)
        if (!isWFH && settings.wifiRequired) {
            const allowed = settings.allowedWifiSSIDs || [];
            if (allowed.length > 0) {
                if (!wifiSSID || !allowed.some(s => s.toLowerCase() === String(wifiSSID).toLowerCase())) {
                    return {
                        valid: false,
                        reason: `WiFi validation failed. You must be connected to an authorized office WiFi network (${allowed.join(', ')}).`,
                    };
                }
            }
        }

        // 5. Face Recognition / Biometric Validation
        if (settings.faceRecognitionRequired && !faceVerified) {
            return {
                valid: false,
                reason: 'Face verification failed. Mandatory biometric validation is required.',
            };
        }

        return { valid: true };
    },

    /**
     * Atomically Record Punch In or Punch Out
     * PRESERVES all previous punch events and sessions!
     */
    recordPunch: async ({
        user,
        action, // 'check-in' or 'check-out'
        mode = 'OFFICE', // 'OFFICE' or 'WFH'
        location = null,
        wifiSSID = null,
        faceVerified = false,
        photoData = null,
        customSettings = null,
    }) => {
        const lockKey = `${user.uid}_punch_lock`;

        // 1. Double-Tap / Duplicate Punch Protection (Mutex Lock)
        if (activeLocks.has(lockKey)) {
            console.warn(`⚠️ Blocked concurrent punch request for ${user.uid}`);
            return {
                success: false,
                error: 'A punch request is already in progress. Please wait a moment.',
            };
        }

        activeLocks.add(lockKey);

        try {
            // 2. Real-Time Network Clock Validation (Anti-Tampering Enforcement)
            const timeCheck = await timeValidationService.verifyRealTimeSync();
            if (!timeCheck.isValid) {
                return {
                    success: false,
                    error: timeCheck.error,
                    isTimeTampered: Boolean(timeCheck.isTimeTampered),
                };
            }

            // Always use trusted atomic server clock time for punch recording & calculations
            const now = timeCheck.trustedTime;
            const nowISO = now.toISOString();
            const today = formatDate(now);
            const timeStr = formatTime(now);

            // Fetch active attendance rules
            const settings = customSettings || await getAttendanceSettings(user.companyId);

            // Fetch existing today's record
            const { exists, data: existingRecord } = await attendanceEngine.getTodayRecord(user.uid, user.companyId, today);

            // Perform business rule validation
            const validation = attendanceEngine.validatePunch({
                user,
                action,
                mode,
                location,
                wifiSSID,
                faceVerified,
                settings,
                todayRecord: existingRecord,
            });

            if (!validation.valid) {
                return { success: false, error: validation.reason, details: validation };
            }

            const docId = existingRecord?.id || `att_${user.uid}_${today}`;
            let sessions = Array.isArray(existingRecord?.sessions) ? [...existingRecord.sessions] : [];
            let punches = Array.isArray(existingRecord?.punches) ? [...existingRecord.punches] : [];

            const sanitizedLocation = location ? {
                latitude: Number(location.latitude) || 0,
                longitude: Number(location.longitude) || 0,
                accuracy: Number(location.accuracy) || 0,
                locationValid: true,
                capturedAt: nowISO,
                address: location.address || (mode === 'WFH' ? 'Work From Home' : 'Office Location'),
            } : null;

            let updatedRecord;
            let currentSessionNumber;

            if (action === 'check-in') {
                // ==================== PUNCH IN ====================
                const newSession = {
                    sessionId: `sess_${Date.now()}`,
                    checkIn: nowISO,
                    checkInTime: timeStr,
                    checkOut: null,
                    checkOutTime: null,
                    sessionHours: 0,
                    location: sanitizedLocation,
                    checkinLocation: sanitizedLocation,
                    attendanceMode: mode,
                    validations: {
                        faceVerified: Boolean(faceVerified),
                        locationVerified: Boolean(sanitizedLocation),
                        wifiVerified: Boolean(wifiSSID),
                        photoCaptured: Boolean(photoData),
                    },
                    photoRef: photoData || null,
                    checkinPhotoRef: photoData || null,
                };

                sessions.push(newSession);
                currentSessionNumber = sessions.length;

                // Immutable punch audit trail
                punches.push({
                    punchId: `punch_${Date.now()}`,
                    type: 'IN',
                    sessionIndex: sessions.length - 1,
                    timestamp: nowISO,
                    time: timeStr,
                    location: sanitizedLocation,
                    attendanceMode: mode,
                    faceVerified: Boolean(faceVerified),
                    wifiVerified: Boolean(wifiSSID),
                });

                const summary = calculateSessionsSummary(sessions, settings);

                updatedRecord = {
                    id: docId,
                    userId: user.uid,
                    employeeId: user.employeeId || 'N/A',
                    employeeName: user.name || 'Employee',
                    companyId: user.companyId || 'default',
                    department: user.department || 'General',
                    date: today,
                    currentStatus: 'IN',
                    activeSessionId: newSession.sessionId,
                    firstCheckIn: sessions[0].checkIn,
                    firstCheckInTime: sessions[0].checkInTime,
                    lastCheckIn: nowISO,
                    lastCheckInTime: timeStr,
                    checkIn: nowISO,
                    checkInTime: timeStr,
                    checkOut: null,
                    checkOutTime: null,
                    sessions,
                    punches,
                    totalWorkHours: summary.totalWorkHours,
                    workHours: summary.totalWorkHours,
                    totalBreakHours: summary.totalBreakHours,
                    breakHours: summary.totalBreakHours,
                    status: summary.status,
                    isLate: summary.isLate,
                    lateMinutes: summary.lateMinutes,
                    attendanceMode: mode,
                    location: sanitizedLocation,
                    faceVerified: Boolean(faceVerified),
                    wifiVerified: Boolean(wifiSSID),
                    createdAt: existingRecord?.createdAt || nowISO,
                    updatedAt: nowISO,
                };

            } else {
                // ==================== PUNCH OUT ====================
                const openIndex = sessions.findIndex(s => !s.checkOut);
                if (openIndex === -1) {
                    throw new Error('No open session found to check out.');
                }

                const openSession = sessions[openIndex];
                const start = new Date(openSession.checkIn);
                const sessionHours = (now - start) / (1000 * 60 * 60);

                sessions[openIndex] = {
                    ...openSession,
                    checkOut: nowISO,
                    checkOutTime: timeStr,
                    sessionHours: parseFloat(Math.max(0, sessionHours).toFixed(2)),
                    checkoutLocation: sanitizedLocation,
                    checkoutValidations: {
                        faceVerified: Boolean(faceVerified),
                        locationVerified: Boolean(sanitizedLocation),
                        wifiVerified: Boolean(wifiSSID),
                        photoCaptured: Boolean(photoData),
                    },
                    checkoutPhotoRef: photoData || null,
                };

                currentSessionNumber = openIndex + 1;

                // Immutable punch audit trail
                punches.push({
                    punchId: `punch_${Date.now()}`,
                    type: 'OUT',
                    sessionIndex: openIndex,
                    timestamp: nowISO,
                    time: timeStr,
                    location: sanitizedLocation,
                    sessionHours: sessions[openIndex].sessionHours,
                    attendanceMode: mode,
                });

                const summary = calculateSessionsSummary(sessions, settings);

                updatedRecord = {
                    ...existingRecord,
                    id: docId,
                    userId: user.uid,
                    employeeId: user.employeeId || 'N/A',
                    employeeName: user.name || 'Employee',
                    companyId: user.companyId || 'default',
                    department: user.department || 'General',
                    date: today,
                    currentStatus: 'OUT',
                    activeSessionId: null,
                    firstCheckIn: sessions[0].checkIn,
                    firstCheckInTime: sessions[0].checkInTime,
                    lastCheckOut: nowISO,
                    lastCheckOutTime: timeStr,
                    checkOut: nowISO,
                    checkOutTime: timeStr,
                    sessions,
                    punches,
                    totalWorkHours: summary.totalWorkHours,
                    workHours: summary.totalWorkHours,
                    totalBreakHours: summary.totalBreakHours,
                    breakHours: summary.totalBreakHours,
                    status: summary.status,
                    isLate: summary.isLate,
                    lateMinutes: summary.lateMinutes,
                    attendanceMode: mode,
                    checkoutLocation: sanitizedLocation,
                    updatedAt: nowISO,
                };
            }

            // Save atomic attendance document
            await db.collection('attendance').doc(docId).set(updatedRecord);

            // Record immutable audit event in background (non-blocking for instant response)
            const eventId = `event_${user.uid}_${Date.now()}`;
            db.collection('attendance_events').doc(eventId).set({
                id: eventId,
                userId: user.uid,
                employeeId: user.employeeId || 'N/A',
                employeeName: user.name || 'Employee',
                companyId: user.companyId || 'default',
                date: today,
                type: action === 'check-in' ? 'IN' : 'OUT',
                timestamp: nowISO,
                time: timeStr,
                sessionIndex: currentSessionNumber - 1,
                location: sanitizedLocation,
                attendanceMode: mode,
                faceVerified: Boolean(faceVerified),
                wifiVerified: Boolean(wifiSSID),
                createdAt: nowISO,
            }).catch(eventErr => {
                console.warn('⚠️ Could not save event log (non-critical):', eventErr);
            });

            console.log(`✅ Attendance punch recorded: ${action.toUpperCase()} session #${currentSessionNumber}`);

            return {
                success: true,
                record: updatedRecord,
                sessionNumber: currentSessionNumber,
                action,
                time: timeStr,
                totalWorkHours: updatedRecord.totalWorkHours,
                totalBreakHours: updatedRecord.totalBreakHours,
                status: updatedRecord.status,
            };
        } catch (error) {
            console.error('❌ Error recording attendance punch:', error);
            return {
                success: false,
                error: error.message || 'Unable to record attendance. Please try again.',
            };
        } finally {
            activeLocks.delete(lockKey);
        }
    }
};

/**
 * Normalizes legacy records so that sessions and punches arrays are always valid arrays
 */
function normalizeRecord(data) {
    if (!data) return null;

    let sessions = Array.isArray(data.sessions) ? data.sessions : [];
    let punches = Array.isArray(data.punches) ? data.punches : [];

    // Synthesize session if record has legacy checkIn/checkOut but no sessions array
    if (sessions.length === 0 && data.checkIn) {
        sessions = [{
            sessionId: 'sess_legacy',
            checkIn: data.checkIn,
            checkInTime: data.checkInTime || formatTime(new Date(data.checkIn)),
            checkOut: data.checkOut || null,
            checkOutTime: data.checkOutTime || (data.checkOut ? formatTime(new Date(data.checkOut)) : null),
            sessionHours: data.workHours || 0,
            location: data.location || null,
            checkoutLocation: data.checkoutLocation || null,
        }];
    }

    const hasOpen = sessions.some(s => !s.checkOut);

    return {
        ...data,
        sessions,
        punches,
        currentStatus: data.currentStatus || (hasOpen ? 'IN' : (data.checkOut ? 'OUT' : 'NOT_MARKED')),
        totalWorkHours: data.totalWorkHours !== undefined ? data.totalWorkHours : (data.workHours || 0),
        totalBreakHours: data.totalBreakHours !== undefined ? data.totalBreakHours : (data.breakHours || 0),
    };
}

