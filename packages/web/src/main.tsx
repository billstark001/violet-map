import { initializeRuntime, showStartupError } from './runtime';
import '@radix-ui/themes/styles.css';
import './i18n';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

void initializeRuntime()
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  )
  .catch(showStartupError);
