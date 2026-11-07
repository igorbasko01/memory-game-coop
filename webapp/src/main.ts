import './style.css';
import { PhoneApp } from './ui/app';
import { TvApp } from './ui/tv';

/** Whether `gap` works on flex layouts (Chromium 84+); old TV browsers get margins instead. */
const flexGap = () => {
  const el = document.createElement('div');
  el.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute';
  el.appendChild(document.createElement('div'));
  el.appendChild(document.createElement('div'));
  document.body.appendChild(el);
  const ok = el.scrollHeight === 1;
  el.remove();
  return ok;
};
if (!flexGap()) document.documentElement.classList.add('no-flex-gap');
// CSS Grid arrived in Chromium 57; Samsung's 2018 TVs run 56. Those get flexbox layouts instead.
if (!(window.CSS && CSS.supports && CSS.supports('display', 'grid'))) document.documentElement.classList.add('no-grid');

const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

// `?tv` (or `?tv=ABCD`) turns this screen into the room's big screen; anything else is a player's device.
if (params.has('tv')) new TvApp(root).start(params.get('tv'));
else void new PhoneApp(root).start(params);
