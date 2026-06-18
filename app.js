const $ = (id) => document.getElementById(id);

let stream=null, track=null, torchOn=false, audioCtx=null, analyser=null;
let prev=null, running=false, mode='dual';
let audioScore=0, motionScore=0, wallScore=0, lockScore=0;
let stillCandidates=[];

$('startBtn').addEventListener('click', startHunt);
$('stopBtn').addEventListener('click', stopHunt);
$('torchBtn').addEventListener('click', toggleTorch);
$('modeBtn').addEventListener('click', toggleMode);

async function startHunt(){
  try{
    $('startScreen').classList.add('hidden');
    $('huntScreen').classList.remove('hidden');

    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},
      audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}
    });

    const video=$('video');
    video.srcObject=stream;
    await video.play();
    track=stream.getVideoTracks()[0];

    setupAudio(stream);
    running=true;
    requestAnimationFrame(scanFrame);
    setInterval(updateHud,250);
  }catch(e){
    alert('Starten lukt niet: '+e.message+'\nGebruik de HTTPS GitHub Pages-link.');
    $('huntScreen').classList.add('hidden');
    $('startScreen').classList.remove('hidden');
  }
}

function setupAudio(s){
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  const source=audioCtx.createMediaStreamSource(s);
  analyser=audioCtx.createAnalyser();
  analyser.fftSize=4096;
  source.connect(analyser);
}

function scanAudio(){
  if(!analyser||!audioCtx)return;
  const data=new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  let peak=0,idx=0;
  for(let i=0;i<data.length;i++){ if(data[i]>peak){peak=data[i];idx=i;} }
  const freq=idx*audioCtx.sampleRate/analyser.fftSize;
  let score=0;
  if(freq>=350&&freq<=900)score+=45;
  if(peak>45)score+=Math.min(45,(peak-45)*1.3);
  audioScore=Math.round(Math.max(0,Math.min(100,score)));
  $('freqOut').textContent=`${Math.round(freq)} Hz / ${peak}`;
}

function scanFrame(){
  if(!running)return;
  const video=$('video'), overlay=$('overlay'), octx=overlay.getContext('2d');
  overlay.width=video.clientWidth; overlay.height=video.clientHeight;
  octx.clearRect(0,0,overlay.width,overlay.height);

  const w=320;
  const h=Math.max(180,Math.round(w*(video.videoHeight||720)/(video.videoWidth||1280)));
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const ctx=c.getContext('2d',{willReadFrequently:true});

  if(video.videoWidth>0){
    ctx.drawImage(video,0,0,w,h);
    const frame=ctx.getImageData(0,0,w,h);
    if(mode==='dual'||mode==='motion') scanMotion(frame,w,h,octx,overlay);
    if(mode==='dual'||mode==='wall') scanWall(frame,w,h,octx,overlay);
    prev=frame;
  }

  scanAudio();

  const combined=Math.max(motionScore,wallScore,(wallScore+audioScore)/2,(motionScore+audioScore)/2);
  if(combined>62) lockScore=Math.min(100,lockScore+7);
  else lockScore=Math.max(0,lockScore-4);

  requestAnimationFrame(scanFrame);
}

function scanMotion(frame,w,h,octx,overlay){
  if(!prev){motionScore=0;return;}
  const step=4;
  let total=0,sx=0,sy=0;
  for(let y=0;y<h;y+=step){
    for(let x=0;x<w;x+=step){
      const i=(y*w+x)*4;
      const d=Math.abs(frame.data[i]-prev.data[i])+Math.abs(frame.data[i+1]-prev.data[i+1])+Math.abs(frame.data[i+2]-prev.data[i+2]);
      if(d>80){total++;sx+=x;sy+=y;}
    }
  }
  $('motionOut').textContent=total;
  if(total>2&&total<180){
    const cx=sx/total, cy=sy/total;
    motionScore=Math.round(Math.max(0,Math.min(100,30+total*0.9)));
    drawRedTarget(octx,cx*overlay.width/w,cy*overlay.height/h,motionScore);
  }else{
    motionScore=Math.max(0,motionScore-8);
  }
}

function scanWall(frame,w,h,octx,overlay){
  // zoekt kleine donkere stipjes op relatief lichte/egale achtergrond
  const step=3;
  const candidates=[];
  const data=frame.data;

  for(let y=8;y<h-8;y+=step){
    for(let x=8;x<w-8;x+=step){
      const i=(y*w+x)*4;
      const lum=0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2];

      let ring=0, n=0;
      for(let dy=-6;dy<=6;dy+=6){
        for(let dx=-6;dx<=6;dx+=6){
          if(dx===0&&dy===0)continue;
          const j=((y+dy)*w+(x+dx))*4;
          ring += 0.2126*data[j]+0.7152*data[j+1]+0.0722*data[j+2];
          n++;
        }
      }
      const bg=ring/n;
      const contrast=bg-lum;

      // filter: donkerder dan omgeving, niet enorm donker vlak, niet te weinig contrast
      if(contrast>38 && bg>85 && lum<115){
        candidates.push({x,y,score:Math.min(100,Math.round(contrast*1.5))});
      }
    }
  }

  // cluster kandidaten die dicht bij elkaar liggen
  const clusters=[];
  for(const p of candidates){
    let found=false;
    for(const cl of clusters){
      const dx=cl.x-p.x, dy=cl.y-p.y;
      if(dx*dx+dy*dy<80){
        cl.x=(cl.x*cl.n+p.x)/(cl.n+1);
        cl.y=(cl.y*cl.n+p.y)/(cl.n+1);
        cl.score=Math.max(cl.score,p.score);
        cl.n++;
        found=true; break;
      }
    }
    if(!found) clusters.push({x:p.x,y:p.y,score:p.score,n:1});
  }

  const filtered=clusters
    .filter(c=>c.n>=1 && c.n<=18)
    .sort((a,b)=>(b.score+b.n*4)-(a.score+a.n*4))
    .slice(0,5);

  stillCandidates=filtered;
  $('wallOut').textContent=filtered.length;

  wallScore=filtered.length ? Math.min(100, Math.round(filtered[0].score + filtered[0].n*4)) : Math.max(0,wallScore-5);

  for(const cl of filtered){
    drawGreenTarget(octx,cl.x*overlay.width/w,cl.y*overlay.height/h,Math.min(99,Math.round(cl.score+cl.n*4)));
  }
}

function drawRedTarget(ctx,x,y,conf){
  const r=conf>65?58:42;
  ctx.strokeStyle='#ff1a1a'; ctx.lineWidth=5;
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x-r-12,y);ctx.lineTo(x-r+10,y);
  ctx.moveTo(x+r-10,y);ctx.lineTo(x+r+12,y);
  ctx.moveTo(x,y-r-12);ctx.lineTo(x,y-r+10);
  ctx.moveTo(x,y+r-10);ctx.lineTo(x,y+r+12);
  ctx.stroke();
  ctx.fillStyle='#ff1a1a';ctx.font='bold 18px Arial';
  ctx.fillText(`${conf}% MOVING`,x+r+10,y-6);
}

function drawGreenTarget(ctx,x,y,conf){
  const r=30;
  ctx.strokeStyle='#00ff78'; ctx.lineWidth=4;
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle='rgba(0,255,120,.16)';
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#00ff78';ctx.font='bold 16px Arial';
  ctx.fillText(`${conf}% STILL?`,x+r+8,y-5);
}

function updateHud(){
  const confidence=Math.round(Math.max(motionScore,wallScore,(audioScore+Math.max(motionScore,wallScore))/2));
  $('confidenceOut').textContent=`${confidence}%`;
  $('audioThreat').textContent=`Audio: ${label(audioScore)}`;
  $('motionThreat').textContent=`Motion: ${label(motionScore)}`;
  $('wallThreat').textContent=`Wall: ${label(wallScore)}`;

  if(lockScore>65){
    $('lockState').textContent='🔴 TARGET LOCKED';
    $('lockState').style.background='rgba(229,9,20,.92)';
    if(navigator.vibrate)navigator.vibrate(80);
  }else if(confidence>35){
    $('lockState').textContent='Searching...';
    $('lockState').style.background='rgba(0,0,0,.75)';
  }else{
    $('lockState').textContent='No lock';
    $('lockState').style.background='rgba(0,0,0,.75)';
  }
}
function label(v){if(v>70)return'HIGH';if(v>35)return'MEDIUM';return'LOW';}

function toggleMode(){
  if(mode==='dual')mode='motion';
  else if(mode==='motion')mode='wall';
  else mode='dual';
  $('modeBtn').textContent='Mode: '+(mode==='dual'?'Dual':mode==='motion'?'Motion':'Wall');
}

async function toggleTorch(){
  if(!track)return alert('Camera is nog niet gestart.');
  const caps=track.getCapabilities?track.getCapabilities():{};
  if(!caps.torch){
    alert('Deze browser/telefoon staat zaklampbediening niet toe. Zet desnoods handmatig je zaklamp aan.');
    return;
  }
  torchOn=!torchOn;
  await track.applyConstraints({advanced:[{torch:torchOn}]});
  $('torchBtn').textContent=torchOn?'Zaklamp uit':'Zaklamp';
}

function stopHunt(){
  running=false;
  if(stream)stream.getTracks().forEach(t=>t.stop());
  if(audioCtx)audioCtx.close();
  stream=null;track=null;prev=null;
  $('huntScreen').classList.add('hidden');
  $('startScreen').classList.remove('hidden');
}
