import React from 'react';
import * as RN from 'react-native';

const OriginalText = RN.Text;
const OriginalTextInput = RN.TextInput;

/**
 * Maps fontWeight to corresponding Montserrat font variant.
 * Preserves custom fonts like vector icons ('ionicons', etc.) and 'monospace'.
 */
export const resolveMontserratFont = (style) => {
    const flat = RN.StyleSheet.flatten(style) || {};

    // If explicit custom font family is already defined (e.g. icons, monospace), keep it
    if (
        flat.fontFamily &&
        flat.fontFamily !== 'System' &&
        flat.fontFamily !== 'sans-serif' &&
        !flat.fontFamily.includes('Montserrat')
    ) {
        return flat.fontFamily;
    }

    const weight = String(flat.fontWeight || '').toLowerCase();
    if (weight === 'bold' || weight === '700') return 'Montserrat_700Bold';
    if (weight === '800' || weight === '900') return 'Montserrat_800ExtraBold';
    if (weight === '600') return 'Montserrat_600SemiBold';
    if (weight === '500') return 'Montserrat_500Medium';
    if (weight === '300' || weight === '100' || weight === '200') return 'Montserrat_300Light';

    return 'Montserrat_400Regular';
};

/**
 * Universal CustomText component applying Montserrat globally
 */
const CustomText = React.forwardRef((props, ref) => {
    const { style, children, ...rest } = props;
    const resolvedFont = resolveMontserratFont(style);

    return (
        <OriginalText
            ref={ref}
            {...rest}
            style={[{ fontFamily: resolvedFont }, style]}
        >
            {children}
        </OriginalText>
    );
});

/**
 * Universal CustomTextInput component applying Montserrat globally
 */
const CustomTextInput = React.forwardRef((props, ref) => {
    const { style, ...rest } = props;
    const resolvedFont = resolveMontserratFont(style);

    return (
        <OriginalTextInput
            ref={ref}
            {...rest}
            style={[{ fontFamily: resolvedFont }, style]}
        />
    );
});

// Configure defaultProps as extra safety
if (OriginalText.defaultProps == null) OriginalText.defaultProps = {};
OriginalText.defaultProps.style = { fontFamily: 'Montserrat_400Regular' };

if (OriginalTextInput.defaultProps == null) OriginalTextInput.defaultProps = {};
OriginalTextInput.defaultProps.style = { fontFamily: 'Montserrat_400Regular' };

// Override React Native's exported Text and TextInput getters globally
try {
    Object.defineProperty(RN, 'Text', {
        value: CustomText,
        configurable: true,
        writable: true,
        enumerable: true,
    });
} catch (e) {
    console.warn('Could not override RN.Text getter:', e);
}

try {
    Object.defineProperty(RN, 'TextInput', {
        value: CustomTextInput,
        configurable: true,
        writable: true,
        enumerable: true,
    });
} catch (e) {
    console.warn('Could not override RN.TextInput getter:', e);
}

export { CustomText, CustomTextInput };
