import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    StatusBar,
    ActivityIndicator,
    Modal,
    ScrollView,
    Alert,
    Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Calendar } from 'react-native-calendars';
import { db, attendanceHelpers } from '../../services/firebaseConfig';
import { attendanceEngine } from '../../services/attendanceEngine';
import {
    formatDate,
    formatDurationHM,
    getFacePhotoUri,
    getLocationAddress
} from '../../utils/attendance';
import { pdfReportService } from '../../services/pdfReportService';

export default function AdminEmployeeHistoryScreen({ route, navigation }) {
    const { employee } = route.params;
    const [loading, setLoading] = useState(true);
    const [markedDates, setMarkedDates] = useState({});
    const [currentDate, setCurrentDate] = useState(new Date());
    const [stats, setStats] = useState({ present: 0, absent: 0, late: 0, paidLeave: 0 });
    const [showMonthPicker, setShowMonthPicker] = useState(false);
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
    const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
    const [attendanceRecords, setAttendanceRecords] = useState([]);

    // Day details modal state
    const [selectedDay, setSelectedDay] = useState(null);
    const [showDetailsModal, setShowDetailsModal] = useState(false);
    const [previewPhotoUri, setPreviewPhotoUri] = useState(null);
    const [showPhotoPreview, setShowPhotoPreview] = useState(false);

    useEffect(() => {
        const unsubscribe = navigation.addListener('focus', () => {
            loadEmployeeHistory();
        });
        return unsubscribe;
    }, [navigation, currentDate]);

    const loadEmployeeHistory = async () => {
        try {
            setLoading(true);
            const targetUid = employee.uid || employee.id || employee.userId;
            let records = [];

            // 1. Fetch records using attendanceHelpers
            if (targetUid) {
                const helperRes = await attendanceHelpers.getUserAttendance(targetUid);
                if (helperRes?.success && Array.isArray(helperRes.records)) {
                    records = [...helperRes.records];
                }
            }

            // 2. Direct fetch of today's atomic record to ensure today's punches are immediately present
            if (targetUid) {
                const todayRes = await attendanceEngine.getTodayRecord(targetUid, employee.companyId);
                if (todayRes?.exists && todayRes.data) {
                    const todayData = todayRes.data;
                    const existingIdx = records.findIndex(r => r.date === todayData.date);
                    if (existingIdx !== -1) {
                        records[existingIdx] = todayData;
                    } else {
                        records.unshift(todayData);
                    }
                }
            }

            // 3. Fallback: Query by targetUid in attendance
            if (records.length === 0 && targetUid) {
                const snapshot = await db.collection('attendance')
                    .where('userId', '==', targetUid);
                records = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            }

            // 4. Secondary fallback: Query by employeeId
            if (employee.employeeId) {
                const empSnap = await db.collection('attendance')
                    .where('employeeId', '==', employee.employeeId);
                empSnap.docs.forEach(doc => {
                    const data = { id: doc.id, ...doc.data() };
                    if (!records.some(r => r.date === data.date || r.id === data.id)) {
                        records.push(data);
                    }
                });
            }

            setAttendanceRecords(records);
            calculateStats(records, currentDate);
            generateMarkedDates(records);
        } catch (error) {
            console.error('Error loading history:', error);
        } finally {
            setLoading(false);
        }
    };

    const calculateStats = (records, date) => {
        const month = date.getMonth();
        const year = date.getFullYear();
        const monthRecords = records.filter(r => {
            const d = new Date(r.date);
            return d.getMonth() === month && d.getFullYear() === year;
        });

        setStats({
            present: monthRecords.filter(r => r.status === 'present').length,
            late: monthRecords.filter(r => r.status === 'late' || r.status === 'half_day').length,
            absent: monthRecords.filter(r => r.status === 'absent').length,
            paidLeave: monthRecords.filter(r => r.status === 'paid_leave').length,
        });
    };

    const generateMarkedDates = (records) => {
        const marked = {};

        // 1. Mark existing records
        records.forEach(record => {
            let color = '#BDC3C7';
            if (record.status === 'present') color = '#2ECC71';
            else if (record.status === 'absent') color = '#E74C3C';
            else if (record.status === 'late' || record.status === 'half_day') color = '#F39C12';
            else if (record.status === 'weekly_off') color = '#607D8B';
            else if (record.status === 'paid_leave') color = '#4A90E2';

            marked[record.date] = {
                customStyles: {
                    container: { backgroundColor: color, borderRadius: 8 },
                    text: { color: 'white', fontWeight: 'bold' }
                }
            };
        });

        // 2. Mark specific days for the current displayed month
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const todayStr = formatDate(new Date());

        for (let i = 1; i <= daysInMonth; i++) {
            const date = new Date(year, month, i);
            const dateString = formatDate(date);

            if (!marked[dateString]) {
                const isSunday = date.getDay() === 0;
                const isPast = dateString < todayStr;

                if (isSunday) {
                    marked[dateString] = {
                        customStyles: {
                            container: { backgroundColor: '#B0BEC5', borderRadius: 8 },
                            text: { color: 'white' }
                        }
                    };
                } else if (isPast) {
                    marked[dateString] = {
                        customStyles: {
                            container: { backgroundColor: '#FFCDD2', borderRadius: 8 },
                            text: { color: '#C62828' }
                        }
                    };
                }
            }
        }

        setMarkedDates(marked);
    };

    const confirmDateSelection = () => {
        setCurrentDate(new Date(selectedYear, selectedMonth - 1, 1));
        setShowMonthPicker(false);
    };

    const formatDisplayDate = (dateStr) => {
        if (!dateStr) return '';
        try {
            const d = new Date(dateStr + 'T00:00:00');
            return d.toLocaleDateString('en-US', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            });
        } catch {
            return dateStr;
        }
    };

    const getStatusColor = (status) => {
        switch (status) {
            case 'present': return '#10B981';
            case 'late': return '#F59E0B';
            case 'half_day': return '#8B5CF6';
            case 'absent': return '#EF4444';
            case 'weekly_off': return '#64748B';
            case 'paid_leave': return '#3B82F6';
            default: return '#64748B';
        }
    };

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()}>
                    <Ionicons name="arrow-back" size={24} color="#FFF" />
                </TouchableOpacity>
                <View style={styles.headerInfo}>
                    <Text style={styles.headerTitle}>{employee.name}</Text>
                    <Text style={styles.headerSub}>{employee.employeeId || 'EMP'}</Text>
                </View>
                <View style={{ width: 24 }} />
            </View>

            <View style={[styles.monthBar, { justifyContent: 'space-between', paddingHorizontal: 16 }]}>
                <TouchableOpacity style={styles.monthBtn} onPress={() => setShowMonthPicker(true)}>
                    <Text style={styles.monthText}>
                        {currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
                    </Text>
                    <Ionicons name="caret-down" size={16} color="#2C3E50" />
                </TouchableOpacity>

                <TouchableOpacity
                    style={{
                        backgroundColor: '#2563EB',
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6
                    }}
                    onPress={async () => {
                        try {
                            const month = currentDate.getMonth();
                            const year = currentDate.getFullYear();
                            const monthRecords = attendanceRecords.filter(r => {
                                const d = new Date(r.date);
                                return d.getMonth() === month && d.getFullYear() === year;
                            });
                            await pdfReportService.generateEmployeeReport({
                                employee,
                                company: { name: 'SmartAttend Enterprise' },
                                records: monthRecords,
                                periodTitle: `Attendance Audit - ${employee.name} (${currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })})`,
                            });
                        } catch (e) {
                            Alert.alert('Error', e.message || 'Failed to export PDF');
                        }
                    }}
                >
                    <Ionicons name="document-text-outline" size={16} color="#FFF" />
                    <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 12 }}>Export PDF</Text>
                </TouchableOpacity>
            </View>

            <View style={styles.statsCard}>
                <StatItem label="Present" value={stats.present} color="#2ECC71" />
                <StatItem label="Late" value={stats.late} color="#F39C12" />
                <StatItem label="Absent" value={stats.absent} color="#E74C3C" />
                <StatItem label="Paid Leave" value={stats.paidLeave} color="#4A90E2" />
            </View>

            {loading ? (
                <View style={styles.loading}>
                    <ActivityIndicator size="large" color="#1a2a6c" />
                </View>
            ) : (
                <Calendar
                    current={currentDate.toISOString().split('T')[0]}
                    key={currentDate.toISOString()}
                    markingType={'custom'}
                    markedDates={markedDates}
                    enableSwipeMonths={true}
                    theme={{
                        calendarBackground: '#FFF',
                        todayTextColor: '#1a2a6c',
                        dayTextColor: '#2C3E50',
                        textDayFontWeight: 'bold',
                    }}
                    style={styles.calendar}
                    onDayPress={(day) => {
                        const existingRecord = attendanceRecords.find(r => r.date === day.dateString);
                        const dayRecord = existingRecord || {
                            date: day.dateString,
                            status: 'absent',
                            checkInTime: '--:--',
                            checkOutTime: '--:--',
                            workHours: 0,
                            sessions: []
                        };
                        setSelectedDay(dayRecord);
                        setShowDetailsModal(true);
                    }}
                />
            )}

            {/* Day Details Modal (Same as Employee History Screen with Face Photos) */}
            <Modal
                visible={showDetailsModal}
                transparent
                animationType="slide"
                onRequestClose={() => setShowDetailsModal(false)}
            >
                <View style={styles.detailsModalOverlay}>
                    <View style={styles.detailsModalContent}>
                        {/* Modal Header */}
                        <View style={styles.detailsModalHeader}>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.detailsModalTitle}>
                                    {formatDisplayDate(selectedDay?.date)}
                                </Text>
                                <Text style={styles.detailsModalSubtitle}>
                                    {employee.name} ({employee.employeeId || 'EMP'})
                                </Text>
                            </View>
                            <TouchableOpacity
                                onPress={() => setShowDetailsModal(false)}
                                style={styles.modalCloseIconBtn}
                            >
                                <Ionicons name="close" size={24} color="#64748B" />
                            </TouchableOpacity>
                        </View>

                        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 520 }}>
                            {/* Face Photo + Verification Status Card */}
                            {(() => {
                                const facePhoto = getFacePhotoUri(selectedDay);
                                const statusColor = getStatusColor(selectedDay?.status || 'absent');
                                const hasFace = Boolean(facePhoto);
                                return (
                                    <View style={styles.modalFaceCard}>
                                        {hasFace ? (
                                            <TouchableOpacity
                                                onPress={() => {
                                                    setPreviewPhotoUri(facePhoto);
                                                    setShowPhotoPreview(true);
                                                }}
                                                style={styles.faceImageTouchable}
                                            >
                                                <Image source={{ uri: facePhoto }} style={styles.modalFaceImage} />
                                                <View style={styles.zoomBadge}>
                                                    <Ionicons name="expand-outline" size={12} color="#FFF" />
                                                </View>
                                            </TouchableOpacity>
                                        ) : (
                                            <View style={styles.modalFacePlaceholder}>
                                                <Ionicons name="person-circle-outline" size={60} color="#94A3B8" />
                                            </View>
                                        )}
                                        <View style={styles.modalFaceInfo}>
                                            <View style={[styles.statusBadgeLarge, { backgroundColor: `${statusColor}20` }]}>
                                                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                                                <Text style={[styles.statusTextLarge, { color: statusColor }]}>
                                                    {selectedDay?.status?.replace('_', ' ').toUpperCase() || 'ABSENT'}
                                                </Text>
                                            </View>
                                            <View style={styles.faceVerifiedTag}>
                                                <Ionicons
                                                    name={hasFace ? "shield-checkmark" : "shield-outline"}
                                                    size={14}
                                                    color={hasFace ? "#10B981" : "#94A3B8"}
                                                />
                                                <Text style={[styles.faceVerifiedTagText, !hasFace && { color: "#94A3B8" }]}>
                                                    {hasFace ? 'Face Biometric Verified' : 'Face Biometric Not Found'}
                                                </Text>
                                            </View>
                                        </View>
                                    </View>
                                );
                            })()}

                            {/* Location Address Row */}
                            <View style={styles.locationCard}>
                                <Ionicons name="location" size={20} color="#2563EB" style={{ marginTop: 2 }} />
                                <View style={{ flex: 1, marginLeft: 10 }}>
                                    <Text style={styles.locationCardLabel}>PUNCH LOCATION</Text>
                                    <Text style={styles.locationCardAddress}>{getLocationAddress(selectedDay)}</Text>
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
                                    value={formatDurationHM(selectedDay?.totalWorkHours || selectedDay?.workHours)}
                                    color="#2563EB"
                                />
                                <DetailRow
                                    icon="pause-circle-outline"
                                    label="Break Duration"
                                    value={formatDurationHM(selectedDay?.totalBreakHours || selectedDay?.breakHours)}
                                    color="#8B5CF6"
                                />
                            </View>

                            {/* Multi-Session Breakdown */}
                            <View style={styles.sessionsBox}>
                                <Text style={styles.sessionsBoxTitle}>
                                    Punch Sessions ({Array.isArray(selectedDay?.sessions) ? selectedDay.sessions.length : (selectedDay?.checkInTime && selectedDay?.checkInTime !== '--:--' ? 1 : 0)})
                                </Text>

                                {Array.isArray(selectedDay?.sessions) && selectedDay.sessions.length > 0 ? (
                                    selectedDay.sessions.map((sess, idx) => {
                                        const inPhoto = sess.photoRef || sess.checkinPhotoRef || sess.checkInImage || null;
                                        const inAddr = sess.location?.address || sess.checkinLocation?.address || (sess.location?.latitude ? `Lat: ${sess.location.latitude.toFixed(4)}, Lng: ${sess.location.longitude.toFixed(4)}` : 'Office Location');

                                        const outPhoto = sess.checkoutPhotoRef || sess.checkOutImage || null;
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
                                                            <TouchableOpacity
                                                                onPress={() => {
                                                                    setPreviewPhotoUri(inPhoto);
                                                                    setShowPhotoPreview(true);
                                                                }}
                                                                style={styles.thumbTouchable}
                                                            >
                                                                <Image source={{ uri: inPhoto }} style={styles.punchBoxThumb} />
                                                                <View style={styles.zoomBadgeSmall}>
                                                                    <Ionicons name="expand-outline" size={8} color="#FFF" />
                                                                </View>
                                                            </TouchableOpacity>
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
                                                            <TouchableOpacity
                                                                onPress={() => {
                                                                    setPreviewPhotoUri(outPhoto);
                                                                    setShowPhotoPreview(true);
                                                                }}
                                                                style={styles.thumbTouchable}
                                                            >
                                                                <Image source={{ uri: outPhoto }} style={styles.punchBoxThumb} />
                                                                <View style={styles.zoomBadgeSmall}>
                                                                    <Ionicons name="expand-outline" size={8} color="#FFF" />
                                                                </View>
                                                            </TouchableOpacity>
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
                                ) : selectedDay?.checkInTime && selectedDay?.checkInTime !== '--:--' ? (
                                    <View style={styles.singlePunchFallback}>
                                        <Text style={styles.fallbackText}>
                                            Single Session: {selectedDay.checkInTime} ➔ {selectedDay.checkOutTime || 'Active'}
                                        </Text>
                                    </View>
                                ) : (
                                    <View style={{ padding: 15, alignItems: 'center' }}>
                                        <Ionicons name="calendar-outline" size={32} color="#CBD5E1" />
                                        <Text style={{ color: '#94A3B8', fontSize: 13, marginTop: 4 }}>
                                            No punch activity recorded for this day
                                        </Text>
                                    </View>
                                )}
                            </View>

                            {/* Action Buttons */}
                            <TouchableOpacity
                                style={styles.adminEditBtn}
                                onPress={() => {
                                    setShowDetailsModal(false);
                                    navigation.navigate('AdminEditAttendance', {
                                        record: selectedDay,
                                        employee: employee,
                                        date: selectedDay.date
                                    });
                                }}
                            >
                                <Ionicons name="create-outline" size={18} color="#FFF" />
                                <Text style={styles.adminEditBtnText}>Edit / Override Attendance</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                onPress={() => setShowDetailsModal(false)}
                                style={styles.closeBtn}
                            >
                                <Text style={styles.closeBtnText}>CLOSE</Text>
                            </TouchableOpacity>
                        </ScrollView>
                    </View>
                </View>
            </Modal>

            {/* Photo Preview Modal */}
            <Modal
                visible={showPhotoPreview}
                transparent
                animationType="fade"
                onRequestClose={() => setShowPhotoPreview(false)}
            >
                <View style={styles.previewOverlay}>
                    <View style={styles.previewCard}>
                        <View style={styles.previewHeader}>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.previewTitle}>{employee.name}</Text>
                                <Text style={styles.previewSubtitle}>Biometric Face Capture ({selectedDay?.date})</Text>
                            </View>
                            <TouchableOpacity
                                onPress={() => setShowPhotoPreview(false)}
                                style={styles.previewCloseBtn}
                            >
                                <Ionicons name="close" size={24} color="#FFF" />
                            </TouchableOpacity>
                        </View>
                        {previewPhotoUri ? (
                            <Image
                                source={{ uri: previewPhotoUri }}
                                style={styles.previewImage}
                                resizeMode="contain"
                            />
                        ) : null}
                    </View>
                </View>
            </Modal>

            {/* Month Picker Modal */}
            <Modal visible={showMonthPicker} transparent animationType="fade">
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Select Month</Text>
                        <View style={styles.yearRow}>
                            {[2025, 2026].map(y => (
                                <TouchableOpacity
                                    key={y}
                                    style={[styles.chip, selectedYear === y && styles.chipActive]}
                                    onPress={() => setSelectedYear(y)}
                                >
                                    <Text style={[styles.chipText, selectedYear === y && styles.chipTextActive]}>{y}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        <View style={styles.monthGrid}>
                            {Array.from({ length: 12 }).map((_, i) => (
                                <TouchableOpacity
                                    key={i}
                                    style={[styles.mChip, selectedMonth === i + 1 && styles.chipActive]}
                                    onPress={() => setSelectedMonth(i + 1)}
                                >
                                    <Text style={[styles.chipText, selectedMonth === i + 1 && styles.chipTextActive]}>
                                        {new Date(0, i).toLocaleString('default', { month: 'short' })}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        <TouchableOpacity style={styles.confirmBtn} onPress={confirmDateSelection}>
                            <Text style={styles.confirmText}>CONFIRM</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const DetailRow = ({ icon, label, value, color }) => (
    <View style={styles.detailRowContainer}>
        <View style={[styles.detailIconWrapper, { backgroundColor: `${color}15` }]}>
            <Ionicons name={icon} size={18} color={color} />
        </View>
        <View style={styles.detailInfo}>
            <Text style={styles.detailLabel}>{label}</Text>
            <Text style={styles.detailValue} numberOfLines={1}>{value}</Text>
        </View>
    </View>
);

const StatItem = ({ label, value, color }) => (
    <View style={styles.statItem}>
        <Text style={[styles.statValue, { color }]}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
    </View>
);

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F5F5F5' },
    header: { backgroundColor: '#1a2a6c', paddingTop: 50, paddingBottom: 20, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center' },
    headerInfo: { flex: 1, alignItems: 'center' },
    headerTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
    headerSub: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
    monthBar: { backgroundColor: '#E0F2F1', paddingVertical: 10, alignItems: 'center' },
    monthBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#FFF', paddingHorizontal: 15, paddingVertical: 5, borderRadius: 20 },
    monthText: { fontWeight: 'bold', color: '#2C3E50' },
    statsCard: { margin: 15, backgroundColor: '#FFF', borderRadius: 15, flexDirection: 'row', padding: 15, elevation: 3 },
    statItem: { flex: 1, alignItems: 'center' },
    statValue: { fontSize: 20, fontWeight: 'bold' },
    statLabel: { fontSize: 12, color: '#95A5A6', marginTop: 2 },
    calendar: { marginHorizontal: 15, borderRadius: 15, elevation: 2 },
    loading: { flex: 1, justifyContent: 'center' },

    // Day Details Modal Styles
    detailsModalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(15, 23, 42, 0.7)',
        justifyContent: 'flex-end',
    },
    detailsModalContent: {
        backgroundColor: '#FFFFFF',
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        padding: 20,
        maxHeight: '90%',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
        elevation: 10,
    },
    detailsModalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#F1F5F9',
        marginBottom: 16,
    },
    detailsModalTitle: {
        fontSize: 17,
        fontWeight: '800',
        color: '#1E293B',
    },
    detailsModalSubtitle: {
        fontSize: 13,
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
    faceImageTouchable: {
        position: 'relative',
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
    zoomBadge: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.75)',
        width: 20,
        height: 20,
        borderRadius: 10,
        justifyContent: 'center',
        alignItems: 'center',
    },
    zoomBadgeSmall: {
        position: 'absolute',
        bottom: 2,
        right: 2,
        backgroundColor: 'rgba(15, 23, 42, 0.75)',
        width: 16,
        height: 16,
        borderRadius: 8,
        justifyContent: 'center',
        alignItems: 'center',
    },
    thumbTouchable: {
        position: 'relative',
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
    adminEditBtn: {
        backgroundColor: '#2563EB',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 14,
        borderRadius: 14,
        marginBottom: 10,
    },
    adminEditBtnText: {
        color: '#FFF',
        fontSize: 14,
        fontWeight: '700',
    },
    closeBtn: {
        backgroundColor: '#F1F5F9',
        paddingVertical: 13,
        borderRadius: 14,
        alignItems: 'center',
        marginBottom: 10,
    },
    closeBtnText: {
        color: '#475569',
        fontSize: 14,
        fontWeight: '700',
    },

    // Photo Preview Modal Styles
    previewOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
    },
    previewCard: {
        width: '100%',
        maxWidth: 380,
        backgroundColor: '#1E293B',
        borderRadius: 20,
        padding: 16,
        alignItems: 'center',
    },
    previewHeader: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
    },
    previewTitle: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: 'bold',
    },
    previewSubtitle: {
        color: '#94A3B8',
        fontSize: 12,
        marginTop: 2,
    },
    previewCloseBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(255,255,255,0.2)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewImage: {
        width: 320,
        height: 320,
        borderRadius: 16,
        backgroundColor: '#0F172A',
    },

    // Month Picker Modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
    modalContent: { width: '85%', backgroundColor: '#FFF', borderRadius: 20, padding: 20 },
    modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
    yearRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginBottom: 15 },
    chip: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20, backgroundColor: '#F0F0F0' },
    mChip: { width: '23%', paddingVertical: 10, alignItems: 'center', borderRadius: 10, backgroundColor: '#F0F0F0', marginBottom: 8 },
    chipActive: { backgroundColor: '#1a2a6c' },
    chipText: { color: '#2C3E50' },
    chipTextActive: { color: '#FFF' },
    monthGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
    confirmBtn: { backgroundColor: '#1ABC9C', paddingVertical: 15, borderRadius: 10, alignItems: 'center', marginTop: 20 },
    confirmText: { color: '#FFF', fontWeight: 'bold' }
});