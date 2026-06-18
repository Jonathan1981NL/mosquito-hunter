const $ = (id) => document.getElementById(id);

let stream=null, track=null, torchOn=false, audioCtx=null, analyser=null;
let prev=null, running=false, mode='dual';
let audioScore=0, motionScore=0, wallScore=0, lockScore=0;
let tracks=[];
let zoomLevel=1;
let nextTrackId=1;

$('startBtn').addEventListener('click', startHunt);
$('stopBtn').addEventListener('click', stopHunt);
$('torchBtn').addEventListener('click', toggleTorch);
$('modeBtn').addEventListener('click', toggleMode);
$('zoomBtn').addEventListener('click', cycleZoom);

async function startHunt(){
  try{
    $('startScreen').classList.add('hidden');
    $('huntScreen').classList.remove('hidden');

    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},
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
    alert('Starten lukt niet: '+e.message+'\\nGebruik de HTTPS GitHub Pages-link.');
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
  if(freq>=350&&freq<=900)score+=40;
  if(peak>50)score+=Math.min(45,(peak-50)*1.15);
  audioScore=Math.round(Math.max(0,Math.min(100,score)));
  $('freqOut').textContent=`${Math.round(freq)} Hz / ${peak}`;
}

function scanFrame(){
  if(!running)return;
  const video=$('video'), overlay=$('overlay'), octx=overlay.getContext('2d');
  overlay.width=video.clientWidth; overlay.height=video.clientHeight;
  octx.clearRect(0,0,overlay.width,overlay.height);

  const w=360;
  const h=Math.max(202,Math.round(w*(video.videoHeight||1080)/(video.videoWidth||1920)));
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const ctx=c.getContext('2d',{willReadFrequently:true});

  if(video.videoWidth>0){
    const vw=video.videoWidth, vh=video.videoHeight;
    const cropW=vw/zoomLevel, cropH=vh/zoomLevel;
    const cropX=(vw-cropW)/2, cropY=(vh-cropH)/2;
    ctx.drawImage(video,cropX,cropY,cropW,cropH,0,0,w,h);

    const frame=ctx.getImageData(0,0,w,h);
    const detections=[];

    if(mode==='dual'||mode==='motion') detections.push(...scanMotion(frame,w,h));
    if(mode==='dual'||mode==='wall') detections.push(...scanWall(frame,w,h));

    updateTracks(detections,w,h);
    drawTracks(octx,overlay,w,h);

    prev=frame;
  }

  scanAudio();
  const best = tracks.length ? Math.max(...tracks.map(t=>t.score)) : 0;
  const combined=Math.max(best,(best+audioScore)/2);
  if(combined>72) lockScore=Math.min(100,lockScore+6);
  else lockScore=Math.max(0,lockScore-3);

  requestAnimationFrame(scanFrame);
}

function scanMotion(frame,w,h){
  if(!prev){motionScore=0;return [];}
  const step=4;
  let total=0,sx=0,sy=0;
  for(let y=0;y<h;y+=step){
    for(let x=0;x<w;x+=step){
      const i=(y*w+x)*4;
      const d=Math.abs(frame.data[i]-prev.data[i])+Math.abs(frame.data[i+1]-prev.data[i+1])+Math.abs(frame.data[i+2]-prev.data[i+2]);
      if(d>95){total++;sx+=x;sy+=y;}
    }
  }
  $('motionOut').textContent=total;

  if(total>2&&total<85){
    const cx=sx/total, cy=sy/total;
    // hand/large movement suppression: small cluster only
    const raw=Math.min(100,30+total*1.1);
    motionScore=Math.round(raw);
    return [{x:cx,y:cy,type:'motion',score:motionScore,size:total}];
  }else{
    motionScore=Math.max(0,motionScore-10);
    return [];
  }
}

function scanWall(frame,w,h){
  const step=4;
  const candidates=[];
  const data=frame.data;

  for(let y=10;y<h-10;y+=step){
    for(let x=10;x<w-10;x+=step){
      const i=(y*w+x)*4;
      const lum=0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2];

      let ring=0,n=0, ringVar=0;
      const samples=[];
      for(let dy=-8;dy<=8;dy+=8){
        for(let dx=-8;dx<=8;dx+=8){
          if(dx===0&&dy===0)continue;
          const j=((y+dy)*w+(x+dx))*4;
          const l=0.2126*data[j]+0.7152*data[j+1]+0.0722*data[j+2];
          samples.push(l); ring+=l; n++;
        }
      }
      const bg=ring/n;
      for(const s of samples) ringVar += Math.abs(s-bg);
      ringVar/=samples.length;

      const contrast=bg-lum;

      // stricter: dark spot on reasonably light, not too textured background
      if(contrast>48 && bg>95 && lum<105 && ringVar<38){
        candidates.push({x,y,score:Math.min(100,Math.round(contrast*1.25 - ringVar*0.35))});
      }
    }
  }

  const clusters=[];
  for(const p of candidates){
    let found=false;
    for(const cl of clusters){
      const dx=cl.x-p.x, dy=cl.y-p.y;
      if(dx*dx+dy*dy<95){
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
    .filter(c=>c.n>=1 && c.n<=10)
    .map(c=>{
      // pseudo-AI scoring: contrast + plausible size + audio support, penalize texture/large clusters
      const sizeScore = c.n>=2 && c.n<=7 ? 16 : 6;
      const audioBoost = audioScore>35 ? 8 : 0;
      return {x:c.x,y:c.y,type:'wall',score:Math.min(99,Math.round(c.score+sizeScore+audioBoost)),size:c.n};
    })
    .sort((a,b)=>b.score-a.score)
    .slice(0,4);

  $('wallOut').textContent=filtered.length;
  wallScore=filtered.length ? filtered[0].score : Math.max(0,wallScore-6);
  return filtered;
}

function updateTracks(detections,w,h){
  // decay existing tracks
  for(const t of tracks){
    t.age++;
    t.ttl--;
    t.score=Math.max(0,t.score-1.2);
    t.matched=false;
  }

  for(const d of detections){
    let best=null,bestDist=99999;
    for(const t of tracks){
      const dx=t.x-d.x, dy=t.y-d.y;
      const dist=dx*dx+dy*dy;
      if(dist<bestDist && dist<900){ best=t; bestDist=dist; }
    }
    if(best){
      const movement=Math.sqrt(bestDist);
      best.x=best.x*0.65+d.x*0.35;
      best.y=best.y*0.65+d.y*0.35;
      best.type=d.type;
      best.hits++;
      best.ttl=d.type==='wall'?45:25;
      best.score=Math.min(100, best.score*0.55 + d.score*0.45 + Math.min(18,best.hits*2));
      best.lastMove=movement;
      best.matched=true;
    }else{
      tracks.push({id:nextTrackId++,x:d.x,y:d.y,type:d.type,score:d.score,hits:1,age:0,ttl:d.type==='wall'?38:20,lastMove:0,matched:true});
    }
  }

  tracks=tracks.filter(t=>t.ttl>0 && t.score>8).sort((a,b)=>b.score-a.score).slice(0,8);
  $('tracksOut').textContent=tracks.length;
}

function drawTracks(ctx,overlay,w,h){
  for(const t of tracks){
    const x=t.x*overlay.width/w, y=t.y*overlay.height/h;
    const conf=Math.round(t.score);
    if(t.type==='motion') drawRedTarget(ctx,x,y,conf,t.hits);
    else drawGreenTarget(ctx,x,y,conf,t.hits);
  }
}

function drawRedTarget(ctx,x,y,conf,hits){
  const r=conf>70?60:42;
  ctx.strokeStyle='#ff1a1a'; ctx.lineWidth=5;
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x-r-12,y);ctx.lineTo(x-r+10,y);
  ctx.moveTo(x+r-10,y);ctx.lineTo(x+r+12,y);
  ctx.moveTo(x,y-r-12);ctx.lineTo(x,y-r+10);
  ctx.moveTo(x,y+r-10);ctx.lineTo(x,y+r+12);
  ctx.stroke();
  ctx.fillStyle='#ff1a1a';ctx.font='bold 18px Arial';
  ctx.fillText(`${conf}% MOVING (${hits})`,x+r+10,y-6);
}

function drawGreenTarget(ctx,x,y,conf,hits){
  const r=conf>70?42:31;
  ctx.strokeStyle='#00ff78'; ctx.lineWidth=4;
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle='rgba(0,255,120,.16)';
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#00ff78';ctx.font='bold 16px Arial';
  ctx.fillText(`${conf}% STILL (${hits})`,x+r+8,y-5);
}

function updateHud(){
  const best = tracks.length ? Math.max(...tracks.map(t=>t.score)) : 0;
  $('confidenceOut').textContent=`${Math.round(best)}%`;
  $('audioThreat').textContent=`Audio: ${label(audioScore)}`;
  $('motionThreat').textContent=`Motion: ${label(motionScore)}`;
  $('wallThreat').textContent=`Wall: ${label(wallScore)}`;

  if(lockScore>70){
    const top=tracks[0];
    $('lockState').textContent=top && top.type==='wall' ? '🟢 STILL TARGET LOCKED' : '🔴 MOVING TARGET LOCKED';
    $('lockState').style.background=top && top.type==='wall' ? 'rgba(0,160,80,.92)' : 'rgba(229,9,20,.92)';
    if(navigator.vibrate)navigator.vibrate(80);
  }else if(best>40){
    $('lockState').textContent='Tracking...';
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

async function cycleZoom(){
  zoomLevel = zoomLevel===1 ? 2 : zoomLevel===2 ? 3 : 1;
  $('zoomBtn').textContent=`Zoom: ${zoomLevel}x`;

  // Try real optical/browser zoom first. If unsupported, app still uses digital crop zoom.
  if(track && track.getCapabilities){
    const caps=track.getCapabilities();
    if(caps.zoom){
      const z=Math.min(caps.zoom.max, Math.max(caps.zoom.min, zoomLevel));
      try{ await track.applyConstraints({advanced:[{zoom:z}]}); }catch(e){}
    }
  }
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
  stream=null;track=null;prev=null;tracks=[];
  $('huntScreen').classList.add('hidden');
  $('startScreen').classList.remove('hidden');
}
