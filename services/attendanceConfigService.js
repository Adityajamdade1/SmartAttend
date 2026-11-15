import { db } from './firebaseConfig.js';

/**
 * Default Attendance Configuration
 * Used when company has not customized settings yet.
 */
export const DEFAULT_ATTENDANCE_SETTINGS = {
    officeStartTime: '09:30',        // HH:mm (24hr format or standard)
    officeEndTime: '18:30',          // HH:mm
    breakStartTime: '13:00',         // HH:mm
    breakEndTime: '14:00',           // HH:mm
    fullDayHours: 8.0,               // Total required hours for full day
    halfDayHours: 4.0,               // Minimum required hours for half day
    gracePeriodMinutes: 15,          // Grace period for late mark (e.g. 15 mins -> 09:45 AM)
    lateMarkThresholdMinutes: 30,    // Minutes after grace period before severe late penalty
    earlyCheckoutThresholdMinutes: 30, // Checkout before officeEndTime - threshold is early
    
    // Geo-Fence & Location Rules
    locationRequired: false,          // Mandatory location validation when configured by admin
    officeLocation: null,             // Configured per company via Admin Panel

    // WiFi Rules
    wifiRequired: false,             // Mandatory WiFi validation
    allowedWifiSSIDs: [],            // Array of allowed WiFi network names (SSIDs)

    // Biometric & Mode Rules
    faceRecognitionRequired: true,   // Mandatory face verification
    allowWFH: true,                  // Can employee toggle WFH mode
    maxPunchesPerDay: 0,             // 0 = unlimited punches allowed
};

/**
 * Fetch active attendance settings for a company or default
 * @param {string} companyId - Optional company ID
 * @returns {Promise<Object>} Active configuration object
 */
export const getAttendanceSettings = async (companyId = null) => {
    try {
        // 1. Try company-specific attendance settings first
        if (companyId && companyId !== 'default') {
            const companySettingsDoc = await db.collection('attendance_settings').doc(`settings_${companyId}`).get();
            if (companySettingsDoc.exists) {
                const data = companySettingsDoc.data();
                return sanitizeSettings({ ...DEFAULT_ATTENDANCE_SETTINGS, ...data, companyId });
            }

            // Fallback: check company document itself
            const companyDoc = await db.collection('companies').doc(companyId).get();
            if (companyDoc.exists) {
                const compData = companyDoc.data();
                if (compData.attendanceSettings) {
                    return sanitizeSettings({ ...DEFAULT_ATTENDANCE_SETTINGS, ...compData.attendanceSettings, companyId });
                }
                if (compData.officeLocation) {
                    return sanitizeSettings({
                        ...DEFAULT_ATTENDANCE_SETTINGS,
                        officeLocation: compData.officeLocation,
                        locationRequired: Boolean(compData.locationRequired),
                        companyId,
                    });
                }
            }

            // Fresh unconfigured company: return isolated defaults (no cross-company pollution)
            return { ...DEFAULT_ATTENDANCE_SETTINGS, companyId };
        }

        // 2. Try global office_settings/settings_default
        const defaultDoc = await db.collection('office_settings').doc('settings_default').get();
        if (defaultDoc.exists) {
            const data = defaultDoc.data();
            return sanitizeSettings({ ...DEFAULT_ATTENDANCE_SETTINGS, ...data });
        }

        // 3. Fallback to hard defaults
        return { ...DEFAULT_ATTENDANCE_SETTINGS };
    } catch (error) {
        console.error('⚠️ Error fetching attendance settings, using defaults:', error);
        return { ...DEFAULT_ATTENDANCE_SETTINGS };
    }
};

/**
 * Save or update attendance settings for a company or global
 * @param {string} companyId - Company ID or 'default'
 * @param {Object} newSettings - Partial or complete settings object
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const saveAttendanceSettings = async (companyId, newSettings) => {
    try {
        const sanitized = sanitizeSettings(newSettings);
        const isGlobal = !companyId || companyId === 'default';
        const docId = isGlobal ? 'settings_default' : `settings_${companyId}`;

        // Save isolated settings to attendance_settings
        await db.collection('attendance_settings').doc(docId).set({
            ...sanitized,
            companyId: isGlobal ? 'default' : companyId,
            updatedAt: new Date().toISOString(),
        });

        // Also sync directly to company document so company holds its own location & rules
        if (!isGlobal) {
            try {
                await db.collection('companies').doc(companyId).update({
                    officeLocation: sanitized.officeLocation,
                    locationRequired: sanitized.locationRequired,
                    attendanceSettings: sanitized,
                    updatedAt: new Date().toISOString(),
                });
            } catch (compErr) {
                console.log('Company doc sync note:', compErr.message);
            }
        } else {
            // Also sync to office_settings for backwards compatibility
            await db.collection('office_settings').doc('settings_default').set({
                ...sanitized,
                updatedAt: new Date().toISOString(),
            });
        }

        console.log(`✅ Saved attendance settings for ${docId}`);
        return { success: true };
    } catch (error) {
        console.error('❌ Error saving attendance settings:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Ensure all values are correctly typed numbers/strings/booleans
 */
function sanitizeSettings(settings) {
    return {
        officeStartTime: String(settings.officeStartTime || '09:30').trim(),
        officeEndTime: String(settings.officeEndTime || '18:30').trim(),
        breakStartTime: String(settings.breakStartTime || '13:00').trim(),
        breakEndTime: String(settings.breakEndTime || '14:00').trim(),
        fullDayHours: Number(settings.fullDayHours) > 0 ? Number(settings.fullDayHours) : 8.0,
        halfDayHours: Number(settings.halfDayHours) > 0 ? Number(settings.halfDayHours) : 4.0,
        gracePeriodMinutes: Number(settings.gracePeriodMinutes) >= 0 ? Number(settings.gracePeriodMinutes) : 15,
        lateMarkThresholdMinutes: Number(settings.lateMarkThresholdMinutes) >= 0 ? Number(settings.lateMarkThresholdMinutes) : 30,
        earlyCheckoutThresholdMinutes: Number(settings.earlyCheckoutThresholdMinutes) >= 0 ? Number(settings.earlyCheckoutThresholdMinutes) : 30,
        locationRequired: Boolean(settings.locationRequired),
        officeLocation: (settings.officeLocation && Number(settings.officeLocation.latitude)) ? {
            latitude: Number(settings.officeLocation.latitude),
            longitude: Number(settings.officeLocation.longitude),
            radiusMeters: Number(settings.officeLocation.radiusMeters) > 0 ? Number(settings.officeLocation.radiusMeters) : 100,
            address: String(settings.officeLocation.address || 'Office Location').trim(),
        } : null,
        wifiRequired: Boolean(settings.wifiRequired),
        allowedWifiSSIDs: Array.isArray(settings.allowedWifiSSIDs) ? settings.allowedWifiSSIDs : [],
        faceRecognitionRequired: settings.faceRecognitionRequired !== false,
        allowWFH: settings.allowWFH !== false,
        maxPunchesPerDay: Number(settings.maxPunchesPerDay) >= 0 ? Number(settings.maxPunchesPerDay) : 0,
    };
}

