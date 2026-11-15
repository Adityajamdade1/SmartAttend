import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
    ActivityIndicator,
    Alert,
    StatusBar,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import NetInfo from '@react-native-community/netinfo';

import { useAuth } from '../context/AuthContext';
import { faceApiService } from '../services/faceApiService';
import { attendanceEngine } from '../services/attendanceEngine';
import { getAttendanceSettings } from '../services/attendanceConfigService';
import { timeValidationService } from '../services/timeValidationService';
import { faceDetectorSettings } from '../utils/faceRecognition';
import { calculateDistance, isOpenSession, getActiveSession } from '../utils/attendance';

function formatDistance(m) {
    if (m === null || m === undefined) return '';
    if (m >= 1000) {
        return `${(m / 1000).toFixed(1)} km`;
    }
    return `${Math.round(m)}m`;
}

export default function RealTimeFaceScanScreen({ navigation, route }) {
    const insets = useSafeAreaInsets();
    const { user } = useAuth();
    const { action, onSuccess, isWFH } = route.params || {};
    const [permission, requestPermission] = useCameraPermissions();
    const cameraRef = useRef(null);

    // State
    const [facing, setFacing] = useState('front');
    const [cameraReady, setCameraReady] = useState(false);
    const [processing, setProcessing] = useState(false);
    const [currentAction, setCurrentAction] = useState(action || 'check-in');
    const [activeSessionInfo, setActiveSessionInfo] = useState(null);
    const [location, setLocation] = useState(null);
    const [locationLoading, setLocationLoading] = useState(true);
    const [locationError, setLocationError] = useState(null);
    const [officeSettings, setOfficeSettings] = useState(null);
    const [officeDistance, setOfficeDistance] = useState(null);
    const [faceData, setFaceData] = useState(null);
    const [isFaceAligned, setIsFaceAligned] = useState(false);
    const [errorMessage, setErrorMessage] = useState(null);

    const toggleCameraFacing = () => {
        setFacing(prev => (prev === 'front' ? 'back' : 'front'));
    };

    // Auto-detect whether employee has an active open session
    const syncAttendanceState = useCallback(async () => {
        if (!user?.uid) return;
        try {
            const { exists, data } = await attendanceEngine.getTodayRecord(user.uid, user.companyId);
            if (exists && data) {
                const hasOpen = isOpenSession(data);
                const active = getActiveSession(data);
                if (hasOpen) {
                    setCurrentAction('check-out');
                    setActiveSessionInfo(active?.checkInTime || data.checkInTime || 'earlier');
                } else {
                    setCurrentAction('check-in');
                    setActiveSessionInfo(null);
                }
            } else {
                setCurrentAction('check-in');
                setActiveSessionInfo(null);
            }
        } catch (_e) {
            // Keep default action if offline
        }
    }, [user?.companyId, user?.uid]);

    useEffect(() => {
        syncAttendanceState();
    }, [syncAttendanceState]);

    const clockVerifiedRef = useRef(false);

    const handleGoBack = useCallback(() => {
        try {
            if (navigation.canGoBack()) {
                navigation.goBack();
            } else {
                navigation.navigate('Dashboard');
            }
        } catch (_e) {
            navigation.navigate('Dashboard');
        }
    }, [navigation]);

    const checkTimeSync = useCallback(async () => {
        try {
            const timeCheck = await timeValidationService.verifyRealTimeSync();
            if (!timeCheck.isValid) {
                clockVerifiedRef.current = false;
                Alert.alert(
                    'Automatic Time Required ⚠️',
                    timeCheck.error,
                    [{ text: 'Go Back', onPress: handleGoBack }]
                );
            } else {
                clockVerifiedRef.current = true;
            }
        } catch (e) {
            console.warn('Time check error:', e);
            clockVerifiedRef.current = true;
        }
    }, [handleGoBack]);

    useEffect(() => {
        checkTimeSync();
    }, [checkTimeSync]);

    const loadOfficeSettings = useCallback(async () => {
        try {
            const settings = await getAttendanceSettings(user?.companyId);
            setOfficeSettings(settings);
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }, [user?.companyId]);

    const fetchAccurateLocation = useCallback(async () => {
        try {
            setLocationLoading(true);
            setLocationError(null);

            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status !== 'granted') {
                const permMsg = 'Location permission denied. Please allow location access in app settings.';
                setLocationError(permMsg);
                setLocationLoading(false);
                return null;
            }

            // Check if device Location / GPS service is turned ON
            const isServicesEnabled = await Location.hasServicesEnabledAsync();
            if (!isServicesEnabled) {
                // Prompt Android system dialog to turn on GPS automatically
                try {
                    await Location.enableNetworkProviderAsync();
                } catch (_providerErr) {
                    // User dismissed or provider not available
                }

                // Check again after prompt
                const checkAgain = await Location.hasServicesEnabledAsync();
                if (!checkAgain) {
                    const gpsOffMsg = 'Location (GPS) is turned OFF. Please turn ON Location.';
                    setLocationError(gpsOffMsg);
                    setLocationLoading(false);
                    Alert.alert(
                        'Location (GPS) is Turned OFF 📍',
                        'To mark attendance, your phone\'s Location (GPS) must be turned ON.\n\nPlease turn ON Location from your quick notification panel or phone settings, then tap Retry.',
                        [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Turn ON & Retry', onPress: () => fetchAccurateLocation() }
                        ]
                    );
                    return null;
                }
            }

            let pos = null;
            try {
                pos = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                });
            } catch (_curErr) {
                try {
                    pos = await Location.getLastKnownPositionAsync();
                } catch (_lastErr) {
                    pos = null;
                }
            }

            if (!pos?.coords) {
                throw new Error('Unable to retrieve GPS coordinates. Please ensure Location is turned ON.');
            }

            let addressText = `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;
            let addressComponents = {};

            try {
                const geocodes = await Location.reverseGeocodeAsync({
                    latitude: pos.coords.latitude,
                    longitude: pos.coords.longitude,
                });
                if (geocodes && geocodes.length > 0) {
                    const g = geocodes[0];
                    addressComponents = g;
                    const parts = [
                        g.name && !g.name.includes('+') ? g.name : null,
                        g.streetNumber,
                        g.street,
                        g.district || g.subregion,
                        g.city,
                        g.region,
                        g.postalCode,
                        g.country,
                    ].filter(Boolean);
                    const uniqueParts = [...new Set(parts)];
                    if (uniqueParts.length > 0) addressText = uniqueParts.join(', ');
                }
            } catch (_e) {
                // Coordinate string is preserved
            }

            const locObj = {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
                timestamp: new Date().toISOString(),
                address: addressText,
                addressComponents,
            };

            setLocation(locObj);
            setLocationLoading(false);
            setLocationError(null);
            return locObj;
        } catch (err) {
            console.log('Location acquisition notice:', err?.message);
            const isSettingsError = err?.message?.toLowerCase().includes('unsatisfied device settings') ||
                                    err?.message?.toLowerCase().includes('disabled') ||
                                    err?.message?.toLowerCase().includes('turned off');
            const errorMsg = isSettingsError
                ? 'Location (GPS) is turned OFF. Please turn ON Location.'
                : 'Location unavailable. Tap to retry.';
            setLocationError(errorMsg);
            setLocationLoading(false);

            if (isSettingsError) {
                Alert.alert(
                    'Location (GPS) is Turned OFF 📍',
                    'Please turn ON Location in your phone settings or quick toggle panel to verify your attendance.',
                    [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Turn ON & Retry', onPress: () => fetchAccurateLocation() }
                    ]
                );
            }
            return null;
        }
    }, []);

    useEffect(() => {
        if (!permission) {
            requestPermission();
        }
        fetchAccurateLocation();
        loadOfficeSettings();
    }, [permission, requestPermission, fetchAccurateLocation, loadOfficeSettings]);

    // Calculate live distance to office
    useEffect(() => {
        if (location?.latitude && officeSettings?.officeLocation?.latitude) {
            const d = calculateDistance(
                location.latitude,
                location.longitude,
                officeSettings.officeLocation.latitude,
                officeSettings.officeLocation.longitude
            );
            setOfficeDistance(Math.round(d));
        } else {
            setOfficeDistance(null);
        }
    }, [location, officeSettings]);

    const handleFacesDetected = ({ faces }) => {
        if (processing) return;

        if (!faces || faces.length === 0) {
            setFaceData(null);
            setIsFaceAligned(false);
            setErrorMessage(null);
            return;
        }

        const face = faces[0];
        setFaceData(face);

        if (faces.length > 1) {
            setIsFaceAligned(false);
            setErrorMessage('Multiple faces detected!');
            return;
        }

        const faceWidth = face.bounds?.size?.width || 0;
        const MIN_FACE_SIZE = 80;

        if (faceWidth >= MIN_FACE_SIZE) {
            if (!isFaceAligned) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }
            setIsFaceAligned(true);
            setErrorMessage(null);
        } else {
            setIsFaceAligned(false);
            setErrorMessage('Move closer to the camera');
        }
    };

    const validateOfficeGeofence = (currentLoc) => {
        if (isWFH) return { valid: true };
        if (!officeSettings?.locationRequired) return { valid: true };

        const office = officeSettings?.officeLocation;
        if (!office || !office.latitude || !office.longitude) {
            return { valid: true };
        }

        if (!currentLoc || !currentLoc.latitude) {
            return {
                valid: false,
                error: 'Valid GPS location is required before punch can be recorded. Please ensure location services are enabled.'
            };
        }

        const distance = calculateDistance(
            currentLoc.latitude,
            currentLoc.longitude,
            office.latitude,
            office.longitude
        );

        const allowedRadius = Number(office.radiusMeters) > 0 ? Number(office.radiusMeters) : 100;
        const accuracyBuffer = currentLoc.accuracy ? Math.min(currentLoc.accuracy, 50) : 0;
        const effectiveDistance = Math.max(0, distance - accuracyBuffer);

        if (effectiveDistance > allowedRadius) {
            return {
                valid: false,
                error: `You are outside the allowed office location.\nCurrent distance: ${Math.round(distance)}m from office (Allowed: within ${allowedRadius}m).`
            };
        }

        return { valid: true, distance };
    };

    const validateOfficeWifi = async () => {
        if (isWFH) return { valid: true };
        if (!officeSettings?.wifiRequired) return { valid: true };

        const allowed = officeSettings?.allowedWifiSSIDs || [];
        if (allowed.length === 0) return { valid: true };

        try {
            const net = await NetInfo.fetch();
            const currentSSID = net.details?.ssid || net.details?.bssid;

            if (!currentSSID || !allowed.includes(currentSSID)) {
                return {
                    valid: false,
                    error: `You must be connected to authorized office WiFi to punch attendance.\nAllowed: ${allowed.join(', ')}`
                };
            }
            return { valid: true };
        } catch (_e) {
            return { valid: true };
        }
    };

    const handleCapture = async () => {
        if (processing) return;

        try {
            setProcessing(true);

            // 1. Anti-tamper phone clock verification (uses cached sync if already verified)
            if (!clockVerifiedRef.current) {
                const timeCheck = await timeValidationService.verifyRealTimeSync();
                if (!timeCheck.isValid) {
                    throw new Error(timeCheck.error);
                }
                clockVerifiedRef.current = true;
            }

            // 2. GPS Location check with fallback
            let activeLoc = location;
            if (!activeLoc && !isWFH && officeSettings?.locationRequired) {
                activeLoc = await fetchAccurateLocation();
            }

            const geoCheck = validateOfficeGeofence(activeLoc);
            if (!geoCheck.valid) {
                throw new Error(geoCheck.error);
            }

            // 3. WiFi check
            const wifiCheck = await validateOfficeWifi();
            if (!wifiCheck.valid) {
                throw new Error(wifiCheck.error);
            }

            // 4. Capture photo from camera (ultra-fast snapshot)
            if (!cameraRef.current) {
                throw new Error('Camera is not ready yet');
            }

            const photo = await cameraRef.current.takePictureAsync({
                quality: 0.2,
            });

            // Crop & resize for face API (ultra-lightweight ~6KB for instantaneous upload)
            const manipResult = await manipulateAsync(
                photo.uri,
                [{ resize: { width: 200 } }],
                { compress: 0.35, format: SaveFormat.JPEG, base64: true }
            );

            const base64 = manipResult.base64;
            const formattedImage = `data:image/jpeg;base64,${base64}`;

            // 5. Verify with Backend Face API
            const apiResult = await faceApiService.verifyFace(user.uid, base64);
            const isFaceVerified = apiResult && apiResult.success && (apiResult.verified || apiResult.isMatch);
            if (!isFaceVerified) {
                throw new Error(apiResult?.error || 'Face did not match employee profile. Please try again.');
            }

            // 6. Record punch via Attendance Engine (Preserves all previous session records)
            const punchResult = await attendanceEngine.recordPunch({
                user,
                action: currentAction,
                mode: isWFH ? 'WFH' : 'OFFICE',
                location: activeLoc || location,
                faceVerified: true,
                photoData: formattedImage,
                customSettings: officeSettings,
            });

            if (!punchResult.success) {
                throw new Error(punchResult.error);
            }

            const isCheckIn = currentAction === 'check-in';
            const title = isCheckIn ? 'Punch In Successful! ✅' : 'Punch Out Successful! ✅';
            const msg = `Face Verified (${Math.round((apiResult.matchScore || 0.95) * 100)}% match)\nTime: ${punchResult.time}\nSession: #${punchResult.sessionNumber}\nTotal Work: ${punchResult.totalWorkHours} hrs\nTotal Break: ${punchResult.totalBreakHours || 0} hrs`;

            Alert.alert(title, msg, [
                {
                    text: 'OK',
                    onPress: () => {
                        handleGoBack();
                        if (typeof onSuccess === 'function') onSuccess(activeLoc || location, punchResult);
                    }
                }
            ]);
        } catch (error) {
            Alert.alert('Verification Failed ❌', error.message || 'Face verification failed');
        } finally {
            setProcessing(false);
        }
    };

    const officeAllowedRadius = Number(officeSettings?.officeLocation?.radiusMeters) > 0 ? Number(officeSettings.officeLocation.radiusMeters) : 100;
    const accuracyBuffer = location?.accuracy ? Math.min(location.accuracy, 50) : 0;
    const effectiveOfficeDistance = officeDistance !== null ? Math.max(0, officeDistance - accuracyBuffer) : null;
    const isLocationInRange =
        isWFH ||
        !officeSettings?.locationRequired ||
        !officeSettings?.officeLocation?.latitude ||
        (effectiveOfficeDistance !== null && effectiveOfficeDistance <= officeAllowedRadius);

    if (!permission) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#6366F1" />
                <Text style={styles.loadingText}>Opening camera...</Text>
            </View>
        );
    }

    if (!permission.granted) {
        return (
            <View style={styles.loadingContainer}>
                <Ionicons name="camera-reverse-outline" size={54} color="#6366F1" />
                <Text style={styles.errorText}>Camera permission is required</Text>
                <TouchableOpacity style={styles.grantBtn} onPress={requestPermission}>
                    <Text style={styles.grantBtnText}>Grant Camera Access</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <StatusBar barStyle="dark-content" backgroundColor="#F8FAFC" />

            {/* Top Navigation Header */}
            <View style={[styles.header, { paddingTop: Math.max(insets.top + 6, 38) }]}>
                <TouchableOpacity
                    style={styles.backButton}
                    onPress={handleGoBack}
                    activeOpacity={0.7}
                >
                    <Ionicons name="arrow-back" size={20} color="#4F46E5" />
                </TouchableOpacity>

                <Text style={styles.headerTitle}>
                    {currentAction === 'check-out' ? 'Punch Out' : 'Mark Attendance'}
                </Text>

                <View style={styles.headerRightPlaceholder} />
            </View>

            {/* Action Mode & Flip Camera Row */}
            <View style={styles.actionHeaderRow}>
                <TouchableOpacity
                    style={[
                        styles.modeTogglePill,
                        currentAction === 'check-out' ? styles.modePillOut : styles.modePillIn
                    ]}
                    onPress={() => setCurrentAction(prev => (prev === 'check-in' ? 'check-out' : 'check-in'))}
                    activeOpacity={0.8}
                >
                    <Ionicons
                        name={currentAction === 'check-out' ? 'log-out-outline' : 'log-in-outline'}
                        size={14}
                        color={currentAction === 'check-out' ? '#EF4444' : '#16A34A'}
                    />
                    <Text
                        style={[
                            styles.modeToggleText,
                            { color: currentAction === 'check-out' ? '#DC2626' : '#15803D' }
                        ]}
                    >
                        {currentAction === 'check-out' ? 'Punch Out Mode' : 'Punch In Mode'}
                    </Text>
                    <Ionicons name="swap-horizontal" size={13} color="#94A3B8" />
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.flipBtn}
                    onPress={toggleCameraFacing}
                    activeOpacity={0.75}
                >
                    <Ionicons name="camera-reverse-outline" size={16} color="#1E293B" />
                    <Text style={styles.flipBtnText}>Flip Camera</Text>
                </TouchableOpacity>
            </View>

            {/* Main Center Circular Camera Preview */}
            <View style={styles.centerSection}>
                <View style={styles.cameraCircleWrapper}>
                    <View
                        style={[
                            styles.cameraCircle,
                            isFaceAligned ? styles.cameraCircleAligned : styles.cameraCircleNormal
                        ]}
                    >
                        <CameraView
                            ref={cameraRef}
                            style={StyleSheet.absoluteFill}
                            facing={facing}
                            onCameraReady={() => setCameraReady(true)}
                            onFacesDetected={handleFacesDetected}
                            faceDetectorSettings={faceDetectorSettings}
                        />
                    </View>
                </View>

                {/* Face Registered / Detected Status Pill */}
                <View
                    style={[
                        styles.facePill,
                        isFaceAligned ? styles.facePillAligned : styles.facePillWaiting
                    ]}
                >
                    <Ionicons
                        name={isFaceAligned ? 'happy-outline' : 'scan-outline'}
                        size={16}
                        color={isFaceAligned ? '#16A34A' : '#64748B'}
                    />
                    <Text
                        style={[
                            styles.facePillText,
                            isFaceAligned ? styles.facePillTextAligned : styles.facePillTextWaiting
                        ]}
                    >
                        {isFaceAligned
                            ? (currentAction === 'check-out'
                                ? `Active session (${activeSessionInfo || ''}) • Ready to Punch Out`
                                : 'Face registered • Ready to Punch In')
                            : errorMessage || (faceData ? 'Center your face' : 'Looking for face...')}
                    </Text>
                </View>
            </View>

            {/* Bottom Card: Current Location & Punch Button */}
            <View
                style={[
                    styles.bottomCard,
                    { marginBottom: Math.max(insets.bottom + 10, 20) }
                ]}
            >
                <TouchableOpacity
                    style={styles.locationRow}
                    onPress={fetchAccurateLocation}
                    activeOpacity={0.7}
                >
                    <View style={[styles.locationIconCircle, locationError && { backgroundColor: '#FEE2E2' }]}>
                        <Ionicons
                            name={locationError ? "alert-circle" : "location"}
                            size={18}
                            color={locationError ? "#DC2626" : "#6366F1"}
                        />
                    </View>

                    <View style={styles.locationInfoColumn}>
                        <View style={styles.locationTitleRow}>
                            <Text style={styles.locationTitle}>Current Location</Text>
                            {locationError ? (
                                <Text style={[styles.distancePill, { color: '#DC2626' }]}>• Tap to Retry GPS</Text>
                            ) : officeDistance !== null && (
                                <Text
                                    style={[
                                        styles.distancePill,
                                        { color: isLocationInRange ? '#16A34A' : '#DC2626' }
                                    ]}
                                >
                                    {isLocationInRange
                                        ? `• ${formatDistance(officeDistance)}`
                                        : `• Outside (${formatDistance(officeDistance)})`}
                                </Text>
                            )}
                        </View>

                        <Text style={[styles.locationAddress, locationError && { color: '#DC2626', fontWeight: '600' }]} numberOfLines={2}>
                            {locationLoading
                                ? 'Acquiring GPS location...'
                                : location?.address || locationError || 'Fetching current location...'}
                        </Text>
                    </View>
                </TouchableOpacity>

                {/* Punch CTA Button */}
                <TouchableOpacity
                    style={[
                        styles.punchButton,
                        currentAction === 'check-out' && styles.punchButtonOut,
                        (processing || locationLoading || !cameraReady) && styles.punchButtonDisabled
                    ]}
                    onPress={handleCapture}
                    disabled={processing || locationLoading || !cameraReady}
                    activeOpacity={0.85}
                >
                    {processing ? (
                        <View style={styles.btnRow}>
                            <ActivityIndicator size="small" color="#FFFFFF" />
                            <Text style={styles.punchButtonText}>Verifying & Recording...</Text>
                        </View>
                    ) : (
                        <Text style={styles.punchButtonText}>
                            {currentAction === 'check-out' ? 'Punch out' : 'Punch in'}
                        </Text>
                    )}
                </TouchableOpacity>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F8FAFC',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#F8FAFC',
        padding: 24,
    },
    loadingText: {
        marginTop: 14,
        fontSize: 15,
        color: '#64748B',
        fontWeight: '500',
    },
    errorText: {
        fontSize: 16,
        color: '#1E293B',
        textAlign: 'center',
        marginTop: 12,
        fontWeight: '600',
    },
    grantBtn: {
        marginTop: 18,
        backgroundColor: '#6366F1',
        paddingHorizontal: 22,
        paddingVertical: 12,
        borderRadius: 12,
    },
    grantBtnText: {
        color: '#FFFFFF',
        fontWeight: '700',
        fontSize: 14,
    },

    // Header
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 18,
        paddingBottom: 10,
    },
    backButton: {
        width: 42,
        height: 42,
        borderRadius: 21,
        backgroundColor: '#EEF2FF',
        justifyContent: 'center',
        alignItems: 'center',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: '#1E293B',
        textAlign: 'center',
    },
    headerRightPlaceholder: {
        width: 42,
    },

    // Action Mode & Flip Row
    actionHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 18,
        marginTop: 4,
    },
    modeTogglePill: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 20,
        gap: 6,
        borderWidth: 1,
    },
    modePillIn: {
        backgroundColor: '#DCFCE7',
        borderColor: '#86EFAC',
    },
    modePillOut: {
        backgroundColor: '#FEE2E2',
        borderColor: '#FCA5A5',
    },
    modeToggleText: {
        fontSize: 12,
        fontWeight: '700',
    },
    flipBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFFFFF',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: '#E2E8F0',
        gap: 6,
        elevation: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
    },
    flipBtnText: {
        fontSize: 12,
        fontWeight: '600',
        color: '#1E293B',
    },

    // Center Section with Circular Camera
    centerSection: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: 20,
    },
    cameraCircleWrapper: {
        shadowColor: '#16A34A',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 16,
        elevation: 8,
    },
    cameraCircle: {
        width: 280,
        height: 280,
        borderRadius: 140,
        overflow: 'hidden',
        backgroundColor: '#E2E8F0',
        position: 'relative',
    },
    cameraCircleNormal: {
        borderWidth: 4,
        borderColor: '#22C55E',
    },
    cameraCircleAligned: {
        borderWidth: 4,
        borderColor: '#16A34A',
    },

    // Face Status Pill
    facePill: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        gap: 6,
        marginTop: 18,
        borderWidth: 1,
    },
    facePillAligned: {
        backgroundColor: '#DCFCE7',
        borderColor: '#86EFAC',
    },
    facePillWaiting: {
        backgroundColor: '#F1F5F9',
        borderColor: '#E2E8F0',
    },
    facePillText: {
        fontSize: 12,
        fontWeight: '600',
    },
    facePillTextAligned: {
        color: '#15803D',
    },
    facePillTextWaiting: {
        color: '#64748B',
    },

    // Bottom Location & Punch Card
    bottomCard: {
        backgroundColor: '#FFFFFF',
        borderRadius: 20,
        padding: 16,
        marginHorizontal: 16,
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 10,
        borderWidth: 1,
        borderColor: '#F1F5F9',
    },
    locationRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
    },
    locationIconCircle: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: '#EEF2FF',
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 2,
    },
    locationInfoColumn: {
        flex: 1,
    },
    locationTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    locationTitle: {
        fontSize: 13,
        fontWeight: '700',
        color: '#1E293B',
    },
    distancePill: {
        fontSize: 11,
        fontWeight: '600',
    },
    locationAddress: {
        fontSize: 11,
        color: '#64748B',
        lineHeight: 16,
        marginTop: 3,
    },

    // Punch CTA Button
    punchButton: {
        backgroundColor: '#6366F1',
        paddingVertical: 14,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 14,
        elevation: 2,
        shadowColor: '#6366F1',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
    },
    punchButtonOut: {
        backgroundColor: '#EF4444',
        shadowColor: '#EF4444',
    },
    punchButtonDisabled: {
        opacity: 0.6,
    },
    punchButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: 0.3,
    },
    btnRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
});
