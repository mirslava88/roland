import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/100.css'
import '@fontsource/inter/300.css'
import './assets/index.css'
import { AuxiliaryApp } from './AuxiliaryApp'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuxiliaryApp />
  </React.StrictMode>
)
