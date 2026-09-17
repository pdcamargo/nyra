import React from 'react'
import ReactDOM from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import App from './App'
import { initTauriApi } from './lib/tauri-api'
import { bootTheme } from './lib/theme'
import './index.css'

// The graffiti theme is light-by-default, so the `.dark` class has to land on
// <html> before anything paints or a dark-mode user sees a white frame.
bootTheme()

// `window.api` has to exist before any component renders, and the backend event
// listeners have to be attached before the first prompt can fire one.
await initTauriApi()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// The window starts hidden so the first paint is the app, not a blank rectangle.
void getCurrentWindow().show()
