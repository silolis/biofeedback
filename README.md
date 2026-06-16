# HRV Biofeedback

Resonance-frequency heart-rate-variability biofeedback — a single-page web app
that pairs with a Bluetooth heart-rate strap to pace your breathing, measure the
respiratory sinus arrhythmia (RSA) amplitude, and sweep breathing rates to find
your resonance frequency. Includes a Demo mode that needs no hardware.

## Develop

```bash
npm install
npm run dev      # dev server (ES modules need http, not file://)
npm run build    # → dist/index.html, one self-contained file
```

The build inlines all CSS/JS into a single `dist/index.html` you can just open.

## Layout

- `index.html` — Vite entry
- `src/` — app modules (`app` entry → `state`, `signal`, `feedback`, `search`) + `estimators-core.mjs` (shared analysis core)
- `tools/` — offline Node analysis of exported sessions:
  ```bash
  node tools/reanalyze.mjs  <export.json>
  node tools/estimators.mjs <export.json> [more.json ...]
  ```

## License

MIT — see [LICENSE](LICENSE).
