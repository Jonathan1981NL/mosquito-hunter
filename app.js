const $ = (id) => document.getElementById(id);

let stream=null, track=null, torchOn=false, audioCtx=null, analyser=null;
let prev=null, running=false, mode='dual', sensitivity='balanced';
let audioScore=0, motionScore=0, wallScore=0, lockScore=0, avgLum=0;
let tracks=[], samples=[];
let zoomLevel=1, nextTrackId=1;

$('startBtn').addEventListener('click', startHunt);
$('stopBtn').addEventListener('click', stopHunt);
$('torchBtn').addEventListener('click', toggleTorch);
$('modeBtn').addEventListener('click', toggleMode);
$('zoomBtn').addEventListener('click', cycleZoom);
$('sensitivityBtn').addEventListener('click', cycleSensitivity);
$('confirmMosquito').addEventListener('click', () => labelBest(true));
$('rejectTarget').addEventListener('click', () => labelBest(false));
$('overlay').addEventListener('pointerdown', manualTarget);

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

  // more selective mosquito-like wingbeat band; still broad enough for testing
  let score=0;
  if(freq>=380&&freq<=820)score+=46;
  if(freq>=430&&freq<=680)score+=14;
  if(peak>52)score+=Math.min(40,(peak-52)*1.05);

  audioScore=Math.round(clamp(score,0,100));
  $('freqOut').textContent=`${Math.round(freq)} Hz / ${peak}`;
}

function scanFrame(){
  if(!running)return;

  const video=$('video'), overlay=$('overlay'), octx=overlay.getContext('2d');
  overlay.width=video.clientWidth; overlay.height=video.clientHeight;
  octx.clearRect(0,0,overlay.width,overlay.height);

  const w=420;
  const h=Math.max(236,Math.round(w*(video.videoHeight||1080)/(video.videoWidth||1920)));
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const ctx=c.getContext('2d',{willReadFrequently:true});

  if(video.videoWidth>0){
    const vw=video.videoWidth, vh=video.videoHeight;
    const cropW=vw/zoomLevel, cropH=vh/zoomLevel;
    const cropX=(vw-cropW)/2, cropY=(vh-cropH)/2;
    ctx.drawImage(video,cropX,cropY,cropW,cropH,0,0,w,h);

    const frame=ctx.getImageData(0,0,w,h);
    avgLum = computeAvgLum(frame);
    $('lightOut').textContent = Math.round(avgLum);

    const detections=[];
    if(mode==='dual'||mode==='motion') detections.push(...scanMotion(frame,w,h));
    if(mode==='dual'||mode==='wall') detections.push(...scanWall(frame,w,h));

    updateTracks(detections,w,h);
    drawTracks(octx,overlay,w,h);

    prev=frame;
  }

  scanAudio();
  const best = tracks.length ? Math.max(...tracks.map(t=>t.score)) : 0;
  const bestHits = tracks.length ? tracks[0].hits : 0;
  const combined=Math.max(best,(best+audioScore)/2);

  // longer, stricter lock: needs repeated evidence or manual target
  if((combined>78 && bestHits>=3) || (tracks[0] && tracks[0].manual && tracks[0].score>62)){
    lockScore=Math.min(100,lockScore+5);
  } else {
    lockScore=Math.max(0,lockScore-1.5);
  }

  requestAnimationFrame(scanFrame);
}

function computeAvgLum(frame){
  const d=frame.data; let total=0, n=0;
  for(let i=0;i<d.length;i+=80){
    total += 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; n++;
  }
  return total/n;
}

function scanMotion(frame,w,h){
  if(!prev){motionScore=0;return [];}
  const step=4;
  let total=0,sx=0,sy=0,minX=w,maxX=0,minY=h,maxY=0;
  const threshold = avgLum < 70 ? 120 : 105;

  for(let y=0;y<h;y+=step){
    for(let x=0;x<w;x+=step){
      const i=(y*w+x)*4;
      const d=Math.abs(frame.data[i]-prev.data[i])+Math.abs(frame.data[i+1]-prev.data[i+1])+Math.abs(frame.data[i+2]-prev.data[i+2]);
      if(d>threshold){
        total++;sx+=x;sy+=y;
        if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
      }
    }
  }

  $('motionOut').textContent=total;
  const boxW=maxX-minX, boxH=maxY-minY, area=boxW*boxH;

  // suppress hand and camera sweep: too large, too spread out, too much total motion
  const maxTotal = sensitivity==='strict' ? 45 : sensitivity==='balanced' ? 75 : 115;
  if(total>=3 && total<maxTotal && area<2400){
    const cx=sx/total, cy=sy/total;
    const compactness = area>0 ? clamp((total*16)/area,0,1) : 0;
    const darkBoost = avgLum<65 ? 8 : 0;
    const score=clamp(42 + total*0.9 + compactness*18 + darkBoost,0,100);
    motionScore=Math.round(score);
    return [{x:cx,y:cy,type:'motion',score:motionScore,size:total,boxArea:area}];
  }

  motionScore=Math.max(0,motionScore-8);
  return [];
}

function scanWall(frame,w,h){
  const step = sensitivity==='high' ? 3 : 4;
  const candidates=[];
  const data=frame.data;

  const isDark = avgLum < 75;
  const contrastMin = sensitivity==='strict' ? 62 : sensitivity==='balanced' ? 55 : 48;
  const bgMin = isDark ? 55 : 90;
  const lumMax = isDark ? 95 : 112;
  const textureMax = sensitivity==='strict' ? 26 : sensitivity==='balanced' ? 32 : 40;

  for(let y=12;y<h-12;y+=step){
    for(let x=12;x<w-12;x+=step){
      const i=(y*w+x)*4;
      const lum=lumAt(data,i);

      let ring=0,n=0, ringVar=0;
      const samples=[];
      for(let dy=-10;dy<=10;dy+=10){
        for(let dx=-10;dx<=10;dx+=10){
          if(dx===0&&dy===0)continue;
          const j=((y+dy)*w+(x+dx))*4;
          const l=lumAt(data,j);
          samples.push(l); ring+=l; n++;
        }
      }
      const bg=ring/n;
      for(const s of samples) ringVar+=Math.abs(s-bg);
      ringVar/=samples.length;

      const contrast=bg-lum;
      if(contrast>contrastMin && bg>bgMin && lum<lumMax && ringVar<textureMax){
        candidates.push({x,y,contrast,texture:ringVar,lum,bg});
      }
    }
  }

  const clusters=[];
  for(const p of candidates){
    let found=false;
    for(const cl of clusters){
      const dx=cl.x-p.x, dy=cl.y-p.y;
      if(dx*dx+dy*dy<120){
        cl.x=(cl.x*cl.n+p.x)/(cl.n+1);
        cl.y=(cl.y*cl.n+p.y)/(cl.n+1);
        cl.contrast=Math.max(cl.contrast,p.contrast);
        cl.texture=(cl.texture*cl.n+p.texture)/(cl.n+1);
        cl.n++;
        found=true; break;
      }
    }
    if(!found) clusters.push({x:p.x,y:p.y,contrast:p.contrast,texture:p.texture,n:1});
  }

  const filtered=clusters
    .filter(c=>{
      // reject texture/noise and objects too large for likely mosquito at typical scan distance
      const maxN = sensitivity==='high' ? 12 : 8;
      return c.n>=1 && c.n<=maxN && c.texture<textureMax;
    })
    .map(c=>{
      const sizeScore = c.n>=2 && c.n<=6 ? 24 : 9;
      const contrastScore = clamp((c.contrast-contrastMin)*1.8,0,34);
      const texturePenalty = c.texture*0.45;
      const darkBoost = isDark ? 10 : 0;
      const audioBoost = audioScore>40 ? 7 : 0;
      const score = clamp(50 + sizeScore + contrastScore + darkBoost + audioBoost - texturePenalty,0,99);
      return {x:c.x,y:c.y,type:'wall',score:Math.round(score),size:c.n,texture:c.texture};
    })
    .filter(c=>c.score >= (sensitivity==='strict'?72:65))
    .sort((a,b)=>b.score-a.score)
    .slice(0,3);

  $('wallOut').textContent=filtered.length;
  wallScore=filtered.length ? filtered[0].score : Math.max(0,wallScore-5);
  return filtered;
}

function lumAt(data,i){ return 0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2]; }
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }

function updateTracks(detections,w,h){
  for(const t of tracks){
    t.age++; t.ttl--; t.score=Math.max(0,t.score-(t.manual?0.25:0.9)); t.matched=false;
  }

  for(const d of detections){
    let best=null,bestDist=99999;
    for(const t of tracks){
      const dx=t.x-d.x, dy=t.y-d.y;
      const dist=dx*dx+dy*dy;
      const gate = t.manual ? 2500 : 1100;
      if(dist<bestDist && dist<gate){ best=t; bestDist=dist; }
    }

    if(best){
      const movement=Math.sqrt(bestDist);
      best.x=best.x*0.72+d.x*0.28;
      best.y=best.y*0.72+d.y*0.28;
      best.type=best.manual ? 'manual' : d.type;
      best.hits++;
      best.ttl=best.manual ? 180 : d.type==='wall' ? 95 : 55;
      best.score=clamp(best.score*0.62 + d.score*0.38 + Math.min(20,best.hits*1.7),0,100);
      best.lastMove=movement;
      best.matched=true;
    }else{
      tracks.push({
        id:nextTrackId++,x:d.x,y:d.y,type:d.type,score:d.score,hits:1,age:0,
        ttl:d.type==='wall'?85:45,lastMove:0,matched:true,manual:false
      });
    }
  }

  tracks=tracks.filter(t=>t.ttl>0 && t.score>14).sort((a,b)=>b.score-a.score).slice(0,8);
  $('tracksOut').textContent=tracks.length;
}

function manualTarget(ev){
  const overlay=$('overlay');
  const rect=overlay.getBoundingClientRect();
  const ox=ev.clientX-rect.left, oy=ev.clientY-rect.top;

  // map screen tap to analysis space approximation
  const w=420;
  const h=Math.max(236,Math.round(w*(($('video').videoHeight||1080)/($('video').videoWidth||1920))));
  const x=ox/overlay.width*w, y=oy/overlay.height*h;

  tracks.unshift({
    id:nextTrackId++, x, y, type:'manual', score:88, hits:6, age:0,
    ttl:220, lastMove:0, matched:true, manual:true
  });
  tracks=tracks.slice(0,8);
  lockScore=75;
  $('manualState').textContent='Manual: target';
  if(navigator.vibrate)navigator.vibrate([40,30,40]);
}

function drawTracks(ctx,overlay,w,h){
  for(const t of tracks){
    const x=t.x*overlay.width/w, y=t.y*overlay.height/h;
    const conf=Math.round(t.score);
    if(t.type==='motion') drawRedTarget(ctx,x,y,conf,t.hits);
    else if(t.type==='manual') drawBlueTarget(ctx,x,y,conf,t.hits);
    else drawGreenTarget(ctx,x,y,conf,t.hits);
  }
}

function drawReticle(ctx,x,y,r,color,label){
  ctx.strokeStyle=color; ctx.lineWidth=5;
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x-r-12,y);ctx.lineTo(x-r+10,y);
  ctx.moveTo(x+r-10,y);ctx.lineTo(x+r+12,y);
  ctx.moveTo(x,y-r-12);ctx.lineTo(x,y-r+10);
  ctx.moveTo(x,y+r-10);ctx.lineTo(x,y+r+12);
  ctx.stroke();
  ctx.fillStyle=color; ctx.font='bold 17px Arial';
  ctx.fillText(label,x+r+9,y-6);
}
function drawRedTarget(ctx,x,y,conf,hits){ drawReticle(ctx,x,y,conf>76?60:42,'#ff1a1a',`${conf}% MOVING (${hits})`); }
function drawGreenTarget(ctx,x,y,conf,hits){
  const r=conf>78?43:31;
  ctx.strokeStyle='#00ff78'; ctx.lineWidth=4;
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle='rgba(0,255,120,.16)';
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#00ff78';ctx.font='bold 16px Arial';
  ctx.fillText(`${conf}% STILL (${hits})`,x+r+8,y-5);
}
function drawBlueTarget(ctx,x,y,conf,hits){ drawReticle(ctx,x,y,60,'#2b8cff',`${conf}% MANUAL LOCK`); }

function updateHud(){
  const best = tracks.length ? tracks[0].score : 0;
  $('confidenceOut').textContent=`${Math.round(best)}%`;
  $('audioThreat').textContent=`Audio: ${label(audioScore)}`;
  $('motionThreat').textContent=`Motion: ${label(motionScore)}`;
  $('wallThreat').textContent=`Wall: ${label(wallScore)}`;
  $('samplesOut').textContent=samples.length;

  if(lockScore>70 && tracks.length){
    const top=tracks[0];
    if(top.type==='manual') {
      $('lockState').textContent='🔵 MANUAL TARGET LOCKED';
      $('lockState').style.background='rgba(43,140,255,.92)';
    } else if(top.type==='wall') {
      $('lockState').textContent='🟢 STILL TARGET LOCKED';
      $('lockState').style.background='rgba(0,160,80,.92)';
    } else {
      $('lockState').textContent='🔴 MOVING TARGET LOCKED';
      $('lockState').style.background='rgba(229,9,20,.92)';
    }
  }else if(best>45){
    $('lockState').textContent='Tracking...';
    $('lockState').style.background='rgba(0,0,0,.75)';
  }else{
    $('lockState').textContent='No lock';
    $('lockState').style.background='rgba(0,0,0,.75)';
  }
}

function label(v){if(v>70)return'HIGH';if(v>35)return'MEDIUM';return'LOW';}

function labelBest(isMosquito){
  if(!tracks.length){ alert('Geen target om te labelen. Tik eerst op een target of scan opnieuw.'); return; }
  const t=tracks[0];
  samples.push({ts:Date.now(),label:isMosquito?'mosquito':'not_mosquito',type:t.type,score:Math.round(t.score),hits:t.hits,manual:t.manual});
  localStorage.setItem('mh_samples_v04', JSON.stringify(samples.slice(-500)));
  if(isMosquito){
    t.score=100; t.hits+=5; t.ttl=Math.max(t.ttl,220); lockScore=100;
    if(navigator.vibrate)navigator.vibrate([60,30,60]);
  }else{
    tracks.shift(); lockScore=Math.max(0,lockScore-25);
  }
}

function toggleMode(){
  if(mode==='dual')mode='motion';
  else if(mode==='motion')mode='wall';
  else mode='dual';
  $('modeBtn').textContent='Mode: '+(mode==='dual'?'Dual':mode==='motion'?'Motion':'Wall');
}

function cycleSensitivity(){
  if(sensitivity==='balanced')sensitivity='strict';
  else if(sensitivity==='strict')sensitivity='high';
  else sensitivity='balanced';
  const label=sensitivity==='balanced'?'Balanced':sensitivity==='strict'?'Strict':'Dark Boost';
  $('sensitivityBtn').textContent='Sensitivity: '+label;
}

async function cycleZoom(){
  zoomLevel = zoomLevel===1 ? 2 : zoomLevel===2 ? 3 : 1;
  $('zoomBtn').textContent=`Zoom: ${zoomLevel}x`;
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
