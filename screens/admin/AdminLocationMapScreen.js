import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ActivityIndicator,
    FlatList,
    TextInput,
    Modal,
    Linking,
    StatusBar,
    ScrollView,
    Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MapView, { Marker, Callout } from '../../components/PlatformMap';
import { useAuth } from '../../context/AuthContext';
import { db } from '../../services/firebaseConfig';
import { formatDate } from '../../utils/attendance';

export default function AdminLocationMapScreen({ navigation }) {
    const { user } = useAuth();
    const [loading, setLoading] = useState(true);
    const [attendanceData, setAttendanceData] = useState([]);
    const [currentDateObj, setCurrentDateObj] = useState(new Date());
    const [selectedDate, setSelectedDate] = useState(formatDate(new Date()));
    const [searchQuery, setSearchQuery] = useState('');
    const [filterModalVisible, setFilterModalVisible] = useState(false);
    const [activeTab, setActiveTab] = useState('list'); // Default to 'list' for 100% reliable zero-crash experience
    const [mapRegion, setMapRegion] = useState({
        latitude: 18.5204,
        longitude: 73.8567,
        latitudeDelta: 0.1,
        longitudeDelta: 0.1,
    });

    useEffect(() => {
        loadLocationData();
    }, [selectedDate]);

    const changeDate = (offset) => {
        const next = new Date(currentDateObj);
        next.setDate(next.getDate() + offset);
        setCurrentDateObj(next);
        setSelectedDate(formatDate(next));
    };

    const resetToToday = () => {
        const today = new Date();
        setCurrentDateObj(today);
        setSelectedDate(formatDate(today));
    };

    const loadLocationData = async () => {
        try {
            setLoading(true);

            const attendanceSnapshot = await db.collection('attendance')
                .where('companyId', '==', user.companyId);

            const allDocs = attendanceSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            const records = allDocs.filter(record => {
                // Filter by selected date
                if (record.date !== selectedDate) return false;

                // Check for location in record or sessions
                const hasDirectLoc = (record.location?.latitude && record.location?.longitude) ||
                    (record.checkoutLocation?.latitude && record.checkoutLocation?.longitude);

                const hasSessionLoc = Array.isArray(record.sessions) && record.sessions.some(s =>
                    (s.location?.latitude && s.location?.longitude) ||
                    (s.checkinLocation?.latitude && s.checkinLocation?.longitude) ||
                    (s.checkoutLocation?.latitude && s.checkoutLocation?.longitude)
                );

                return hasDirectLoc || hasSessionLoc;
            });

            // Flatten into location punch entries
            const punchEntries = [];
            records.forEach(r => {
                const empName = r.employeeName || 'Employee';
                const empId = r.employeeId || 'N/A';

                // 1. Sessions
                if (Array.isArray(r.sessions) && r.sessions.length > 0) {
                    r.sessions.forEach((s, idx) => {
                        const inLoc = s.location || s.checkinLocation;
                        if (inLoc?.latitude && inLoc?.longitude) {
                            punchEntries.push({
                                id: `${r.id}_s${idx}_in`,
                                employeeName: empName,
                                employeeId: empId,
                                type: 'Check-In',
                                time: s.checkInTime || r.checkInTime || '-',
                                latitude: Number(inLoc.latitude),
                                longitude: Number(inLoc.longitude),
                                accuracy: inLoc.accuracy || null,
                                address: inLoc.address || 'Office Location',
                                sessionIndex: idx + 1,
                                isLate: r.isLate,
                            });
                        }
                        if (s.checkoutLocation?.latitude && s.checkoutLocation?.longitude) {
                            punchEntries.push({
                                id: `${r.id}_s${idx}_out`,
                                employeeName: empName,
                                employeeId: empId,
                                type: 'Check-Out',
                                time: s.checkOutTime || r.checkOutTime || '-',
                                latitude: Number(s.checkoutLocation.latitude),
                                longitude: Number(s.checkoutLocation.longitude),
                                accuracy: s.checkoutLocation.accuracy || null,
                                address: s.checkoutLocation.address || 'Office Location',
                                sessionIndex: idx + 1,
                                workHours: s.sessionHours || r.workHours || 0,
                            });
                        }
                    });
                } else {
                    // Fallback to top-level locations
                    if (r.location?.latitude && r.location?.longitude) {
                        punchEntries.push({
                            id: `${r.id}_top_in`,
                            employeeName: empName,
                            employeeId: empId,
                            type: 'Check-In',
                            time: r.checkInTime || '-',
                            latitude: Number(r.location.latitude),
                            longitude: Number(r.location.longitude),
                            accuracy: r.location.accuracy || null,
                            address: r.location.address || 'Office Location',
                            isLate: r.isLate,
                        });
                    }
                    if (r.checkoutLocation?.latitude && r.checkoutLocation?.longitude) {
                        punchEntries.push({
                            id: `${r.id}_top_out`,
                            employeeName: empName,
                            employeeId: empId,
                            type: 'Check-Out',
                            time: r.checkOutTime || '-',
                            latitude: Number(r.checkoutLocation.latitude),
                            longitude: Number(r.checkoutLocation.longitude),
                            accuracy: r.checkoutLocation.accuracy || null,
                            address: r.checkoutLocation.address || 'Office Location',
                            workHours: r.workHours || 0,
                        });
                    }
                }
            });

            // Filter by search query if present
            const filtered = searchQuery.trim() === ''
                ? punchEntries
                : punchEntries.filter(item =>
                    item.employeeName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    item.employeeId?.toLowerCase().includes(searchQuery.toLowerCase())
                );

            setAttendanceData(filtered);

            // Auto-center map on first location
            if (filtered.length > 0) {
                setMapRegion({
                    latitude: filtered[0].latitude,
                    longitude: filtered[0].longitude,
                    latitudeDelta: 0.05,
                    longitudeDelta: 0.05,
                });
            }
        } catch (error) {
            console.log('Error loading location data:', error?.message);
            Alert.alert('Notice', 'Could not load location records for this date.');
        } finally {
            setLoading(false);
        }
    };

    const openInGoogleMaps = (lat, lng, label) => {
        const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
        Linking.openURL(url).catch(err => {
            console.log('Could not open Google Maps link:', err?.message);
        });
    };

    const renderPunchItem = ({ item }) => {
        const isCheckIn = item.type === 'Check-In';

        return (
            <View style={styles.card}>
                <View style={styles.cardHeader}>
                    <View style={styles.empInfo}>
                        <Text style={styles.empName}>{item.employeeName}</Text>
                        <Text style={styles.empId}>{item.employeeId}</Text>
                    </View>
                    <View style={[styles.typeBadge, isCheckIn ? styles.checkInBadge : styles.checkOutBadge]}>
                        <Ionicons
                            name={isCheckIn ? "log-in" : "log-out"}
                            size={14}
                            color={isCheckIn ? "#16A34A" : "#DC2626"}
                        />
                        <Text style={[styles.typeBadgeText, isCheckIn ? styles.checkInText : styles.checkOutText]}>
                            {item.type} {item.sessionIndex ? `#${item.sessionIndex}` : ''}
                        </Text>
                    </View>
                </View>

                {/* Details */}
                <View style={styles.cardDetails}>
                    <View style={styles.detailRow}>
                        <Ionicons name="time-outline" size={16} color="#64748B" />
                        <Text style={styles.timeText}>{item.time}</Text>
                        {item.isLate && (
                            <View style={styles.latePill}>
                                <Text style={styles.latePillText}>Late</Text>
                            </View>
                        )}
                        {item.workHours > 0 && (
                            <Text style={styles.hoursText}>({item.workHours.toFixed(1)} hrs)</Text>
                        )}
                    </View>

                    <View style={styles.detailRow}>
                        <Ionicons name="location" size={16} color="#4A90E2" />
                        <Text style={styles.addressText} numberOfLines={2}>
                            {item.address}
                        </Text>
                    </View>

                    <View style={styles.detailRow}>
                        <Ionicons name="navigate-outline" size={14} color="#94A3B8" />
                        <Text style={styles.coordsText}>
                            {item.latitude.toFixed(6)}, {item.longitude.toFixed(6)}
                            {item.accuracy ? ` (±${Math.round(item.accuracy)}m)` : ''}
                        </Text>
                    </View>
                </View>

                {/* Action button: Open in Google Maps */}
                <TouchableOpacity
                    style={styles.openMapBtn}
                    onPress={() => openInGoogleMaps(item.latitude, item.longitude, item.employeeName)}
                >
                    <Ionicons name="map" size={16} color="#2563EB" />
                    <Text style={styles.openMapBtnText}>Open in Google Maps</Text>
                    <Ionicons name="open-outline" size={14} color="#2563EB" />
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
                    <Ionicons name="arrow-back" size={24} color="#1E293B" />
                </TouchableOpacity>
                <View style={styles.headerTitleContainer}>
                    <Text style={styles.headerTitle}>Location Tracking</Text>
                    <Text style={styles.headerSubtitle}>Verified Employee Punch Coordinates</Text>
                </View>
                <TouchableOpacity
                    style={styles.refreshBtn}
                    onPress={loadLocationData}
                >
                    <Ionicons name="refresh" size={20} color="#4A90E2" />
                </TouchableOpacity>
            </View>

            {/* Date Navigator Bar */}
            <View style={styles.dateBar}>
                <TouchableOpacity onPress={() => changeDate(-1)} style={styles.dateArrow}>
                    <Ionicons name="chevron-back" size={20} color="#0284C7" />
                </TouchableOpacity>

                <View style={styles.dateDisplay}>
                    <Ionicons name="calendar-outline" size={18} color="#0284C7" />
                    <Text style={styles.dateText}>{selectedDate}</Text>
                    {selectedDate !== formatDate(new Date()) && (
                        <TouchableOpacity style={styles.todayBtn} onPress={resetToToday}>
                            <Text style={styles.todayBtnText}>Today</Text>
                        </TouchableOpacity>
                    )}
                </View>

                <TouchableOpacity onPress={() => changeDate(1)} style={styles.dateArrow}>
                    <Ionicons name="chevron-forward" size={20} color="#0284C7" />
                </TouchableOpacity>
            </View>

            {/* View Switcher Tabs: List View (Safe Default) vs Map View */}
            <View style={styles.tabContainer}>
                <TouchableOpacity
                    style={[styles.tabBtn, activeTab === 'list' && styles.activeTabBtn]}
                    onPress={() => setActiveTab('list')}
                >
                    <Ionicons
                        name="list"
                        size={18}
                        color={activeTab === 'list' ? "#FFF" : "#64748B"}
                    />
                    <Text style={[styles.tabBtnText, activeTab === 'list' && styles.activeTabBtnText]}>
                        Punch Locations ({attendanceData.length})
                    </Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={[styles.tabBtn, activeTab === 'map' && styles.activeTabBtn]}
                    onPress={() => setActiveTab('map')}
                >
                    <Ionicons
                        name="map"
                        size={18}
                        color={activeTab === 'map' ? "#FFF" : "#64748B"}
                    />
                    <Text style={[styles.tabBtnText, activeTab === 'map' && styles.activeTabBtnText]}>
                        Interactive Map
                    </Text>
                </TouchableOpacity>
            </View>

            {/* Search Bar */}
            <View style={styles.searchBar}>
                <Ionicons name="search" size={18} color="#94A3B8" />
                <TextInput
                    style={styles.searchInput}
                    placeholder="Search employee name or ID..."
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholderTextColor="#94A3B8"
                />
                {searchQuery.length > 0 && (
                    <TouchableOpacity onPress={() => setSearchQuery('')}>
                        <Ionicons name="close-circle" size={18} color="#94A3B8" />
                    </TouchableOpacity>
                )}
            </View>

            {/* Content Display */}
            {loading ? (
                <View style={styles.loaderContainer}>
                    <ActivityIndicator size="large" color="#4A90E2" />
                    <Text style={styles.loaderText}>Loading verified punch locations...</Text>
                </View>
            ) : attendanceData.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Ionicons name="location-outline" size={60} color="#CBD5E1" />
                    <Text style={styles.emptyText}>No punch location records for {selectedDate}</Text>
                    <Text style={styles.emptySubtext}>
                        When employees mark attendance, their verified GPS coordinates and addresses appear here.
                    </Text>
                </View>
            ) : activeTab === 'list' ? (
                /* Location Cards List View */
                <FlatList
                    data={attendanceData}
                    renderItem={renderPunchItem}
                    keyExtractor={item => item.id}
                    contentContainerStyle={styles.listContent}
                    showsVerticalScrollIndicator={false}
                />
            ) : (
                /* Safe Map View */
                <View style={styles.mapContainer}>
                    <MapView
                        style={styles.map}
                        region={mapRegion}
                        onRegionChangeComplete={setMapRegion}
                        showsUserLocation={false}
                        showsMyLocationButton={true}
                    >
                        {attendanceData.map((item, idx) => (
                            <Marker
                                key={`marker_${idx}`}
                                coordinate={{ latitude: item.latitude, longitude: item.longitude }}
                                pinColor={item.type === 'Check-In' ? '#16A34A' : '#DC2626'}
                            >
                                <Callout>
                                    <View style={styles.calloutBox}>
                                        <Text style={styles.calloutName}>{item.employeeName}</Text>
                                        <Text style={styles.calloutType}>{item.type} • {item.time}</Text>
                                        <Text style={styles.calloutAddress}>{item.address}</Text>
                                    </View>
                                </Callout>
                            </Marker>
                        ))}
                    </MapView>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F8FAFC',
        paddingTop: 50,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        marginBottom: 12,
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
    refreshBtn: {
        padding: 8,
        backgroundColor: '#E0F2FE',
        borderRadius: 8,
    },
    dateBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#E0F2FE',
        marginHorizontal: 20,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 12,
        marginBottom: 12,
    },
    dateArrow: {
        padding: 4,
    },
    dateDisplay: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    dateText: {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#0369A1',
    },
    todayBtn: {
        backgroundColor: '#0284C7',
        paddingVertical: 2,
        paddingHorizontal: 8,
        borderRadius: 6,
        marginLeft: 6,
    },
    todayBtnText: {
        color: '#FFF',
        fontSize: 11,
        fontWeight: 'bold',
    },
    tabContainer: {
        flexDirection: 'row',
        marginHorizontal: 20,
        backgroundColor: '#E2E8F0',
        borderRadius: 10,
        padding: 4,
        marginBottom: 12,
    },
    tabBtn: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 8,
        borderRadius: 8,
        gap: 6,
    },
    activeTabBtn: {
        backgroundColor: '#2563EB',
    },
    tabBtnText: {
        fontSize: 13,
        fontWeight: '600',
        color: '#64748B',
    },
    activeTabBtnText: {
        color: '#FFF',
        fontWeight: 'bold',
    },
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFF',
        marginHorizontal: 20,
        paddingHorizontal: 14,
        height: 42,
        borderRadius: 10,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    searchInput: {
        flex: 1,
        marginLeft: 8,
        fontSize: 14,
        color: '#1E293B',
    },
    listContent: {
        paddingHorizontal: 20,
        paddingBottom: 40,
    },
    card: {
        backgroundColor: '#FFF',
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        borderWidth: 1,
        borderColor: '#F1F5F9',
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 10,
    },
    empInfo: {
        flex: 1,
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
    typeBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 6,
        gap: 4,
    },
    checkInBadge: {
        backgroundColor: '#DCFCE7',
    },
    checkOutBadge: {
        backgroundColor: '#FEE2E2',
    },
    typeBadgeText: {
        fontSize: 11,
        fontWeight: 'bold',
    },
    checkInText: {
        color: '#16A34A',
    },
    checkOutText: {
        color: '#DC2626',
    },
    cardDetails: {
        gap: 6,
        marginBottom: 12,
    },
    detailRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    timeText: {
        fontSize: 13,
        fontWeight: '600',
        color: '#334155',
    },
    hoursText: {
        fontSize: 12,
        color: '#64748B',
    },
    latePill: {
        backgroundColor: '#FEF3C7',
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
    },
    latePillText: {
        fontSize: 10,
        color: '#B45309',
        fontWeight: 'bold',
    },
    addressText: {
        flex: 1,
        fontSize: 12,
        color: '#475569',
        lineHeight: 16,
    },
    coordsText: {
        fontSize: 11,
        color: '#94A3B8',
        fontFamily: 'monospace',
    },
    openMapBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#EFF6FF',
        borderWidth: 1,
        borderColor: '#BFDBFE',
        paddingVertical: 8,
        borderRadius: 8,
        gap: 6,
    },
    openMapBtnText: {
        fontSize: 12,
        fontWeight: 'bold',
        color: '#2563EB',
    },
    mapContainer: {
        flex: 1,
    },
    map: {
        flex: 1,
    },
    calloutBox: {
        padding: 8,
        minWidth: 160,
    },
    calloutName: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#1E293B',
    },
    calloutType: {
        fontSize: 12,
        color: '#2563EB',
        marginTop: 2,
    },
    calloutAddress: {
        fontSize: 10,
        color: '#64748B',
        marginTop: 4,
    },
    loaderContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loaderText: {
        marginTop: 12,
        color: '#64748B',
        fontSize: 13,
    },
    emptyContainer: {
        alignItems: 'center',
        marginTop: 80,
        paddingHorizontal: 30,
    },
    emptyText: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#64748B',
        marginTop: 12,
        textAlign: 'center',
    },
    emptySubtext: {
        fontSize: 13,
        color: '#94A3B8',
        textAlign: 'center',
        marginTop: 6,
        lineHeight: 18,
    },
});
