import { defineConfig } from 'vite'
import userscript from 'vite-userscript-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  base: './',
  build: {
    minify: true,
    sourcemap: true,
  },
  plugins: [
    userscript({
      entry: 'src/index.ts',
      fileName: 'tgstories-downloader',
      autoMetaUrls: true,
      header: {
        'name': 'Telegram Stories Downloader',
        'version': pkg.version,
        'description': pkg.description,
        'icon': 'greasify.svg',
        'homepage': 'https://greasify.github.io/tgstories-downloader-userscript/',
        'match': [
          'https://web.telegram.org/a/*',
          'https://webz.telegram.org/*',
        ],
        'grant': 'none',
        'run-at': 'document-end',
      },
      server: {
        file: true,
      },
    }),
  ],
})
