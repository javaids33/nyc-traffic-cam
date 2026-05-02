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
import World1940 from './world-1940';
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
                  : path.startsWith('/world1940') || path.startsWith('/1940')
                    ? World1940
                    : Lounge;

// /world1940 is a full-bleed first-person street walk — hide the
// AudioPanel + BodegaCat (which live at app root for every other route)
// so they don't sit on top of the immersive canvas.
const IS_FULL_BLEED = path.startsWith('/world1940') || path.startsWith('/1940');
const Tree = (
  <>
    <Page />
    {!IS_FULL_BLEED && <AudioPanel />}
    {!IS_FULL_BLEED && <BodegaCat />}
  </>
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{Tree}</React.StrictMode>,
);
