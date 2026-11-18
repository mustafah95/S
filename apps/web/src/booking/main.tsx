import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/cormorant-garamond/latin-600.css';
import '@fontsource/amiri/arabic-700.css';
import '@fontsource/ibm-plex-sans-arabic/latin-400.css';
import '@fontsource/ibm-plex-sans-arabic/latin-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '../styles/theme.css';
import '../i18n';
import { BookingApp } from './BookingApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BookingApp />
  </StrictMode>,
);
