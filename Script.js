/* GKEDIT AI — script.js
   Mobile-first, JARVIS-style assistant with voice, waveform, AI proxy request, and built-in tools.
   IMPORTANT: Do NOT place any private API keys here. Use a secure backend.
*/

/* ========== CONFIGURATION ===========
   These are frontend configuration values. Do NOT store secret API keys here.
   The frontend will call API_ENDPOINT (e.g. /api/chat) which should be implemented on your secure backend.
*/
let API_ENDPOINT = '/api/chat';         // FRONTEND endpoint to call for AI — change in Settings (no secret keys here)
let WEATHER_API_BASE = '';             // Optional base URL for weather proxy e.g. '/api/weather?q=' or 'https://myproxy/weather?q='
/* ===================================== */

const state = {
  listening: false,
  speaking: false,
  thinking: false,
  orbState: 'IDLE',
  voiceEnabled: true,
  autoSpeak: true,
  history: [],
  recognition: null,
  synth: window.speechSynthesis,
  currentUtterance: null
};

/* ---------- DOM ---------- */
const orb = document.getElementById('orb');
const orbStateLabel = document.getElementById('orbState');
const micBtn = document.getElementById('micBtn');
const stopSpeakBtn = document.getElementById('stopSpeakBtn');
const inputBox = document.getElementById('inputBox');
const sendBtn = document.getElementById('sendBtn');
const chatEl = document.getElementById('chat');
const apiStatus = document.getElementById('apiStatus');
const statusText = document.getElementById('statusText');
const btnSettings = document.getElementById('btnSettings');
const settingsPanel = document.getElementById('settingsPanel');
const toggleVoice = document.getElementById('toggleVoice');
const toggleAutoSpeak = document.getElementById('toggleAutoSpeak');
const themeSelect = document.getElementById('themeSelect');
const apiEndpointInput = document.getElementById('apiEndpointInput');
const weatherApiInput = document.getElementById('weatherApiInput');
const saveSettings = document.getElementById('saveSettings');
const closeSettings = document.getElementById('closeSettings');
const clearConv = document.getElementById('clearConv');
const fileInput = document.getElementById('fileInput');
const previewModal = document.getElementById('previewModal');
const previewArea = document.getElementById('previewArea');
const closePreview = document.getElementById('closePreview');
const toast = document.getElementById('toast');
const particleCanvas = document.getElementById('particleCanvas');
const waveformCanvas = document.getElementById('waveform');

/* ---------- Utilities ---------- */
function toastMsg(text, timeout=2500){
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>toast.classList.add('hidden'), timeout);
}

function setOrbState(s){
  state.orbState = s;
  orb.classList.remove('idle','listening','thinking','speaking','error');
  orb.classList.add(s.toLowerCase());
  orbStateLabel.textContent = s.toUpperCase();
}

/* ---------- Local Storage: conversation ---------- */
const STORAGE_KEY = 'gkedit_conv_v1';
function saveHistory(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.history || []));
}
function loadHistory(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    state.history = raw ? JSON.parse(raw) : [];
  }catch(e){
    state.history = [];
  }
}
function clearHistory(){
  state.history = [];
  saveHistory();
  renderMessages();
}

/* ---------- Rendering ---------- */
function renderMessages(){
  chatEl.innerHTML = '';
  state.history.forEach(msg=>{
    const el = document.createElement('div');
    el.className = 'message ' + (msg.role === 'user' ? 'user' : 'ai');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${msg.role === 'user' ? 'You' : 'GKEDIT'} • ${new Date(msg.ts).toLocaleTimeString()}`;
    el.appendChild(meta);

    if(msg.type === 'image'){
      const img = document.createElement('img');
      img.src = msg.content;
      img.style.maxWidth='220px';
      img.style.borderRadius='8px';
      el.appendChild(img);
    } else {
      const p = document.createElement('div');
      p.className = 'content';
      p.textContent = msg.content;
      el.appendChild(p);
    }

    chatEl.appendChild(el);
  });

  // scroll to bottom
  setTimeout(()=> chatEl.scrollTop = chatEl.scrollHeight, 80);
}

/* ---------- Add message ---------- */
function addMessage(role, content, extras = {}){
  const msg = {
    role,
    content,
    ts: Date.now(),
    ...extras
  };
  state.history.push(msg);
  saveHistory();
  renderMessages();
  return msg;
}

/* ---------- Voice: Speech Recognition ---------- */
function initRecognition(){
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onstart = () => {
    state.listening = true;
    setOrbState('LISTENING');
    toastMsg('Listening...');
    startMicAnalyser();
  };
  rec.onresult = ev => {
    const text = ev.results[0][0].transcript.trim();
    addMessage('user', text);
    stopMicAnalyser();
    setTimeout(()=>processUserInput(text), 60);
  };
  rec.onerror = ev => {
    console.error('Recognition error', ev);
    stopMicAnalyser();
    setOrbState('ERROR');
    toastMsg('Speech recognition error');
    setTimeout(()=>setOrbState('IDLE'), 1200);
  };
  rec.onend = () => {
    state.listening = false;
    stopMicAnalyser();
    if(state.orbState !== 'SPEAKING' && state.orbState !== 'THINKING') setOrbState('IDLE');
  };
  return rec;
}

/* ---------- Microphone analyzer (visual waveform) ---------- */
let audioContext = null, analyser = null, analyserSource = null, micStream = null, wfRAF = null;
const wfCanvas = waveformCanvas;
const wfCtx = wfCanvas.getContext('2d');

function startMicAnalyser(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(stream=>{
    micStream = stream;
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.85;
    analyserSource = audioContext.createMediaStreamSource(stream);
    analyserSource.connect(analyser);
    drawWaveform();
  }).catch(err=>{
    console.warn('Mic access denied or unavailable', err);
  });
}

function stopMicAnalyser(){
  if(micStream){
    micStream.getTracks().forEach(t=>t.stop());
    micStream = null;
  }
  if(audioContext){
    try{ audioContext.close(); }catch(e){}
    audioContext = null;
  }
  if(wfRAF) cancelAnimationFrame(wfRAF);
  clearWaveform();
}

function drawWaveform(){
  const WIDTH = wfCanvas.width = wfCanvas.clientWidth * devicePixelRatio;
  const HEIGHT = wfCanvas.height = wfCanvas.clientHeight * devicePixelRatio;
  wfCtx.clearRect(0,0,WIDTH,HEIGHT);
  if(!analyser){
    // fallback CSS animation
    wfCtx.fillStyle = 'rgba(255,255,255,0.02)';
    wfCtx.fillRect(0,0,WIDTH,HEIGHT);
    return;
  }
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw(){
    wfRAF = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);
    wfCtx.fillStyle = 'rgba(2,4,6,0.12)';
    wfCtx.fillRect(0,0,WIDTH,HEIGHT);
    wfCtx.lineWidth = 2 * devicePixelRatio;
    const gradient = wfCtx.createLinearGradient(0,0,WIDTH,0);
    gradient.addColorStop(0, 'rgba(55,240,255,0.9)');
    gradient.addColorStop(1, 'rgba(122,59, i=0;i<bufferLength;i++){
      const v = dataArray[i]/128.0;
      const y = v * HEIGHT/2;
      if(i===0) wfCtx.moveTo(x,y);
      else wfCtx.lineTo(x,y);
      x += sliceWidth;
    }
    wfCtx.lineTo(WIDTH,HEIGHT/2);
    wfCtx.stroke();
  }
  draw();
}

function clearWaveform(){
  if(!wfCtx) return;
  wfCtx.clearRect(0,0,wfCanvas.width, wfCanvas.height);
}

/* ---------- Speech Synthesis ---------- */
function speakText(text, onend();
    state.currentUtterance = null;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  // pick a voice close to preference
  const voices = window.speechSynthesis.getVoices();
  if(voices && voices.length){
    constaking = false; setOrbState('IDLE'); stopSpeakingWave(); state.currentUtterance = null; onend && onend(); };
  u.onerror = (e) => { console.error('TTS error', e); state.speaking=false; setOrbState('ERROR'); stopSpeakingWave(); on */
let speakRAF = null;
function startSpeakingWave(){
  const WIDTH = wfCanvas.width = wfCanvas.clientWidth * devicePixelRatio;
  const HEIGHT = wfCanvas.height = wfCanvas.clientHeight * devicePixelRatio;
  let t=0;
  function draw(){
    speakRAF = requestAnimationFrame(draw);
    t += 0.08;
    wfCtx.clearRect(0,0,WIDTH,HEIGHT);
    for(let i=0;i<4;i++){
      const hue = (200 + i*30) % 360;
      wfCtx.fillStyle = `hsla(${hue},80%,60%,${0.06 + i*0.04})`;
      const amplitude = (Math.sin(t + i) + 1) * (HEIGHT/10 + i*4);
      wfCtx.fillRect(i*20 * devicePixelRatio, HEIGHT/2 - amplitude/2, WIDTH - i*40 * devicePixelRatio, amplitude);
    }
  }
  draw();
}
function stopSpeakingWave(){ if(speakRAF) cancelAnimationFrame(speakRAF); clearWaveform(); }

/* ---------- AI API integration ---------- */
async function sendToAI(messages){
  // messages: array of {role, content}
  setOrbState('THINKING');
  apiStatus.classList.remove('online');
  apiStatus.classList.add('offline');
  statusText.textContent = 'CONNECTING...';
  try{
    const res = await fetch(API_ENDPOINT, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({messages})
    });
    if(!res.ok){
      const txt = await res.text();
      throw new Error('API error: ' + (txt || res.status));
    }
    const json = await res.json();
    // Expect structured response: { reply: "text" } — adjust backend accordingly
    apiStatus.classList.remove('offline');
    apiStatus.classList.add('online');
    statusText.textContent = 'ONLINE';
    setOrbState('IDLE');

    return json;
  }catch(err){
    console.error('AI request failed', err);
    apiStatus.classList.remove('online');
    apiStatus.classList.add('offline');
    statusText.textContent = 'OFFLINE';
    setOrbState('ERROR');
    return { error: String(err) };
  }
}

/* ---------- Process user input ---------- */
async function processUserInput(text){
  // Basic voice-command processing
  setOrbState('THINKING');
  addMessage('user', text);
  const cmd = text.toLowerCase();

  // Voice command handling examples:
  if(/^(hello|hi|hey)\s+gkedit/i.test(text)){
    const reply = `Hello — I am GKEDIT. How can I assist you today?`;
    handleAIReply(reply);
    return;
  }
  if(/weather|temperature|forecast/i.test(cmd)){
    // extract location if present
    const locMatch = text.match(/in ([a-zA-Z\s]+)/i);
    const city = locMatch ? locMatch[1].trim() : 'current location';
    getWeather(city);
    return;
  }
  if(/calculate|what is|what's|compute|evaluate/i.test(cmd) && /[0-9+\-/*%^().]/.test(text)){
    let expr = text.replace(/(calculate|compute|what is|what's|evaluate)/ig,'').replace(/x/ig,'*').replace(/times/ig,'*');
    expr = expr.replace(/[^\d+\-*/().% ]/g, '');
    const result = safeEval(expr);
    handleAIReply(result === null ? "I couldn't compute that." : `Result: ${result}`);
    return;
  }
  if(/search youtube|youtube search|youtube for/i.test(cmd)){
    const q = text.replace(/(search|find|youtube|on youtube|youtube search)/ig,'').trim();
    const query = encodeURIComponent(q || 'trending');
    window.open(`https://www.youtube.com/results?search_query=${query}`, '_blank');
    handleAIReply(`Opened YouTube results for "${q || 'trending'}".`);
    return;
  }
  if(/open google|go to google|open google.com/i.test(cmd)){
    window.open('https://www.google.com', '_blank');
    handleAIReply('Opening Google.');
    return;
  }
  if(/time|what time/i.test(cmd) && /what|tell|show|give/i.test(cmd)){
    handleAIReply(`The time is ${new Date().toLocaleTimeString()}`);
    return;
  }
  if(/set a reminder|remind me to|set reminder/i.test(cmd)){
    // parse simple "set a reminder in X seconds/minutes to do Y"
    const m = text.match(/in (\d+)\s*(second|minute|hour)/i);
    let delay = 0;
    if(m){
      const n = parseInt(m[1],10);
      if(/second/i.test(m[2])) delay = n*1000;
      if(/minute/i.test(m[2])) delay = n*60*1000;
      if(/hour/i.test(m[2])) delay = n*60*60*1000;
    } else {
      delay = 5000; // default 5s
    }
    const what = (text.split('to').slice(1).join('to') || 'Reminder').trim();
    setReminder(what, delay);
    handleAIReply(`Reminder set: "${what}" in ${Math.round(delay/1000)} seconds.`);
    return;
  }

  // If no local command matched, forward to AI
  // We'll send recent history (last 12 messages) to the backend
  const tail = state.history.slice(-12).map(m => ({role: m.role === 'user' ? 'user' : 'assistant', content: m.content}));
  // Append the user message we just added
  tail.push({role:'user', content:text});

  // Show thinking indicator in UI
  const typ = document.createElement('div');
  typ.className = 'message ai typing';
  typ.innerHTML = `<div class="meta">GKEDIT • ...</div><div class="dot"></div><div class="dot"></div><div class="dot"></div>`;
  chatEl.appendChild(typ);
  chatEl.scrollTop = chatEl.scrollHeight;

  const res = await sendToAI(tail);

  // remove typing
  typ.remove();

  if(res.error){
    const errMsg = `AI Error: ${res.error}`;
    handleAIReply(errMsg);
  }else{
    // Accept either {reply: "text"} or {message: {content: "..."}} or OpenAI-like choices
    let reply = res.reply || (res.message && res.message.content) || (res.choices && res.choices[0] && (res.choices[0].message?.content || res.choices[0 on end */ });
  }
}

/* ---------- Safe calculator ---------- */
function safeEval(expr){
  if(!expr || !/^[0-9+\-*/().% \t]+$/.test(expr)) return null;
  try{
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${expr})`);
    const v = fn();
    if(typeof v === 'number' && isFinite(v)) return v;
    return null;
  }catch(e){
    return null;
  }
}

/* ---------- Weather (basic) ---------- */
async function getWeather(city){
  setOrbState('THINKING');
  toastMsg('Fetching weather...');
  // If WEATHER_API_BASE is provided, call it with city appended; else simple demo
  try{
    if(WEATHER_API_BASE){
      const url = WEATHER_API_BASE + encodeURIComponent(city);
      const r = await fetch(url);
      if(!r.ok) throw new Error('Weather API error');
      const j = await r.json();
      // Try to show useful info if OpenWeather-like response
      if(j && j.weather){
        const desc = j.weather[0].description;
        const temp = j.main && j.main.temp ? j.main.temp : '';
        handleAIReply(`Weather in ${city}: ${desc}${temp? `, ${temp}°` : ''}`);
      } else if(j && j.current){
        // Some proxies return current
        const desc = j.current.weather_descriptions ? j.current.weather_descriptions.join(', ') : '';
        handleAIReply(`Weather in ${city}: ${desc}`);
      } else {
        handleAIReply('Weather: ' + JSON.stringify(j));
      }
    } else {
      // Demo fallback
      handleAIReply(`Demo weather: Clear skies in ${city}. (No real API configured)`);
    }
  }catch(err){
    console.warn(err);
    handleAIReply('Unable to fetch weather. Check your weather API settings or backend proxy.');
  } finally {
    setOrbState('IDLE');
  }
}

/* ---------- Reminders (Notifications API) ---------- */
function setReminder(text, delay){
  if(!('Notification' in window)){
    toastMsg('Notifications not supported');
    return;
  }
  if(Notification.permission !== 'granted'){
    Notification.requestPermission().then(p=>{
      if(p === 'granted'){
        scheduleReminder(text, delay);
      } else {
        toastMsg('Notifications blocked');
      }
    });
  }else{
    scheduleReminder(text, delay);
  }
}
function scheduleReminder(text, delay){
  setTimeout(()=>{
    try{
      new Notification('GKEDIT Reminder', { body: text, icon: '' });
    }catch(e){
      console.warn('Notification failed', e);
    }
    addMessage('assistant', `Reminder: ${text}`, {meta:'reminder'});
  }, delay);
}

/* ---------- File upload / preview ---------- */
fileInput.addEventListener('change', async (ev)=>{
  const f = ev.target.files[0];
  if(!f) return;
  if(f.type.startsWith('image/')){
    const url = URL.createObjectURL(f);
    previewArea.innerHTML = `<img src="${url}" style="max-width:100%;border-radius:8px" alt="preview"/>`;
    previewModal.classList.remove('hidden');
    // add image into conversation as assistant supporting preview
    addMessage('user', `Uploaded image: ${f.name}`);
    addMessage('assistant', url, {type:'image'});
  } else {
    // try read text
    try{
      const txt = await f.text();
      previewArea.innerHTML = `<pre style="white-space:pre-wrap;max-height:60vh;overflow:auto">${escapeHtml(txt)}</pre>`;
      previewModal.classList.remove('hidden');
      addMessage('user', `Uploaded file: ${f.name}`);
      addMessage('assistant', txt.slice(0, 1000));
    }catch(e){
      toastMsg('Unable to read file');
    }
  }
});
closePreview.addEventListener('click', ()=> previewModal.classList.add('hidden'));
function escapeHtml(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

/* ---------- Quick action buttons ---------- */
document.querySelectorAll('.quick').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const a = btn.dataset.action;
    if(a === 'time') processUserInput('Tell me the time');
    if(a === 'date') addMessage('assistant', `Today is ${new Date().toLocaleDateString()}`);
    if(a === 'weather') processUserInput('What is the weather?');
    if(a === 'search') {
      const q = prompt('Search the web for:');
      if(q) window.open(`https://www.google.com/search?q=${encodeURIComponent(q)}`, '_blank');
    }
    if(a === 'youtube') {
      const q = prompt('Search YouTube for:');
      if(q) window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, '_blank');
    }
    if(a === 'calc'){
      const q = prompt('Enter expression to calculate (e.g. 25*48):');
      if(q){ const res = safeEval(q); addMessage('assistant', res===null? 'Invalid expression' : `Result: ${res}`); }
    }
  });
});

/* ---------- Event handlers: send, enter, mic, stop speak ---------- */
sendBtn.addEventListener('click', ()=> {
  const v = inputBox.value.trim();
  if(!v) return;
  inputBox.value = '';
  processUserInput(v);
});
inputBox.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    sendBtn.click();
  }
});

micBtn.addEventListener('click', () => {
  if(!state.recognition){
    state.recognition = initRecognition();
    if(!state.recognition){
      toastMsg('Speech Recognition not supported in this browser.');
      return;
    }
  }
  try{
    if(state.listening){
      state.recognition.stop();
    }else{
      state.recognition.start();
    }
  }catch(e){
    console.warn(e);
  }
});

stopSpeakBtn.addEventListener('click', ()=>{
  if(window.speechSynthesis){
    window.speechSynthesis.cancel();
    state.speaking = false;
    setOrbState('IDLE');
    stopSpeakingWave();
  }
});

/* ---------- Settings ---------- */
btnSettings.addEventListener('click', ()=> {
  settingsPanel.classList.toggle('hidden');
  settingsPanel.setAttribute('aria-hidden', settingsPanel.classList.contains('hidden'));
});
closeSettings.addEventListener('click', ()=> btnSettings.click());
saveSettings.addEventListener('click', ()=>{
  state.voiceEnabled = toggleVoice.checked;
  state.autoSpeak = toggleAutoSpeak.checked;
  document.documentElement.classList.toggle('theme-light', themeSelect.value === 'light');
  API_ENDPOINT = apiEndpointInput.value.trim() || '/a
