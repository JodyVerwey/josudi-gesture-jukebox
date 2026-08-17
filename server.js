/**
 * server.js — a tiny static web server, zero dependencies.
 *
 * WHY DOES THIS EXIST?
 * You'd think you could just double-click index.html. You can't, and here's why:
 * browsers only hand over your webcam on a "secure context". That means HTTPS...
 * or http://localhost, which browsers trust as a special case. A file opened
 * directly from disk (file:///C:/...) is NOT a secure context, so Chrome will
 * silently refuse the camera. Serving the folder over localhost fixes that.
 *
 * Run it with:  node server.js
 * Then open:    http://localhost:5173
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 5173;
const ROOT = __dirname; // serve files from this folder

// Browsers decide how to treat a file based on the Content-Type header we send.
// Get these wrong and the app breaks in confusing ways — e.g. .wasm served as
// text/plain makes the fast WebAssembly loader refuse to start.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", // MediaPipe ships an ES module
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm", // the hand-tracking engine, compiled to WebAssembly
  ".task": "application/octet-stream", // MediaPipe's trained model file
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".m4a", ".flac"];

const server = http.createServer((req, res) => {
  // Strip the query string (?foo=bar) and decode %20-style escapes.
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  // --- Small API: list whatever audio files are sitting in /sounds ---------
  // The web page can't read a folder by itself (browsers won't allow it), so
  // the server peeks into /sounds and reports what's there as JSON. The page
  // then auto-assigns files to gestures by filename, e.g. fist.mp3 -> ✊.
  if (urlPath === "/api/sounds") {
    let files = [];
    try {
      files = fs
        .readdirSync(path.join(ROOT, "sounds"))
        .filter((f) => AUDIO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
    } catch {
      files = []; // folder missing? just report nothing.
    }
    res.writeHead(200, { "Content-Type": MIME[".json"] });
    return res.end(JSON.stringify(files));
  }

  // --- Everything else: serve a real file off disk -------------------------
  if (urlPath === "/") urlPath = "/index.html";

  // Security: resolve the path, then confirm it's still inside our folder.
  // Without this, a request for /../../Documents/taxes.pdf would work. Bad.
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found: " + urlPath);
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      // Never cache anything. Browsers are especially sticky about caching
      // JavaScript modules, which means you edit a file, reload, and get the
      // OLD code back with no clue why. "no-store" forbids keeping a copy at
      // all; the other two are for older browsers and proxies that ignore it.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Josudi Gesture Jukebox running at  http://localhost:${PORT}\n`);
  console.log(`  Serving folder: ${ROOT}`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
