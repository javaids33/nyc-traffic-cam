import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import Lounge from './lounge';
import About from './about';
import Game from './game';
import Turnstile from './turnstile';
import GeoGuessr from './geoguessr';

const path = window.location.pathname;
const Page = path.startsWith('/about')
  ? About
  : path.startsWith('/game') || path.startsWith('/arcade')
    ? Game
    : path.startsWith('/turnstile') || path.startsWith('/hop')
      ? Turnstile
      : path.startsWith('/geoguessr') || path.startsWith('/guess')
        ? GeoGuessr
        : Lounge;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
