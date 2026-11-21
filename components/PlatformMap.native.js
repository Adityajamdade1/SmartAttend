import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import NativeMapView, {
    Callout as NativeCallout,
    Marker as NativeMarker,
    Polyline as NativePolyline
} from 'react-native-maps';

class SafeMapView extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        console.log('SafeMapView caught error:', error?.message);
    }

    render() {
        if (this.state.hasError) {
            return (
                <View style={[styles.fallbackContainer, this.props.style]}>
                    <Ionicons name="map-outline" size={48} color="#94A3B8" />
                    <Text style={styles.fallbackTitle}>Map Display Fallback</Text>
                    <Text style={styles.fallbackSubtext}>
                        Interactive map display could not initialize. You can view all punch locations with full addresses in the Location List below or tap any location to open in Google Maps.
                    </Text>
                </View>
            );
        }

        try {
            return <NativeMapView {...this.props} />;
        } catch (err) {
            console.log('SafeMapView render catch:', err?.message);
            return (
                <View style={[styles.fallbackContainer, this.props.style]}>
                    <Ionicons name="map-outline" size={48} color="#94A3B8" />
                    <Text style={styles.fallbackTitle}>Location Coordinates Available</Text>
                    <Text style={styles.fallbackSubtext}>
                        Use the Location List to inspect all employee check-in and check-out coordinates.
                    </Text>
                </View>
            );
        }
    }
}

const styles = StyleSheet.create({
    fallbackContainer: {
        backgroundColor: '#F8FAFC',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
        minHeight: 250,
    },
    fallbackTitle: {
        fontSize: 15,
        fontWeight: 'bold',
        color: '#1E293B',
        marginTop: 10,
    },
    fallbackSubtext: {
        fontSize: 12,
        color: '#64748B',
        textAlign: 'center',
        marginTop: 6,
        lineHeight: 18,
        maxWidth: 320,
    },
});

export const Callout = NativeCallout;
export const Marker = NativeMarker;
export const Polyline = NativePolyline;
export default SafeMapView;
