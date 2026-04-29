import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import Lounge from './lounge';
import About from './about';
import Curator from './curator';
import Game from './game';
import Turnstile from './turnstile';
import GeoGuessr from './geoguessr';
import Scratch from './scratch';
import Shrine from './shrine';
import Poi from './poi';
import Cab from './cab';
import { AudioPanel } from './audio-panel';
import { BodegaCat } from './bodega-cat';

const path = window.location.pathname;
const Page = path.startsWith('/about')
  ? About
  : path.startsWith('/curator')
    ? Curator
    : path.startsWith('/game') || path.startsWith('/arcade')
      ? Game
      : path.startsWith('/turnstile') || path.startsWith('/hop')
        ? Turnstile
        : path.startsWith('/geoguessr') || path.startsWith('/guess')
          ? GeoGuessr
          : path.startsWith('/scratch') || path.startsWith('/lotto')
            ? Scratch
            : path.startsWith('/shrine') || path.startsWith('/mamdani')
              ? Shrine
              : path.startsWith('/poi') || path.startsWith('/landmarks')
                ? Poi
                : path.startsWith('/cab') || path.startsWith('/taxi')
                  ? Cab
                  : Lounge;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Page is the route component; AudioPanel + BodegaCat live at
        the app root so they appear on every route, with their
        position + state restored from localStorage on each
        navigation (each anchor is a real reload — no router). */}
    <Page />
    <AudioPanel />
    <BodegaCat />
  </React.StrictMode>,
);
