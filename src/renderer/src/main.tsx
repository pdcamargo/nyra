// First, and above every import that can throw: it patches the console and
// attaches the error listeners as it evaluates, so a module-level failure
// further down this list is still visible from outside the app.
import './lib/devlog'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
// Above `./App` on purpose — it renames the persisted storage keys, and the
// stores `./App` pulls in read those keys as they are evaluated.
import './lib/legacy-storage'
import App from './App'
import { initTauriApi } from './lib/tauri-api'
import { bootTheme } from './lib/theme'
import { bootAppearance } from './lib/appearance'
import { applyZoom, persistedZoom } from './lib/zoom'
import './index.css'

// The graffiti theme is light-by-default, so the `.dark` class has to land on
// <html> before anything paints or a dark-mode user sees a white frame.
bootTheme()

// Same reason as the theme: the first frame should be the size and the face you
// left it at, not the defaults followed by a visible correction.
bootAppearance()

// `window.api` has to exist before any component renders, and the backend event
// listeners have to be attached before the first prompt can fire one.
await initTauriApi()

// The window is still hidden here, so awaiting costs nothing and avoids a frame
// painted at 100%.
await applyZoom(persistedZoom())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// The window starts hidden so the first paint is the app, not a blank rectangle.
void getCurrentWindow().show()
