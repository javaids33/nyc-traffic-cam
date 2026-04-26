import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import Dashboard from './dashboard';
import Lounge from './lounge';

const path = window.location.pathname;
const Page = path.startsWith('/dashboard') ? Dashboard : Lounge;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
