import React, { useState, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    StatusBar,
    Modal,
    ScrollView,
    Alert,
    ActivityIndicator,
    Image,
    RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Calendar } from 'react-native-calendars';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { db, attendanceHelpers } from '../services/firebaseConfig';
import { attendanceEngine } from '../services/attendanceEngine';
import { formatDate } from '../utils/attendance';
import { pdfReportService } from '../services/pdfReportService';
import Colors, { shadows } from '../constants/Colors';
import BottomNavigation from '../components/BottomNavigation';

/**
 * Format decimal hours to exact "X hrs Y mins" or "Y mins"
 * @param {number} decimalHours 
 */
export const formatDurationHM = (decimalHours) => {
    if (decimalHours === undefined || decimalHours === null || isNaN(decimalHours) || decimalHours <= 0) {
        return '0 hrs 0 mins';
    }
    const totalMinutes = Math.round(decimalHours * 60);
    const hrs = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const hrUnit = hrs === 1 ? 'hr' : 'hrs';
    const minUnit = mins === 1 ? 'min' : 'mins';
    if (hrs === 0) return `${mins} ${minUnit}`;
    if (mins === 0) return `${hrs} ${hrUnit}`;
    return `${hrs} ${hrUnit} ${mins} ${minUnit}`;
};

/**
 * Extract face photo from attendance record or its sessions
 */
export const getFacePhotoUri = (record) => {
    if (!record) return null;
    if (Array.isArray(record.sessions) && record.sessions.length > 0) {
        for (let i = record.sessions.length - 1; i >= 0; i--) {
            const s = record.sessions[i];
            if (s.checkoutPhotoRef) return s.checkoutPhotoRef;
            if (s.photoRef) return s.photoRef;
            if (s.checkinPhotoRef) return s.checkinPhotoRef;
        }
    }
    if (record.checkoutPhotoRef) return record.checkoutPhotoRef;
    if (record.photoRef) return record.photoRef;
    if (record.checkInImage) return record.checkInImage;
    if (record.photoData) return record.photoData;
    return null;
};

/**
 * Extract human-readable location address from record or sessions
 */
export const getLocationAddress = (record) => {
    if (!record) return 'Office Location';
    if (Array.isArray(record.sessions) && record.sessions.length > 0) {
        for (let i = record.sessions.length - 1; i >= 0; i--) {
            const s = record.sessions[i];
            if (s.checkoutLocation?.address) return s.checkoutLocation.address;
            if (s.location?.address) return s.location.address;
            if (s.checkinLocation?.address) return s.checkinLocation.address;
        }
    }
    if (record.checkoutLocation?.address) return record.checkoutLocation.address;
    if (record.location?.address) return record.location.address;
    if (record.checkinLocation?.address) return record.checkinLocation.address;
    if (record.location?.latitude && record.location?.longitude) {
        return `Lat: ${record.location.latitude.toFixed(4)}, Long: ${record.location.longitude.toFixed(4)}`;
    }
    return 'Registered Office Location';
};

export default function AttendanceHistoryScreen({ navigation }) {
    const { user, company } = useAuth();
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [exportingPdf, setExportingPdf] = useState(false);
    const [attendanceRecords, setAttendanceRecords] = useState([]);
    const [markedDates, setMarkedDates] = useState({});
    const [currentDate, setCurrentDate] = useState(new Date()); // Tracks calendar month
    const [selectedDay, setSelectedDay] = useState(null);
    const [showDetailsModal, setShowDetailsModal] = useState(false);
    const [stats, setStats] = useState({
        present: 0,
        absent: 0,
        halfDay: 0,
        paid: 0,
        unpaid: 0,
    });
    const [showMonthPicker, setShowMonthPicker] = useState(false);
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
    const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1); // 1-12

    const loadAttendanceHistory = useCallback(async () => {
        if (!user?.uid) return;
        try {
            setLoading(true);

            // 1. Fetch records using attendanceHelpers
            let records = [];
            const helperRes = await attendanceHelpers.getUserAttendance(user.uid);
            if (helperRes.success && Array.isArray(helperRes.records)) {
                records = [...helperRes.records];
            }

            // 2. Direct fetch of today's atomic record to ensure today's punches are immediately present
            const todayRes = await attendanceEngine.getTodayRecord(user.uid, user.companyId);
            if (todayRes.exists && todayRes.data) {
                const todayData = todayRes.data;
                const existingIdx = records.findIndex(r => r.date === todayData.date);
                if (existingIdx !== -1) {
                    records[existingIdx] = todayData;
                } else {
                    records.unshift(todayData);
                }
            }

            // Fallback: If no records found, try direct Firestore where query
            if (records.length === 0) {
                const snapshot = await db.collection('attendance').where('userId', '==', user.uid);
                if (snapshot.docs && snapshot.docs.length > 0) {
                    records = snapshot.docs.map(doc => doc.data());
                }
            }

            // Filter for current user (case-insensitive) and matching company if specified
            const userRecords = records.filter(record => {
                const recordUserId = record.userId || record.id?.split('_')[1];
                const matchesUser = !recordUserId ||
                    String(recordUserId).toLowerCase() === String(user.uid).toLowerCase();
                const matchesCompany = !record.companyId || !user.companyId ||
                    String(record.companyId).toLowerCase() === String(user.companyId).toLowerCase();
                return matchesUser && matchesCompany;
            });

            // Sort newest first
            userRecords.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

            setAttendanceRecords(userRecords);
            calculateStats(userRecords, currentDate);
            generateMarkedDates(userRecords);

            // Default selected day to today or latest record
            const todayStr = formatDate(new Date());
            const todayRecord = userRecords.find(r => r.date === todayStr);
            if (todayRecord) {
                setSelectedDay(todayRecord);
            } else if (userRecords.length > 0) {
                setSelectedDay(userRecords[0]);
            }
        } catch (error) {
            console.error('Error loading attendance history:', error);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [user?.uid, user?.companyId, currentDate]);

    // Automatically reload whenever this screen gains navigation focus
    useFocusEffect(
        useCallback(() => {
            loadAttendanceHistory();
        }, [loadAttendanceHistory])
    );

    const onRefresh = useCallback(() => {
        setRefreshing(true);
        loadAttendanceHistory();
    }, [loadAttendanceHistory]);

    const calculateStats = (records, date) => {
        const currentMonth = date.getMonth();
        const currentYear = date.getFullYear();
        const todayStr = formatDate(new Date());

        // 1. Get existing records for this month
        const monthRecords = records.filter(record => {
            if (!record.date) return false;
            const rDate = new Date(record.date);
            return rDate.getMonth() === currentMonth && rDate.getFullYear() === currentYear;
        });

        // 2. Calculate actual counts from records
        let present = monthRecords.filter(r => r.status === 'present').length;
        let halfDay = monthRecords.filter(r => r.status === 'half_day' || r.status === 'late').length;
        let manualAbsent = monthRecords.filter(r => r.status === 'absent').length;
        let paidLeaves = monthRecords.filter(r => r.status === 'paid_leave').length;

        // 3. Calculate automatic absent days (past weekdays with no record)
        let autoAbsent = 0;
        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

        for (let i = 1; i <= daysInMonth; i++) {
            const dStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
            if (dStr < todayStr) {
                const hasRecord = monthRecords.some(r => r.date === dStr);
                const isSun = new Date(currentYear, currentMonth, i).getDay() === 0;
                if (!hasRecord && !isSun) {
                    autoAbsent++;
                }
            }
        }

        const totalAbsent = manualAbsent + autoAbsent;
        const unpaid = totalAbsent;

        setStats({
            present,
            absent: totalAbsent,
            halfDay,
            unpaid,
            paidLeaves,
        });
    };

    const generateMarkedDates = (records) => {
        const marked = {};
        const todayStr = formatDate(new Date());
        const currentMonth = currentDate.getMonth();
        const currentYear = currentDate.getFullYear();
        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

        // 1. Mark existing records
        records.forEach(record => {
            if (!record?.date) return;
            let containerBgColor = '#2ECC71'; // Default green (Present)
            let dots = [];

            if (record.status === 'present' || record.status === 'late' || record.status === 'half_day') {
                if (record.isLate || record.status === 'late') {
                    containerBgColor = '#F1C40F'; // Yellow for Late
                } else if (record.status === 'half_day') {
                    containerBgColor = '#F39C12'; // Orange for Half Day
                } else {
                    containerBgColor = '#2ECC71'; // Green for On-Time
                }

                // Add dots based on work hours
                const hours = record.totalWorkHours || record.workHours || 0;
                if (hours >= 8) {
                    dots = [
                        { key: 'work1', color: '#FFFFFF', selectedDotColor: '#FFFFFF' },
                        { key: 'work2', color: '#FFFFFF', selectedDotColor: '#FFFFFF' },
                    ];
                } else if (hours > 0) {
                    dots = [
                        { key: 'work1', color: '#FFFFFF', selectedDotColor: '#FFFFFF' },
                    ];
                }
            } else if (record.status === 'absent') {
                containerBgColor = '#E74C3C'; // Red
            } else if (record.status === 'weekly_off') {
                containerBgColor = '#607D8B'; // Blue gray
            } else if (record.status === 'paid_leave') {
                containerBgColor = '#4A90E2'; // Blue for Paid Leave
            }

            marked[record.date] = {
                selected: true,
                selectedColor: containerBgColor,
                dots: dots,
                textColor: '#FFFFFF',
            };
        });

        // 2. Auto-fill missing days
        for (let i = 1; i <= daysInMonth; i++) {
            const date = new Date(currentYear, currentMonth, i);
            const dateString = formatDate(date);

            if (!marked[dateString]) {
                const isSunday = date.getDay() === 0;
                const isPast = dateString < todayStr;
                const isToday = dateString === todayStr;

                if (isToday) {
                    marked[dateString] = {
                        selected: true,
                        selectedColor: '#6366F1', // Indigo indicator for today
                        textColor: '#FFFFFF',
                    };
                } else if (isSunday) {
                    marked[dateString] = {
                        selected: true,
                        selectedColor: '#CFD8DC',
                        textColor: '#455A64',
                    };
                } else if (isPast) {
                    marked[dateString] = {
                        selected: true,
                        selectedColor: '#FFCDD2',
                        textColor: '#C62828',
                    };
                }
            }
        }
        setMarkedDates(marked);
    };

    const handleDayPress = async (day) => {
        const record = attendanceRecords.find(r => r.date === day.dateString);
        if (record) {
            setSelectedDay(record);
            setShowDetailsModal(true);
            return;
        }

        const todayStr = formatDate(new Date());
        // If clicking today and record wasn't in state, try live lookup
        if (day.dateString === todayStr) {
            try {
                const live = await attendanceEngine.getTodayRecord(user?.uid, user?.companyId);
                if (live.exists && live.data) {
                    setSelectedDay(live.data);
                    setShowDetailsModal(true);
                    return;
                }
            } catch (_e) { }
        }

        // For past days with no record (absent or weekly off)
        const d = new Date(day.timestamp);
        const isSunday = d.getDay() === 0;

        if (day.dateString <= todayStr) {
            setSelectedDay({
                date: day.dateString,
                status: isSunday ? 'weekly_off' : (day.dateString === todayStr ? 'not_marked' : 'absent'),
                checkIn: null,
                checkOut: null,
                workHours: 0,
                totalWorkHours: 0,
                sessions: [],
            });
            setShowDetailsModal(true);
        }
    };

    const handleMonthChange = (month) => {
        const date = new Date(month.timestamp);
        setCurrentDate(date);
    };

    const confirmDateSelection = () => {
        const newDate = new Date(selectedYear, selectedMonth - 1, 1);
        setCurrentDate(newDate);
        setShowMonthPicker(false);
    };

    const handleDownloadPdf = async () => {
        try {
            setExportingPdf(true);
            const currentMonth = currentDate.getMonth();
            const currentYear = currentDate.getFullYear();

            const monthRecords = attendanceRecords.filter(record => {
                if (!record.date) return false;
                const rDate = new Date(record.date);
                return rDate.getMonth() === currentMonth && rDate.getFullYear() === currentYear;
            });

            await pdfReportService.generateEmployeeReport({
                employee: user,
                company: company || { name: 'SmartAttend Enterprise' },
                records: monthRecords,
                periodTitle: `Attendance Report - ${getMonthName(currentDate)}`,
            });
        } catch (error) {
            Alert.alert('Report Error', error.message || 'Failed to generate PDF report');
        } finally {
            setExportingPdf(false);
        }
    };

    const getMonthName = (date) => {
        return date.toLocaleString('default', { month: 'long', year: 'numeric' });
    };

    const years = [2024, 2025, 2026, 2027];
    const months = [
        { label: 'January', value: 1 }, { label: 'February', value: 2 },
        { label: 'March', value: 3 }, { label: 'April', value: 4 },
        { label: 'May', value: 5 }, { label: 'June', value: 6 },
        { label: 'July', value: 7 }, { label: 'August', value: 8 },
        { label: 'September', value: 9 }, { label: 'October', value: 10 },
        { label: 'November', value: 11 }, { label: 'December', value: 12 },
    ];

    const facePhoto = getFacePhotoUri(selectedDay);
    const locationAddr = getLocationAddress(selectedDay);
    const totalWorkDurationText = formatDurationHM(selectedDay?.totalWorkHours || selectedDay?.workHours || 0);
    const totalBreakDurationText = formatDurationHM(selectedDay?.totalBreakHours || selectedDay?.breakHours || 0);

    return (
        <View style={styles.container}>
            <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity
                    onPress={() => {
                        if (navigation.canGoBack()) {
                            navigation.goBack();
                        } else {
                            navigation.navigate('Dashboard');
                        }
                    }}
                    style={styles.backButton}
                >
                    <Ionicons name="arrow-back" size={22} color="#1E293B" />
                </TouchableOpacity>
                <View style={styles.headerCenter}>
                    <Text style={styles.headerTitle}>Attendance History</Text>
                    <Text style={styles.headerSubtitle}>{user?.name || 'Employee'}</Text>
                </View>
                <TouchableOpacity onPress={onRefresh} style={styles.refreshButton}>
                    <Ionicons name="sync" size={20} color="#2563EB" />
                </TouchableOpacity>
            </View>

            <ScrollView
                style={styles.mainScrollView}
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#2563EB']} />
                }
            >
                {/* Month Selector & PDF Export Bar */}
                <View style={styles.monthSelectorContainer}>
                    <TouchableOpacity
                        style={styles.monthSelectorBtn}
                        onPress={() => setShowMonthPicker(true)}
                    >
                        <Ionicons name="calendar-outline" size={16} color="#2563EB" />
                        <Text style={styles.monthSelectorText}>{getMonthName(currentDate)}</Text>
                        <Ionicons name="chevron-down" size={16} color="#64748B" />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.pdfExportBtn}
                        onPress={handleDownloadPdf}
                        disabled={exportingPdf}
                    >
                        {exportingPdf ? (
                            <ActivityIndicator size="small" color="#FFFFFF" />
                        ) : (
                            <>
                                <Ionicons name="download-outline" size={16} color="#FFFFFF" />
                                <Text style={styles.pdfExportBtnText}>Export PDF</Text>
                            </>
                        )}
                    </TouchableOpacity>
                </View>

                {/* Monthly Stats Overview */}
                <View style={styles.statsWrapper}>
                    <View style={styles.statsContainer}>
                        <StatItem label="Present" value={stats.present} color="#10B981" />
                        <StatItem label="Late/Half" value={stats.halfDay} color="#F59E0B" />
                        <StatItem label="Absent" value={stats.absent} color="#EF4444" />
                        <StatItem label="Leave" value={stats.paidLeaves || 0} color="#3B82F6" />
                    </View>
                </View>

                {/* Calendar Area */}
                <View style={styles.calendarCard}>
                    <Calendar
                        current={currentDate.toISOString().split('T')[0]}
                        key={currentDate.toISOString()}
                        monthFormat={'yyyy MM'}
                        keyExtractor={(item) => item}
                        hideExtraDays={true}
                        disableMonthChange={false}
                        firstDay={1}
                        hideArrows={true}
                        enableSwipeMonths={true}
                        onMonthChange={handleMonthChange}
                        onDayPress={handleDayPress}
                        renderHeader={() => null}
                        markingType={'multi-dot'}
                        markedDates={markedDates}
                        theme={{
                            calendarBackground: 'transparent',
                            textSectionTitleColor: '#64748B',
                            textSectionTitleDisabledColor: '#CBD5E1',
                            selectedDayBackgroundColor: '#2563EB',
                            selectedDayTextColor: '#FFFFFF',
                            todayTextColor: '#2563EB',
                            dayTextColor: '#1E293B',
                            textDisabledColor: '#CBD5E1',
                            textDayFontWeight: '700',
                            textMonthFontWeight: '800',
                            textDayHeaderFontWeight: '700',
                            textDayFontSize: 15,
                            textDayHeaderFontSize: 13,
                        }}
                        style={styles.calendar}
                    />
                </View>

                {/* Selected Day Punch Summary Card (Always Visible on Screen) */}
                {selectedDay && (
                    <View style={styles.activeDayCard}>
                        <View style={styles.activeDayHeader}>
                            <View style={styles.activeDayDateGroup}>
                                <Ionicons name="calendar" size={18} color="#2563EB" />
                                <Text style={styles.activeDayDateText}>
                                    {selectedDay.date ? new Date(selectedDay.date).toLocaleDateString('en-GB', {
                                        weekday: 'short',
                                        day: 'numeric',
                                        month: 'short',
                                        year: 'numeric'
                                    }) : 'Today'}
                                </Text>
                            </View>
                            <View style={[styles.statusBadgeSmall, { backgroundColor: `${getStatusColor(selectedDay?.status || 'absent')}20` }]}>
                                <View style={[styles.statusDotSmall, { backgroundColor: getStatusColor(selectedDay?.status || 'absent') }]} />
                                <Text style={[styles.statusTextSmall, { color: getStatusColor(selectedDay?.status || 'absent') }]}>
                                    {selectedDay?.status ? selectedDay.status.replace('_', ' ').toUpperCase() : 'NO PUNCH'}
                                </Text>
                            </View>
                        </View>

                        {/* Employee Verified Face Photo + Details */}
                        <View style={styles.summaryProfileRow}>
                            {facePhoto ? (
                                <View style={styles.photoContainer}>
                                    <Image source={{ uri: facePhoto }} style={styles.faceThumbnail} />
                                    <View style={styles.verifiedCheckBadge}>
                                        <Ionicons name="checkmark-circle" size={16} color="#10B981" />
                                    </View>
                                </View>
                            ) : (
                                <View style={styles.photoPlaceholder}>
                                    <Ionicons name="person" size={28} color="#94A3B8" />
                                </View>
                            )}

                            <View style={styles.summaryMetricsCol}>
                                <View style={styles.summaryMetricItem}>
                                    <Ionicons name="time-outline" size={15} color="#2563EB" />
                                    <Text style={styles.summaryMetricLabel}>Work Duration:</Text>
                                    <Text style={styles.summaryMetricValueBold}>{totalWorkDurationText}</Text>
                                </View>
                                <View style={styles.summaryMetricItem}>
                                    <Ionicons name="log-in-outline" size={15} color="#10B981" />
                                    <Text style={styles.summaryMetricLabel}>In:</Text>
                                    <Text style={styles.summaryMetricValue}>
                                        {selectedDay?.firstCheckInTime || selectedDay?.checkInTime || '--:--'}
                                    </Text>
                                    <Ionicons name="log-out-outline" size={15} color="#EF4444" style={{ marginLeft: 8 }} />
                                    <Text style={styles.summaryMetricLabel}>Out:</Text>
                                    <Text style={styles.summaryMetricValue}>
                                        {selectedDay?.lastCheckOutTime || selectedDay?.checkOutTime || '--:--'}
                                    </Text>
                                </View>
                                <View style={styles.summaryMetricItem}>
                                    <Ionicons name="location-outline" size={15} color="#6366F1" />
                                    <Text style={styles.summaryLocationText} numberOfLines={2}>
                                        {locationAddr}
                                    </Text>
                                </View>
                            </View>
                        </View>

                        <TouchableOpacity
                            style={styles.viewFullDetailsBtn}
                            onPress={() => setShowDetailsModal(true)}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.viewFullDetailsBtnText}>
                                View Full Punch Breakdown ({Array.isArray(selectedDay?.sessions) ? selectedDay.sessions.length : 1} Session{Array.isArray(selectedDay?.sessions) && selectedDay.sessions.length > 1 ? 's' : ''})
                            </Text>
                            <Ionicons name="arrow-forward" size={16} color="#2563EB" />
                        </TouchableOpacity>
                    </View>
                )}

                <View style={{ height: 100 }} />
            </ScrollView>

            {/* Attendance Details Modal */}
            <Modal
                visible={showDetailsModal}
                transparent
                animationType="slide"
                onRequestClose={() => setShowDetailsModal(false)}
            >
                <View style={styles.detailsOverlay}>
                    <View style={styles.detailsContent}>
                        <View style={styles.detailsHeader}>
                            <View>
                                <Text style={styles.detailsDate}>
                                    {selectedDay?.date ? new Date(selectedDay.date).toLocaleDateString('en-GB', {
                                        weekday: 'long',
                                        day: 'numeric',
                                        month: 'long',
                                        year: 'numeric'
                                    }) : 'Attendance Details'}
                                </Text>
                                <Text style={styles.detailsEmployeeSubtitle}>{user?.name} ({user?.employeeId || 'Staff'})</Text>
                            </View>
                            <TouchableOpacity onPress={() => setShowDetailsModal(false)} style={styles.modalCloseIconBtn}>
                                <Ionicons name="close" size={24} color="#64748B" />
                            </TouchableOpacity>
                        </View>

                        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 520 }}>
                            {/* Face Photo + Verification Status */}
                            <View style={styles.modalFaceCard}>
                                {facePhoto ? (
                                    <Image source={{ uri: facePhoto }} style={styles.modalFaceImage} />
                                ) : (
                                    <View style={styles.modalFacePlaceholder}>
                                        <Ionicons name="person-circle-outline" size={64} color="#94A3B8" />
                                    </View>
                                )}
                                <View style={styles.modalFaceInfo}>
                                    <View style={[styles.statusBadgeLarge, { backgroundColor: `${getStatusColor(selectedDay?.status || 'absent')}20` }]}>
                                        <View style={[styles.statusDot, { backgroundColor: getStatusColor(selectedDay?.status || 'absent') }]} />
                                        <Text style={[styles.statusTextLarge, { color: getStatusColor(selectedDay?.status || 'absent') }]}>
                                            {selectedDay?.status?.replace('_', ' ').toUpperCase() || 'ABSENT'}
                                        </Text>
                                    </View>
                                    <View style={styles.faceVerifiedTag}>
                                        <Ionicons name="shield-checkmark" size={14} color="#10B981" />
                                        <Text style={styles.faceVerifiedTagText}>Face Biometric Verified</Text>
                                    </View>
                                </View>
                            </View>

                            {/* Location Address Row */}
                            <View style={styles.locationCard}>
                                <Ionicons name="location" size={20} color="#2563EB" style={{ marginTop: 2 }} />
                                <View style={{ flex: 1, marginLeft: 10 }}>
                                    <Text style={styles.locationCardLabel}>PUNCH LOCATION</Text>
                                    <Text style={styles.locationCardAddress}>{locationAddr}</Text>
                                </View>
                            </View>

                            {/* Overall Summary Row */}
                            <View style={styles.detailsGrid}>
                                <DetailRow
                                    icon="time-outline"
                                    label="First IN"
                                    value={selectedDay?.firstCheckInTime || selectedDay?.checkInTime || '--:--'}
                                    color="#10B981"
                                />
                                <DetailRow
                                    icon="log-out-outline"
                                    label="Last OUT"
                                    value={selectedDay?.lastCheckOutTime || selectedDay?.checkOutTime || '--:--'}
                                    color="#EF4444"
                                />
                                <DetailRow
                                    icon="hourglass-outline"
                                    label="Work Duration"
                                    value={totalWorkDurationText}
                                    color="#2563EB"
                                />
                                <DetailRow
                                    icon="pause-circle-outline"
                                    label="Break Duration"
                                    value={totalBreakDurationText}
                                    color="#8B5CF6"
                                />
                            </View>

                            {/* Multi-Session Breakdown */}
                            <View style={styles.sessionsBox}>
                                <Text style={styles.sessionsBoxTitle}>
                                    Punch Sessions ({Array.isArray(selectedDay?.sessions) ? selectedDay.sessions.length : (selectedDay?.checkInTime ? 1 : 0)})
                                </Text>

                                {Array.isArray(selectedDay?.sessions) && selectedDay.sessions.length > 0 ? (
                                    selectedDay.sessions.map((sess, idx) => {
                                        const inPhoto = sess.photoRef || sess.checkinPhotoRef || null;
                                        const inAddr = sess.location?.address || sess.checkinLocation?.address || (sess.location?.latitude ? `Lat: ${sess.location.latitude.toFixed(4)}, Lng: ${sess.location.longitude.toFixed(4)}` : 'Office Location');
                                        
                                        const outPhoto = sess.checkoutPhotoRef || null;
                                        const outAddr = sess.checkoutLocation?.address || (sess.checkoutLocation?.latitude ? `Lat: ${sess.checkoutLocation.latitude.toFixed(4)}, Lng: ${sess.checkoutLocation.longitude.toFixed(4)}` : (sess.checkOut ? inAddr : 'Session in progress...'));

                                        return (
                                            <View key={idx} style={styles.sessionCard}>
                                                <View style={styles.sessionCardHeader}>
                                                    <View style={styles.sessionBadge}>
                                                        <Text style={styles.sessionBadgeText}>SESSION #{idx + 1}</Text>
                                                    </View>
                                                    <Text style={[styles.sessionStatusText, { color: sess.checkOut ? '#10B981' : '#F59E0B' }]}>
                                                        {sess.checkOut ? 'COMPLETED' : '🟢 ACTIVE'}
                                                    </Text>
                                                    <Text style={styles.sessionDurationText}>
                                                        {formatDurationHM(sess.sessionHours)}
                                                    </Text>
                                                </View>

                                                {/* PUNCH IN DETAILS */}
                                                <View style={styles.punchBoxIn}>
                                                    <View style={styles.punchBoxHeader}>
                                                        <View style={[styles.punchStatusDot, { backgroundColor: '#10B981' }]} />
                                                        <Text style={styles.punchBoxTitleIn}>PUNCH IN</Text>
                                                        <Text style={styles.punchBoxTime}>{sess.checkInTime || '--:--'}</Text>
                                                    </View>
                                                    <View style={styles.punchBoxContent}>
                                                        {inPhoto ? (
                                                            <Image source={{ uri: inPhoto }} style={styles.punchBoxThumb} />
                                                        ) : (
                                                            <View style={styles.punchBoxThumbPlaceholder}>
                                                                <Ionicons name="person" size={22} color="#10B981" />
                                                            </View>
                                                        )}
                                                        <View style={styles.punchBoxDetailsCol}>
                                                            <View style={styles.punchMetaTag}>
                                                                <Ionicons name="shield-checkmark" size={12} color="#10B981" />
                                                                <Text style={styles.punchMetaTagText}>Face Biometric Verified</Text>
                                                            </View>
                                                            <View style={styles.punchLocRow}>
                                                                <Ionicons name="location" size={13} color="#10B981" style={{ marginTop: 2 }} />
                                                                <Text style={styles.punchLocAddressText} numberOfLines={2}>
                                                                    {inAddr}
                                                                </Text>
                                                            </View>
                                                        </View>
                                                    </View>
                                                </View>

                                                {/* PUNCH OUT DETAILS */}
                                                <View style={[styles.punchBoxOut, !sess.checkOut && styles.punchBoxOutPending]}>
                                                    <View style={styles.punchBoxHeader}>
                                                        <View style={[styles.punchStatusDot, { backgroundColor: sess.checkOut ? '#EF4444' : '#F59E0B' }]} />
                                                        <Text style={[styles.punchBoxTitleOut, !sess.checkOut && { color: '#D97706' }]}>
                                                            PUNCH OUT
                                                        </Text>
                                                        <Text style={[styles.punchBoxTime, !sess.checkOut && { color: '#D97706' }]}>
                                                            {sess.checkOutTime || 'In Progress'}
                                                        </Text>
                                                    </View>
                                                    <View style={styles.punchBoxContent}>
                                                        {outPhoto ? (
                                                            <Image source={{ uri: outPhoto }} style={styles.punchBoxThumb} />
                                                        ) : (
                                                            <View style={[styles.punchBoxThumbPlaceholder, !sess.checkOut && { backgroundColor: '#FEF3C7', borderColor: '#FDE68A' }]}>
                                                                <Ionicons
                                                                    name={sess.checkOut ? "person" : "hourglass-outline"}
                                                                    size={22}
                                                                    color={sess.checkOut ? "#EF4444" : "#D97706"}
                                                                />
                                                            </View>
                                                        )}
                                                        <View style={styles.punchBoxDetailsCol}>
                                                            <View style={styles.punchMetaTag}>
                                                                <Ionicons
                                                                    name={sess.checkOut ? "shield-checkmark" : "time"}
                                                                    size={12}
                                                                    color={sess.checkOut ? "#EF4444" : "#D97706"}
                                                                />
                                                                <Text style={[styles.punchMetaTagText, { color: sess.checkOut ? '#EF4444' : '#D97706' }]}>
                                                                    {sess.checkOut ? 'Face Biometric Verified' : 'Session Active'}
                                                                </Text>
                                                            </View>
                                                            <View style={styles.punchLocRow}>
                                                                <Ionicons
                                                                    name="location"
                                                                    size={13}
                                                                    color={sess.checkOut ? "#EF4444" : "#D97706"}
                                                                    style={{ marginTop: 2 }}
                                                                />
                                                                <Text style={styles.punchLocAddressText} numberOfLines={2}>
                                                                    {outAddr}
                                                                </Text>
                                                            </View>
                                                        </View>
                                                    </View>
                                                </View>
                                            </View>
                                        );
                                    })
                                ) : (
                                    <View style={styles.singlePunchFallback}>
                                        <Text style={styles.fallbackText}>
                                            IN: {selectedDay?.firstCheckInTime || selectedDay?.checkInTime || '--:--'}  ➜  OUT: {selectedDay?.lastCheckOutTime || selectedDay?.checkOutTime || '--:--'}
                                        </Text>
                                    </View>
                                )}
                            </View>
                        </ScrollView>

                        <TouchableOpacity
                            style={styles.closeBtn}
                            onPress={() => setShowDetailsModal(false)}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.closeBtnText}>CLOSE</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Manual Month Picker Modal */}
            <Modal
                visible={showMonthPicker}
                transparent
                animationType="fade"
                onRequestClose={() => setShowMonthPicker(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Select Month & Year</Text>

                        <Text style={styles.inputLabel}>Year</Text>
                        <View style={styles.pickerRow}>
                            {years.map(y => (
                                <TouchableOpacity
                                    key={y}
                                    style={[styles.pickerChip, selectedYear === y && styles.pickerChipActive]}
                                    onPress={() => setSelectedYear(y)}
                                >
                                    <Text style={[styles.pickerChipText, selectedYear === y && styles.pickerChipTextActive]}>{y}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <Text style={styles.inputLabel}>Month</Text>
                        <View style={styles.monthGrid}>
                            {months.map(m => (
                                <TouchableOpacity
                                    key={m.value}
                                    style={[styles.monthChip, selectedMonth === m.value && styles.monthChipActive]}
                                    onPress={() => setSelectedMonth(m.value)}
                                >
                                    <Text style={[styles.monthChipText, selectedMonth === m.value && styles.monthChipTextActive]}>
                                        {m.label.substring(0, 3)}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <TouchableOpacity style={styles.confirmButton} onPress={confirmDateSelection}>
                            <Text style={styles.confirmButtonText}>APPLY</Text>
                        </TouchableOpacity>

                        <TouchableOpacity style={styles.cancelButton} onPress={() => setShowMonthPicker(false)}>
                            <Text style={styles.cancelButtonText}>CANCEL</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            <BottomNavigation />
        </View>
    );
}

const StatItem = ({ label, value, color }) => (
    <View style={styles.statItem}>
        <Text style={[styles.statValue, { color }]}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
    </View>
);

const DetailRow = ({ icon, label, value, color }) => (
    <View style={styles.detailRowContainer}>
        <View style={[styles.detailIconWrapper, { backgroundColor: `${color}15` }]}>
            <Ionicons name={icon} size={20} color={color} />
        </View>
        <View style={styles.detailInfo}>
            <Text style={styles.detailLabel}>{label}</Text>
            <Text style={styles.detailValue}>{value}</Text>
        </View>
    </View>
);

const getStatusColor = (status) => {
    switch (status) {
        case 'present': return '#10B981';
        case 'late': return '#F59E0B';
        case 'half_day': return '#F59E0B';
        case 'absent': return '#EF4444';
        case 'weekly_off': return '#64748B';
        case 'paid_leave': return '#3B82F6';
        default: return '#94A3B8';
    }
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F8FAFC',
    },
    header: {
        backgroundColor: '#FFFFFF',
        paddingTop: 50,
        paddingBottom: 16,
        paddingHorizontal: 20,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: '#E2E8F0',
    },
    backButton: {
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: '#F1F5F9',
        justifyContent: 'center',
        alignItems: 'center',
    },
    refreshButton: {
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: '#EFF6FF',
        justifyContent: 'center',
        alignItems: 'center',
    },
    headerCenter: {
        alignItems: 'center',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '800',
        color: '#1E293B',
    },
    headerSubtitle: {
        fontSize: 12,
        color: '#64748B',
        fontWeight: '600',
    },
    mainScrollView: {
        flex: 1,
    },
    monthSelectorContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingVertical: 14,
    },
    monthSelectorBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFFFFF',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 14,
        gap: 8,
        ...shadows.small,
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    monthSelectorText: {
        fontSize: 14,
        fontWeight: '800',
        color: '#1E293B',
    },
    pdfExportBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#2563EB',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 14,
        gap: 6,
        ...shadows.small,
    },
    pdfExportBtnText: {
        color: '#FFFFFF',
        fontSize: 13,
        fontWeight: '700',
    },
    statsWrapper: {
        paddingHorizontal: 20,
        marginBottom: 14,
    },
    statsContainer: {
        backgroundColor: '#FFFFFF',
        borderRadius: 20,
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 15,
        ...shadows.small,
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    statItem: {
        alignItems: 'center',
        flex: 1,
    },
    statLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: '#64748B',
        marginTop: 4,
    },
    statValue: {
        fontSize: 20,
        fontWeight: '900',
    },
    calendarCard: {
        marginHorizontal: 20,
        backgroundColor: '#FFFFFF',
        borderRadius: 20,
        padding: 12,
        ...shadows.small,
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    calendar: {
        borderRadius: 16,
    },
    activeDayCard: {
        marginHorizontal: 20,
        marginTop: 16,
        backgroundColor: '#FFFFFF',
        borderRadius: 20,
        padding: 16,
        ...shadows.small,
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    activeDayHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    activeDayDateGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    activeDayDateText: {
        fontSize: 15,
        fontWeight: '800',
        color: '#1E293B',
    },
    statusBadgeSmall: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 10,
        gap: 5,
    },
    statusDotSmall: {
        width: 7,
        height: 7,
        borderRadius: 4,
    },
    statusTextSmall: {
        fontSize: 11,
        fontWeight: '800',
    },
    summaryProfileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        marginBottom: 14,
    },
    photoContainer: {
        position: 'relative',
    },
    faceThumbnail: {
        width: 64,
        height: 64,
        borderRadius: 32,
        borderWidth: 2,
        borderColor: '#10B981',
    },
    photoPlaceholder: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: '#F1F5F9',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: '#E2E8F0',
    },
    verifiedCheckBadge: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        backgroundColor: '#FFFFFF',
        borderRadius: 10,
    },
    summaryMetricsCol: {
        flex: 1,
        gap: 4,
    },
    summaryMetricItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    summaryMetricLabel: {
        fontSize: 12,
        color: '#64748B',
        fontWeight: '600',
    },
    summaryMetricValue: {
        fontSize: 12,
        color: '#1E293B',
        fontWeight: '700',
    },
    summaryMetricValueBold: {
        fontSize: 13,
        color: '#2563EB',
        fontWeight: '800',
    },
    summaryLocationText: {
        fontSize: 11,
        color: '#475569',
        fontWeight: '500',
        flex: 1,
    },
    viewFullDetailsBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: '#EFF6FF',
        gap: 6,
    },
    viewFullDetailsBtnText: {
        fontSize: 12,
        fontWeight: '800',
        color: '#2563EB',
    },
    detailsOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    detailsContent: {
        backgroundColor: '#FFFFFF',
        borderTopLeftRadius: 30,
        borderTopRightRadius: 30,
        paddingHorizontal: 22,
        paddingTop: 24,
        paddingBottom: 40,
        ...shadows.large,
    },
    detailsHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 18,
    },
    detailsDate: {
        fontSize: 17,
        fontWeight: '900',
        color: '#1E293B',
    },
    detailsEmployeeSubtitle: {
        fontSize: 12,
        color: '#64748B',
        fontWeight: '600',
        marginTop: 2,
    },
    modalCloseIconBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: '#F1F5F9',
        justifyContent: 'center',
        alignItems: 'center',
    },
    modalFaceCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#F8FAFC',
        borderRadius: 18,
        padding: 12,
        borderWidth: 1,
        borderColor: '#E2E8F0',
        marginBottom: 14,
        gap: 14,
    },
    modalFaceImage: {
        width: 68,
        height: 68,
        borderRadius: 34,
        borderWidth: 2,
        borderColor: '#10B981',
    },
    modalFacePlaceholder: {
        width: 68,
        height: 68,
        borderRadius: 34,
        backgroundColor: '#F1F5F9',
        justifyContent: 'center',
        alignItems: 'center',
    },
    modalFaceInfo: {
        flex: 1,
        gap: 6,
    },
    statusBadgeLarge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 10,
        alignSelf: 'flex-start',
        gap: 6,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    statusTextLarge: {
        fontSize: 12,
        fontWeight: '900',
        letterSpacing: 0.5,
    },
    faceVerifiedTag: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    faceVerifiedTagText: {
        fontSize: 11,
        color: '#10B981',
        fontWeight: '700',
    },
    locationCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: '#EFF6FF',
        borderRadius: 16,
        padding: 12,
        marginBottom: 16,
    },
    locationCardLabel: {
        fontSize: 10,
        fontWeight: '800',
        color: '#2563EB',
        letterSpacing: 0.5,
    },
    locationCardAddress: {
        fontSize: 12,
        fontWeight: '600',
        color: '#1E293B',
        marginTop: 2,
        lineHeight: 16,
    },
    detailsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        marginBottom: 16,
    },
    detailRowContainer: {
        width: '48%',
        backgroundColor: '#F8FAFC',
        borderRadius: 14,
        padding: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    detailIconWrapper: {
        width: 36,
        height: 36,
        borderRadius: 10,
        justifyContent: 'center',
        alignItems: 'center',
    },
    detailInfo: {
        flex: 1,
    },
    detailLabel: {
        fontSize: 10,
        color: '#64748B',
        fontWeight: '600',
    },
    detailValue: {
        fontSize: 12,
        fontWeight: '800',
        color: '#1E293B',
        marginTop: 2,
    },
    sessionsBox: {
        backgroundColor: '#F8FAFC',
        borderRadius: 18,
        padding: 14,
        borderWidth: 1,
        borderColor: '#E2E8F0',
        marginBottom: 16,
    },
    sessionsBoxTitle: {
        fontSize: 13,
        fontWeight: '800',
        color: '#1E293B',
        marginBottom: 10,
    },
    sessionCard: {
        backgroundColor: '#FFFFFF',
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: '#E2E8F0',
        marginBottom: 10,
        gap: 8,
    },
    sessionCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    sessionBadge: {
        backgroundColor: '#EFF6FF',
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    sessionBadgeText: {
        fontSize: 10,
        fontWeight: '800',
        color: '#2563EB',
    },
    sessionStatusText: {
        fontSize: 11,
        fontWeight: '800',
    },
    sessionDurationText: {
        fontSize: 12,
        fontWeight: '800',
        color: '#1E293B',
    },
    punchBoxIn: {
        backgroundColor: '#F0FDF4',
        borderRadius: 12,
        padding: 10,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: '#DCFCE7',
    },
    punchBoxOut: {
        backgroundColor: '#FEF2F2',
        borderRadius: 12,
        padding: 10,
        borderWidth: 1,
        borderColor: '#FEE2E2',
    },
    punchBoxOutPending: {
        backgroundColor: '#FFFBEB',
        borderColor: '#FEF3C7',
    },
    punchBoxHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    punchStatusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 6,
    },
    punchBoxTitleIn: {
        fontSize: 11,
        fontWeight: '800',
        color: '#15803D',
        flex: 1,
        letterSpacing: 0.5,
    },
    punchBoxTitleOut: {
        fontSize: 11,
        fontWeight: '800',
        color: '#B91C1C',
        flex: 1,
        letterSpacing: 0.5,
    },
    punchBoxTime: {
        fontSize: 12,
        fontWeight: '800',
        color: '#1E293B',
    },
    punchBoxContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    punchBoxThumb: {
        width: 48,
        height: 48,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: '#FFFFFF',
    },
    punchBoxThumbPlaceholder: {
        width: 48,
        height: 48,
        borderRadius: 10,
        backgroundColor: '#DCFCE7',
        borderWidth: 1,
        borderColor: '#BBF7D0',
        justifyContent: 'center',
        alignItems: 'center',
    },
    punchBoxDetailsCol: {
        flex: 1,
    },
    punchMetaTag: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginBottom: 3,
    },
    punchMetaTagText: {
        fontSize: 10,
        fontWeight: '700',
        color: '#15803D',
    },
    punchLocRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 4,
    },
    punchLocAddressText: {
        fontSize: 11,
        color: '#475569',
        flex: 1,
        lineHeight: 15,
        fontWeight: '500',
    },
    singlePunchFallback: {
        padding: 10,
        alignItems: 'center',
    },
    fallbackText: {
        fontSize: 13,
        fontWeight: '700',
        color: '#1E293B',
    },
    closeBtn: {
        backgroundColor: '#1E293B',
        paddingVertical: 14,
        borderRadius: 16,
        alignItems: 'center',
        ...shadows.medium,
    },
    closeBtnText: {
        color: '#FFFFFF',
        fontSize: 14,
        fontWeight: '800',
        letterSpacing: 0.5,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    modalContent: {
        width: '88%',
        backgroundColor: '#FFFFFF',
        borderRadius: 24,
        padding: 22,
        ...shadows.large,
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: '900',
        color: '#1E293B',
        marginBottom: 20,
        textAlign: 'center',
    },
    inputLabel: {
        fontSize: 11,
        fontWeight: '800',
        color: '#64748B',
        marginBottom: 10,
        textTransform: 'uppercase',
    },
    pickerRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 18,
    },
    pickerChip: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 12,
        backgroundColor: '#F1F5F9',
    },
    pickerChipActive: {
        backgroundColor: '#2563EB',
    },
    pickerChipText: {
        color: '#64748B',
        fontWeight: '700',
        fontSize: 13,
    },
    pickerChipTextActive: {
        color: '#FFFFFF',
    },
    monthGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    monthChip: {
        width: '31%',
        alignItems: 'center',
        paddingVertical: 10,
        borderRadius: 10,
        backgroundColor: '#F1F5F9',
    },
    monthChipActive: {
        backgroundColor: '#2563EB',
    },
    monthChipText: {
        color: '#64748B',
        fontWeight: '700',
        fontSize: 12,
    },
    monthChipTextActive: {
        color: '#FFFFFF',
    },
    confirmButton: {
        backgroundColor: '#2563EB',
        paddingVertical: 14,
        borderRadius: 14,
        alignItems: 'center',
        marginTop: 24,
    },
    confirmButtonText: {
        color: '#FFFFFF',
        fontSize: 14,
        fontWeight: '800',
    },
    cancelButton: {
        paddingVertical: 12,
        alignItems: 'center',
        marginTop: 4,
    },
    cancelButtonText: {
        color: '#64748B',
        fontWeight: '700',
        fontSize: 13,
    },
});
