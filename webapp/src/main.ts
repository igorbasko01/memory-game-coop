import './style.css';
import { PhoneApp } from './ui/app';
import { TvApp } from './ui/tv';

const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

// `?tv` (or `?tv=ABCD`) turns this screen into the room's big screen; anything else is a player's device.
if (params.has('tv')) new TvApp(root).start(params.get('tv'));
else void new PhoneApp(root).start(params);
