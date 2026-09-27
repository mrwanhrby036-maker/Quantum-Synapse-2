const $ = (id) => document.getElementById(id);
const canvas = $('canvas'), ctx = canvas.getContext('2d'), video = $('video');
const connections = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
const gestures = {
  open: {name:'كف مفتوح',icon:'🖐️',detail:'خمسة أصابع مرفوعة، أهلًا بيك!', fingers:[1,1,1,1,1]},
  fist: {name:'قبضة مغلقة',icon:'✊',detail:'الصوابع مضمومة داخل كفك',fingers:[0,0,0,0,0]},
  peace: {name:'علامة السلام',icon:'✌️',detail:'السبابة والوسطى مرفوعين',fingers:[0,1,1,0,0]},
  point: {name:'إشارة بصباع',icon:'☝️',detail:'السبابة مرفوعة لوحدها',fingers:[0,1,0,0,0]},
  pinch: {name:'ضمّ إصبعين',icon:'🤏',detail:'الإبهام والسبابة قريبين من بعض',fingers:[0,0,1,1,1]},
  other: {name:'يد قيد التتبّع',icon:'✋',detail:'جرّب واحدة من الإشارات اللي تحت'}
};
let mode='idle', stream=null, landmarker=null, modelPromise=null, session=0, facing='user';
let animation=0, lastVideoTime=-1, lastInference=0, latestPoints=null, lastHandSeen=0;
let fpsStart=0, frameCount=0, demoGesture='open', candidate='', stable='', candidateSince=0;
let canvasWidth=0,canvasHeight=0, modelReady=false;
const embedded=window.self!==window.top;
$('embedWarning').hidden=!embedded;
if(embedded && /^https?:$/.test(location.protocol)){
  $('openExternal').href=location.href;$('openExternal').hidden=false;
}
function setPermission(text){$('permissionState').textContent='الإذن: '+text;}
async function readPermission(){
  try{
    const permission=await navigator.permissions.query({name:'camera'});
    const update=()=>setPermission({granted:'مسموح',denied:'محظور — راجع إعدادات الموقع',prompt:'في انتظار طلبك'}[permission.state]||'غير معروف');
    update();permission.addEventListener('change',update);
  }catch{ /* Safari and some embedded browsers do not expose permission queries. */ }
}
readPermission();

function resizeCanvas(){
  const rect=$('stage').getBoundingClientRect();
  canvasWidth=rect.width;canvasHeight=rect.height;
  const dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
new ResizeObserver(resizeCanvas).observe($('stage'));
function notify(text){$('message').textContent=text;$('message').hidden=!text;}
function status(text,active=false){$('statusText').textContent=text;$('status').classList.toggle('active',active);}
function fingerUI(fingers){
  $('fingerCount').innerHTML=fingers ? `${fingers.filter(Boolean).length} <small>/ 5</small>` : '— <small>/ 5</small>';
  [...$('fingerIndicators').children].forEach((el,i)=>el.classList.toggle('on',!!fingers?.[i]));
}
function renderGesture(key,fingers,simulated=false){
  const g=gestures[key]||gestures.other;
  $('gestureName').textContent=g.name;$('gestureIcon').textContent=g.icon;
  $('gestureDetail').textContent=simulated?'محاكاة توضيحية، مش قراءة كاميرا':g.detail;
  $('trackingValue').textContent=simulated?'محاكاة':'يد مكتشفة';
  fingerUI(fingers||g.fingers);
  document.querySelectorAll('.gesture-card').forEach(el=>el.classList.toggle('selected',el.dataset.gesture===key));
}
function resetReading(waiting=false){
  $('gestureName').textContent='في انتظار يدك';$('gestureIcon').textContent='✋';
  $('gestureDetail').textContent=waiting?'ارفع يدك وخليها ظاهرة بالكامل':'ابدأ التتبّع عشان نقرأ إشارتك';
  $('trackingValue').textContent=waiting?'بيبحث عن يد':'غير نشط';fingerUI(null);
  document.querySelectorAll('.gesture-card').forEach(el=>el.classList.remove('selected'));
}
function releaseCamera(){if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}video.pause();video.srcObject=null;video.hidden=true;$('cameraBadge').hidden=true;}
function stop({quiet=false}={}){
  session++;cancelAnimationFrame(animation);releaseCamera();mode='idle';latestPoints=null;stable='';candidate='';modelReady=false;$('retryModel').hidden=true;
  ctx.clearRect(0,0,canvasWidth,canvasHeight);$('emptyState').hidden=false;$('demoBadge').hidden=true;$('stageTip').hidden=true;
  $('startButton').disabled=false;$('startButton').querySelector('span').textContent='السماح وتشغيل الكاميرا';$('startCenter').disabled=false;
  $('switchCamera').disabled=true;$('fpsValue').textContent='—';status('الكاميرا غير مفعّلة');resetReading();if(!quiet)notify('');
}
async function loadModel(){
  if(landmarker)return landmarker;
  if(!modelPromise){modelPromise=(async()=>{
    const {FilesetResolver,HandLandmarker}=await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
    const files=await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
    const modelAssetPath='https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
    const options={baseOptions:{modelAssetPath,delegate:'GPU'},runningMode:'VIDEO',numHands:1,minHandDetectionConfidence:.6,minHandPresenceConfidence:.6,minTrackingConfidence:.6};
    try{landmarker=await HandLandmarker.createFromOptions(files,options);}catch{options.baseOptions.delegate='CPU';landmarker=await HandLandmarker.createFromOptions(files,options);}
    return landmarker;
  })().catch(err=>{modelPromise=null;throw err;});}
  return modelPromise;
}
async function activateTracking(token){
  $('retryModel').hidden=true;
  $('trackingValue').textContent='تحميل النموذج';
  $('gestureDetail').textContent='الكاميرا شغّالة؛ جاري تجهيز التتبّع';
  $('stageTip').textContent='البث حقيقي · جاري تحميل تتبّع اليد';$('stageTip').hidden=false;
  status('الكاميرا شغّالة · تجهيز التتبّع',true);
  notify('إذن الكاميرا اتمنح والبث المباشر ظاهر. جاري تحميل نموذج اليد؛ الفيديو مش بيترفع لأي سيرفر.');
  try{
    await loadModel();if(token!==session||mode!=='camera')return;
    modelReady=true;lastVideoTime=-1;lastInference=0;fpsStart=performance.now();frameCount=0;
    $('stageTip').textContent='ارفع يد واحدة داخل الإطار';resetReading(true);
    status('بث مباشر · التتبّع جاهز',true);notify('');
  }catch(error){
    if(token!==session||mode!=='camera')return;
    modelReady=false;$('trackingValue').textContent='غير متاح';$('gestureDetail').textContent='البث يعمل بدون تحليل اليد';
    $('stageTip').textContent='كاميرا فعلية · التتبّع غير متاح';status('بث مباشر · بدون تتبّع',true);
    notify('الكاميرا الحقيقية شغّالة، لكن تحميل نموذج اليد فشل. اتأكد من الإنترنت واضغط إعادة المحاولة. مش هنستبدل البث بمحاكاة.');
    $('retryModel').hidden=false;console.error(error);
  }
}
async function startCamera(){
  stop();const token=++session;mode='loading';
  const policy=document.permissionsPolicy||document.featurePolicy;
  if(policy?.allowsFeature && !policy.allowsFeature('camera')){
    stop();setPermission('المعاينة تمنع طلب الكاميرا');
    notify('المتصفح منع الكاميرا داخل الإطار المضمّن، لذلك نافذة الإذن لن تظهر هنا. افتح رابط الموقع نفسه في تبويب مستقل، وليس معاينة الملف. لا يمكن للكود تجاوز هذا القيد.');return;
  }
  if(!window.isSecureContext){stop();setPermission('محتاج رابط HTTPS');notify('الكاميرا لا تعمل من اتصال غير آمن. افتح الموقع برابط HTTPS من الموبايل.');return;}
  if(!navigator.mediaDevices?.getUserMedia){stop();setPermission('غير متاح في هذه المعاينة');notify('المعاينة أو المتصفح لا يتيح طلب الكاميرا. افتح رابط الموقع في تبويب مستقل على Chrome أو Safari حديث.');return;}
  // This invokes the browser's native camera permission prompt, not a fake dialog.
  // A prompt may not repeat if the user has already granted or blocked permission.
  $('startCenter').disabled=true;$('startButton').querySelector('span').textContent='إلغاء طلب الكاميرا';
  setPermission('في انتظار موافقتك في المتصفح');status('في انتظار إذن الكاميرا');
  notify('اختار «سماح / Allow» في نافذة المتصفح. لو مفيش نافذة، راجع إذن الكاميرا في إعدادات الموقع؛ ممكن الإذن يكون محفوظ أو محظور.');
  try{
    const newStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:640},height:{ideal:480}},audio:false});
    if(token!==session){newStream.getTracks().forEach(t=>t.stop());return;}
    stream=newStream;video.srcObject=stream;video.hidden=false;video.classList.toggle('mirrored',$('mirror').checked);
    // Expose the real video immediately, without waiting for MediaPipe.
    $('emptyState').hidden=true;await video.play();
    if(token!==session)return;
    const track=stream.getVideoTracks()[0];
    if(!track||track.readyState!=='live')throw new Error('Camera track is not live');
    setPermission('مسموح — الكاميرا متصلة');mode='camera';lastHandSeen=0;
    $('startButton').disabled=false;$('startCenter').disabled=false;$('switchCamera').disabled=false;
    $('startButton').querySelector('span').textContent='إيقاف الكاميرا';
    $('cameraBadge').hidden=false;
    $('cameraInfo').textContent=`${video.videoWidth} × ${video.videoHeight}`;
    $('cameraInfo').title=track.label;
    status('بث مباشر · كاميرا فعلية',true);resetReading(true);
    track.addEventListener('ended',()=>{if(mode==='camera'){stop();notify('اتصال الكاميرا اتوقف. اضغط تشغيل عشان تطلب الاتصال تاني.');}},{once:true});
    animation=requestAnimationFrame(cameraLoop);
    void activateTracking(token);
  }catch(error){
    if(token!==session)return;
    stop({quiet:true});
    const errors={
      NotAllowedError:'المتصفح لم يسمح باستخدام الكاميرا. لو رفضت الإذن، غيّره إلى «سماح» من إعدادات الموقع. لو داخل معاينة، افتح الموقع في تبويب مستقل؛ الرفض ممكن يكون بسبب الإطار وليس اختيارك.',
      SecurityError:'إعدادات أمان المتصفح تمنع الكاميرا هنا. افتح الموقع مباشرة من رابط HTTPS.',
      NotFoundError:'لا توجد كاميرا متاحة على الجهاز. افتح نفس رابط الموقع على الموبايل؛ الكمبيوتر من غير كاميرا مش هيعرض بثًا حقيقيًا.',
      NotReadableError:'الكاميرا مش متاحة حاليًا. اقفل التطبيقات اللي بتستخدمها وراجع إذن الكاميرا للمتصفح في إعدادات الجهاز.',
      OverconstrainedError:'الكاميرا مش بتدعم الإعدادات المطلوبة. جرّب كاميرا أو متصفح مختلف.'
    };
    setPermission(error.name==='NotAllowedError'?'لم يُسمح بالوصول':'تعذّر فتح الكاميرا');
    notify(errors[error.name]||'تعذّر فتح بث الكاميرا الحقيقي. جرّب رابط HTTPS في متصفح حديث وراجع صلاحيات الكاميرا.');console.error(error);
  }
}
function drawSkeleton(points,toScreen){
  ctx.save();ctx.lineWidth=2;ctx.strokeStyle='#b4f574';ctx.shadowColor='#93ee6a';ctx.shadowBlur=5;
  connections.forEach(([a,b])=>{const p=toScreen(points[a]),q=toScreen(points[b]);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();});
  points.forEach((point,i)=>{const p=toScreen(point);ctx.beginPath();ctx.arc(p.x,p.y,[4,8,12,16,20].includes(i)?4.7:3.1,0,Math.PI*2);ctx.fillStyle='#0d2416';ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle=[4,8,12,16,20].includes(i)?'#eaffd9':'#b4f574';ctx.stroke();});ctx.restore();
}
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}
function angle(a,b,c){const u=[a.x-b.x,a.y-b.y,a.z-b.z],v=[c.x-b.x,c.y-b.y,c.z-b.z];const cosine=u.reduce((s,x,i)=>s+x*v[i],0)/(Math.hypot(...u)*Math.hypot(...v)||1);return Math.acos(Math.max(-1,Math.min(1,cosine)))*180/Math.PI;}
function classify(p){
  // World coordinates keep geometric checks independent of the camera aspect ratio.
  const palm=distance(p[0],p[9]);
  const thumb=angle(p[1],p[2],p[3])>145&&angle(p[2],p[3],p[4])>150&&distance(p[4],p[17])>distance(p[2],p[17])*1.2;
  const fingers=[thumb,...[5,9,13,17].map(base=>angle(p[base],p[base+1],p[base+3])>155&&distance(p[base+3],p[0])>distance(p[base+1],p[0])*1.12)];
  let key='other';
  if(distance(p[4],p[8])<palm*.27)key='pinch';
  else if(fingers.every(Boolean))key='open';
  else if(!fingers.some(Boolean))key='fist';
  else if(!fingers[0]&&fingers[1]&&fingers[2]&&!fingers[3]&&!fingers[4])key='peace';
  else if(!fingers[0]&&fingers[1]&&!fingers[2]&&!fingers[3]&&!fingers[4])key='point';
  return {key,fingers};
}
function cameraLoop(now){
  if(mode!=='camera')return;
  ctx.clearRect(0,0,canvasWidth,canvasHeight);
  const vw=video.videoWidth,vh=video.videoHeight;
  if(vw&&vh){
    const scale=Math.min(canvasWidth/vw,canvasHeight/vh),w=vw*scale,h=vh*scale,x=(canvasWidth-w)/2,y=(canvasHeight-h)/2;
    if(modelReady&&video.currentTime!==lastVideoTime&&now-lastInference>=33){
      lastVideoTime=video.currentTime;lastInference=now;
      try{
        const result=landmarker.detectForVideo(video,now);latestPoints=result.landmarks[0]||null;frameCount++;
        if(latestPoints){
          lastHandSeen=now;const {key,fingers}=classify(result.worldLandmarks?.[0]||latestPoints);
          if(candidate!==key){candidate=key;candidateSince=now;}
          if(now-candidateSince>160||!stable){stable=key;renderGesture(key,fingers);}else fingerUI(fingers);
          $('stageTip').hidden=true;
        }else if(now-lastHandSeen>450){stable='';candidate='';resetReading(true);$('stageTip').hidden=false;}
        if(now-fpsStart>=1000){$('fpsValue').textContent=Math.round(frameCount*1000/(now-fpsStart));frameCount=0;fpsStart=now;}
      }catch(error){console.error(error);modelReady=false;latestPoints=null;resetReading();$('trackingValue').textContent='غير متاح';$('gestureDetail').textContent='البث يعمل بدون تحليل اليد';status('بث مباشر · بدون تتبّع',true);notify('تحليل اليد اتوقف، لكن بث الكاميرا الحقيقي ما زال شغّال. تقدر تعيد محاولة التتبّع.');$('retryModel').hidden=false;}
    }
    if(latestPoints&&$('showPoints').checked)drawSkeleton(latestPoints,p=>({x:x+($('mirror').checked?1-p.x:p.x)*w,y:y+p.y*h}));
  }
  animation=requestAnimationFrame(cameraLoop);
}
function demoPoints(key,t){
  const raw=[[.5,.86],[.38,.73],[.28,.61],[.2,.5],[.13,.42],[.39,.53],[.36,.35],[.35,.22],[.34,.11],[.51,.5],[.51,.3],[.51,.15],[.51,.055],[.62,.53],[.65,.35],[.66,.23],[.67,.14],[.72,.59],[.78,.46],[.8,.35],[.82,.27]];
  const fingers=gestures[key].fingers;
  for(let f=1;f<5;f++){if(!fingers[f]){const b=1+f*4;raw[b+1]=[raw[b][0],raw[b][1]-.07];raw[b+2]=[raw[b][0]-.025,raw[b][1]+.07];raw[b+3]=[raw[b][0]-.035,raw[b][1]+.14];}}
  if(!fingers[0]){raw[2]=[.34,.63];raw[3]=[.42,.63];raw[4]=[.49,.64];}
  if(key==='pinch'){raw[3]=[.3,.49];raw[4]=[.34,.42];raw[6]=[.37,.34];raw[7]=[.34,.35];raw[8]=[.34,.42];}
  const sway=matchMedia('(prefers-reduced-motion: reduce)').matches?0:Math.sin(t/1300)*.025;
  return raw.map(([x,y])=>({x:x+sway,y:y+Math.sin(t/1000)*sway*.3,z:0}));
}
function demoLoop(now){
  if(mode!=='demo')return;ctx.clearRect(0,0,canvasWidth,canvasHeight);
  const size=Math.min(canvasHeight*.79,canvasWidth*.73),x=(canvasWidth-size)/2,y=(canvasHeight-size)/2+5;
  if($('showPoints').checked)drawSkeleton(demoPoints(demoGesture,now),p=>({x:x+($('mirror').checked?1-p.x:p.x)*size,y:y+p.y*size}));
  animation=requestAnimationFrame(demoLoop);
}
function startDemo(key='open'){
  stop();mode='demo';demoGesture=key;$('emptyState').hidden=true;$('demoBadge').hidden=false;
  status('محاكاة فقط · الكاميرا مغلقة');$('startButton').querySelector('span').textContent='السماح وتشغيل الكاميرا';
  renderGesture(key,null,true);$('fpsValue').textContent='—';
  notify('ده عرض محاكاة من غير كاميرا. اختار كارت من دليل الإشارات لتغيير شكل اليد، أو شغّل الكاميرا للتتبّع الحقيقي.');animation=requestAnimationFrame(demoLoop);
}
$('startButton').addEventListener('click',()=>mode==='camera'||mode==='loading'?stop():startCamera());
$('startCenter').addEventListener('click',startCamera);
$('mirror').addEventListener('change',()=>video.classList.toggle('mirrored',$('mirror').checked));
$('retryModel').addEventListener('click',()=>{if(mode==='camera')void activateTracking(session);});$('demoCenter').addEventListener('click',()=>startDemo());
$('switchCamera').addEventListener('click',()=>{facing=facing==='user'?'environment':'user';$('mirror').checked=facing==='user';startCamera();});
document.querySelectorAll('.gesture-card').forEach(card=>card.addEventListener('click',()=>{if(mode==='camera'||mode==='loading'){notify('أنت في وضع الكاميرا الحقيقي. نفّذ الإشارة بإيدك أمام الكاميرا. الكارت مجرد دليل، ومش هيغيّر نتيجة التتبّع.');return;}startDemo(card.dataset.gesture);$('workspace').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}));
$('fullscreen').addEventListener('click',async()=>{
  try{if(document.fullscreenElement)await document.exitFullscreen();else if($('cameraPanel').requestFullscreen)await $('cameraPanel').requestFullscreen();else notify('ملء الشاشة مش متاح في المتصفح ده. تقدر تلف الموبايل بالعرض لمساحة أكبر.');}
  catch{notify('المعاينة لا تسمح بملء الشاشة. افتح الموقع في تبويب مستقل وجرب تاني.');}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(mode==='camera'||mode==='loading')){stop();notify('وقفنا الكاميرا لحماية خصوصيتك لما سبت الصفحة. اضغط تشغيل عشان تبدأ تاني.');}});
window.addEventListener('pagehide',()=>stop());
