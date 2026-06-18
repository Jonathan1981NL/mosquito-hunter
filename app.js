const $ = (id) => document.getElementById(id);

let stream = null;
let track = null;
let torchOn = false;
let audioCtx = null;
let analyser = null;
let prev = null;
let running = false;
let audioScore = 0;
let visualScore = 0;
let lockScore = 0;

$('startBtn').addEventListener('click', startHunt);
$('stopBtn').addEventListener('click', stopHunt);
$('torchBtn').addEventListener('click', toggleTorch);

async function startHunt() {
  try {
    $('startScreen').classList.add('hidden');
    $('huntScreen').classList.remove('hidden');

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const video = $('video');
    video.srcObject = stream;
    await video.play();

    track = stream.getVideoTracks()[0];
    running = true;

    setupAudio(stream);
    requestAnimationFrame(scanFrame);
    setInterval(updateHud, 250);
  } catch (e) {
    alert('Camera/microfoon starten lukt niet: ' + e.message + '\n\nGebruik straks de HTTPS GitHub Pages link op je telefoon.');
    $('startScreen').classList.remove('hidden');
    $('huntScreen').classList.add('hidden');
  }
}

function setupAudio(s) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(s);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 4096;
  source.connect(analyser);
}

function scanAudio() {
  if (!analyser || !audioCtx) return { freq: 0, peak: 0, score: 0 };

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);

  let peak = 0, idx = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > peak) { peak = data[i]; idx = i; }
  }

  const freq = idx * audioCtx.sampleRate / analyser.fftSize;
  let score = 0;

  if (freq >= 350 && freq <= 900) score += 45;
  if (peak > 45) score += Math.min(45, (peak - 45) * 1.3);

  audioScore = Math.round(Math.max(0, Math.min(100, score)));
  $('freqOut').textContent = `${Math.round(freq)} Hz / ${peak}`;
  return { freq, peak, score: audioScore };
}

function scanFrame() {
  if (!running) return;

  const video = $('video');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');

  overlay.width = video.clientWidth;
  overlay.height = video.clientHeight;
  octx.clearRect(0, 0, overlay.width, overlay.height);

  const w = 240;
  const h = Math.max(135, Math.round(w * (video.videoHeight || 720) / (video.videoWidth || 1280)));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });

  if (video.videoWidth > 0) {
    ctx.drawImage(video, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);

    if (prev) {
      const grid = [];
      const step = 4;
      let total = 0, sx = 0, sy = 0;

      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          const d = Math.abs(frame.data[i] - prev.data[i]) +
                    Math.abs(frame.data[i+1] - prev.data[i+1]) +
                    Math.abs(frame.data[i+2] - prev.data[i+2]);
          if (d > 75) {
            total++;
            sx += x;
            sy += y;
          }
        }
      }

      $('motionOut').textContent = total;

      if (total > 3 && total < 280) {
        const cx = sx / total;
        const cy = sy / total;
        visualScore = Math.round(Math.max(0, Math.min(100, 25 + total * 0.7)));

        const scaleX = overlay.width / w;
        const scaleY = overlay.height / h;
        drawTarget(octx, cx * scaleX, cy * scaleY, visualScore);
      } else {
        visualScore = Math.max(0, visualScore - 8);
      }
    }
    prev = frame;
  }

  scanAudio();

  if (audioScore > 35 && visualScore > 35) lockScore = Math.min(100, lockScore + 8);
  else lockScore = Math.max(0, lockScore - 5);

  requestAnimationFrame(scanFrame);
}

function drawTarget(ctx, x, y, conf) {
  const r = conf > 65 ? 58 : 42;
  ctx.strokeStyle = '#ff1a1a';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x - r - 12, y); ctx.lineTo(x - r + 10, y);
  ctx.moveTo(x + r - 10, y); ctx.lineTo(x + r + 12, y);
  ctx.moveTo(x, y - r - 12); ctx.lineTo(x, y - r + 10);
  ctx.moveTo(x, y + r - 10); ctx.lineTo(x, y + r + 12);
  ctx.stroke();

  ctx.fillStyle = '#ff1a1a';
  ctx.font = 'bold 18px Arial';
  ctx.fillText(`${conf}% TARGET?`, x + r + 10, y - 6);
}

function updateHud() {
  const confidence = Math.round(Math.max(visualScore, (audioScore + visualScore) / 2));
  $('confidenceOut').textContent = `${confidence}%`;

  $('audioThreat').textContent = `Audio: ${label(audioScore)}`;
  $('visualThreat').textContent = `Visual: ${label(visualScore)}`;

  if (lockScore > 65) {
    $('lockState').textContent = '🔴 TARGET LOCKED';
    $('lockState').style.background = 'rgba(229,9,20,.92)';
    if (navigator.vibrate) navigator.vibrate(80);
  } else if (visualScore > 35 || audioScore > 35) {
    $('lockState').textContent = 'Searching...';
    $('lockState').style.background = 'rgba(0,0,0,.75)';
  } else {
    $('lockState').textContent = 'No lock';
    $('lockState').style.background = 'rgba(0,0,0,.75)';
  }
}

function label(v) {
  if (v > 70) return 'HIGH';
  if (v > 35) return 'MEDIUM';
  return 'LOW';
}

async function toggleTorch() {
  if (!track) return alert('Camera is nog niet gestart.');
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.torch) {
    alert('Deze browser/telefoon staat zaklampbediening niet toe. Zet desnoods handmatig je zaklamp aan.');
    return;
  }
  torchOn = !torchOn;
  await track.applyConstraints({ advanced: [{ torch: torchOn }] });
  $('torchBtn').textContent = torchOn ? 'Zaklamp uit' : 'Zaklamp';
}

function stopHunt() {
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  stream = null; track = null; prev = null;
  $('huntScreen').classList.add('hidden');
  $('startScreen').classList.remove('hidden');
}
