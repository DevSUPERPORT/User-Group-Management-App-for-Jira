import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/app.css';
import { MotionGlobalConfig } from 'framer-motion';
import { App } from './App.jsx';
import { DEMO } from './api/client.js';

// Click-dummy only: ?motion=off skips all animations (screenshots, automated UI tests).
if (DEMO && new URLSearchParams(window.location.search).get('motion') === 'off') MotionGlobalConfig.skipAnimations = true;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
