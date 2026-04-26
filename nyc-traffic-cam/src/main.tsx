import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import Dashboard from './dashboard';
import Lounge from './lounge';
import About from './about';
import Game from './game';

const path = window.location.pathname;
const Page = path.startsWith('/dashboard')
  ? Dashboard
  : path.startsWith('/about')
    ? About
    : path.startsWith('/game') || path.startsWith('/arcade')
      ? Game
      : Lounge;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
