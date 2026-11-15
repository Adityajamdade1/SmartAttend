import React, { useState, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    StatusBar,
    Alert,
    ActivityIndicator,
    ScrollView,
    Switch
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useAuth } from '../context/AuthContext';
import { attendanceEngine } from '../services/attendanceEngine';
import { getAttendanceSettings } from '../services/attendanceConfigService';
import { timeValidationService } from '../services/timeValidationService';
import {
    isOpenSession,
    getActiveSession
} from '../utils/attendance';
import Colors, { gradients, shadows } from '../constants/Colors';

export default function AttendanceScanScreen({ navigation }) {
    const { user, isFeatureEnabled, FEATURES } = useAuth();
    const [loading, setLoading] = useState(false);
    const [todayAttendance, setTodayAttendance] = useState(null);
    const [officeSettings, setOfficeSettings] = useState(null);
    const [isWFH, setIsWFH] = useState(false);

    const loadData = useCallback(async () => {
        if (!user?.uid) return;
        try {
            setLoading(true);

            // 1. Load active attendance settings
            const settings = await getAttendanceSettings(user?.companyId);
            setOfficeSettings(settings);

            // 2. Load today's attendance record
            const { exists, data } = await attendanceEngine.getTodayRecord(user.uid, user.companyId);
            if (exists && data) {
                setTodayAttendance(data);
                if (data.attendanceMode === 'WFH') {
                    setIsWFH(true);
                }
            } else {
                setTodayAttendance(null);
            }
        } catch (error) {
            console.error('Error loading attendance scan data:', error);
        } finally {
            setLoading(false);
        }
    }, [user?.companyId, user?.uid]);

    useFocusEffect(
        useCallback(() => {
            loadData();
        }, [loadData])
    );

    /**
     * Acquire high-accuracy GPS coordinates
     */
    const getCurrentLocation = async () => {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
            throw new Error('Location permission is denied. GPS is mandatory to mark attendance.');
        }

        const isServicesEnabled = await Location.hasServicesEnabledAsync();
        if (!isServicesEnabled) {
            try {
                await Location.enableNetworkProviderAsync();
            } catch (_e) { }
            const checkAgain = await Location.hasServicesEnabledAsync();
            if (!checkAgain) {
                throw new Error('Please turn ON Location (GPS) on your phone to verify attendance.');
            }
        }

        let position = null;
        try {
            position = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
            });
        } catch (_curErr) {
            position = await Location.getLastKnownPositionAsync();
        }

        if (!position?.coords) {
            throw new Error('Unable to retrieve GPS coordinates. Please turn ON Location.');
        }

        return {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
        };
    };

    const handleCheckIn = async () => {
        // Enforce Network Real-Time Clock Sync Check
        try {
            setLoading(true);
            const timeCheck = await timeValidationService.verifyRealTimeSync();
            if (!timeCheck.isValid) {
                Alert.alert('Automatic Time Required ⚠️', timeCheck.error);
                return;
            }
        } catch (e) {
            console.warn('Time check error:', e);
        } finally {
            setLoading(false);
        }

        // If face recognition is enabled, open camera scanner
        if (isFeatureEnabled(FEATURES.FACE_RECOGNITION)) {
            navigation.navigate('RealTimeFaceScan', {
                action: 'check-in',
                isWFH,
            });
            return;
        }

        // Fallback for non-face plan: Acquire GPS and record punch
        try {
            setLoading(true);
            let location = null;
            if (!isWFH) {
                location = await getCurrentLocation();
            }

            const res = await attendanceEngine.recordPunch({
                user,
                action: 'check-in',
                mode: isWFH ? 'WFH' : 'OFFICE',
                location,
                faceVerified: false,
                customSettings: officeSettings,
            });

            if (!res.success) {
                Alert.alert('Punch Failed ❌', res.error);
                return;
            }

            Alert.alert(
                'Punch In Successful! ✅',
                `Time: ${res.time}\nSession #${res.sessionNumber} started.\nMode: ${isWFH ? 'Work From Home' : 'Office'}`
            );
            await loadData();
        } catch (error) {
            Alert.alert('Location / Punch Error ❌', error.message || 'Failed to record check-in');
        } finally {
            setLoading(false);
        }
    };

    const handleCheckOut = async () => {
        // Enforce Network Real-Time Clock Sync Check
        try {
            setLoading(true);
            const timeCheck = await timeValidationService.verifyRealTimeSync();
            if (!timeCheck.isValid) {
                Alert.alert('Automatic Time Required ⚠️', timeCheck.error);
                return;
            }
        } catch (e) {
            console.warn('Time check error:', e);
        } finally {
            setLoading(false);
        }

        // If face recognition is enabled, open camera scanner
        if (isFeatureEnabled(FEATURES.FACE_RECOGNITION)) {
            navigation.navigate('RealTimeFaceScan', {
                action: 'check-out',
                isWFH,
            });
            return;
        }

        // Fallback for non-face plan: Acquire GPS and record punch
        try {
            setLoading(true);
            let location = null;
            if (!isWFH) {
                location = await getCurrentLocation();
            }

            const res = await attendanceEngine.recordPunch({
                user,
                action: 'check-out',
                mode: isWFH ? 'WFH' : 'OFFICE',
                location,
                faceVerified: false,
                customSettings: officeSettings,
            });

            if (!res.success) {
                Alert.alert('Punch Failed ❌', res.error);
                return;
            }

            Alert.alert(
                'Punch Out Successful! ✅',
                `Time: ${res.time}\nSession #${res.sessionNumber} closed.\nTotal Work: ${res.totalWorkHours} hrs\nTotal Break: ${res.totalBreakHours || 0} hrs\nStatus: ${res.status.toUpperCase()}`
            );
            await loadData();
        } catch (error) {
            Alert.alert('Location / Punch Error ❌', error.message || 'Failed to record check-out');
        } finally {
            setLoading(false);
        }
    };

    const hasOpenSession = isOpenSession(todayAttendance);
    const activeSession = getActiveSession(todayAttendance);
    const sessions = Array.isArray(todayAttendance?.sessions) ? todayAttendance.sessions : [];

    const getStatusInfo = () => {
        if (!todayAttendance || sessions.length === 0) {
            return {
                title: 'Not Marked Today',
                subtitle: 'Ready to punch in for your first session',
                icon: 'time-outline',
                color: Colors.textSecondary,
            };
        }

        if (hasOpenSession) {
            return {
                title: `Punched In (Session #${sessions.length})`,
                subtitle: `Active since ${activeSession?.checkInTime || todayAttendance.checkInTime}`,
                icon: 'play-circle',
                color: Colors.primary,
            };
        }

        return {
            title: `Punched Out (${sessions.length} sessions completed)`,
            subtitle: `Total Work: ${(todayAttendance.totalWorkHours || todayAttendance.workHours || 0).toFixed(1)} hrs | Break: ${(todayAttendance.totalBreakHours || 0).toFixed(1)} hrs`,
            icon: 'checkmark-circle',
            color: Colors.success,
        };
    };

    const statusInfo = getStatusInfo();

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            {/* Header */}
            <LinearGradient
                colors={gradients.primary}
                style={styles.header}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            >
                <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => {
                        if (navigation.canGoBack()) {
                            navigation.goBack();
                        } else {
                            navigation.navigate('Dashboard');
                        }
                    }}
                >
                    <Ionicons name="arrow-back" size={24} color={Colors.textInverse} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>
                    {isFeatureEnabled(FEATURES.FACE_RECOGNITION) ? 'Face Attendance' : 'Mark Attendance'}
                </Text>
                <Text style={styles.headerSubtitle}>
                    {isFeatureEnabled(FEATURES.FACE_RECOGNITION) ? 'Biometric + Multi-Session Engine' : 'Multi-Punch In/Out Active'}
                </Text>
            </LinearGradient>

            <ScrollView contentContainerStyle={styles.content}>
                {/* WFH Mode Toggle */}
                {officeSettings?.allowWFH !== false && (
                    <View style={styles.wfhCard}>
                        <View style={styles.wfhInfo}>
                            <Ionicons name={isWFH ? "home" : "business"} size={22} color={isWFH ? Colors.secondary : Colors.primary} />
                            <View style={{ marginLeft: 10 }}>
                                <Text style={styles.wfhTitle}>{isWFH ? "Work From Home Mode" : "Office Attendance Mode"}</Text>
                                <Text style={styles.wfhSubtitle}>{isWFH ? "Geofencing bypassed for remote work" : "Requires office location validation"}</Text>
                            </View>
                        </View>
                        <Switch
                            value={isWFH}
                            onValueChange={setIsWFH}
                            disabled={hasOpenSession}
                            trackColor={{ false: '#cbd5e1', true: Colors.secondary }}
                            thumbColor="#ffffff"
                        />
                    </View>
                )}

                {/* Current Status Card */}
                <View style={styles.statusCard}>
                    <View style={styles.statusIconContainer}>
                        <Ionicons name={statusInfo.icon} size={42} color={statusInfo.color} />
                    </View>
                    <Text style={styles.statusTitle}>{statusInfo.title}</Text>
                    <Text style={styles.statusSubtitle}>{statusInfo.subtitle}</Text>

                    {todayAttendance?.isLate && (
                        <View style={styles.lateWarning}>
                            <Ionicons name="warning" size={16} color={Colors.warning} />
                            <Text style={styles.lateText}>
                                Late Arrival ({todayAttendance.lateMinutes || 0} mins)
                            </Text>
                        </View>
                    )}
                </View>

                {/* Live Working Hours Summary Card */}
                {todayAttendance && (
                    <View style={styles.metricsRow}>
                        <View style={styles.metricCard}>
                            <Text style={styles.metricLabel}>Total Work Time</Text>
                            <Text style={styles.metricValue}>
                                {(todayAttendance.totalWorkHours || todayAttendance.workHours || 0).toFixed(1)} <Text style={styles.metricUnit}>hrs</Text>
                            </Text>
                        </View>
                        <View style={styles.metricCard}>
                            <Text style={styles.metricLabel}>Total Break Time</Text>
                            <Text style={styles.metricValue}>
                                {(todayAttendance.totalBreakHours || todayAttendance.breakHours || 0).toFixed(1)} <Text style={styles.metricUnit}>hrs</Text>
                            </Text>
                        </View>
                        <View style={styles.metricCard}>
                            <Text style={styles.metricLabel}>Current Status</Text>
                            <Text style={[styles.metricValue, { fontSize: 13, color: todayAttendance.status === 'present' ? Colors.success : Colors.warning }]}>
                                {(todayAttendance.status || 'PRESENT').toUpperCase()}
                            </Text>
                        </View>
                    </View>
                )}

                {/* Action Buttons: Punch In or Punch Out */}
                <View style={styles.actionButtons}>
                    {!hasOpenSession ? (
                        <TouchableOpacity
                            style={styles.punchButton}
                            onPress={handleCheckIn}
                            disabled={loading}
                            activeOpacity={0.8}
                        >
                            <LinearGradient
                                colors={[Colors.success, Colors.successDark]}
                                style={styles.buttonGradient}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                            >
                                {loading ? (
                                    <ActivityIndicator color={Colors.textInverse} />
                                ) : (
                                    <>
                                        <Ionicons name="log-in" size={26} color={Colors.textInverse} />
                                        <Text style={styles.buttonText}>
                                            {sessions.length === 0 ? 'Punch In Now' : `Punch In (Session #${sessions.length + 1})`}
                                        </Text>
                                    </>
                                )}
                            </LinearGradient>
                        </TouchableOpacity>
                    ) : (
                        <TouchableOpacity
                            style={styles.punchButton}
                            onPress={handleCheckOut}
                            disabled={loading}
                            activeOpacity={0.8}
                        >
                            <LinearGradient
                                colors={[Colors.error, Colors.errorDark]}
                                style={styles.buttonGradient}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                            >
                                {loading ? (
                                    <ActivityIndicator color={Colors.textInverse} />
                                ) : (
                                    <>
                                        <Ionicons name="log-out" size={26} color={Colors.textInverse} />
                                        <Text style={styles.buttonText}>
                                            Punch Out (Close Session #{sessions.length})
                                        </Text>
                                    </>
                                )}
                            </LinearGradient>
                        </TouchableOpacity>
                    )}
                </View>

                {/* Today's Punch Sessions List */}
                {sessions.length > 0 && (
                    <View style={styles.sessionsCard}>
                        <View style={styles.sessionsHeader}>
                            <Text style={styles.sessionsTitle}>Today&apos;s Punch Timeline ({sessions.length})</Text>
                            <TouchableOpacity onPress={() => navigation.navigate('AttendanceHistory')}>
                                <Text style={styles.viewHistoryLink}>Full History →</Text>
                            </TouchableOpacity>
                        </View>

                        {sessions.map((sess, idx) => (
                            <View key={sess.sessionId || idx} style={styles.sessionItem}>
                                <View style={styles.sessionBadge}>
                                    <Text style={styles.sessionBadgeText}>#{idx + 1}</Text>
                                </View>
                                <View style={styles.sessionTimes}>
                                    <Text style={styles.sessionTimeText}>
                                        <Text style={{ fontWeight: '700', color: Colors.success }}>IN:</Text> {sess.checkInTime || '-'}
                                    </Text>
                                    <Text style={styles.sessionTimeText}>
                                        <Text style={{ fontWeight: '700', color: Colors.error }}>OUT:</Text> {sess.checkOutTime || 'Active Session ⏳'}
                                    </Text>
                                </View>
                                <View style={styles.sessionDuration}>
                                    <Text style={styles.sessionDurationText}>
                                        {sess.sessionHours !== undefined && sess.checkOut ? `${sess.sessionHours} hrs` : 'In Progress'}
                                    </Text>
                                    {sess.attendanceMode === 'WFH' && (
                                        <Text style={styles.sessionModeText}>WFH</Text>
                                    )}
                                </View>
                            </View>
                        ))}
                    </View>
                )}

                {/* Dynamic Policy Info Card */}
                <View style={styles.infoCard}>
                    <Ionicons name="information-circle" size={22} color={Colors.info} />
                    <View style={{ marginLeft: 10, flex: 1 }}>
                        <Text style={styles.infoTitle}>Office Attendance Policy</Text>
                        <Text style={styles.infoText}>
                            Office Hours: {officeSettings?.officeStartTime || '09:30'} - {officeSettings?.officeEndTime || '18:30'}
                            {'\n'}Full Day Required: {officeSettings?.fullDayHours || 8} hrs | Half Day: {officeSettings?.halfDayHours || 4} hrs
                            {'\n'}Grace Period: {officeSettings?.gracePeriodMinutes || 15} mins
                        </Text>
                    </View>
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: Colors.background,
    },
    header: {
        paddingTop: StatusBar.currentHeight ? StatusBar.currentHeight + 10 : 40,
        paddingBottom: 20,
        paddingHorizontal: 20,
        borderBottomLeftRadius: 24,
        borderBottomRightRadius: 24,
    },
    backButton: {
        marginBottom: 10,
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: Colors.textInverse,
    },
    headerSubtitle: {
        fontSize: 13,
        color: 'rgba(255,255,255,0.85)',
        marginTop: 2,
    },
    content: {
        padding: 16,
        paddingBottom: 40,
    },
    wfhCard: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#ffffff',
        padding: 14,
        borderRadius: 14,
        marginBottom: 14,
        ...shadows.small,
    },
    wfhInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    wfhTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: Colors.text,
    },
    wfhSubtitle: {
        fontSize: 11,
        color: Colors.textSecondary,
        marginTop: 2,
    },
    statusCard: {
        backgroundColor: '#ffffff',
        borderRadius: 16,
        padding: 20,
        alignItems: 'center',
        marginBottom: 14,
        ...shadows.medium,
    },
    statusIconContainer: {
        marginBottom: 10,
    },
    statusTitle: {
        fontSize: 17,
        fontWeight: 'bold',
        color: Colors.text,
        textAlign: 'center',
    },
    statusSubtitle: {
        fontSize: 13,
        color: Colors.textSecondary,
        marginTop: 4,
        textAlign: 'center',
    },
    lateWarning: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,149,0,0.12)',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        marginTop: 10,
    },
    lateText: {
        fontSize: 12,
        fontWeight: '600',
        color: Colors.warning,
        marginLeft: 6,
    },
    metricsRow: {
        flexDirection: 'row',
        gap: 10,
        marginBottom: 16,
    },
    metricCard: {
        flex: 1,
        backgroundColor: '#ffffff',
        padding: 12,
        borderRadius: 12,
        alignItems: 'center',
        ...shadows.small,
    },
    metricLabel: {
        fontSize: 10,
        color: Colors.textSecondary,
        fontWeight: '600',
        textTransform: 'uppercase',
    },
    metricValue: {
        fontSize: 16,
        fontWeight: 'bold',
        color: Colors.primary,
        marginTop: 4,
    },
    metricUnit: {
        fontSize: 11,
        fontWeight: 'normal',
        color: Colors.textSecondary,
    },
    actionButtons: {
        marginBottom: 16,
    },
    punchButton: {
        borderRadius: 14,
        overflow: 'hidden',
        ...shadows.medium,
    },
    buttonGradient: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        gap: 10,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: 'bold',
        color: Colors.textInverse,
    },
    sessionsCard: {
        backgroundColor: '#ffffff',
        borderRadius: 16,
        padding: 16,
        marginBottom: 16,
        ...shadows.small,
    },
    sessionsHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#f1f5f9',
        paddingBottom: 8,
    },
    sessionsTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: Colors.text,
    },
    viewHistoryLink: {
        fontSize: 12,
        fontWeight: '600',
        color: Colors.primary,
    },
    sessionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#f8fafc',
        borderRadius: 10,
        padding: 10,
        marginBottom: 8,
    },
    sessionBadge: {
        backgroundColor: Colors.primaryLight,
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
    },
    sessionBadgeText: {
        fontSize: 11,
        fontWeight: '700',
        color: Colors.primary,
    },
    sessionTimes: {
        flex: 1,
    },
    sessionTimeText: {
        fontSize: 12,
        color: Colors.text,
        marginBottom: 2,
    },
    sessionDuration: {
        alignItems: 'flex-end',
    },
    sessionDurationText: {
        fontSize: 12,
        fontWeight: '700',
        color: Colors.primary,
    },
    sessionModeText: {
        fontSize: 9,
        fontWeight: '700',
        color: Colors.secondary,
        textTransform: 'uppercase',
        marginTop: 2,
    },
    infoCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: '#f0f9ff',
        borderWidth: 1,
        borderColor: '#bae6fd',
        padding: 14,
        borderRadius: 12,
    },
    infoTitle: {
        fontSize: 13,
        fontWeight: '700',
        color: '#0369a1',
        marginBottom: 2,
    },
    infoText: {
        fontSize: 11,
        color: '#0284c7',
        lineHeight: 16,
    },
});
