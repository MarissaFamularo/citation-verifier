import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { countVisit } from './lib/usage.js'

countVisit()

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
