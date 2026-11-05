/**
 * Browser entry point of the Custom UI: loads the Inter font and the stylesheets and mounts <App/>. In the
 * click-dummy, ?motion=off switches all animations off for screenshots and UI tests.
 *
 * @file        static/app/src/main.jsx
 * @app         Group Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-26
 * @updated     2026-11-05
 */

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
