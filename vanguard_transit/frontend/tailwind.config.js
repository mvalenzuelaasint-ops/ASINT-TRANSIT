/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
        // ----- PRIMARIO: PÚRPURA NABLA/ASINT (color de marca, tono oscurecido para contraste con blanco) ----- //
        'primary': '#6452A2',

        'primary-dim': '#4B3D79',
        'primary-fixed': '#AAA0CC',
        'primary-fixed-dim': '#6452A2',
        'on-primary': '#FFFFFF',
        'on-primary-fixed': '#241C40',
        'on-primary-fixed-variant': '#4A3D73',
        'on-primary-container': '#453874',
        'primary-container': '#F0EEF6',
        'inverse-primary': '#C9C2DE',

        // ----- SECUNDARIO: GRAFITO (del isotipo NABLA) ----- //
        'secondary': '#3A3748',

        'secondary-dim': '#232130',
        'secondary-fixed': '#ECEBF0',
        'secondary-fixed-dim': '#B7B3C4',
        'on-secondary': '#FFFFFF',
        'on-secondary-fixed': '#3A3748',
        'on-secondary-fixed-variant': '#6E6A80',
        'on-secondary-container': '#3A3748',
        'secondary-container': '#ECEBF0',

        // ----- TERCIARIO: ADVERTENCIA Y ALERTAS ----- //
        'tertiary': '#D99300',

        'tertiary-dim': '#B57A00',
        'tertiary-fixed': '#FFEAAA',
        'tertiary-fixed-dim': '#FFD966',
        'on-tertiary': '#FFFFFF',
        'on-tertiary-fixed': '#2B1F00',
        'on-tertiary-fixed-variant': '#3D2D00',
        'tertiary-container': '#FFEAAA',
        'on-tertiary-container': '#2B1F00',

        // ----- SUPERFICIES: Blanco predominante ----- //
        'background': '#FAF9FD',
        'surface': '#FFFFFF',

        'surface-dim': '#EFEAFB',
        'surface-bright': '#FFFFFF',
        'surface-tint': '#6452A2',
        'surface-variant': '#ECEBF0',
        'surface-container-lowest': '#FFFFFF',
        'surface-container-low': '#FAF9FD',
        'surface-container': '#F4F1FA',
        'surface-container-high': '#ECE6F7',
        'surface-container-highest': '#DED4F2',

        // ----- TEXTOS ----- //
        'on-surface': '#12121A',
        'on-background': '#12121A',

        'on-surface-variant': '#6E6A80',
        'inverse-surface': '#12121A',
        'inverse-on-surface': '#FAF9FD',

        //----- CONTORNOS -----//
        'outline': '#6E6A80',
        'outline-variant': '#6452A2',

        // ----- ERRORES ----- //
        'error': '#C8102E',

        'error-dim': '#A50D25',
        'error-container': '#FFD0D7',
        'on-error': '#FFFFFF',
        'on-error-container': '#8C0008',
      },

      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.25rem',
        xl: '0.5rem',
        full: '0.75rem',
      },
      fontFamily: {
        headline: ['Rajdhani', 'sans-serif'],
        body: ['DM sans', 'sans-serif'],
        label: ['DM sans', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
