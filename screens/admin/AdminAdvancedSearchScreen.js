import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    StatusBar,
    FlatList,
    ActivityIndicator,
    TextInput,
    Modal,
    Alert,
    ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { db } from '../../services/firebaseConfig';
import { useAuth } from '../../context/AuthContext';
import { pdfReportService } from '../../services/pdfReportService';
import Colors from '../../constants/Colors';

export default function AdminAdvancedSearchScreen({ navigation }) {
    const { user, company } = useAuth();
    const [employees, setEmployees] = useState([]);
    const [allMonthAttendance, setAllMonthAttendance] = useState([]);
    const [filteredData, setFilteredData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [exporting, setExporting] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    // Selected Employees for multi-export (Set of uid strings)
    const [selectedEmpUids, setSelectedEmpUids] = useState(new Set());

    // Date State
    const [selectedDate, setSelectedDate] = useState(new Date());
    const [showMonthPicker, setShowMonthPicker] = useState(false);
    const [pickerYear, setPickerYear] = useState(new Date().getFullYear());

    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    useEffect(() => {
        loadData();
    }, [selectedDate]);

    const loadData = async () => {
        try {
            setLoading(true);

            // 1. Fetch all employees of this company
            const usersSnapshot = await db.collection('users')
                .where('companyId', '==', user.companyId);
            const empList = usersSnapshot.docs
                .map(doc => doc.data())
                .filter(u => u.role !== 'admin' && u.role !== 'COMPANY_ADMIN' && u.role !== 'SUPER_ADMIN')
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

            // 2. Fetch all attendance for the company
            const year = selectedDate.getFullYear();
            const month = (selectedDate.getMonth() + 1).toString().padStart(2, '0');
            const monthPrefix = `${year}-${month}`;

            const attendanceSnapshot = await db.collection('attendance')
                .where('companyId', '==', user.companyId);
            const allAttendance = attendanceSnapshot.docs.map(doc => doc.data());

            // Filter attendance records belonging to this month
            const monthAttendance = allAttendance.filter(a =>
                a.date && a.date.startsWith(monthPrefix)
            );
            setAllMonthAttendance(monthAttendance);

            // 3. Process data: Calculate stats for each employee for the month
            const reportData = empList.map(emp => {
                const targetUid = emp.uid || emp.id;
                const empAttendance = monthAttendance.filter(a =>
                    a.userId === targetUid || a.employeeId === emp.employeeId
                );

                const present = empAttendance.filter(a => a.status === 'present').length;
                const late = empAttendance.filter(a => a.status === 'late').length;
                const halfDay = empAttendance.filter(a => a.status === 'half_day').length;
                const absent = empAttendance.filter(a => a.status === 'absent').length;
                const paidLeave = empAttendance.filter(a => a.status === 'paid_leave').length;
                const totalHours = empAttendance.reduce((acc, a) => acc + (a.workHours || a.totalWorkHours || 0), 0);

                return {
                    ...emp,
                    stats: {
                        present,
                        late,
                        halfDay,
                        absent,
                        paidLeave,
                        hours: parseFloat(totalHours.toFixed(1))
                    },
                    monthRecords: empAttendance,
                };
            });

            setEmployees(reportData);
            applyFilter(reportData, searchQuery);
        } catch (error) {
            console.error('Error loading report:', error);
            Alert.alert('Error', 'Failed to load employee attendance data');
        } finally {
            setLoading(false);
        }
    };

    const applyFilter = (dataList, query) => {
        if (!query || query.trim() === '') {
            setFilteredData(dataList);
        } else {
            const q = query.toLowerCase();
            const filtered = dataList.filter(item =>
                item.name?.toLowerCase().includes(q) ||
                item.employeeId?.toLowerCase().includes(q) ||
                item.department?.toLowerCase().includes(q)
            );
            setFilteredData(filtered);
        }
    };

    const handleSearch = (text) => {
        setSearchQuery(text);
        applyFilter(employees, text);
    };

    const changeMonth = (offset) => {
        const newDate = new Date(selectedDate);
        newDate.setMonth(newDate.getMonth() + offset);
        setSelectedDate(newDate);
    };

    // Toggle employee selection
    const toggleSelectEmployee = (uid) => {
        setSelectedEmpUids(prev => {
            const updated = new Set(prev);
            if (updated.has(uid)) {
                updated.delete(uid);
            } else {
                updated.add(uid);
            }
            return updated;
        });
    };

    const selectAllEmployees = () => {
        const allUids = new Set(filteredData.map(e => e.uid || e.id));
        setSelectedEmpUids(allUids);
    };

    const clearSelection = () => {
        setSelectedEmpUids(new Set());
    };

    // Export PDF for a single employee
    const handleExportSingleEmployee = async (emp) => {
        try {
            setExporting(true);
            const monthName = months[selectedDate.getMonth()];
            const year = selectedDate.getFullYear();
            const periodTitle = `Monthly Attendance Report - ${monthName} ${year}`;

            await pdfReportService.generateEmployeeReport({
                employee: emp,
                company: company || { name: user?.companyName || 'SmartAttend Enterprise' },
                records: emp.monthRecords || [],
                periodTitle,
            });
        } catch (error) {
            Alert.alert('Export Error', error.message || 'Could not export employee report.');
        } finally {
            setExporting(false);
        }
    };

    // Export PDF for multiple / all employees
    const handleExportReport = async () => {
        try {
            setExporting(true);
            const monthName = months[selectedDate.getMonth()];
            const year = selectedDate.getFullYear();
            const periodTitle = `Organization Attendance Report - ${monthName} ${year}`;

            // Determine which employees to export
            const isMultiSelected = selectedEmpUids.size > 0;
            const targetEmployees = isMultiSelected
                ? employees.filter(e => selectedEmpUids.has(e.uid || e.id))
                : employees;

            if (targetEmployees.length === 0) {
                Alert.alert('Notice', 'No employees available to export.');
                setExporting(false);
                return;
            }

            // Gather all records for target employees
            const targetUids = new Set(targetEmployees.map(e => e.uid || e.id));
            const targetEmpIds = new Set(targetEmployees.map(e => e.employeeId));

            const relevantRecords = allMonthAttendance.filter(a =>
                targetUids.has(a.userId) || targetEmpIds.has(a.employeeId)
            );

            await pdfReportService.generateAdminReport({
                company: company || { name: user?.companyName || 'SmartAttend Enterprise' },
                records: relevantRecords,
                employees: targetEmployees,
                periodTitle,
                filters: {
                    month: `${monthName} ${year}`,
                    employeeCount: targetEmployees.length,
                    isFiltered: isMultiSelected,
                },
            });
        } catch (error) {
            Alert.alert('Export Error', error.message || 'Could not export attendance report.');
        } finally {
            setExporting(false);
        }
    };

    const renderReportItem = ({ item }) => {
        const itemUid = item.uid || item.id;
        const isSelected = selectedEmpUids.has(itemUid);

        return (
            <View style={[styles.reportCard, isSelected && styles.selectedCard]}>
                <View style={styles.cardHeader}>
                    {/* Checkbox for Multi-select */}
                    <TouchableOpacity
                        style={styles.checkboxContainer}
                        onPress={() => toggleSelectEmployee(itemUid)}
                    >
                        <Ionicons
                            name={isSelected ? "checkbox" : "square-outline"}
                            size={24}
                            color={isSelected ? "#4A90E2" : "#BDC3C7"}
                        />
                    </TouchableOpacity>

                    {/* Employee Info */}
                    <TouchableOpacity
                        style={styles.empInfoArea}
                        onPress={() => navigation.navigate('AdminEmployeeDetail', { employee: item })}
                    >
                        <View>
                            <Text style={styles.empName}>{item.name}</Text>
                            <Text style={styles.empId}>{item.employeeId}</Text>
                        </View>
                        <View style={styles.deptTag}>
                            <Text style={styles.deptText}>{item.department || 'General'}</Text>
                        </View>
                    </TouchableOpacity>

                    {/* Individual Single PDF Export */}
                    <TouchableOpacity
                        style={styles.singlePdfBtn}
                        onPress={() => handleExportSingleEmployee(item)}
                        disabled={exporting}
                    >
                        <Ionicons name="document-text" size={16} color="#4A90E2" />
                        <Text style={styles.singlePdfText}>PDF</Text>
                    </TouchableOpacity>
                </View>

                {/* Stats Matrix */}
                <TouchableOpacity
                    onPress={() => navigation.navigate('AdminEmployeeDetail', { employee: item })}
                >
                    <View style={styles.statsContainer}>
                        <View style={[styles.statBox, { borderLeftColor: '#2ECC71' }]}>
                            <Text style={styles.statValue}>{item.stats.present}</Text>
                            <Text style={styles.statLabel}>Present</Text>
                        </View>
                        <View style={[styles.statBox, { borderLeftColor: '#F39C12' }]}>
                            <Text style={styles.statValue}>{item.stats.late + item.stats.halfDay}</Text>
                            <Text style={styles.statLabel}>Late/Half</Text>
                        </View>
                        <View style={[styles.statBox, { borderLeftColor: '#E74C3C' }]}>
                            <Text style={styles.statValue}>{item.stats.absent}</Text>
                            <Text style={styles.statLabel}>Absent</Text>
                        </View>
                        <View style={[styles.statBox, { borderLeftColor: '#3498DB' }]}>
                            <Text style={styles.statValue}>{item.stats.paidLeave}</Text>
                            <Text style={styles.statLabel}>Leave</Text>
                        </View>
                        <View style={[styles.statBox, { borderLeftColor: '#9B59B6' }]}>
                            <Text style={styles.statValue}>{item.stats.hours}h</Text>
                            <Text style={styles.statLabel}>Hours</Text>
                        </View>
                    </View>
                </TouchableOpacity>
            </View>
        );
    };

    return (
        <View style={styles.container}>
            <StatusBar barStyle="dark-content" />

            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                    <Ionicons name="arrow-back" size={24} color="#2C3E50" />
                </TouchableOpacity>
                <View style={styles.headerTitleContainer}>
                    <Text style={styles.headerTitle}>Advanced Reports</Text>
                    <Text style={styles.headerSubtitle}>Month-wise & Multi-Employee PDF</Text>
                </View>
                <TouchableOpacity
                    style={[styles.exportHeaderBtn, exporting && { opacity: 0.6 }]}
                    onPress={handleExportReport}
                    disabled={exporting || loading}
                >
                    {exporting ? (
                        <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                        <>
                            <Ionicons name="download-outline" size={18} color="#FFF" />
                            <Text style={styles.exportHeaderBtnText}>Export</Text>
                        </>
                    )}
                </TouchableOpacity>
            </View>

            {/* Month & Year Bar */}
            <View style={styles.monthSelector}>
                <TouchableOpacity onPress={() => changeMonth(-1)} style={styles.monthArrow}>
                    <Ionicons name="chevron-back" size={22} color="#4A90E2" />
                </TouchableOpacity>
                <TouchableOpacity
                    style={styles.monthInfo}
                    onPress={() => {
                        setPickerYear(selectedDate.getFullYear());
                        setShowMonthPicker(true);
                    }}
                >
                    <Ionicons name="calendar-outline" size={20} color="#4A90E2" />
                    <Text style={styles.monthText}>
                        {months[selectedDate.getMonth()]} {selectedDate.getFullYear()}
                    </Text>
                    <Ionicons name="caret-down" size={14} color="#4A90E2" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => changeMonth(1)} style={styles.monthArrow}>
                    <Ionicons name="chevron-forward" size={22} color="#4A90E2" />
                </TouchableOpacity>
            </View>

            {/* Employee Selection Controls */}
            <View style={styles.selectionBar}>
                <View style={styles.selectionCount}>
                    <Ionicons name="people" size={18} color="#64748B" />
                    <Text style={styles.selectionCountText}>
                        {selectedEmpUids.size > 0
                            ? `Selected: ${selectedEmpUids.size} of ${filteredData.length}`
                            : `All Employees (${filteredData.length})`}
                    </Text>
                </View>

                <View style={styles.selectionActions}>
                    <TouchableOpacity
                        style={styles.actionChip}
                        onPress={selectAllEmployees}
                    >
                        <Text style={styles.actionChipText}>Select All</Text>
                    </TouchableOpacity>

                    {selectedEmpUids.size > 0 && (
                        <TouchableOpacity
                            style={[styles.actionChip, styles.clearChip]}
                            onPress={clearSelection}
                        >
                            <Text style={[styles.actionChipText, styles.clearChipText]}>Clear</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </View>

            {/* Search Input */}
            <View style={styles.searchContainer}>
                <Ionicons name="search" size={18} color="#95A5A6" />
                <TextInput
                    style={styles.searchInput}
                    placeholder="Search employee by name, ID or department..."
                    value={searchQuery}
                    onChangeText={handleSearch}
                    placeholderTextColor="#95A5A6"
                />
                {searchQuery.length > 0 && (
                    <TouchableOpacity onPress={() => handleSearch('')}>
                        <Ionicons name="close-circle" size={18} color="#BDC3C7" />
                    </TouchableOpacity>
                )}
            </View>

            {/* Content List */}
            {loading ? (
                <View style={styles.loader}>
                    <ActivityIndicator size="large" color="#4A90E2" />
                    <Text style={styles.loaderText}>Compiling monthly report data...</Text>
                </View>
            ) : (
                <FlatList
                    data={filteredData}
                    renderItem={renderReportItem}
                    keyExtractor={item => item.uid || item.id}
                    contentContainerStyle={styles.list}
                    showsVerticalScrollIndicator={false}
                    ListHeaderComponent={() => {
                        const totalHours = employees.reduce((acc, e) => acc + e.stats.hours, 0);
                        const totalPresent = employees.reduce((acc, e) => acc + e.stats.present, 0);

                        return (
                            <View style={styles.summaryContainer}>
                                <View style={styles.summaryRow}>
                                    <View style={styles.summaryBox}>
                                        <View style={styles.summaryIconBox}>
                                            <Ionicons name="time" size={22} color="#4A90E2" />
                                        </View>
                                        <View>
                                            <Text style={styles.summaryLabel}>Total Work Hours</Text>
                                            <Text style={styles.summaryValue}>{totalHours.toFixed(1)}h</Text>
                                        </View>
                                    </View>
                                    <View style={styles.summaryBox}>
                                        <View style={[styles.summaryIconBox, { backgroundColor: '#E8F5E9' }]}>
                                            <Ionicons name="checkmark-done" size={22} color="#2ECC71" />
                                        </View>
                                        <View>
                                            <Text style={styles.summaryLabel}>Total Present Days</Text>
                                            <Text style={styles.summaryValue}>{totalPresent}</Text>
                                        </View>
                                    </View>
                                </View>
                                <Text style={styles.listTitle}>
                                    {selectedEmpUids.size > 0
                                        ? `Selected Employees (${selectedEmpUids.size})`
                                        : 'Employee Attendance Summary'}
                                </Text>
                            </View>
                        );
                    }}
                    ListEmptyComponent={
                        <View style={styles.empty}>
                            <Ionicons name="bar-chart-outline" size={60} color="#BDC3C7" />
                            <Text style={styles.emptyText}>No employee records found for this month</Text>
                        </View>
                    }
                />
            )}

            {/* Bottom Floating Export Bar */}
            <View style={styles.bottomBar}>
                <TouchableOpacity
                    style={[styles.mainExportBtn, exporting && { opacity: 0.7 }]}
                    onPress={handleExportReport}
                    disabled={exporting || loading}
                >
                    {exporting ? (
                        <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                        <>
                            <Ionicons name="download" size={20} color="#FFF" />
                            <Text style={styles.mainExportBtnText}>
                                {selectedEmpUids.size > 0
                                    ? `Export PDF for ${selectedEmpUids.size} Selected (${months[selectedDate.getMonth()]})`
                                    : `Export Full Month PDF (${months[selectedDate.getMonth()]} ${selectedDate.getFullYear()})`}
                            </Text>
                        </>
                    )}
                </TouchableOpacity>
            </View>

            {/* Month & Year Picker Modal */}
            <Modal
                visible={showMonthPicker}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setShowMonthPicker(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>Select Month & Year</Text>
                            <TouchableOpacity onPress={() => setShowMonthPicker(false)}>
                                <Ionicons name="close" size={24} color="#64748B" />
                            </TouchableOpacity>
                        </View>

                        {/* Year Selector */}
                        <View style={styles.yearSelectorRow}>
                            <TouchableOpacity
                                style={styles.yearBtn}
                                onPress={() => setPickerYear(prev => prev - 1)}
                            >
                                <Ionicons name="chevron-back" size={20} color="#4A90E2" />
                            </TouchableOpacity>
                            <Text style={styles.pickerYearText}>{pickerYear}</Text>
                            <TouchableOpacity
                                style={styles.yearBtn}
                                onPress={() => setPickerYear(prev => prev + 1)}
                            >
                                <Ionicons name="chevron-forward" size={20} color="#4A90E2" />
                            </TouchableOpacity>
                        </View>

                        {/* Month Grid */}
                        <View style={styles.monthGrid}>
                            {months.map((m, idx) => {
                                const isCurrent =
                                    selectedDate.getMonth() === idx &&
                                    selectedDate.getFullYear() === pickerYear;

                                return (
                                    <TouchableOpacity
                                        key={m}
                                        style={[styles.monthGridItem, isCurrent && styles.activeMonthItem]}
                                        onPress={() => {
                                            const newDate = new Date(pickerYear, idx, 1);
                                            setSelectedDate(newDate);
                                            setShowMonthPicker(false);
                                        }}
                                    >
                                        <Text style={[styles.monthGridText, isCurrent && styles.activeMonthText]}>
                                            {m.substring(0, 3)}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F8F9FA',
        paddingTop: 50,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        marginBottom: 15,
    },
    backButton: {
        padding: 6,
    },
    headerTitleContainer: {
        flex: 1,
        marginLeft: 12,
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#1E293B',
    },
    headerSubtitle: {
        fontSize: 12,
        color: '#64748B',
        marginTop: 2,
    },
    exportHeaderBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#4A90E2',
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 8,
        gap: 6,
    },
    exportHeaderBtnText: {
        color: '#FFF',
        fontWeight: 'bold',
        fontSize: 13,
    },
    monthSelector: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#FFF',
        marginHorizontal: 20,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 14,
        marginBottom: 12,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 4,
    },
    monthArrow: {
        padding: 6,
    },
    monthInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    monthText: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#1E293B',
    },
    selectionBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginHorizontal: 20,
        marginBottom: 12,
    },
    selectionCount: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    selectionCountText: {
        fontSize: 13,
        fontWeight: '600',
        color: '#475569',
    },
    selectionActions: {
        flexDirection: 'row',
        gap: 8,
    },
    actionChip: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        backgroundColor: '#E0F2FE',
        borderRadius: 6,
    },
    actionChipText: {
        fontSize: 12,
        fontWeight: '600',
        color: '#0284C7',
    },
    clearChip: {
        backgroundColor: '#FEE2E2',
    },
    clearChipText: {
        color: '#DC2626',
    },
    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFF',
        marginHorizontal: 20,
        paddingHorizontal: 14,
        height: 44,
        borderRadius: 10,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    searchInput: {
        flex: 1,
        marginLeft: 10,
        fontSize: 14,
        color: '#1E293B',
    },
    list: {
        paddingHorizontal: 20,
        paddingBottom: 100,
    },
    reportCard: {
        backgroundColor: '#FFF',
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 5,
        borderWidth: 1,
        borderColor: '#F1F5F9',
    },
    selectedCard: {
        borderColor: '#4A90E2',
        borderWidth: 2,
        backgroundColor: '#F8FBFF',
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    checkboxContainer: {
        paddingRight: 10,
    },
    empInfoArea: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    empName: {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#1E293B',
    },
    empId: {
        fontSize: 12,
        color: '#64748B',
        marginTop: 2,
    },
    deptTag: {
        backgroundColor: '#E1F5FE',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        marginRight: 10,
    },
    deptText: {
        fontSize: 10,
        color: '#0288D1',
        fontWeight: 'bold',
    },
    singlePdfBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#F0F7FF',
        borderWidth: 1,
        borderColor: '#BAE6FD',
        paddingVertical: 5,
        paddingHorizontal: 8,
        borderRadius: 6,
        gap: 4,
    },
    singlePdfText: {
        fontSize: 11,
        fontWeight: 'bold',
        color: '#0284C7',
    },
    statsContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        backgroundColor: '#F8FAFC',
        borderRadius: 8,
        paddingVertical: 8,
    },
    statBox: {
        flex: 1,
        alignItems: 'center',
        borderLeftWidth: 3,
        paddingVertical: 2,
    },
    statValue: {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#1E293B',
    },
    statLabel: {
        fontSize: 10,
        color: '#64748B',
        marginTop: 2,
    },
    summaryContainer: {
        marginBottom: 14,
    },
    summaryRow: {
        flexDirection: 'row',
        gap: 10,
        marginBottom: 12,
    },
    summaryBox: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFF',
        borderRadius: 12,
        padding: 12,
        elevation: 1,
        gap: 12,
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    summaryIconBox: {
        width: 42,
        height: 42,
        borderRadius: 21,
        backgroundColor: '#EBF5FF',
        justifyContent: 'center',
        alignItems: 'center',
    },
    summaryLabel: {
        fontSize: 11,
        color: '#64748B',
        fontWeight: '600',
    },
    summaryValue: {
        fontSize: 17,
        fontWeight: '800',
        color: '#0F172A',
        marginTop: 2,
    },
    listTitle: {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#1E293B',
        marginTop: 6,
    },
    loader: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loaderText: {
        marginTop: 10,
        color: '#64748B',
        fontSize: 13,
    },
    empty: {
        alignItems: 'center',
        marginTop: 80,
    },
    emptyText: {
        marginTop: 10,
        color: '#94A3B8',
        fontSize: 14,
    },
    bottomBar: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: '#FFF',
        paddingVertical: 14,
        paddingHorizontal: 20,
        borderTopWidth: 1,
        borderTopColor: '#E2E8F0',
        elevation: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -3 },
        shadowOpacity: 0.1,
        shadowRadius: 5,
    },
    mainExportBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#2563EB',
        paddingVertical: 14,
        borderRadius: 12,
        gap: 10,
    },
    mainExportBtnText: {
        color: '#FFF',
        fontSize: 14,
        fontWeight: 'bold',
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    modalContent: {
        width: '100%',
        maxWidth: 340,
        backgroundColor: '#FFF',
        borderRadius: 20,
        padding: 20,
        elevation: 10,
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
    },
    modalTitle: {
        fontSize: 17,
        fontWeight: 'bold',
        color: '#1E293B',
    },
    yearSelectorRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: '#F1F5F9',
        borderRadius: 10,
        paddingVertical: 8,
        paddingHorizontal: 16,
        marginBottom: 16,
    },
    yearBtn: {
        padding: 4,
    },
    pickerYearText: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1E293B',
    },
    monthGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        gap: 10,
    },
    monthGridItem: {
        width: '30%',
        paddingVertical: 12,
        alignItems: 'center',
        borderRadius: 10,
        backgroundColor: '#F8FAFC',
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    activeMonthItem: {
        backgroundColor: '#2563EB',
        borderColor: '#2563EB',
    },
    monthGridText: {
        fontSize: 14,
        fontWeight: '600',
        color: '#334155',
    },
    activeMonthText: {
        color: '#FFF',
        fontWeight: 'bold',
    },
});
