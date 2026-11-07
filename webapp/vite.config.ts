import legacy from '@vitejs/plugin-legacy';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [
    // TV browsers run old Chromium (Samsung Tizen: ~56 on 2018 models, 63-85 on 2019-2022).
    // Browsers without ES modules get a separate ES5 build with polyfills; the modern build
    // is lowered and polyfilled down to Chrome 64, so syntax like `?.` never reaches them.
    legacy({
      targets: ['chrome >= 49', 'safari >= 11', 'defaults'],
      modernPolyfills: true,
    }),
  ],
  build: {
    // Lowers newer CSS (e.g. `inset`) for the same old browsers.
    cssTarget: 'chrome61',
  },
});
