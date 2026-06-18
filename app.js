const $=(id)=>document.getElementById(id);
let stream=null,track=null,audioCtx=null,analyser=null,prev=null,running=false;
let sensitivity='strict',hunterMode=true,manualArmed=false,zoomLevel=1,nextTrackId=1;
let audioScore=0,motionScore=0,wallScore=0,lockScore=0,avgLum=0,tracks=[];
let profile=loadProfile();

$('startBtn').onclick=startHunt;$('academyStartBtn').onclick=openAcademy;$('profileStartBtn').onclick=openProfile;
$('menuBtn').onclick=()=>$('menuSheet').classList.remove('hidden');$('closeMenuBtn').onclick=()=>$('menuSheet').classList.add('hidden');
$('openAcademyBtn').onclick=openAcademy;$('academyBtn')&&($('academyBtn').onclick=openAcademy);$('closeAcademyBtn').onclick=closeAcademy;
$('openProfileBtn').onclick=openProfile;$('profileBtn')&&($('profileBtn').onclick=openProfile);$('closeProfileBtn').onclick=closeProfile;$('saveProfileBtn').onclick=saveProfile;
$('stopBtn').onclick=stopHunt;$('manualBtn').onclick=armManual;$('toggleHunterBtn').onclick=toggleHunter;$('zoomBtn').onclick=cycleZoom;$('cycleModeBtn').onclick=cycleSensitivity;
$('confirmMosquito').onclick=()=>labelBest(true);$('rejectTarget').onclick=()=>labelBest(false);$('catchShotBtn').onclick=makeCatchShot;$('overlay').addEventListener('pointerdown',manualTarget);

function loadProfile(){return JSON.parse(localStorage.getItem('mh_profile_v07')||'{"name":"Guest Hunter","kills":0,"xp":0,"shots":0}')}
function saveProfileData(){localStorage.setItem('mh_profile_v07',JSON.stringify(profile))}
function rankForXP(xp){if(xp>=5000)return ['Mosquito Overlord',6,'👑🦟'];if(xp>=2500)return ['Night Stalker',5,'🥷🦟'];if(xp>=1200)return ['Swarm Slayer',4,'🛡️🦟'];if(xp>=500)return ['Hunter Elite',3,'🎯🦟'];if(xp>=150)return ['Hunter',2,'🧢🦟'];return ['Rookie',1,'🧢']}
function nextRankXP(xp){return xp<150?150:xp<500?500:xp<1200?1200:xp<2500?2500:xp<5000?5000:5000}
function refreshProfileUI(){
  const [rank,level,avatar]=rankForXP(profile.xp);
  $('hunterNameOut').textContent=profile.name;$('rankOut').textContent=rank;$('rankHud').textContent=rank;$('xpOut').textContent=profile.xp;$('killOut').textContent=profile.kills;
  $('profileRank').textContent=rank;$('profileLevel').textContent=level;$('profileKills').textContent=profile.kills;$('profileXP').textContent=profile.xp;$('avatar').textContent=avatar;$('hunterNameInput').value=profile.name;
  const next=nextRankXP(profile.xp),prev=level===1?0:level===2?150:level===3?500:level===4?1200:level===5?2500:5000,pct=next===prev?100:Math.round((profile.xp-prev)/(next-prev)*100);
  $('xpBar').style.width=clamp(pct,0,100)+'%';$('nextRankText').textContent=profile.xp>=5000?'Max rank reached.':`${next-profile.xp} XP tot volgende rank.`;
  $('gearText').textContent=['Rookie cap unlocked.','Hunter cap + tracker.','Elite goggles unlocked.','Swarm shield unlocked.','Night cloak unlocked.','Golden Overlord crown unlocked.'][level-1]
}

async function startHunt(){
  try{
    $('startScreen').classList.add('hidden');$('academyScreen').classList.add('hidden');$('profileScreen').classList.add('hidden');$('huntScreen').classList.remove('hidden');refreshProfileUI();
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    const video=$('video');video.srcObject=stream;await video.play();track=stream.getVideoTracks()[0];
    setupAudio(stream);running=true;requestAnimationFrame(scanFrame);setInterval(updateHud,250);
  }catch(e){alert('Starten lukt niet: '+e.message);$('huntScreen').classList.add('hidden');$('startScreen').classList.remove('hidden')}
}
function setupAudio(s){audioCtx=new (window.AudioContext||window.webkitAudioContext)();const source=audioCtx.createMediaStreamSource(s);analyser=audioCtx.createAnalyser();analyser.fftSize=4096;source.connect(analyser)}
function scanAudio(){if(!analyser||!audioCtx)return;const data=new Uint8Array(analyser.frequencyBinCount);analyser.getByteFrequencyData(data);let peak=0,idx=0;for(let i=0;i<data.length;i++){if(data[i]>peak){peak=data[i];idx=i}}const freq=idx*audioCtx.sampleRate/analyser.fftSize;let score=0;if(freq>=380&&freq<=850)score+=44;if(freq>=430&&freq<=700)score+=16;if(peak>55)score+=Math.min(40,(peak-55)*1.05);audioScore=Math.round(clamp(score,0,100));$('freqOut').textContent=`${Math.round(freq)} Hz / ${peak}`}

function scanFrame(){
  if(!running)return;
  const video=$('video'),overlay=$('overlay'),octx=overlay.getContext('2d');overlay.width=video.clientWidth;overlay.height=video.clientHeight;octx.clearRect(0,0,overlay.width,overlay.height);
  const w=480,h=Math.max(270,Math.round(w*(video.videoHeight||1080)/(video.videoWidth||1920)));const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});
  if(video.videoWidth>0){
    const vw=video.videoWidth,vh=video.videoHeight,cropW=vw/zoomLevel,cropH=vh/zoomLevel;ctx.drawImage(video,(vw-cropW)/2,(vh-cropH)/2,cropW,cropH,0,0,w,h);
    const frame=ctx.getImageData(0,0,w,h);avgLum=computeAvgLum(frame);$('lightOut').textContent=Math.round(avgLum);
    const detections=[...scanMotion(frame,w,h),...scanWall(frame,w,h)];
    updateTracks(detections,w,h);drawTracks(octx,overlay,w,h);prev=frame;
  }
  scanAudio();const top=tracks[0],best=top?top.score:0;if(top&&(top.manual||(best>=90&&top.hits>=3)))lockScore=Math.min(100,lockScore+4.5);else lockScore=Math.max(0,lockScore-1.2);
  requestAnimationFrame(scanFrame)
}
function computeAvgLum(frame){const d=frame.data;let total=0,n=0;for(let i=0;i<d.length;i+=96){total+=lumAt(d,i);n++}return total/n}

function scanMotion(frame,w,h){
  if(!prev){motionScore=0;return []}
  const step=4,isDark=avgLum<70,threshold=isDark?132:112;let total=0,sx=0,sy=0,minX=w,maxX=0,minY=h,maxY=0;
  for(let y=0;y<h;y+=step){for(let x=0;x<w;x+=step){const i=(y*w+x)*4,d=Math.abs(frame.data[i]-prev.data[i])+Math.abs(frame.data[i+1]-prev.data[i+1])+Math.abs(frame.data[i+2]-prev.data[i+2]);if(d>threshold){total++;sx+=x;sy+=y;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)}}}
  const area=(maxX-minX)*(maxY-minY);
  if(total>=3&&total<55&&area<1900){const cx=sx/total,cy=sy/total,compact=area>0?clamp((total*18)/area,0,1):0,score=clamp(58+total*.9+compact*22+(isDark?5:0)+(audioScore>45?7:0),0,99);motionScore=Math.round(score);return[{x:cx,y:cy,type:'motion',score:motionScore,size:total}]}
  motionScore=Math.max(0,motionScore-8);return []
}
function scanWall(frame,w,h){
  const step=sensitivity==='dark'?3:4,data=frame.data,candidates=[],isDark=avgLum<76,contrastMin=sensitivity==='strict'?66:sensitivity==='dark'?52:58,bgMin=isDark?50:92,lumMax=isDark?102:110,textureMax=sensitivity==='strict'?24:sensitivity==='dark'?36:30;
  for(let y=14;y<h-14;y+=step){for(let x=14;x<w-14;x+=step){const i=(y*w+x)*4,lum=lumAt(data,i);let ring=0,n=0,variance=0,samples=[];for(let dy=-12;dy<=12;dy+=12){for(let dx=-12;dx<=12;dx+=12){if(dx===0&&dy===0)continue;const j=((y+dy)*w+(x+dx))*4,l=lumAt(data,j);samples.push(l);ring+=l;n++}}const bg=ring/n;for(const s of samples)variance+=Math.abs(s-bg);variance/=samples.length;const contrast=bg-lum;if(contrast>contrastMin&&bg>bgMin&&lum<lumMax&&variance<textureMax)candidates.push({x,y,contrast,texture:variance})}}
  const clusters=[];for(const p of candidates){let found=false;for(const c of clusters){const dx=c.x-p.x,dy=c.y-p.y;if(dx*dx+dy*dy<130){c.x=(c.x*c.n+p.x)/(c.n+1);c.y=(c.y*c.n+p.y)/(c.n+1);c.contrast=Math.max(c.contrast,p.contrast);c.texture=(c.texture*c.n+p.texture)/(c.n+1);c.n++;found=true;break}}if(!found)clusters.push({x:p.x,y:p.y,contrast:p.contrast,texture:p.texture,n:1})}
  const filtered=clusters.filter(c=>c.n>=1&&c.n<=7&&c.texture<textureMax).map(c=>{const sizeScore=c.n>=2&&c.n<=5?26:10,contrastScore=clamp((c.contrast-contrastMin)*2,0,36),texturePenalty=c.texture*.55,darkBoost=sensitivity==='dark'?14:0,audioBoost=audioScore>45?8:0,score=clamp(70+sizeScore+contrastScore+darkBoost+audioBoost-texturePenalty,0,99);return{x:c.x,y:c.y,type:'wall',score:Math.round(score),size:c.n}}).filter(c=>c.score>=88).sort((a,b)=>b.score-a.score).slice(0,2);
  wallScore=filtered.length?filtered[0].score:Math.max(0,wallScore-5);return filtered
}
function updateTracks(detections,w,h){for(const t of tracks){t.age++;t.ttl--;t.score=Math.max(0,t.score-(t.manual?.12:.45));t.matched=false}for(const d of detections){let best=null,bestDist=99999;for(const t of tracks){const dx=t.x-d.x,dy=t.y-d.y,dist=dx*dx+dy*dy,gate=t.manual?3600:1250;if(dist<bestDist&&dist<gate){best=t;bestDist=dist}}if(best){best.x=best.x*.78+d.x*.22;best.y=best.y*.78+d.y*.22;if(!best.manual)best.type=d.type;best.hits++;best.ttl=best.manual?360:190;best.score=clamp(best.score*.68+d.score*.32+Math.min(18,best.hits*1.35),0,100)}else tracks.push({id:nextTrackId++,x:d.x,y:d.y,type:d.type,score:d.score,hits:1,age:0,ttl:170,manual:false})}tracks=tracks.filter(t=>t.ttl>0&&t.score>35).sort((a,b)=>b.score-a.score).slice(0,6);$('tracksOut').textContent=tracks.length}
function drawTracks(ctx,overlay,w,h){const top=tracks[0];for(const t of tracks){if(!t.manual&&t.score<(hunterMode?90:75))continue;if(hunterMode&&t!==top&&!t.manual)continue;const x=t.x*overlay.width/w,y=t.y*overlay.height/h,conf=Math.round(t.score);if(t.manual)drawTarget(ctx,x,y,62,'#2b8cff',`${conf}% MANUAL LOCK`);else if(t.type==='motion')drawTarget(ctx,x,y,50,'#ff2828',`${conf}% MOVING`);else drawTarget(ctx,x,y,conf>94?50:38,'#00ff78',`${conf}% STILL TARGET`)}}
function drawTarget(ctx,x,y,r,color,label){ctx.strokeStyle=color;ctx.lineWidth=5;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();ctx.fillStyle=color;ctx.font='bold 18px Arial';ctx.fillText(label,x+r+9,y-6)}
function updateHud(){const best=tracks.length?tracks[0].score:0;$('confidenceOut').textContent=Math.round(best)+'%';$('audioThreat').textContent='Audio: '+label(audioScore);$('motionThreat').textContent='Motion: '+label(motionScore);$('wallThreat').textContent='Wall: '+label(wallScore);refreshProfileUI();if(lockScore>70&&tracks.length){const top=tracks[0];$('lockState').textContent=top.manual?'🔵 MANUAL LOCK':top.type==='motion'?'🔴 TARGET LOCKED':'🟢 TARGET LOCKED';$('lockState').style.background=top.manual?'rgba(43,140,255,.92)':top.type==='motion'?'rgba(229,9,20,.92)':'rgba(0,160,80,.92)'}else{$('lockState').textContent=best>=90?'High confidence':'Scanning';$('lockState').style.background='rgba(0,0,0,.75)'}}
function armManual(){manualArmed=true;$('tapHint').classList.remove('hidden');setTimeout(()=>{if(manualArmed){manualArmed=false;$('tapHint').classList.add('hidden')}},8000)}
function manualTarget(ev){if(!manualArmed)return;ev.preventDefault();const overlay=$('overlay'),video=$('video'),rect=overlay.getBoundingClientRect(),w=480,h=Math.max(270,Math.round(w*((video.videoHeight||1080)/(video.videoWidth||1920))));tracks.unshift({id:nextTrackId++,x:(ev.clientX-rect.left)/overlay.width*w,y:(ev.clientY-rect.top)/overlay.height*h,type:'manual',score:95,hits:8,age:0,ttl:420,manual:true});tracks=tracks.slice(0,6);lockScore=100;manualArmed=false;$('tapHint').classList.add('hidden');if(navigator.vibrate)navigator.vibrate([50,25,50])}
function labelBest(isMosquito){if(!tracks.length){alert('Geen target. Gebruik Manual of scan opnieuw.');return}if(isMosquito){profile.kills++;profile.xp+=50+(tracks[0].manual?10:25);saveProfileData();tracks[0].score=100;tracks[0].ttl=420;lockScore=100;if(navigator.vibrate)navigator.vibrate([70,30,70])}else{tracks.shift();lockScore=Math.max(0,lockScore-30)}refreshProfileUI()}
function makeCatchShot(){const canvas=$('shareCanvas'),ctx=canvas.getContext('2d'),video=$('video'),top=tracks[0],rank=rankForXP(profile.xp);ctx.fillStyle='#070707';ctx.fillRect(0,0,1080,1920);try{ctx.drawImage(video,0,0,1080,1450)}catch(e){}ctx.fillStyle='rgba(0,0,0,.72)';ctx.fillRect(0,1320,1080,600);ctx.fillStyle='#00ff78';ctx.font='bold 60px Arial';ctx.fillText('MOSQUITO HUNTER',60,1410);ctx.fillStyle='#fff';ctx.font='bold 48px Arial';ctx.fillText(profile.name,60,1485);ctx.fillStyle='#ffcf33';ctx.font='bold 44px Arial';ctx.fillText(rank[0]+'  '+rank[2],60,1555);ctx.fillStyle='#fff';ctx.font='38px Arial';ctx.fillText('Kills: '+profile.kills+'   XP: '+profile.xp,60,1630);ctx.fillText('Target confidence: '+(top?Math.round(top.score):0)+'%',60,1690);ctx.fillText(new Date().toLocaleString(),60,1750);ctx.strokeStyle='#00ff78';ctx.lineWidth=10;ctx.strokeRect(35,35,1010,1850);canvas.toBlob(blob=>{const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='mosquito-hunter-catch.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)})}
function saveProfile(){profile.name=$('hunterNameInput').value.trim()||'Guest Hunter';saveProfileData();refreshProfileUI();alert('Profile saved.')}
function openProfile(){$('menuSheet').classList.add('hidden');refreshProfileUI();$('startScreen').classList.add('hidden');$('huntScreen').classList.add('hidden');$('academyScreen').classList.add('hidden');$('profileScreen').classList.remove('hidden')}
function closeProfile(){$('profileScreen').classList.add('hidden');running?$('huntScreen').classList.remove('hidden'):$('startScreen').classList.remove('hidden')}
function openAcademy(){$('menuSheet').classList.add('hidden');$('startScreen').classList.add('hidden');$('huntScreen').classList.add('hidden');$('profileScreen').classList.add('hidden');$('academyScreen').classList.remove('hidden')}
function closeAcademy(){$('academyScreen').classList.add('hidden');running?$('huntScreen').classList.remove('hidden'):$('startScreen').classList.remove('hidden')}
function toggleHunter(){hunterMode=!hunterMode;$('toggleHunterBtn').textContent='Hunter Mode: '+(hunterMode?'ON':'OFF')}
function cycleSensitivity(){sensitivity=sensitivity==='strict'?'dark':sensitivity==='dark'?'balanced':'strict';$('cycleModeBtn').textContent='Detection: '+(sensitivity==='dark'?'Dark':sensitivity==='strict'?'Strict':'Balanced')}
async function cycleZoom(){zoomLevel=zoomLevel===1?2:zoomLevel===2?3:1;$('zoomBtn').textContent=`Zoom: ${zoomLevel}x`;if(track&&track.getCapabilities){const caps=track.getCapabilities();if(caps.zoom){try{await track.applyConstraints({advanced:[{zoom:Math.min(caps.zoom.max,Math.max(caps.zoom.min,zoomLevel))}]})}catch(e){}}}}
function stopHunt(){running=false;$('menuSheet').classList.add('hidden');if(stream)stream.getTracks().forEach(t=>t.stop());if(audioCtx)audioCtx.close();stream=null;track=null;prev=null;tracks=[];$('huntScreen').classList.add('hidden');$('startScreen').classList.remove('hidden')}
function lumAt(d,i){return .2126*d[i]+.7152*d[i+1]+.0722*d[i+2]}function clamp(v,min,max){return Math.max(min,Math.min(max,v))}function label(v){return v>70?'HIGH':v>35?'MEDIUM':'LOW'}
refreshProfileUI();
