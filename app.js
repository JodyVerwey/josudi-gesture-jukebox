/**
 * app.js — Josudi Gesture Jukebox
 *
 * THE WHOLE IDEA IN FOUR STEPS:
 *   1. Get a webcam picture.
 *   2. Ask MediaPipe: "where are the hands?" It replies with 21 dots per hand
 *      (knuckles, joints, fingertips) as x/y coordinates.
 *   3. Look at those dots and work out which fingers are sticking out.
 *      Which fingers are up = which gesture it is.
 *   4. When a gesture holds steady for a moment, play its sound.
 *
 * Everything runs on your machine. No video ever leaves the browser.
 */

// The MediaPipe library, loaded from our own /vendor folder (not the internet).
import { HandLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";

/* ============================================================================
   1. TUNING KNOBS — change these numbers if detection feels off
   ========================================================================= */

const CONFIG = {
  // How much longer a fingertip must be from the wrist than its middle knuckle
  // before we call that finger "extended". 1.0 = no margin (jittery),
  // higher = stricter. 1.12 is a good middle ground.
  fingerExtendRatio: 1.12,

  // Same idea for the thumb, which moves sideways rather than curling.
  thumbExtendRatio: 1.05,

  // A gesture must be recognised this many frames in a row before it counts.
  // This stops a sound firing during the split second your hand passes
  // through "fist" on the way to "peace".
  stableFrames: 5,

  // Minimum gap between two sounds, in milliseconds. Stops machine-gunning.
  cooldownMs: 500,

  // How confident MediaPipe must be that it's found a NEW hand (0–1).
  // Kept deliberately low: spotting a second hand arriving in frame is harder
  // than following one it's already locked onto, and a high bar here is the
  // usual reason only one hand ever gets picked up.
  minDetectionConfidence: 0.35,

  // How confident it must be to keep following a hand it already has.
  minTrackingConfidence: 0.5,

  // Track up to this many hands at once. Each one is watched separately.
  maxHands: 2,

  // MediaPipe decides "left" or "right" per hand. Its docs say it assumes a
  // mirrored (selfie) image, which suggested we'd need to flip its answer —
  // but tested on this machine that came out backwards, so we trust the label
  // as given. Different webcams and drivers do vary here; the ⇄ Swap L/R
  // button flips it live if you ever need it.
  swapHandedness: false,
};

// The two hands we track, in the order their panels appear on screen.
// Because the picture is mirrored, your left hand shows up on the left.
const HAND_KEYS = ["Left", "Right"];

/* ============================================================================
   2. THE GESTURE DICTIONARY
   ----------------------------------------------------------------------------
   `pattern` is five characters — one per finger, in the order
   [thumb, index, middle, ring, pinky]. "1" = extended, "0" = curled.
   So a peace sign is thumb-down, index-up, middle-up, ring-down, pinky-down
   = "01100".

   `tone` describes the built-in synth sound used until you supply a real file.
   ========================================================================= */

const GESTURES = [
  { id: "fist",      name: "Fist",       emoji: "✊",  pattern: "00000", tone: { freq: 110, type: "square",   dur: 0.22 } },
  { id: "open_palm", name: "Open palm",  emoji: "🖐️", pattern: "11111", tone: { freq: 523, type: "sine",     dur: 0.5  } },
  { id: "peace",     name: "Peace",      emoji: "✌️",  pattern: "01100", tone: { freq: 659, type: "triangle", dur: 0.32 } },
  { id: "thumbs_up", name: "Thumbs up",  emoji: "👍",  pattern: "10000", tone: { freq: 784, type: "sine",     dur: 0.3  } },
  { id: "point",     name: "Point",      emoji: "☝️",  pattern: "01000", tone: { freq: 880, type: "square",   dur: 0.14 } },
  { id: "rock",      name: "Rock on",    emoji: "🤘",  pattern: "01001", tone: { freq: 147, type: "sawtooth", dur: 0.42 } },
  { id: "shaka",     name: "Shaka",      emoji: "🤙",  pattern: "10001", tone: { freq: 392, type: "triangle", dur: 0.38 } },
];

// Turn the list into a lookup table: "01100" -> the peace gesture object.
const PATTERN_LOOKUP = Object.fromEntries(GESTURES.map((g) => [g.pattern, g]));

/* ============================================================================
   3. HAND SKELETON — which dots connect to which, for drawing
   ----------------------------------------------------------------------------
   MediaPipe numbers the 21 points like this:
     0 = wrist
     1–4   thumb   (4 = tip)
     5–8   index   (8 = tip)
     9–12  middle  (12 = tip)
     13–16 ring    (16 = tip)
     17–20 pinky   (20 = tip)
   ========================================================================= */

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [5, 9], [9, 10], [10, 11], [11, 12],      // middle
  [9, 13], [13, 14], [14, 15], [15, 16],    // ring
  [13, 17], [17, 18], [18, 19], [19, 20],   // pinky
  [0, 17],                                   // palm base
];

const FINGERTIPS = [4, 8, 12, 16, 20];

/* ============================================================================
   4. PAGE ELEMENTS
   ========================================================================= */

const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const fpsEl = document.getElementById("fps");
const cardsEl = document.getElementById("cards");
const handPanelsEl = document.getElementById("handPanels");
const swapBtn = document.getElementById("swapBtn");

function setStatus(text, kind = "") {
  statusEl.innerHTML = text;
  statusEl.className = kind;
}

/* ============================================================================
   5. SOUND
   ----------------------------------------------------------------------------
   Two ways a gesture can make noise:
     (a) a real audio file  — from /sounds, or one you pick by hand
     (b) a synthesised tone — generated live, so the app is never silent
   ========================================================================= */

let audioCtx = null; // created on first click (browsers block audio before that)
const soundBindings = {}; // gestureId -> { url, label } for real files

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

/** Make a short note from scratch using the Web Audio API. */
function playTone({ freq, type, dur }) {
  const ac = ensureAudio();
  const osc = ac.createOscillator(); // the raw buzzing sound
  const gain = ac.createGain();      // the volume knob

  osc.type = type;
  osc.frequency.value = freq;

  // An "envelope": snap up to full volume, then fade out. Without the fade you
  // get an ugly click when the sound stops dead.
  const now = ac.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.35, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  osc.connect(gain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + dur + 0.05);
}

/** Play whatever is bound to a gesture: real file if there is one, else a tone. */
function playFor(gesture) {
  const binding = soundBindings[gesture.id];
  if (binding) {
    // A fresh Audio object each time, so rapid gestures can overlap
    // instead of cutting each other off.
    const a = new Audio(binding.url);
    a.volume = 0.9;
    a.play().catch((err) => console.warn("Could not play file:", err));
  } else {
    playTone(gesture.tone);
  }
}

/* ============================================================================
   6. THE GESTURE CARDS on the right-hand side
   ========================================================================= */

function buildCards() {
  cardsEl.innerHTML = "";
  for (const g of GESTURES) {
    const card = document.createElement("div");
    card.className = "card";
    card.id = `card-${g.id}`;
    card.innerHTML = `
      <div class="ico">${g.emoji}</div>
      <div class="meta">
        <div class="name">${g.name}</div>
        <div class="sound" id="sound-${g.id}">built-in tone</div>
      </div>
      <button data-act="test" data-id="${g.id}">▶</button>
      <button data-act="pick" data-id="${g.id}">Pick file</button>
    `;
    cardsEl.appendChild(card);
  }

  // One click handler for the whole list rather than one per button.
  cardsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const gesture = GESTURES.find((g) => g.id === btn.dataset.id);
    if (btn.dataset.act === "test") {
      playFor(gesture);
      flashCard(gesture.id);
    } else {
      pickFile(gesture);
    }
  });
}

/** Open the OS file picker and bind the chosen audio file to this gesture. */
function pickFile(gesture) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*";
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    // createObjectURL gives the file a temporary in-browser address.
    // It lives until you refresh — for a permanent binding, drop the file in
    // the /sounds folder named after the gesture instead.
    setBinding(gesture.id, URL.createObjectURL(file), file.name);
  };
  input.click();
}

function setBinding(id, url, label) {
  soundBindings[id] = { url, label };
  const el = document.getElementById(`sound-${id}`);
  if (el) {
    el.textContent = "🎵 " + label;
    el.classList.add("custom");
  }
}

function flashCard(id) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  card.classList.add("fired");
  setTimeout(() => card.classList.remove("fired"), 350);
}

/**
 * Ask our server what's in the /sounds folder, and auto-bind any file whose
 * name matches a gesture id — sounds/fist.mp3 becomes the fist sound.
 */
async function loadSoundsFolder() {
  try {
    const files = await (await fetch("/api/sounds")).json();
    let count = 0;
    for (const file of files) {
      const base = file.replace(/\.[^.]+$/, "").toLowerCase(); // strip extension
      const gesture = GESTURES.find((g) => g.id === base);
      if (gesture) {
        setBinding(gesture.id, `/sounds/${encodeURIComponent(file)}`, file);
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/* ============================================================================
   7. THE ACTUAL FINGER MATHS
   ========================================================================= */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Decide which fingers are extended.
 *
 * For the four fingers: if a finger is straight, its TIP is further from the
 * wrist than its middle knuckle. If it's curled, the tip folds back in and
 * gets closer. Comparing those two distances works no matter how the hand is
 * rotated or how far away it is — that's why we use ratios, not pixels.
 *
 * The thumb is different: it doesn't curl toward the wrist, it folds sideways
 * across the palm. So we measure it against the pinky knuckle instead.
 *
 * Returns five booleans: [thumb, index, middle, ring, pinky]
 */
function getFingerStates(lm) {
  const wrist = lm[0];
  const pinkyKnuckle = lm[17];

  const thumbUp = dist(lm[4], pinkyKnuckle) > dist(lm[3], pinkyKnuckle) * CONFIG.thumbExtendRatio;

  const states = [thumbUp];
  // [fingertip, middle knuckle] for index, middle, ring, pinky
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    states.push(dist(lm[tip], wrist) > dist(lm[pip], wrist) * CONFIG.fingerExtendRatio);
  }
  return states;
}

/** Five booleans -> "01100" -> the matching gesture (or null). */
function classify(states) {
  const key = states.map((s) => (s ? "1" : "0")).join("");
  return { key, gesture: PATTERN_LOOKUP[key] || null };
}

/* --- Which hand is which? ---------------------------------------------------
   MediaPipe tells us "Left" or "Right" for each hand it finds. Its docs warn
   that it assumes a mirrored image and that you may need to swap the result —
   but tested against this webcam, swapping made it wrong, so we take the label
   at face value. Webcams and drivers differ, hence the ⇄ Swap L/R button,
   which toggles it live without touching any code.
--------------------------------------------------------------------------- */

let swapHands = CONFIG.swapHandedness;

function resolveHandKey(result, i) {
  const label = result.handedness && result.handedness[i] && result.handedness[i][0]
    ? result.handedness[i][0].categoryName
    : null;

  // No usable label? Fall back to detection order.
  if (label !== "Left" && label !== "Right") return HAND_KEYS[i] || null;

  if (!swapHands) return label;
  return label === "Left" ? "Right" : "Left";
}

/* ============================================================================
   8. ONE STATE MACHINE PER HAND
   ----------------------------------------------------------------------------
   This is the heart of two-handed support. Each hand gets its OWN memory of
   what it's currently doing, so your left hand holding ✌️ can't block your
   right hand from firing 🤘. They're completely independent — including the
   cooldown, so both hands can trigger in the same instant.
   ========================================================================= */

// Fresh, empty memory for one hand.
const newHandState = () => ({
  candidateId: null,  // gesture we think we're seeing right now
  candidateCount: 0,  // for how many frames in a row we've seen it
  committedId: null,  // gesture we've officially accepted and acted on
  lastFireTime: 0,    // when this hand last played a sound
  seenThisFrame: false,
});

// Left and Right each get their own copy.
const handStates = Object.fromEntries(HAND_KEYS.map((k) => [k, newHandState()]));

function resetHandStates() {
  for (const k of HAND_KEYS) handStates[k] = newHandState();
}

/**
 * Feed one hand's current gesture in. Pass null when that hand isn't visible
 * or isn't making a recognised shape.
 */
function updateGestureState(handKey, gesture) {
  const st = handStates[handKey];
  const id = gesture ? gesture.id : null;

  if (id === st.candidateId) {
    st.candidateCount++;
  } else {
    st.candidateId = id;
    st.candidateCount = 1;
  }

  // Not held long enough yet — do nothing.
  if (st.candidateCount < CONFIG.stableFrames) return;

  // Held long enough, but it's the same gesture this hand already played.
  // Requiring a change means holding a fist doesn't loop forever; you have to
  // drop the gesture and make it again to re-trigger.
  if (st.candidateId === st.committedId) return;

  st.committedId = st.candidateId;

  if (!gesture) return; // moved to "no recognised gesture" — nothing to play

  const now = performance.now();
  if (now - st.lastFireTime < CONFIG.cooldownMs) return;
  st.lastFireTime = now;

  playFor(gesture);
  flashCard(gesture.id);
  flashHandPanel(handKey);
}

/* ============================================================================
   8b. THE ON-SCREEN PANEL FOR EACH HAND
   ========================================================================= */

const FINGER_LABELS = ["thumb", "index", "mid", "ring", "pinky"];

function buildHandPanels() {
  handPanelsEl.innerHTML = "";
  for (const key of HAND_KEYS) {
    const panel = document.createElement("div");
    panel.className = "hand-panel idle";
    panel.id = `hand-${key}`;
    panel.innerHTML = `
      <div class="hand-head">
        <span class="hand-tag">${key} hand</span>
        <span class="hand-pattern" id="pattern-${key}">–––––</span>
      </div>
      <div class="hand-body">
        <span class="emoji" id="emoji-${key}">🖐️</span>
        <span class="gname" id="gname-${key}">not detected</span>
      </div>
      <div class="dots">
        ${FINGER_LABELS.map(
          (label, i) => `<div class="finger" id="dot-${key}-${i}"><div class="dot"></div>${label}</div>`
        ).join("")}
      </div>
    `;
    handPanelsEl.appendChild(panel);
  }
}

/** Refresh one hand's panel. Pass null for states/gesture when it's not in shot. */
function updateHandPanel(key, states, gesture, patternKey) {
  const panel = document.getElementById(`hand-${key}`);
  if (!panel) return;

  const visible = !!states;
  panel.classList.toggle("idle", !visible);
  panel.classList.toggle("active", visible && !!gesture);

  document.getElementById(`emoji-${key}`).textContent = visible ? (gesture ? gesture.emoji : "🫲") : "🖐️";
  document.getElementById(`gname-${key}`).textContent = visible
    ? gesture
      ? gesture.name
      : "unknown shape"
    : "not detected";
  document.getElementById(`pattern-${key}`).textContent = visible ? patternKey : "–––––";

  for (let i = 0; i < 5; i++) {
    document.getElementById(`dot-${key}-${i}`).classList.toggle("up", !!(states && states[i]));
  }
}

function flashHandPanel(key) {
  const panel = document.getElementById(`hand-${key}`);
  if (!panel) return;
  panel.classList.add("fired");
  setTimeout(() => panel.classList.remove("fired"), 350);
}

/* ============================================================================
   9. DRAWING the skeleton over the video
   ========================================================================= */

// Each hand gets its own colour so you can tell at a glance which skeleton
// belongs to which panel.
const HAND_COLORS = {
  Left: { bone: "rgba(87, 217, 163, 0.85)", joint: "rgba(87, 217, 163, 0.95)" },  // green
  Right: { bone: "rgba(240, 180, 41, 0.85)", joint: "rgba(240, 180, 41, 0.95)" }, // amber
};

function drawHand(lm, w, h, handKey) {
  const colors = HAND_COLORS[handKey] || HAND_COLORS.Left;

  // Bones
  ctx.lineWidth = 3;
  ctx.strokeStyle = colors.bone;
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h);
  }
  ctx.stroke();

  // Joints — fingertips drawn bigger and white so they stand out
  for (let i = 0; i < lm.length; i++) {
    const isTip = FINGERTIPS.includes(i);
    ctx.beginPath();
    ctx.arc(lm[i].x * w, lm[i].y * h, isTip ? 6 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = isTip ? "#ffffff" : colors.joint;
    ctx.fill();
  }

  // Label the hand right on the wrist, so there's no ambiguity at all.
  // The canvas is mirrored by CSS, so flip the text back or it reads backwards.
  const wx = lm[0].x * w;
  const wy = lm[0].y * h;
  ctx.save();
  ctx.translate(wx, wy);
  ctx.scale(-1, 1); // undo the mirror, just for this text
  ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = colors.joint;
  ctx.textAlign = "center";
  ctx.fillText(handKey, 0, 26);
  ctx.restore();
}

/* ============================================================================
   10. STARTUP + THE MAIN LOOP
   ========================================================================= */

let handLandmarker = null;
let stream = null;
let running = false;
let lastVideoTime = -1;
let frameTimes = [];

async function loadModel() {
  setStatus("Loading the hand-tracking model (about 8 MB, local)…");

  // Point MediaPipe at our own copy of its WebAssembly engine.
  const vision = await FilesetResolver.forVisionTasks("./vendor/wasm");

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "./vendor/hand_landmarker.task",
      delegate: "GPU", // use the graphics card when available; falls back to CPU
    },
    runningMode: "VIDEO", // tell it frames arrive in time order, so it can track
    numHands: CONFIG.maxHands, // 2 — look for up to two hands every frame
    minHandDetectionConfidence: CONFIG.minDetectionConfidence,
    minHandPresenceConfidence: CONFIG.minDetectionConfidence,
    minTrackingConfidence: CONFIG.minTrackingConfidence,
  });
}

async function start() {
  startBtn.disabled = true;
  try {
    if (!handLandmarker) await loadModel();

    setStatus("Asking for camera permission…");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    // Match the canvas pixel grid to the actual camera resolution, otherwise
    // the drawn skeleton lands in the wrong place.
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;

    ensureAudio(); // this click counts as the user gesture that unlocks audio

    running = true;
    stopBtn.disabled = false;
    setStatus(
      "Running — <b>both hands work independently</b>. Try ✌️ with one and 🤘 with the other at the same time.",
      "ready"
    );
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    setStatus(
      `<b>Couldn't start:</b> ${err.message}<br>` +
        `If this is about permission, click the camera icon in Chrome's address bar and allow it, then retry.`,
      "error"
    );
  }
}

function stop() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // Blank both panels and wipe both hands' memory.
  for (const k of HAND_KEYS) updateHandPanel(k, null, null, "");
  resetHandStates();

  startBtn.disabled = false;
  stopBtn.disabled = true;
  fpsEl.textContent = "";
  setStatus("Stopped. Camera is off.");
}

function loop() {
  if (!running) return;

  // Only run detection on genuinely new frames. The screen may refresh at
  // 120 Hz while the camera only delivers 30 frames a second.
  if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
    lastVideoTime = video.currentTime;

    const result = handLandmarker.detectForVideo(video, performance.now());

    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // --- Handle EVERY hand, each one independently ------------------------
    // `seen` collects what we found this frame, keyed by "Left" / "Right".
    const seen = {};
    const hands = result.landmarks || [];

    for (let i = 0; i < hands.length; i++) {
      let handKey = resolveHandKey(result, i);

      // Occasionally MediaPipe labels both hands the same. Rather than let the
      // second overwrite the first, park it in whichever slot is still free.
      if (seen[handKey]) handKey = HAND_KEYS.find((k) => !seen[k]);
      if (!handKey) continue; // more hands than panels — ignore the extras

      const lm = hands[i];
      const states = getFingerStates(lm);          // which fingers are up
      const { key, gesture } = classify(states);   // "01100" -> Peace

      seen[handKey] = { states, gesture, key };
      drawHand(lm, overlay.width, overlay.height, handKey);
    }

    // Now walk BOTH slots, not just the ones we saw. A hand that left the
    // frame gets fed `null`, which resets its state machine — so the same
    // gesture can fire again next time that hand comes back.
    for (const handKey of HAND_KEYS) {
      const info = seen[handKey];
      updateHandPanel(handKey, info ? info.states : null, info ? info.gesture : null, info ? info.key : "");
      updateGestureState(handKey, info ? info.gesture : null);
    }

    // Rolling frames-per-second counter over the last 30 frames.
    const now = performance.now();
    frameTimes.push(now);
    if (frameTimes.length > 30) frameTimes.shift();
    if (frameTimes.length > 1) {
      const fps = (frameTimes.length - 1) * 1000 / (now - frameTimes[0]);
      // Show the live hand count too — the quickest way to tell whether the
      // model is genuinely seeing both hands or just one.
      fpsEl.textContent = `${fps.toFixed(0)} fps · ${hands.length} hand${hands.length === 1 ? "" : "s"} detected`;
    }
  }

  requestAnimationFrame(loop);
}

/* ============================================================================
   11. WIRE IT UP
   ========================================================================= */

buildCards();
buildHandPanels();

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);

// Flip which physical hand maps to which panel, in case the labels read
// backwards on your camera. Both hands' memory is cleared so nothing
// half-finished carries across the swap.
swapBtn.addEventListener("click", () => {
  swapHands = !swapHands;
  resetHandStates();
  for (const k of HAND_KEYS) updateHandPanel(k, null, null, "");
});

loadSoundsFolder().then((n) => {
  if (n > 0) setStatus(`Loaded ${n} sound file(s) from the <code>sounds</code> folder. Click <b>Start camera</b>.`);
});
