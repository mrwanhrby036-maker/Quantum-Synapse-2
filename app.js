// ============================================================
// 1. عناصر الصفحة، نقاط اليد، والإشارات المدعومة
// ============================================================
const $ = (id) => document.getElementById(id);
const canvas = $("canvas"),
  ctx = canvas.getContext("2d"),
  video = $("video");
const connections = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];
const gestures = {
  open: {
    name: "كف مفتوح",
    icon: "🖐️",
    detail: "خمسة أصابع مرفوعة، أهلًا بيك!",
    fingers: [1, 1, 1, 1, 1],
  },
  fist: {
    name: "قبضة مغلقة",
    icon: "✊",
    detail: "الصوابع مضمومة داخل كفك",
    fingers: [0, 0, 0, 0, 0],
  },
  peace: {
    name: "علامة السلام",
    icon: "✌️",
    detail: "السبابة والوسطى مرفوعين",
    fingers: [0, 1, 1, 0, 0],
  },
  point: {
    name: "إشارة بصباع",
    icon: "☝️",
    detail: "السبابة مرفوعة لوحدها",
    fingers: [0, 1, 0, 0, 0],
  },
  pinch: {
    name: "ضمّ إصبعين",
    icon: "🤏",
    detail: "الإبهام والسبابة قريبين من بعض",
    fingers: [0, 0, 1, 1, 1],
  },
  other: {
    name: "يد قيد التتبّع",
    icon: "✋",
    detail: "جرّب واحدة من الإشارات اللي تحت",
  },
};
let mode = "idle",
  stream = null,
  landmarker = null,
  modelPromise = null,
  session = 0,
  facing = "user";
let animation = 0,
  lastVideoTime = -1,
  lastInference = 0,
  latestHands = [],
  lastHandSeen = 0;
let fpsStart = 0,
  frameCount = 0,
  demoGesture = "open",
  videoConcealed = false;
let canvasWidth = 0,
  canvasHeight = 0,
  modelReady = false;
const embedded = window.self !== window.top;
$("embedWarning").hidden = !embedded;
if (embedded && /^https?:$/.test(location.protocol)) {
  $("openExternal").href = location.href;
  $("openExternal").hidden = false;
}
function setPermission(text) {
  $("permissionState").textContent = "الإذن: " + text;
}
async function readPermission() {
  try {
    const permission = await navigator.permissions.query({ name: "camera" });
    const update = () =>
      setPermission(
        {
          granted: "مسموح",
          denied: "محظور — راجع إعدادات الموقع",
          prompt: "في انتظار طلبك",
        }[permission.state] || "غير معروف",
      );
    update();
    permission.addEventListener("change", update);
  } catch {
    /* Safari and some embedded browsers do not expose permission queries. */
  }
}
readPermission();

// 2. تجهيز مساحة الرسم وتحديث رسائل الواجهة
function resizeCanvas() {
  const rect = $("stage").getBoundingClientRect();
  canvasWidth = rect.width;
  canvasHeight = rect.height;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resizeCanvas).observe($("stage"));
function notify(text) {
  $("message").textContent = text;
  $("message").hidden = !text;
}
function status(text, active = false) {
  $("statusText").textContent = text;
  $("status").classList.toggle("active", active);
}
// 3. منطق اللمسة: تثبيت، فصل الإصبعين، ومنع التكرار
// PINCH_CONTROLLER_BEGIN
// Temporal hysteresis: a held pinch toggles once, and the source hand must
// visibly release before the next pinch. Lost detections are not releases.
class PinchToggleController {
  constructor() {
    this.reset();
  }
  reset() {
    this.armed = true;
    this.sources = new Set();
    this.closeId = null;
    this.closeAt = null;
    this.closeFrames = 0;
    this.openAt = null;
    this.openFrames = 0;
    this.lastToggle = -Infinity;
  }
  requireRelease(ids = []) {
    this.reset();
    this.armed = false;
    this.sources = new Set(ids);
  }
  update(hands, now) {
    const closed = hands.filter(
      (h) => Number.isFinite(h.ratio) && h.ratio <= 0.27,
    );
    if (!this.armed) {
      closed.forEach((h) => this.sources.add(h.id));
      const sourceIds = [...this.sources];
      const allReleased =
        hands.length > 0 &&
        !closed.length &&
        (sourceIds.length
          ? sourceIds.every((id) =>
              hands.some((h) => h.id === id && h.ratio >= 0.4),
            )
          : hands.every((h) => h.ratio >= 0.4));
      if (allReleased) {
        if (this.openAt === null) this.openAt = now;
        this.openFrames++;
        if (this.openFrames >= 3 && now - this.openAt >= 180) {
          this.armed = true;
          this.sources.clear();
          this.openAt = null;
          this.openFrames = 0;
        }
      } else {
        this.openAt = null;
        this.openFrames = 0;
      }
      return false;
    }
    const hand = closed.find((h) => h.id === this.closeId) || closed[0];
    if (!hand) {
      this.closeId = null;
      this.closeAt = null;
      this.closeFrames = 0;
      return false;
    }
    if (this.closeId !== hand.id) {
      this.closeId = hand.id;
      this.closeAt = now;
      this.closeFrames = 0;
    }
    this.closeFrames++;
    if (
      this.closeFrames >= 3 &&
      now - this.closeAt >= 110 &&
      now - this.lastToggle >= 500
    ) {
      this.lastToggle = now;
      this.armed = false;
      this.sources = new Set(closed.map((h) => h.id));
      this.closeId = null;
      this.closeAt = null;
      this.closeFrames = 0;
      return true;
    }
    return false;
  }
}
// PINCH_CONTROLLER_END
// 4. إخفاء الفيديو وعرض قراءات اليدين
const pinchController = new PinchToggleController();
function refreshEffectUI() {
  $("restoreVideo").hidden = !videoConcealed;
  $("showPoints").disabled = videoConcealed;
  $("cameraBadge").querySelector("b").textContent = videoConcealed
    ? "الفيديو مخفي · الكاميرا شغّالة"
    : "بث مباشر · كاميرا فعلية";
  $("visibilityState").textContent =
    mode === "demo"
      ? "محاكاة لليدين — مفيش فيديو فعلي"
      : mode !== "camera"
        ? "في انتظار تشغيل الكاميرا"
        : videoConcealed
          ? "الفيديو مخفي · نقاط اليدين ظاهرة"
          : "الفيديو ظاهر · اللمسة الجاية تخفيه";
  if (mode === "camera" && !$("pinchEnabled").checked)
    $("visibilityState").textContent = "الفيديو ظاهر · الإخفاء باللمسة متوقف";
  $("pinchHint").textContent = videoConcealed
    ? "الكاميرا لسه شغّالة. افصل الإصبعين، والمس تاني لإظهار الفيديو؛ أو استخدم الزر اليدوي."
    : "المس السبابة بالإبهام لحظة قصيرة، ثم افصلهم. الكاميرا والتتبّع بيفضلوا شغّالين أثناء إخفاء الصورة.";
}
function setVideoConcealed(value) {
  videoConcealed = !!value;
  video.classList.toggle("gesture-hidden", videoConcealed);
  $("stage").classList.toggle("is-concealed", videoConcealed);
  refreshEffectUI();
  if (mode === "camera" && modelReady)
    status(
      videoConcealed ? "صورة مخفية · التتبّع شغّال" : "بث مباشر · تتبّع اليدين",
      true,
    );
}
function renderHands(hands, simulated = false) {
  const total = hands.reduce((n, h) => n + h.fingers.filter(Boolean).length, 0);
  $("fingerCount").innerHTML = hands.length
    ? `${total} <small>/ 10</small>`
    : "— <small>/ 10</small>";
  $("handCount").textContent = `${hands.length} / 2`;
  for (let slot = 0; slot < 2; slot++) {
    const hand = hands.find((h) => h.slot === slot),
      row = $("hand" + slot);
    row.querySelector(".hand-gesture").textContent = hand
      ? gestures[hand.key].name
      : "غير ظاهرة";
    row.querySelector(".hand-fingers").textContent = hand
      ? `${hand.fingers.filter(Boolean).length} / 5`
      : "— / 5";
    [...row.querySelectorAll(".mini-fingers span")].forEach((el, i) =>
      el.classList.toggle("on", !!hand?.fingers[i]),
    );
  }
  if (hands.length) {
    const active = hands.find((h) => h.key === "pinch") || hands[0];
    $("gestureName").textContent =
      active.key === "pinch"
        ? "لمسة إصبعين"
        : hands.length === 2
          ? "اليدين تحت التتبّع"
          : gestures[active.key].name;
    $("gestureIcon").textContent =
      active.key === "pinch"
        ? "🤏"
        : hands.length === 2
          ? "👐"
          : gestures[active.key].icon;
    $("gestureDetail").textContent = simulated
      ? "محاكاة توضيحية، مش قراءة كاميرا"
      : hands.length === 2
        ? "لون مختلف وقراءة مستقلة لكل إيد"
        : gestures[active.key].detail;
    $("trackingValue").textContent = simulated
      ? "محاكاة"
      : hands.length === 2
        ? "يدين مكتشفتين"
        : "يد واحدة";
  }
  document.querySelectorAll(".gesture-card").forEach((el) =>
    el.classList.toggle(
      "selected",
      hands.some((h) => h.key === el.dataset.gesture),
    ),
  );
}
function resetReading(waiting = false) {
  renderHands([]);
  $("gestureName").textContent = "في انتظار إيديك";
  $("gestureIcon").textContent = "👐";
  $("gestureDetail").textContent = waiting
    ? "ارفع إيد أو إيدين بوضوح قدام الكاميرا"
    : "ابدأ التتبّع عشان نقرأ إشاراتك";
  $("trackingValue").textContent = waiting ? "بيبحث عن إيدين" : "غير نشط";
}
// 5. إيقاف الكاميرا وتنظيف الجلسة
function releaseCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    setPermission("مسموح — الكاميرا متوقفة");
  }
  video.pause();
  video.srcObject = null;
  video.hidden = true;
  $("cameraBadge").hidden = true;
}
function stop({ quiet = false } = {}) {
  session++;
  cancelAnimationFrame(animation);
  releaseCamera();
  mode = "idle";
  latestHands = [];
  modelReady = false;
  pinchController.reset();
  setVideoConcealed(false);
  $("retryModel").hidden = true;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  $("emptyState").hidden = false;
  $("demoBadge").hidden = true;
  $("stageTip").hidden = true;
  $("startButton").disabled = false;
  $("startButton").querySelector("span").textContent = "السماح وتشغيل الكاميرا";
  $("startCenter").disabled = false;
  $("switchCamera").disabled = true;
  $("fpsValue").textContent = "—";
  status("الكاميرا غير مفعّلة");
  resetReading();
  if (!quiet) notify("");
}
// 6. تحميل MediaPipe وإعداد تتبّع يدين
async function loadModel() {
  if (landmarker) return landmarker;
  if (!modelPromise) {
    modelPromise = (async () => {
      const { FilesetResolver, HandLandmarker } = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs"
      );
      const files = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm",
      );
      const modelAssetPath =
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
      const options = {
        baseOptions: { modelAssetPath, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      };
      try {
        landmarker = await HandLandmarker.createFromOptions(files, options);
      } catch {
        options.baseOptions.delegate = "CPU";
        landmarker = await HandLandmarker.createFromOptions(files, options);
      }
      return landmarker;
    })().catch((err) => {
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}
async function activateTracking(token) {
  $("retryModel").hidden = true;
  $("trackingValue").textContent = "تحميل النموذج";
  $("gestureDetail").textContent = "الكاميرا شغّالة؛ جاري تجهيز التتبّع";
  $("stageTip").textContent = "البث حقيقي · جاري تحميل تتبّع اليد";
  $("stageTip").hidden = false;
  status("الكاميرا شغّالة · تجهيز التتبّع", true);
  notify(
    videoConcealed
      ? "الكاميرا شغّالة والصورة لسه مخفية. بنحاول نجهّز تتبّع اليدين من جديد."
      : "إذن الكاميرا اتمنح والبث المباشر ظاهر. جاري تحميل نموذج اليدين؛ الفيديو مش بيترفع لأي سيرفر.",
  );
  try {
    await loadModel();
    if (token !== session || mode !== "camera") return;
    modelReady = true;
    lastVideoTime = -1;
    lastInference = 0;
    fpsStart = performance.now();
    frameCount = 0;
    $("stageTip").textContent = "ارفع إيد أو إيدين داخل الإطار";
    resetReading(true);
    refreshEffectUI();
    setVideoConcealed(videoConcealed);
    notify("");
  } catch (error) {
    if (token !== session || mode !== "camera") return;
    modelReady = false;
    $("trackingValue").textContent = "غير متاح";
    $("gestureDetail").textContent = "البث يعمل بدون تحليل اليد";
    $("stageTip").textContent = "كاميرا فعلية · التتبّع غير متاح";
    status(
      videoConcealed ? "صورة مخفية · بدون تتبّع" : "بث مباشر · بدون تتبّع",
      true,
    );
    notify(
      "الكاميرا الحقيقية شغّالة، لكن تحميل نموذج اليد فشل. اتأكد من الإنترنت واضغط إعادة المحاولة. مش هنستبدل البث بمحاكاة.",
    );
    $("retryModel").hidden = false;
    console.error(error);
  }
}
// 7. طلب إذن الكاميرا الحقيقي وتشغيل البث
async function startCamera() {
  stop();
  const token = ++session;
  mode = "loading";
  const policy = document.permissionsPolicy || document.featurePolicy;
  if (policy?.allowsFeature && !policy.allowsFeature("camera")) {
    stop();
    setPermission("المعاينة تمنع طلب الكاميرا");
    notify(
      "المتصفح منع الكاميرا داخل الإطار المضمّن، لذلك نافذة الإذن لن تظهر هنا. افتح رابط الموقع نفسه في تبويب مستقل، وليس معاينة الملف. لا يمكن للكود تجاوز هذا القيد.",
    );
    return;
  }
  if (!window.isSecureContext) {
    stop();
    setPermission("محتاج رابط HTTPS");
    notify(
      "الكاميرا لا تعمل من اتصال غير آمن. افتح الموقع برابط HTTPS من الموبايل.",
    );
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    stop();
    setPermission("غير متاح في هذه المعاينة");
    notify(
      "المعاينة أو المتصفح لا يتيح طلب الكاميرا. افتح رابط الموقع في تبويب مستقل على Chrome أو Safari حديث.",
    );
    return;
  }
  // This invokes the browser's native camera permission prompt, not a fake dialog.
  // A prompt may not repeat if the user has already granted or blocked permission.
  $("startCenter").disabled = true;
  $("startButton").querySelector("span").textContent = "إلغاء طلب الكاميرا";
  setPermission("في انتظار موافقتك في المتصفح");
  status("في انتظار إذن الكاميرا");
  notify(
    "اختار «سماح / Allow» في نافذة المتصفح. لو مفيش نافذة، راجع إذن الكاميرا في إعدادات الموقع؛ ممكن الإذن يكون محفوظ أو محظور.",
  );
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
    if (token !== session) {
      newStream.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = newStream;
    video.srcObject = stream;
    video.hidden = false;
    video.classList.toggle("mirrored", $("mirror").checked);
    // Expose the real video immediately, without waiting for MediaPipe.
    $("emptyState").hidden = true;
    await video.play();
    if (token !== session) return;
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== "live")
      throw new Error("Camera track is not live");
    setPermission("مسموح — الكاميرا متصلة");
    mode = "camera";
    lastHandSeen = 0;
    $("startButton").disabled = false;
    $("startCenter").disabled = false;
    $("switchCamera").disabled = false;
    $("startButton").querySelector("span").textContent = "إيقاف الكاميرا";
    $("cameraBadge").hidden = false;
    $("cameraInfo").textContent = `${video.videoWidth} × ${video.videoHeight}`;
    $("cameraInfo").title = track.label;
    status("بث مباشر · كاميرا فعلية", true);
    resetReading(true);
    refreshEffectUI();
    track.addEventListener(
      "ended",
      () => {
        if (mode === "camera") {
          stop();
          notify("اتصال الكاميرا اتوقف. اضغط تشغيل عشان تطلب الاتصال تاني.");
        }
      },
      { once: true },
    );
    animation = requestAnimationFrame(cameraLoop);
    void activateTracking(token);
  } catch (error) {
    if (token !== session) return;
    stop({ quiet: true });
    const errors = {
      NotAllowedError:
        "المتصفح لم يسمح باستخدام الكاميرا. لو رفضت الإذن، غيّره إلى «سماح» من إعدادات الموقع. لو داخل معاينة، افتح الموقع في تبويب مستقل؛ الرفض ممكن يكون بسبب الإطار وليس اختيارك.",
      SecurityError:
        "إعدادات أمان المتصفح تمنع الكاميرا هنا. افتح الموقع مباشرة من رابط HTTPS.",
      NotFoundError:
        "لا توجد كاميرا متاحة على الجهاز. افتح نفس رابط الموقع على الموبايل؛ الكمبيوتر من غير كاميرا مش هيعرض بثًا حقيقيًا.",
      NotReadableError:
        "الكاميرا مش متاحة حاليًا. اقفل التطبيقات اللي بتستخدمها وراجع إذن الكاميرا للمتصفح في إعدادات الجهاز.",
      OverconstrainedError:
        "الكاميرا مش بتدعم الإعدادات المطلوبة. جرّب كاميرا أو متصفح مختلف.",
    };
    setPermission(
      error.name === "NotAllowedError"
        ? "لم يُسمح بالوصول"
        : "تعذّر فتح الكاميرا",
    );
    notify(
      errors[error.name] ||
        "تعذّر فتح بث الكاميرا الحقيقي. جرّب رابط HTTPS في متصفح حديث وراجع صلاحيات الكاميرا.",
    );
    console.error(error);
  }
}
// 8. رسم اليدين وحساب الإشارات هندسيًا
function drawSkeleton(points, toScreen, color = "#b4f574", label = "1") {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 5;
  connections.forEach(([a, b]) => {
    const p = toScreen(points[a]),
      q = toScreen(points[b]);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  });
  points.forEach((point, i) => {
    const p = toScreen(point);
    ctx.beginPath();
    ctx.arc(
      p.x,
      p.y,
      [4, 8, 12, 16, 20].includes(i) ? 4.7 : 3.1,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = "#0d2416";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = [4, 8, 12, 16, 20].includes(i) ? "#efffed" : color;
    ctx.stroke();
  });
  const wrist = toScreen(points[0]);
  ctx.shadowBlur = 0;
  ctx.font = "bold 12px Arial";
  ctx.textAlign = "center";
  ctx.fillStyle = color;
  ctx.fillText(label, wrist.x, wrist.y + 22);
  ctx.restore();
}
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function angle(a, b, c) {
  const u = [a.x - b.x, a.y - b.y, a.z - b.z],
    v = [c.x - b.x, c.y - b.y, c.z - b.z];
  const cosine =
    u.reduce((s, x, i) => s + x * v[i], 0) /
    (Math.hypot(...u) * Math.hypot(...v) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}
function classify(p) {
  // World coordinates keep geometric checks independent of the camera aspect ratio.
  const palm = Math.max(distance(p[0], p[9]), 0.0001),
    ratio = distance(p[4], p[8]) / palm;
  const thumb =
    angle(p[1], p[2], p[3]) > 145 &&
    angle(p[2], p[3], p[4]) > 150 &&
    distance(p[4], p[17]) > distance(p[2], p[17]) * 1.2;
  const fingers = [
    thumb,
    ...[5, 9, 13, 17].map(
      (base) =>
        angle(p[base], p[base + 1], p[base + 3]) > 155 &&
        distance(p[base + 3], p[0]) > distance(p[base + 1], p[0]) * 1.12,
    ),
  ];
  let key = "other";
  if (ratio <= 0.27) key = "pinch";
  else if (fingers.every(Boolean)) key = "open";
  else if (!fingers.some(Boolean)) key = "fist";
  else if (
    !fingers[0] &&
    fingers[1] &&
    fingers[2] &&
    !fingers[3] &&
    !fingers[4]
  )
    key = "peace";
  else if (
    !fingers[0] &&
    fingers[1] &&
    !fingers[2] &&
    !fingers[3] &&
    !fingers[4]
  )
    key = "point";
  return { key, fingers, ratio };
}
// 9. معالجة كل إطار والتبديل بين إخفاء الفيديو وإظهاره
function processHandResults(result, now) {
  const used = new Set();
  latestHands = (result.landmarks || []).slice(0, 2).map((points, index) => {
    // MediaPipe handedness keeps the two channels stable if result order changes.
    const category = result.handedness?.[index]?.[0]?.categoryName;
    let slot = category === "Left" ? 0 : category === "Right" ? 1 : index;
    if (used.has(slot)) slot = slot === 0 ? 1 : 0;
    used.add(slot);
    return {
      id: String(slot),
      slot,
      points,
      ...classify(result.worldLandmarks?.[index] || points),
    };
  });
  if ($("pinchEnabled").checked && pinchController.update(latestHands, now))
    setVideoConcealed(!videoConcealed);
  if (latestHands.length) {
    lastHandSeen = now;
    renderHands(latestHands);
    $("stageTip").hidden = true;
  } else if (now - lastHandSeen > 450) {
    resetReading(true);
    $("stageTip").textContent = videoConcealed
      ? "رجّع إيدك للمس تاني، أو اضغط إظهار الفيديو"
      : "ارفع إيد أو إيدين داخل الإطار";
    $("stageTip").hidden = false;
  }
}
function cameraLoop(now) {
  if (mode !== "camera") return;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  const vw = video.videoWidth,
    vh = video.videoHeight;
  if (vw && vh) {
    const scale = Math.min(canvasWidth / vw, canvasHeight / vh),
      w = vw * scale,
      h = vh * scale,
      x = (canvasWidth - w) / 2,
      y = (canvasHeight - h) / 2;
    // CSS opacity hides only the rendered video, never the MediaStream or model input.
    if (
      modelReady &&
      video.currentTime !== lastVideoTime &&
      now - lastInference >= 33
    ) {
      lastVideoTime = video.currentTime;
      lastInference = now;
      try {
        const result = landmarker.detectForVideo(video, now);
        frameCount++;
        processHandResults(result, now);
        if (now - fpsStart >= 1000) {
          $("fpsValue").textContent = Math.round(
            (frameCount * 1000) / (now - fpsStart),
          );
          frameCount = 0;
          fpsStart = now;
        }
      } catch (error) {
        console.error(error);
        modelReady = false;
        latestHands = [];
        resetReading();
        $("trackingValue").textContent = "غير متاح";
        $("gestureDetail").textContent = "بث الكاميرا يعمل، تحليل اليدين متوقف";
        status(
          videoConcealed
            ? "صورة مخفية · التحليل متوقف"
            : "بث مباشر · بدون تتبّع",
          true,
        );
        notify(
          "تحليل اليدين اتوقف، لكن الكاميرا لسه شغّالة. تقدر تعيد محاولة التتبّع، أو تظهر الفيديو بالزر اليدوي.",
        );
        $("retryModel").hidden = false;
      }
    }
    if ($("showPoints").checked || videoConcealed) {
      latestHands.forEach((hand) =>
        drawSkeleton(
          hand.points,
          (p) => ({
            x: x + ($("mirror").checked ? 1 - p.x : p.x) * w,
            y: y + p.y * h,
          }),
          hand.slot === 0 ? "#b4f574" : "#73d5f5",
          String(hand.slot + 1),
        ),
      );
    }
  }
  animation = requestAnimationFrame(cameraLoop);
}
// 10. المحاكاة فقط — لا تستخدم كاميرا ولا تدّعي قراءة يد حقيقية
function demoPoints(key, t) {
  const raw = [
    [0.5, 0.86],
    [0.38, 0.73],
    [0.28, 0.61],
    [0.2, 0.5],
    [0.13, 0.42],
    [0.39, 0.53],
    [0.36, 0.35],
    [0.35, 0.22],
    [0.34, 0.11],
    [0.51, 0.5],
    [0.51, 0.3],
    [0.51, 0.15],
    [0.51, 0.055],
    [0.62, 0.53],
    [0.65, 0.35],
    [0.66, 0.23],
    [0.67, 0.14],
    [0.72, 0.59],
    [0.78, 0.46],
    [0.8, 0.35],
    [0.82, 0.27],
  ];
  const fingers = gestures[key].fingers;
  for (let f = 1; f < 5; f++) {
    if (!fingers[f]) {
      const b = 1 + f * 4;
      raw[b + 1] = [raw[b][0], raw[b][1] - 0.07];
      raw[b + 2] = [raw[b][0] - 0.025, raw[b][1] + 0.07];
      raw[b + 3] = [raw[b][0] - 0.035, raw[b][1] + 0.14];
    }
  }
  if (!fingers[0]) {
    raw[2] = [0.34, 0.63];
    raw[3] = [0.42, 0.63];
    raw[4] = [0.49, 0.64];
  }
  if (key === "pinch") {
    raw[3] = [0.3, 0.49];
    raw[4] = [0.34, 0.42];
    raw[6] = [0.37, 0.34];
    raw[7] = [0.34, 0.35];
    raw[8] = [0.34, 0.42];
  }
  const sway = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : Math.sin(t / 1300) * 0.025;
  return raw.map(([x, y]) => ({
    x: x + sway,
    y: y + Math.sin(t / 1000) * sway * 0.3,
    z: 0,
  }));
}
function demoLoop(now) {
  if (mode !== "demo") return;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  const size = Math.min(canvasHeight * 0.73, canvasWidth * 0.45),
    y = (canvasHeight - size) / 2 + 12;
  if ($("showPoints").checked) {
    [0, 1].forEach((slot) => {
      const x = canvasWidth * (slot === 0 ? 0.24 : 0.76) - size / 2;
      drawSkeleton(
        demoPoints(demoGesture, now + slot * 240),
        (p) => ({
          x: x + (slot === 0 ? 1 - p.x : p.x) * size,
          y: y + p.y * size,
        }),
        slot === 0 ? "#b4f574" : "#73d5f5",
        String(slot + 1),
      );
    });
  }
  animation = requestAnimationFrame(demoLoop);
}
function startDemo(key = "open") {
  stop();
  mode = "demo";
  demoGesture = key;
  $("emptyState").hidden = true;
  $("demoBadge").hidden = false;
  status("محاكاة فقط · الكاميرا مغلقة");
  $("startButton").querySelector("span").textContent = "السماح وتشغيل الكاميرا";
  renderHands(
    [0, 1].map((slot) => ({ slot, key, fingers: gestures[key].fingers })),
    true,
  );
  refreshEffectUI();
  $("fpsValue").textContent = "—";
  notify(
    "دي محاكاة لرسم إيدين فقط، من غير كاميرا. عشان تجرّب إخفاء فيديوك باللمسة، شغّل الكاميرا واسمح بالتتبّع.",
  );
  animation = requestAnimationFrame(demoLoop);
}
// 11. ربط الأزرار والإعدادات وإيقاف الكاميرا عند مغادرة الصفحة
$("restoreVideo").addEventListener("click", () => {
  setVideoConcealed(false);
  pinchController.requireRelease(latestHands.map((h) => h.id));
});
$("pinchEnabled").addEventListener("change", () => {
  setVideoConcealed(false);
  pinchController.requireRelease(latestHands.map((h) => h.id));
  refreshEffectUI();
});
$("startButton").addEventListener("click", () =>
  mode === "camera" || mode === "loading" ? stop() : startCamera(),
);
$("startCenter").addEventListener("click", startCamera);
$("mirror").addEventListener("change", () =>
  video.classList.toggle("mirrored", $("mirror").checked),
);
$("retryModel").addEventListener("click", () => {
  if (mode === "camera") void activateTracking(session);
});
$("demoCenter").addEventListener("click", () => startDemo());
$("switchCamera").addEventListener("click", () => {
  facing = facing === "user" ? "environment" : "user";
  $("mirror").checked = facing === "user";
  startCamera();
});
document.querySelectorAll(".gesture-card").forEach((card) =>
  card.addEventListener("click", () => {
    if (mode === "camera" || mode === "loading") {
      notify(
        "أنت في وضع الكاميرا الحقيقي. نفّذ الإشارة بإيدك أمام الكاميرا. الكارت مجرد دليل، ومش هيغيّر نتيجة التتبّع.",
      );
      return;
    }
    startDemo(card.dataset.gesture);
    $("workspace").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }),
);
$("fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($("cameraPanel").requestFullscreen)
      await $("cameraPanel").requestFullscreen();
    else
      notify(
        "ملء الشاشة مش متاح في المتصفح ده. تقدر تلف الموبايل بالعرض لمساحة أكبر.",
      );
  } catch {
    notify(
      "المعاينة لا تسمح بملء الشاشة. افتح الموقع في تبويب مستقل وجرب تاني.",
    );
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (mode === "camera" || mode === "loading")) {
    stop();
    notify(
      "وقفنا الكاميرا لحماية خصوصيتك لما سبت الصفحة. اضغط تشغيل عشان تبدأ تاني.",
    );
  }
});
window.addEventListener("pagehide", () => stop());
