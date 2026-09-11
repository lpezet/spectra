import React from 'react'
import { createRoot } from 'react-dom/client'
import '@abseed/spectra-web-lib/styles.css'
import { App } from './App.js'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
