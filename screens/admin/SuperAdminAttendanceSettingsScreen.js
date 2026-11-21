import React, { useState, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    StatusBar,
    ScrollView,
    TextInput,
    Switch,
    Alert,
    ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { db } from '../../services/firebaseConfig';
import {
    getAttendanceSettings,
    saveAttendanceSettings,
    DEFAULT_ATTENDANCE_SETTINGS
} from '../../services/attendanceConfigService';
import Colors, { shadows } from '../../constants/Colors';

export default function SuperAdminAttendanceSettingsScreen({ navigation, route }) {
    const { user } = useAuth();
    
    // Active Company Configuration Target
    const initialCompanyId = route.params?.companyId || user?.companyId || 'default';
    const initialCompanyName = route.params?.companyName || (initialCompanyId === 'default' ? 'Global Defaults' : 'Selected Company');

    const [activeCompanyId, setActiveCompanyId] = useState(initialCompanyId);
    const [activeCompanyName, setActiveCompanyName] = useState(initialCompanyName);
    const [companiesList, setCompaniesList] = useState([]);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Form State
    const [form, setForm] = useState({ ...DEFAULT_ATTENDANCE_SETTINGS });
    const [wifiInput, setWifiInput] = useState('');
    const [detectingLocation, setDetectingLocation] = useState(false);

    // Load available companies for Super Admin switcher
    useEffect(() => {
        const fetchCompanies = async () => {
            try {
                const snap = await db.collection('companies').getDocs();
                const comps = (snap.docs || []).map(doc => ({
                    id: doc.id,
                    name: doc.data().name || doc.id
                }));
                setCompaniesList([
                    { id: 'default', name: 'Global Defaults (Fallback)' },
                    ...comps
                ]);

                if (initialCompanyId !== 'default') {
                    const matched = comps.find(c => c.id === initialCompanyId);
                    if (matched) setActiveCompanyName(matched.name);
                }
            } catch (e) {
                console.log('Error fetching companies list:', e);
            }
        };
        fetchCompanies();
    }, [initialCompanyId]);

    // Load settings for the selected company
    const loadSettings = useCallback(async () => {
        try {
            setLoading(true);
            const settings = await getAttendanceSettings(activeCompanyId);
            setForm(settings);
        } catch (error) {
            console.error('Error loading attendance settings:', error);
            Alert.alert('Error', 'Failed to load attendance configuration');
        } finally {
            setLoading(false);
        }
    }, [activeCompanyId]);

    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    // Safe helper to update nested officeLocation
    const updateOfficeLocation = (key, value) => {
        setForm(prev => {
            const currentLoc = prev.officeLocation || { latitude: 0, longitude: 0, radiusMeters: 100, address: '' };
            return {
                ...prev,
                officeLocation: {
                    ...currentLoc,
                    [key]: value
                }
            };
        });
    };

    const handleDetectCurrentLocation = async () => {
        try {
            setDetectingLocation(true);
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status !== 'granted') {
                Alert.alert(
                    'Permission Denied ❌',
                    'Location permission is required to detect your current office coordinates.'
                );
                return;
            }

            // Prompt GPS provider if disabled
            try {
                const isServicesEnabled = await Location.hasServicesEnabledAsync();
                if (!isServicesEnabled) {
                    await Location.enableNetworkProviderAsync();
                }
            } catch (_e) {}

            let position = null;
            try {
                position = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                });
            } catch (_err) {
                try {
                    position = await Location.getCurrentPositionAsync({
                        accuracy: Location.Accuracy.Lowest,
                    });
                } catch (_lowErr) {
                    position = await Location.getLastKnownPositionAsync();
                }
            }

            if (!position?.coords) {
                throw new Error('Unable to retrieve GPS coordinates. Please ensure GPS/Location is turned on in your device settings.');
            }

            const lat = parseFloat(position.coords.latitude.toFixed(6));
            const lng = parseFloat(position.coords.longitude.toFixed(6));

            let detectedAddress = '';
            try {
                const geocodes = await Location.reverseGeocodeAsync({
                    latitude: lat,
                    longitude: lng,
                });
                if (geocodes && geocodes.length > 0) {
                    const g = geocodes[0];
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
                    if (uniqueParts.length > 0) {
                        detectedAddress = uniqueParts.join(', ');
                    }
                }
            } catch (e) {
                console.log('Geocoding error:', e);
            }

            const finalAddress = detectedAddress || `${lat}, ${lng}`;

            setForm(prev => {
                const curLoc = prev.officeLocation || {};
                return {
                    ...prev,
                    locationRequired: true,
                    officeLocation: {
                        ...curLoc,
                        latitude: lat,
                        longitude: lng,
                        address: finalAddress,
                        radiusMeters: curLoc.radiusMeters || 100
                    }
                };
            });

            Alert.alert(
                'Location Detected Successfully! 📍',
                `Current GPS Coordinates set for ${activeCompanyName}:\n\n• Latitude: ${lat}\n• Longitude: ${lng}\n• Address: ${finalAddress}\n\n👉 Now tap "Save Rules for ${activeCompanyName}" below to apply.`
            );
        } catch (error) {
            Alert.alert('Location Error ❌', error.message || 'Failed to detect current location.');
        } finally {
            setDetectingLocation(false);
        }
    };

    const handleSave = async () => {
        try {
            setSaving(true);

            // Validation
            if (!form.officeStartTime || !form.officeEndTime) {
                Alert.alert('Validation Error', 'Office start time and end time are required.');
                return;
            }

            if (Number(form.fullDayHours) <= 0 || Number(form.halfDayHours) <= 0) {
                Alert.alert('Validation Error', 'Working hours must be greater than zero.');
                return;
            }

            const res = await saveAttendanceSettings(activeCompanyId, form);
            if (res.success) {
                Alert.alert(
                    'Rules Saved Successfully! ✅',
                    `Attendance rules and office coordinates have been saved specifically for:\n\n🏢 ${activeCompanyName}\n(ID: ${activeCompanyId})\n\nAll employees belonging to this company will immediately use these new settings.`,
                    [{ text: 'OK', onPress: () => navigation.goBack() }]
                );
            } else {
                throw new Error(res.error || 'Failed to save');
            }
        } catch (error) {
            Alert.alert('Save Error ❌', error.message || 'Could not update settings');
        } finally {
            setSaving(false);
        }
    };

    const handleAddWifi = () => {
        if (!wifiInput.trim()) return;
        const current = form.allowedWifiSSIDs || [];
        if (!current.includes(wifiInput.trim())) {
            setForm({
                ...form,
                allowedWifiSSIDs: [...current, wifiInput.trim()],
            });
        }
        setWifiInput('');
    };

    const handleRemoveWifi = (ssid) => {
        const current = form.allowedWifiSSIDs || [];
        setForm({
            ...form,
            allowedWifiSSIDs: current.filter(s => s !== ssid),
        });
    };

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={Colors.primary} />
                <Text style={styles.loadingText}>Loading attendance rules for {activeCompanyName}...</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            {/* Header */}
            <LinearGradient
                colors={['#1E3A8A', '#2563EB']}
                style={styles.header}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            >
                <View style={styles.headerTopRow}>
                    <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                        <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
                    </TouchableOpacity>
                    <View style={styles.headerTextGroup}>
                        <Text style={styles.headerTitle}>Attendance Rule Engine</Text>
                        <Text style={styles.headerSubtitle}>Multi-Tenant Configuration</Text>
                    </View>
                </View>

                {/* Target Company Banner */}
                <View style={styles.targetBanner}>
                    <View style={styles.targetIconCircle}>
                        <Ionicons name="business" size={20} color="#2563EB" />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.targetLabel}>CURRENTLY CONFIGURING</Text>
                        <Text style={styles.targetName} numberOfLines={1}>{activeCompanyName}</Text>
                        <Text style={styles.targetId}>Tenant ID: {activeCompanyId}</Text>
                    </View>
                    <View style={[styles.targetBadge, { backgroundColor: activeCompanyId === 'default' ? '#FEF3C7' : '#DCFCE7' }]}>
                        <Text style={[styles.targetBadgeText, { color: activeCompanyId === 'default' ? '#D97706' : '#15803D' }]}>
                            {activeCompanyId === 'default' ? 'GLOBAL' : 'TENANT'}
                        </Text>
                    </View>
                </View>

                {/* Company Switcher Pills */}
                {companiesList.length > 0 && (
                    <View style={styles.companySwitcherSection}>
                        <Text style={styles.companySwitcherLabel}>SWITCH COMPANY:</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.companyScroll}>
                            {companiesList.map(comp => {
                                const isSelected = activeCompanyId === comp.id;
                                return (
                                    <TouchableOpacity
                                        key={comp.id}
                                        style={[styles.compPill, isSelected && styles.compPillActive]}
                                        onPress={() => {
                                            if (activeCompanyId !== comp.id) {
                                                setActiveCompanyId(comp.id);
                                                setActiveCompanyName(comp.name);
                                            }
                                        }}
                                        activeOpacity={0.8}
                                    >
                                        <Ionicons
                                            name={comp.id === 'default' ? 'globe' : 'business'}
                                            size={12}
                                            color={isSelected ? '#FFFFFF' : '#94A3B8'}
                                        />
                                        <Text style={[styles.compPillText, isSelected && styles.compPillTextActive]}>
                                            {comp.name}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>
                    </View>
                )}
            </LinearGradient>

            <ScrollView contentContainerStyle={styles.scrollContent}>
                {/* 1. Working Timings Section */}
                <View style={styles.sectionCard}>
                    <View style={styles.sectionHeader}>
                        <Ionicons name="time" size={20} color="#2563EB" />
                        <Text style={styles.sectionTitle}>Working Schedule</Text>
                    </View>

                    <View style={styles.row}>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Office Start Time</Text>
                            <TextInput
                                style={styles.textInput}
                                value={form.officeStartTime}
                                onChangeText={(t) => setForm({ ...form, officeStartTime: t })}
                                placeholder="09:30"
                            />
                            <Text style={styles.helperText}>e.g. 09:30 (24h or AM/PM)</Text>
                        </View>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Office End Time</Text>
                            <TextInput
                                style={styles.textInput}
                                value={form.officeEndTime}
                                onChangeText={(t) => setForm({ ...form, officeEndTime: t })}
                                placeholder="18:30"
                            />
                            <Text style={styles.helperText}>e.g. 18:30</Text>
                        </View>
                    </View>

                    <View style={styles.row}>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Break Start Time</Text>
                            <TextInput
                                style={styles.textInput}
                                value={form.breakStartTime}
                                onChangeText={(t) => setForm({ ...form, breakStartTime: t })}
                                placeholder="13:00"
                            />
                        </View>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Break End Time</Text>
                            <TextInput
                                style={styles.textInput}
                                value={form.breakEndTime}
                                onChangeText={(t) => setForm({ ...form, breakEndTime: t })}
                                placeholder="14:00"
                            />
                        </View>
                    </View>
                </View>

                {/* 2. Required Hours & Thresholds */}
                <View style={styles.sectionCard}>
                    <View style={styles.sectionHeader}>
                        <Ionicons name="calculator" size={20} color="#2563EB" />
                        <Text style={styles.sectionTitle}>Working Hours & Thresholds</Text>
                    </View>

                    <View style={styles.row}>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Full-Day Hours</Text>
                            <TextInput
                                style={styles.textInput}
                                value={String(form.fullDayHours)}
                                onChangeText={(t) => setForm({ ...form, fullDayHours: parseFloat(t) || 0 })}
                                keyboardType="numeric"
                                placeholder="8.0"
                            />
                            <Text style={styles.helperText}>Min hours for Present</Text>
                        </View>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Half-Day Hours</Text>
                            <TextInput
                                style={styles.textInput}
                                value={String(form.halfDayHours)}
                                onChangeText={(t) => setForm({ ...form, halfDayHours: parseFloat(t) || 0 })}
                                keyboardType="numeric"
                                placeholder="4.0"
                            />
                            <Text style={styles.helperText}>Min hours for Half Day</Text>
                        </View>
                    </View>

                    <View style={styles.row}>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Late Grace Period (mins)</Text>
                            <TextInput
                                style={styles.textInput}
                                value={String(form.gracePeriodMinutes)}
                                onChangeText={(t) => setForm({ ...form, gracePeriodMinutes: parseInt(t, 10) || 0 })}
                                keyboardType="numeric"
                                placeholder="15"
                            />
                            <Text style={styles.helperText}>Grace before Late mark</Text>
                        </View>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Late Mark Threshold (mins)</Text>
                            <TextInput
                                style={styles.textInput}
                                value={String(form.lateMarkThresholdMinutes)}
                                onChangeText={(t) => setForm({ ...form, lateMarkThresholdMinutes: parseInt(t, 10) || 0 })}
                                keyboardType="numeric"
                                placeholder="30"
                            />
                            <Text style={styles.helperText}>Late minutes for penalty</Text>
                        </View>
                    </View>
                </View>

                {/* 3. Office Location & Geo-Fencing */}
                <View style={styles.sectionCard}>
                    <View style={styles.sectionHeader}>
                        <Ionicons name="location" size={20} color="#2563EB" />
                        <Text style={styles.sectionTitle}>Office Geo-Fence & Location</Text>
                    </View>

                    {/* How to get coordinates guide */}
                    <View style={styles.mapHelpBox}>
                        <Ionicons name="information-circle" size={18} color="#0284C7" />
                        <View style={{ flex: 1 }}>
                            <Text style={styles.mapHelpTitle}>How to Set Coordinates for {activeCompanyName}:</Text>
                            <Text style={styles.mapHelpStep}>{'• Option 1: Tap "Auto-Detect" below while standing at this office.'}</Text>
                            <Text style={styles.mapHelpStep}>{'• Option 2: Open Google Maps, long-press on office to copy Lat/Lng (e.g. 16.8524, 74.5815), paste below.'}</Text>
                        </View>
                    </View>

                    <View style={styles.switchRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.switchLabel}>Enforce Office Location for {activeCompanyName}</Text>
                            <Text style={styles.switchSubtitle}>{"Employees cannot punch outside this office's radius"}</Text>
                        </View>
                        <Switch
                            value={form.locationRequired}
                            onValueChange={(v) => setForm({ ...form, locationRequired: v })}
                            trackColor={{ false: '#cbd5e1', true: '#2563EB' }}
                        />
                    </View>

                    <TouchableOpacity
                        style={styles.detectLocationBtn}
                        onPress={handleDetectCurrentLocation}
                        disabled={detectingLocation}
                        activeOpacity={0.8}
                    >
                        {detectingLocation ? (
                            <ActivityIndicator size="small" color="#2563EB" />
                        ) : (
                            <>
                                <Ionicons name="navigate-circle" size={18} color="#2563EB" />
                                <Text style={styles.detectLocationBtnText}>📍 Auto-Detect Current GPS Coordinates</Text>
                            </>
                        )}
                    </TouchableOpacity>

                    <View style={{ marginTop: 14 }}>
                        <Text style={styles.inputLabel}>Office Address / Building Name</Text>
                        <TextInput
                            style={styles.textInput}
                            value={form.officeLocation?.address || ''}
                            onChangeText={(t) => updateOfficeLocation('address', t)}
                            placeholder="e.g. Nexvora Tech HQ, Sangli"
                        />
                    </View>

                    <View style={styles.row}>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Latitude</Text>
                            <TextInput
                                style={styles.textInput}
                                value={form.officeLocation?.latitude != null ? String(form.officeLocation.latitude) : ''}
                                onChangeText={(t) => updateOfficeLocation('latitude', parseFloat(t) || 0)}
                                keyboardType="numeric"
                                placeholder="16.8524"
                            />
                        </View>
                        <View style={styles.halfInput}>
                            <Text style={styles.inputLabel}>Longitude</Text>
                            <TextInput
                                style={styles.textInput}
                                value={form.officeLocation?.longitude != null ? String(form.officeLocation.longitude) : ''}
                                onChangeText={(t) => updateOfficeLocation('longitude', parseFloat(t) || 0)}
                                keyboardType="numeric"
                                placeholder="74.5815"
                            />
                        </View>
                    </View>

                    <View style={{ marginTop: 6 }}>
                        <Text style={styles.inputLabel}>Allowed Radius (Meters)</Text>
                        <TextInput
                            style={styles.textInput}
                            value={form.officeLocation?.radiusMeters !== undefined && form.officeLocation?.radiusMeters !== null ? String(form.officeLocation.radiusMeters) : ''}
                            onChangeText={(t) => {
                                const clean = t.replace(/[^0-9]/g, '');
                                updateOfficeLocation('radiusMeters', clean === '' ? '' : parseInt(clean, 10));
                            }}
                            keyboardType="numeric"
                            placeholder="e.g. 100, 200, 500"
                        />
                        <Text style={styles.helperText}>Employee must be within this distance (e.g. 100m, 200m, 500m)</Text>
                    </View>
                </View>

                {/* 4. WiFi Restriction */}
                <View style={styles.sectionCard}>
                    <View style={styles.sectionHeader}>
                        <Ionicons name="wifi" size={20} color="#2563EB" />
                        <Text style={styles.sectionTitle}>Office WiFi Restriction</Text>
                    </View>

                    <View style={styles.switchRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.switchLabel}>Enforce Office WiFi</Text>
                            <Text style={styles.switchSubtitle}>Requires connection to authorized office WiFi</Text>
                        </View>
                        <Switch
                            value={form.wifiRequired}
                            onValueChange={(v) => setForm({ ...form, wifiRequired: v })}
                            trackColor={{ false: '#cbd5e1', true: '#2563EB' }}
                        />
                    </View>

                    <View style={{ marginTop: 12 }}>
                        <Text style={styles.inputLabel}>Add Allowed WiFi SSID</Text>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                            <TextInput
                                style={[styles.textInput, { flex: 1 }]}
                                value={wifiInput}
                                onChangeText={setWifiInput}
                                placeholder="e.g. Office_WiFi_5G"
                            />
                            <TouchableOpacity style={styles.addWifiBtn} onPress={handleAddWifi}>
                                <Text style={styles.addWifiBtnText}>Add</Text>
                            </TouchableOpacity>
                        </View>
                    </View>

                    {form.allowedWifiSSIDs?.length > 0 && (
                        <View style={styles.wifiChipContainer}>
                            {form.allowedWifiSSIDs.map((ssid) => (
                                <View key={ssid} style={styles.wifiChip}>
                                    <Ionicons name="wifi" size={14} color="#1E40AF" />
                                    <Text style={styles.wifiChipText}>{ssid}</Text>
                                    <TouchableOpacity onPress={() => handleRemoveWifi(ssid)}>
                                        <Ionicons name="close-circle" size={16} color="#EF4444" />
                                    </TouchableOpacity>
                                </View>
                            ))}
                        </View>
                    )}
                </View>

                {/* 5. Biometric & Work Modes */}
                <View style={styles.sectionCard}>
                    <View style={styles.sectionHeader}>
                        <Ionicons name="shield-checkmark" size={20} color="#2563EB" />
                        <Text style={styles.sectionTitle}>Biometrics & Remote Work</Text>
                    </View>

                    <View style={styles.switchRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.switchLabel}>Mandatory Face Recognition</Text>
                            <Text style={styles.switchSubtitle}>Face must match employee profile before punch is saved</Text>
                        </View>
                        <Switch
                            value={form.faceRecognitionRequired}
                            onValueChange={(v) => setForm({ ...form, faceRecognitionRequired: v })}
                            trackColor={{ false: '#cbd5e1', true: '#2563EB' }}
                        />
                    </View>

                    <View style={[styles.switchRow, { marginTop: 14 }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.switchLabel}>Allow Work From Home (WFH)</Text>
                            <Text style={styles.switchSubtitle}>Enables WFH attendance mode toggle for employees</Text>
                        </View>
                        <Switch
                            value={form.allowWFH}
                            onValueChange={(v) => setForm({ ...form, allowWFH: v })}
                            trackColor={{ false: '#cbd5e1', true: '#2563EB' }}
                        />
                    </View>
                </View>

                {/* Save Button */}
                <TouchableOpacity
                    style={styles.saveButton}
                    onPress={handleSave}
                    disabled={saving}
                    activeOpacity={0.85}
                >
                    <LinearGradient
                        colors={['#16A34A', '#15803D']}
                        style={styles.saveGradient}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                    >
                        {saving ? (
                            <ActivityIndicator color="#FFFFFF" />
                        ) : (
                            <>
                                <Ionicons name="cloud-upload" size={22} color="#FFFFFF" />
                                <Text style={styles.saveButtonText}>Save Rules for {activeCompanyName}</Text>
                            </>
                        )}
                    </LinearGradient>
                </TouchableOpacity>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F8FAFC',
    },
    header: {
        paddingTop: StatusBar.currentHeight ? StatusBar.currentHeight + 10 : 45,
        paddingBottom: 16,
        paddingHorizontal: 18,
        borderBottomLeftRadius: 24,
        borderBottomRightRadius: 24,
    },
    headerTopRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    backButton: {
        padding: 4,
        marginRight: 10,
    },
    headerTextGroup: {
        flex: 1,
    },
    headerTitle: {
        fontSize: 19,
        fontWeight: 'bold',
        color: '#FFFFFF',
    },
    headerSubtitle: {
        fontSize: 12,
        color: 'rgba(255,255,255,0.85)',
        marginTop: 1,
    },
    targetBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        borderRadius: 14,
        padding: 12,
        gap: 10,
        marginBottom: 10,
    },
    targetIconCircle: {
        width: 38,
        height: 38,
        borderRadius: 19,
        backgroundColor: '#EFF6FF',
        justifyContent: 'center',
        alignItems: 'center',
    },
    targetLabel: {
        fontSize: 9,
        fontWeight: '800',
        color: '#64748B',
        letterSpacing: 0.5,
    },
    targetName: {
        fontSize: 14,
        fontWeight: '700',
        color: '#0F172A',
    },
    targetId: {
        fontSize: 10,
        color: '#94A3B8',
    },
    targetBadge: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
    },
    targetBadgeText: {
        fontSize: 10,
        fontWeight: '800',
    },
    companySwitcherSection: {
        marginTop: 4,
    },
    companySwitcherLabel: {
        fontSize: 10,
        fontWeight: '700',
        color: 'rgba(255, 255, 255, 0.8)',
        marginBottom: 6,
        letterSpacing: 0.5,
    },
    companyScroll: {
        gap: 8,
    },
    compPill: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 20,
        gap: 6,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.25)',
    },
    compPillActive: {
        backgroundColor: '#FFFFFF',
        borderColor: '#FFFFFF',
    },
    compPillText: {
        fontSize: 12,
        fontWeight: '600',
        color: '#E2E8F0',
    },
    compPillTextActive: {
        color: '#1E3A8A',
        fontWeight: '700',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#F8FAFC',
    },
    loadingText: {
        marginTop: 10,
        fontSize: 14,
        color: '#64748B',
    },
    scrollContent: {
        padding: 16,
        paddingBottom: 40,
    },
    sectionCard: {
        backgroundColor: '#FFFFFF',
        borderRadius: 16,
        padding: 16,
        marginBottom: 16,
        ...shadows.small,
        borderWidth: 1,
        borderColor: '#E2E8F0',
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#F1F5F9',
        paddingBottom: 10,
        marginBottom: 14,
    },
    sectionTitle: {
        fontSize: 15,
        fontWeight: '700',
        color: '#1E293B',
    },
    row: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 12,
    },
    halfInput: {
        flex: 1,
    },
    inputLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: '#475569',
        marginBottom: 4,
    },
    textInput: {
        backgroundColor: '#F8FAFC',
        borderWidth: 1,
        borderColor: '#CBD5E1',
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        color: '#0F172A',
    },
    helperText: {
        fontSize: 10,
        color: '#94A3B8',
        marginTop: 3,
    },
    mapHelpBox: {
        flexDirection: 'row',
        backgroundColor: '#F0F9FF',
        borderWidth: 1,
        borderColor: '#BAE6FD',
        borderRadius: 10,
        padding: 10,
        gap: 8,
        marginBottom: 14,
    },
    mapHelpTitle: {
        fontSize: 11,
        fontWeight: '700',
        color: '#0369A1',
        marginBottom: 2,
    },
    mapHelpStep: {
        fontSize: 10,
        color: '#0C4A6E',
        lineHeight: 14,
    },
    switchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 6,
    },
    switchLabel: {
        fontSize: 13,
        fontWeight: '700',
        color: '#1E293B',
    },
    switchSubtitle: {
        fontSize: 11,
        color: '#64748B',
        marginTop: 2,
    },
    addWifiBtn: {
        backgroundColor: '#2563EB',
        borderRadius: 10,
        paddingHorizontal: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    addWifiBtnText: {
        color: '#FFFFFF',
        fontWeight: '700',
        fontSize: 13,
    },
    wifiChipContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 10,
    },
    wifiChip: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#EFF6FF',
        borderWidth: 1,
        borderColor: '#BFDBFE',
        borderRadius: 20,
        paddingHorizontal: 10,
        paddingVertical: 4,
        gap: 6,
    },
    wifiChipText: {
        fontSize: 12,
        fontWeight: '600',
        color: '#1E40AF',
    },
    detectLocationBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#EFF6FF',
        borderWidth: 1,
        borderColor: '#93C5FD',
        borderRadius: 10,
        paddingVertical: 12,
        paddingHorizontal: 14,
        marginTop: 10,
        gap: 8,
    },
    detectLocationBtnText: {
        color: '#1D4ED8',
        fontSize: 13,
        fontWeight: '700',
    },
    saveButton: {
        borderRadius: 14,
        overflow: 'hidden',
        marginTop: 10,
        ...shadows.medium,
    },
    saveGradient: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        gap: 8,
    },
    saveButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '700',
    },
});
