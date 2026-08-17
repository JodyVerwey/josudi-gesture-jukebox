# 🎛️ Josudi Gesture Jukebox

Make a hand shape at your webcam and it plays a sound. Hand tracking runs
entirely in your browser — **no video is ever uploaded anywhere.**

## Using it

1. Open the site.
2. Click **▶ Start camera** and allow camera access when the browser asks.
3. Hold a gesture up to the camera. The panel on the right flashes green when
   one fires.

Works best in **Chrome or Edge** on a desktop, in decent light, with your hand
roughly 40–80 cm from the camera.

Each gesture plays a built-in synth tone out of the box. Click **Pick file** next
to any gesture to swap in your own audio — the file stays on your machine and is
never uploaded.

## Running it locally

You can't just double-click `index.html`: browsers only hand over the webcam on a
"secure context", which means HTTPS or `http://localhost`. A file opened straight
off disk (`file:///…`) doesn't qualify, so Chrome silently refuses the camera.
Serving the folder over localhost fixes that.

```
node server.js
```

Then open <http://localhost:5173>. On Windows you can double-click `run.bat`
instead, which does both steps.

Running locally also enables one extra trick: drop audio files into the `sounds/`
folder named after a gesture (`fist.mp3`, `peace.wav`, …) and they bind
automatically on refresh. That relies on a small endpoint in `server.js`, so on
the hosted version use **Pick file** instead.

## What's in here

| File | What it does |
| --- | --- |
| `index.html` | Layout and all the styling |
| `app.js` | Hand tracking, gesture detection, sound playback |
| `server.js` | Tiny zero-dependency static server for local use |
| `vendor/` | MediaPipe's vision engine and hand model, vendored so it works offline |

## Privacy

Camera frames are read into a `<canvas>`, measured, and thrown away. Nothing
leaves the browser — there is no backend, no analytics, and no network calls
after the page and model have loaded.
