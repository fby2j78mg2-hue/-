(() => {
  "use strict";

  // =====================
  // Config
  // =====================
  const LS_KEY = "vocab_pack_srs_multi_v1";
  const PACK_SIZE = 20;

  // 세션 기반 간격 (추천값)
  const GAP = {
    known: 10,   // ✅ 앎
    unsure: 3,   // 👇 애매
    unknown: 1,  // ❌ 모름
  };

  const LANGS = {
    en: { label: "English", tts: "en-US" },
    ja: { label: "日本語", tts: "ja-JP" },
    es: { label: "Español", tts: "es-ES" },
  };

  const DATA_SOURCES_FILE = "./data/sources.json";

  // =====================
  // Helpers
  // =====================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(s){
    return String(s ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function hashId(s){
    let h = 0;
    for (let i=0;i<s.length;i++) h = Math.imul(31,h) + s.charCodeAt(i) | 0;
    return Math.abs(h).toString(36);
  }

  function seededRandom(seedStr){
    function xmur3(str){
      let h = 1779033703 ^ str.length;
      for (let i=0; i<str.length; i++){
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
      }
      return function(){
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        return (h ^= h >>> 16) >>> 0;
      };
    }
    function mulberry32(a){
      return function(){
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const seed = xmur3(seedStr)();
    return mulberry32(seed);
  }

  function shuffle(arr, rnd){
    const a = arr.slice();
    for (let i=a.length-1; i>0; i--){
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function nowMs(){ return Date.now(); }

  // seenCount 표시 규칙 (요청 반영)
  // x: 0회, △: 1회, o: 2회 이상
  function repetitionMark(seenCount){
    if (seenCount <= 0) return {ch:"x", cls:"x", title:"0회"};
    if (seenCount === 1) return {ch:"△", cls:"tri", title:"1회"};
    return {ch:"o", cls:"o", title:`${seenCount}회`};
  }

  // =====================
  // Data
  // =====================
  // MASTER_BY_LANG[lang] = [{id,word,ipa,koPron,meaningKo,example}]
  const MASTER_BY_LANG = { en: [], ja: [], es: [] };
  let sources = null;

  async function loadAllMasters(){
    const res = await fetch(DATA_SOURCES_FILE, { cache: "no-store" });
    if (!res.ok) throw new Error("sources.json 로드 실패");
    sources = await res.json();

    for (const lang of Object.keys(LANGS)){
      const files = sources?.[lang];
      if (!Array.isArray(files)) throw new Error(`sources.json: ${lang} 파일 목록이 배열이 아님`);
      const parts = await Promise.all(files.map(async (path) => {
        const r = await fetch(path, { cache: "no-store" });
        if (!r.ok) throw new Error(`단어팩 로드 실패: ${path}`);
        const data = await r.json();
        if (!Array.isArray(data)) throw new Error(`JSON 배열이 아님: ${path}`);
        return data;
      }));

      const merged = parts.flat().map((x, idx) => {
        const word = String(x.word ?? "").trim();
        const example = String(x.example ?? "").trim();
        if (!word || !example) return null;
        return {
          id: String(x.id ?? `${lang}_auto_${idx}_${hashId(word)}`),
          word,
          ipa: String(x.ipa ?? "").trim(),
          koPron: String(x.koPron ?? "").trim(),
          meaningKo: String(x.meaningKo ?? "").trim(),
          example
        };
      }).filter(Boolean);

      const seen = new Set();
      MASTER_BY_LANG[lang] = merged.filter(w => {
        if (seen.has(w.id)) return false;
        seen.add(w.id);
        return true;
      });
    }
  }

  function getMaster(){
    return MASTER_BY_LANG[state.activeLang] ?? [];
  }

  // =====================
  // State (per language)
  // =====================
  function defaultLangState(){
    return {
      session: 0,
      progress: {}, // progress[id] = {status,lastGrade,nextDueSession,seenCount,lastSeenSession,lastUpdatedAt}
      pack: null    // current open pack: {session, ids, idx}
    };
  }

  function defaultState(){
    return {
      schema: 1,
      activeLang: "en",
      langs: {
        en: defaultLangState(),
        ja: defaultLangState(),
        es: defaultLangState()
      }
    };
  }

  function loadState(){
    try{
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      if (!s || typeof s !== "object" || s.schema !== 1) return defaultState();
      s.activeLang ??= "en";
      s.langs ??= {};
      for (const l of Object.keys(LANGS)){
        s.langs[l] ??= defaultLangState();
        s.langs[l].session ??= 0;
        s.langs[l].progress ??= {};
        // pack은 세션 전환 시 안전하게 무시될 수 있음
      }
      return s;
    }catch{
      return defaultState();
    }
  }

  function saveState(){
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  let state = loadState();

  function ls(){
    return state.langs[state.activeLang];
  }

  function getP(id){
    const L = ls();
    L.progress[id] ??= {
      status: "new",         // new | learning
      lastGrade: null,       // known | unsure | unknown
      nextDueSession: 0,
      seenCount: 0,
      lastSeenSession: -1,
      lastUpdatedAt: nowMs()
    };
    return L.progress[id];
  }

  function isDue(id){
    const p = getP(id);
    return p.status !== "new" && p.nextDueSession <= ls().session;
  }

  function gradeCard(id, grade){
    const p = getP(id);
    p.status = "learning";
    p.lastGrade = grade;
    p.seenCount += 1;
    p.lastSeenSession = ls().session;
    p.nextDueSession = ls().session + (GAP[grade] ?? 3);
    p.lastUpdatedAt = nowMs();
    saveState();
  }

  // =====================
  // Pack builder (20 cards)
  // =====================
  function buildPack(){
    const L = ls();
    const master = getMaster();
    const rnd = seededRandom(`pack|${state.activeLang}|${L.session}|${master.length}`);

    const dueUnknown = [];
    const dueUnsure = [];
    const dueKnown = [];

    for (const w of master){
      const p = getP(w.id);
      if (p.status === "new") continue;
      if (p.nextDueSession > L.session) continue;
      if (p.lastGrade === "unknown") dueUnknown.push(w.id);
      else if (p.lastGrade === "unsure") dueUnsure.push(w.id);
      else dueKnown.push(w.id);
    }

    const A = shuffle(dueUnknown, rnd);
    const B = shuffle(dueUnsure, rnd);
    const C = shuffle(dueKnown, rnd);

    const totalDue = A.length + B.length + C.length;

    const pack = [];
    const pushUntil = (arr, max) => {
      for (const id of arr){
        if (pack.length >= max) break;
        pack.push(id);
      }
    };

    if (totalDue >= PACK_SIZE){
      // 복습만 20장 (새 카드 0)
      pushUntil(A, PACK_SIZE);
      pushUntil(B, PACK_SIZE);
      pushUntil(C, PACK_SIZE);
      return pack;
    }

    // due 먼저: 모름 > 애매
    pushUntil(A, PACK_SIZE);
    pushUntil(B, PACK_SIZE);

    // 남는 자리: 새카드 먼저, 마지막에 known due
    if (pack.length < PACK_SIZE){
      const newIds = [];
      for (const w of master){
        const p = getP(w.id);
        if (p.status === "new") newIds.push(w.id);
      }
      const newShuffled = shuffle(newIds, rnd);
      pushUntil(newShuffled, PACK_SIZE);
    }

    pushUntil(C, PACK_SIZE);

    return pack.slice(0, PACK_SIZE);
  }

  function openNewPack(){
    const L = ls();
    L.session += 1;
    const ids = buildPack();
    L.pack = { session: L.session, ids, idx: 0 };
    saveState();
  }

  // =====================
  // TTS
  // =====================
  function speak(text){
    try{
      if(!("speechSynthesis" in window)){
        alert("이 브라우저는 TTS를 지원하지 않아.");
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = LANGS[state.activeLang]?.tts ?? "en-US";
      u.rate = 0.95;
      u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    }catch{
      alert("TTS 재생 실패");
    }
  }

  // =====================
  // Modal
  // =====================
  function ensureModal(){
    if ($("#modalOverlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "modalOverlay";
    overlay.className = "modalOverlay";
    overlay.innerHTML = `
      <div class="modalSheet" role="dialog" aria-modal="true">
        <div class="modalTop">
          <strong id="mTitle">상세</strong>
          <button class="ttsBtn xBtn" id="mClose" aria-label="닫기">✕</button>
        </div>
        <div id="mBody"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    $("#mClose", overlay).addEventListener("click", closeModal);
  }

  function openModal(w){
    ensureModal();
    $("#mTitle").textContent = w.word;
    $("#mBody").innerHTML = `
      <div style="display:flex; gap:10px; align-items:center; justify-content:space-between;">
        <div>
          <div style="font-size:12px;color:#cfe0ff;opacity:.9">${escapeHtml(w.ipa || "")}</div>
          <div style="font-size:12px;color:var(--muted)">발음(한글): ${escapeHtml(w.koPron || "-")}</div>
          <div class="mask revealed" style="margin-top:10px;">뜻: ${escapeHtml(w.meaningKo || "-")}</div>
        </div>
        <button class="ttsBtn" id="mSpeakWord">🔊</button>
      </div>
      <div style="margin-top:12px;">
        <div class="rowEx" id="mExample">${escapeHtml(w.example || "")}</div>
        <div style="margin-top:8px;font-size:12px;color:var(--muted);line-height:1.5">예문을 누르면 TTS가 재생돼.</div>
      </div>
    `;
    $("#mSpeakWord").addEventListener("click", () => speak(w.word));
    $("#mExample").addEventListener("click", () => speak(w.example));
    $("#modalOverlay").classList.add("show");
  }

  function closeModal(){
    $("#modalOverlay")?.classList.remove("show");
  }

  // =====================
  // Mask
  // =====================
  function initMasking(root=document){
    const els = root.querySelectorAll?.("[data-mask]") ?? [];
    els.forEach(el => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        el.classList.toggle("revealed");
      });
    });
  }

  // =====================
  // Swipe 3-way
  // =====================
  function attachSwipe3(el, {onLeft, onRight, onDown}){
    let startX=0, startY=0, dragging=false;

    const TH_X = 70;
    const TH_Y = 90;
    const maxTilt = 12;

    function pt(e){ return {x: e.clientX, y: e.clientY}; }

    function down(e){
      const p = pt(e);
      startX = p.x; startY = p.y;
      dragging = true;
      el.style.transition = "none";
    }

    function move(e){
      if (!dragging) return;
      const p = pt(e);
      const dx = p.x - startX;
      const dy = p.y - startY;
      const tilt = Math.max(-maxTilt, Math.min(maxTilt, dx / 18));
      el.style.transform = `translate(${dx}px, ${Math.max(0, dy)}px) rotate(${tilt}deg)`;
      const fade = Math.min(0.55, Math.max(Math.abs(dx)/420, Math.max(0, dy)/520));
      el.style.opacity = String(1 - fade);
    }

    function up(e){
      if (!dragging) return;
      dragging = false;
      const p = pt(e);
      const dx = p.x - startX;
      const dy = p.y - startY;

      if (Math.abs(dx) >= TH_X && Math.abs(dx) > Math.abs(dy)){
        if (dx < 0) onLeft?.();
        else onRight?.();
        return;
      }
      if (dy >= TH_Y && Math.abs(dy) > Math.abs(dx)){
        onDown?.();
        return;
      }

      el.style.transition = "transform 180ms ease, opacity 180ms ease";
      el.style.transform = "translate(0,0) rotate(0)";
      el.style.opacity = "1";
    }

    el.addEventListener("pointerdown", down, {passive:true});
    window.addEventListener("pointermove", move, {passive:true});
    window.addEventListener("pointerup", up, {passive:true});
    window.addEventListener("pointercancel", up, {passive:true});
  }

  // =====================
  // Routing
  // =====================
  const routes = {
    home: renderHome,
    study: renderStudy,
    unknown: () => renderList("unknown"),
    known: () => renderList("known")
  };
  let currentRoute = "home";

  function setRoute(r){
    currentRoute = r;
    $$(".nav button").forEach(b => b.classList.toggle("active", b.dataset.route === r));
    routes[r]?.();
  }

  // =====================
  // Counts
  // =====================
  function countLearningByGrade(grade){
    const L = ls();
    let c = 0;
    for (const id in L.progress){
      const p = L.progress[id];
      if (p.status !== "new" && p.lastGrade === grade) c++;
    }
    return c;
  }

  function countDueAll(){
    const L = ls();
    const master = getMaster();
    let c = 0;
    for (const w of master){
      const p = getP(w.id);
      if (p.status !== "new" && p.nextDueSession <= L.session) c++;
    }
    return c;
  }

  function countNew(){
    const L = ls();
    const master = getMaster();
    let learned = 0;
    for (const w of master){
      const p = L.progress[w.id];
      if (p && p.status !== "new") learned++;
    }
    return Math.max(0, master.length - learned);
  }

  // =====================
  // Views
  // =====================
  function renderHome(){
    const master = getMaster();
    const L = ls();
    const due = countDueAll();
    const unknown = countLearningByGrade("unknown");
    const unsure = countLearningByGrade("unsure");
    const known = countLearningByGrade("known");
    const newCount = countNew();

    $("#subtitle").textContent = `${LANGS[state.activeLang].label} · 카드팩 ${PACK_SIZE}장 · 왼쪽(앎) / 오른쪽(모름) / 아래(애매)`;
    $("#pillText").textContent = `${LANGS[state.activeLang].label} · 세션 ${L.session} · 복습대기 ${due}개`;

    $("#view").innerHTML = `
      <div class="grid">
        <div class="card">
          <h2>언어 선택</h2>
          <p class="sub">영어/일본어/스페인어를 탭하면, 진행 기록이 언어별로 분리돼.</p>
          <div class="langBar">
            <button class="langBtn" data-lang="en">영어</button>
            <button class="langBtn" data-lang="ja">일본어</button>
            <button class="langBtn" data-lang="es">스페인어</button>
          </div>
          <div class="notice" style="margin-top:12px;">
            현재: <b>${escapeHtml(LANGS[state.activeLang].label)}</b> · 단어 수: <b>${master.length}</b>개<br/>
            새 카드: <b>${newCount}</b>개 · 복습대기: <b>${due}</b>개
          </div>
        </div>

        <div class="card">
          <h2>팩 개봉 학습</h2>
          <p class="sub">날짜 없이 “팩(세션)”으로만 복습해. 타임존/자정 버그가 거의 없어.</p>
          <div class="notice">
            ✅ 규칙<br/>
            - 팩은 항상 <b>${PACK_SIZE}장</b><br/>
            - 복습이 20장 이상이면 새 카드 0장<br/>
            - 우선순위: <b>모름 &gt; 애매 &gt; 새카드 &gt; 복습예정</b><br/>
            - 간격: 모름 ${GAP.unknown} · 애매 ${GAP.unsure} · 앎 ${GAP.known} (세션 기준)
          </div>
          <div class="toolbar">
            <button class="btn" id="btnOpenPack">🎁 새 카드팩 열기</button>
            <button class="btn" id="btnReset">초기화</button>
          </div>
          ${master.length === 0 ? `
            <div class="notice" style="margin-top:12px;">
              ⚠️ 아직 단어가 없어요. 나중에 /data/vocab_${state.activeLang}_*.json에 단어를 넣으면 자동으로 로드돼요.
            </div>
          ` : ``}
        </div>

        <div class="card">
          <h2>상태</h2>
          <p class="sub">스와이프 결과 누적</p>
          <div class="tiles">
            <a class="tile" href="#" data-go="unknown">
              <div><strong>❓ 단어(모름+애매)</strong><div><span>x/△/o 표시</span></div></div>
              <div class="badge">${unknown + unsure}</div>
            </a>
            <a class="tile" href="#" data-go="known">
              <div><strong>✅ 앎</strong><div><span>+${GAP.known} 세션 뒤 복습</span></div></div>
              <div class="badge">${known}</div>
            </a>
            <a class="tile" href="#" data-go="study">
              <div><strong>🎁 학습</strong><div><span>팩 열고 스와이프</span></div></div>
              <div class="badge">${PACK_SIZE}</div>
            </a>
            <a class="tile" href="#" data-go="home">
              <div><strong>📌 표시</strong><div><span>x=0회 · △=1회 · o=2회+</span></div></div>
              <div class="badge">x△o</div>
            </a>
          </div>
        </div>
      </div>
    `;

    // lang buttons
    $$(".langBtn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.lang === state.activeLang);
      btn.addEventListener("click", () => {
        state.activeLang = btn.dataset.lang;
        saveState();
        // 팩은 언어 바꾸면 그대로 두기(언어별 pack 보존)
        renderHome();
      });
    });

    $("#btnOpenPack").addEventListener("click", () => {
      if (getMaster().length === 0){
        alert("아직 단어가 없어요. 나중에 JSON을 추가하면 바로 동작해요.");
        return;
      }
      openNewPack();
      setRoute("study");
    });

    $("#btnReset").addEventListener("click", () => {
      if(!confirm("진행 기록을 모두 초기화할까요? (단어 데이터는 유지)")) return;
      localStorage.removeItem(LS_KEY);
      state = loadState();
      renderHome();
    });

    $$("[data-go]").forEach(a => a.addEventListener("click", (e) => {
      e.preventDefault();
      setRoute(a.dataset.go);
    }));
  }

  function renderStudy(){
    const master = getMaster();
    const L = ls();

    $("#subtitle").textContent = `${LANGS[state.activeLang].label} · 카드팩 ${PACK_SIZE}장 · 왼쪽(앎) / 오른쪽(모름) / 아래(애매)`;
    $("#pillText").textContent = `${LANGS[state.activeLang].label} · 세션 ${L.session} · 팩`;

    if (!L.pack || !Array.isArray(L.pack.ids) || L.pack.ids.length === 0){
      $("#view").innerHTML = `
        <div class="card">
          <h2>팩이 없어</h2>
          <p class="sub">메인에서 “새 카드팩 열기”를 눌러줘.</p>
          <div class="toolbar">
            <button class="btn" id="goHome">메인</button>
          </div>
        </div>
      `;
      $("#goHome").addEventListener("click", () => setRoute("home"));
      return;
    }

    const remainingIds = L.pack.ids.slice(L.pack.idx);
    if (remainingIds.length === 0){
      $("#view").innerHTML = `
        <div class="card">
          <h2>🎉 팩 완료!</h2>
          <p class="sub">이번 팩 ${PACK_SIZE}장을 모두 처리했어.</p>
          <div class="toolbar">
            <button class="btn" id="btnNextPack">🎁 다음 팩 열기</button>
            <button class="btn" id="btnHome">메인</button>
          </div>
        </div>
      `;
      $("#btnHome").addEventListener("click", () => setRoute("home"));
      $("#btnNextPack").addEventListener("click", () => {
        if (master.length === 0) return;
        openNewPack();
        renderStudy();
      });
      return;
    }

    const visible = remainingIds.slice(0, Math.min(3, remainingIds.length))
      .map(id => master.find(w => w.id === id))
      .filter(Boolean);

    const totalDone = L.pack.idx;
    const total = L.pack.ids.length;

    $("#view").innerHTML = `
      <div class="card">
        <h2>🎁 카드팩</h2>
        <p class="sub">${totalDone + 1} / ${total} · 왼쪽=앎 · 오른쪽=모름 · 아래=애매</p>

        <div class="stack" id="stack"></div>

        <div class="notice" style="margin-top:12px;">
          🔥 간격(세션 기준)<br/>
          ◀️ 앎: +${GAP.known} · ▶️ 모름: +${GAP.unknown} · 👇 애매: +${GAP.unsure}
        </div>

        <div class="toolbar">
          <button class="btn good" id="btnKnown">◀️ 앎</button>
          <button class="btn mid" id="btnUnsure">👇 애매</button>
          <button class="btn bad" id="btnUnknown">모름 ▶️</button>
        </div>
      </div>
    `;

    const stack = $("#stack");

    visible.forEach((w, idx) => {
      const card = document.createElement("div");
      card.className = "wordCard";
      card.style.transform = `translateY(${idx*8}px) scale(${1 - idx*0.02})`;
      card.style.opacity = `${1 - idx*0.08}`;
      card.style.zIndex = String(10 - idx);

      card.innerHTML = `
        <div>
          <div class="wcTop">
            <div class="wcIndex">${totalDone + 1} / ${total}</div>
            <div class="wcHint">◀️ 앎<br/>▶️ 모름<br/>👇 애매</div>
          </div>
          <div class="wcMain">
            <div class="wcWordRow">
              <h3 class="wcWord">${escapeHtml(w.word)}</h3>
              <button class="ttsBtn" data-tts="word" aria-label="단어 발음">🔊</button>
            </div>
            <div class="wcIpa">${escapeHtml(w.ipa || "")}</div>
            <div class="wcKo">발음(한글): ${escapeHtml(w.koPron || "-")}</div>
            <div class="wcMeaning mask" data-mask="meaning">뜻: ${escapeHtml(w.meaningKo || "-")}</div>
            <div class="wcExample" data-open="example">${escapeHtml(w.example || "")}</div>
          </div>
        </div>
      `;

      card.querySelector('[data-tts="word"]').addEventListener("click", () => speak(w.word));
      card.querySelector('[data-open="example"]').addEventListener("click", () => openModal(w));

      initMasking(card);

      if (idx === 0){
        attachSwipe3(card, {
          onLeft: () => commit("known"),
          onRight: () => commit("unknown"),
          onDown: () => commit("unsure")
        });
      }

      stack.appendChild(card);
    });

    $("#btnKnown").addEventListener("click", () => commit("known"));
    $("#btnUnsure").addEventListener("click", () => commit("unsure"));
    $("#btnUnknown").addEventListener("click", () => commit("unknown"));

    function commit(grade){
      const id = L.pack.ids[L.pack.idx];
      const w = master.find(x => x.id === id);
      if (!w){
        L.pack.idx += 1;
        saveState();
        renderStudy();
        return;
      }

      gradeCard(w.id, grade);

      const top = stack.querySelector(".wordCard");
      if (top){
        top.style.transition = "transform 220ms ease, opacity 220ms ease";
        if (grade === "known") top.style.transform = "translateX(-120%) rotate(-14deg)";
        else if (grade === "unknown") top.style.transform = "translateX(120%) rotate(14deg)";
        else top.style.transform = "translateY(140%) scale(.98)";
        top.style.opacity = "0";
      }

      setTimeout(() => {
        L.pack.idx += 1;
        saveState();
        renderStudy();
      }, 180);
    }
  }

  function renderList(mode){
    const master = getMaster();
    const L = ls();

    $("#subtitle").textContent = mode === "known" ? `${LANGS[state.activeLang].label} · ✅ 앎` : `${LANGS[state.activeLang].label} · ❓ 단어(모름+애매)`;
    $("#pillText").textContent = `${LANGS[state.activeLang].label} · 세션 ${L.session}`;

    const wantGrades = mode === "known" ? new Set(["known"]) : new Set(["unknown","unsure"]);

    const items = [];
    for (const w of master){
      const p = getP(w.id);
      if (p.status === "new") continue;
      if (!wantGrades.has(p.lastGrade)) continue;
      items.push({ w, p });
    }

    items.sort((a,b) => (b.p.lastUpdatedAt ?? 0) - (a.p.lastUpdatedAt ?? 0));

    $("#view").innerHTML = `
      <div class="card">
        <h2>${mode === "known" ? "아는 단어" : "단어"} (${items.length})</h2>
        <p class="sub">
          ${mode === "known"
            ? "✅ 앎으로 분류된 카드"
            : "❓ 모름 + 👇 애매로 분류된 카드 (같이 유지)"
          }<br/>
          표시: x=0회 · △=1회 · o=2회+
        </p>

        ${items.length === 0
          ? `<div class="empty">아직 없음. 팩부터 열어봐!</div>`
          : `<div class="list" style="margin-top:12px;">
              ${items.map(({w,p}) => {
                const mk = repetitionMark(p.seenCount ?? 0);
                return `
                  <div class="row">
                    <div class="rowTop">
                      <div>
                        <div class="rowWord">
                          <span class="repMark ${mk.cls}" title="${mk.title}">${mk.ch}</span>
                          ${escapeHtml(w.word)}
                        </div>
                        <div class="rowIpa">${escapeHtml(w.ipa || "")}</div>
                        <div class="rowKo">발음(한글): ${escapeHtml(w.koPron || "-")}</div>
                      </div>
                      <div class="rowMeta">다음 복습: 세션 ${p.nextDueSession}</div>
                    </div>
                    <div class="mask revealed">뜻: ${escapeHtml(w.meaningKo || "-")}</div>
                    <div class="rowEx" data-open="example" data-id="${escapeHtml(w.id)}">${escapeHtml(w.example || "")}</div>
                  </div>
                `;
              }).join("")}
            </div>`
        }

        <div class="toolbar">
          <button class="btn" id="btnBack">메인</button>
          <button class="btn" id="btnStudy">팩</button>
        </div>
      </div>
    `;

    $$('[data-open="example"]').forEach(el => {
      el.addEventListener("click", () => {
        const id = el.dataset.id;
        const w = master.find(x => x.id === id);
        if (w) openModal(w);
      });
    });

    $("#btnBack").addEventListener("click", () => setRoute("home"));
    $("#btnStudy").addEventListener("click", () => setRoute("study"));
  }

  // =====================
  // Nav
  // =====================
  $$(".nav button").forEach(b => b.addEventListener("click", () => setRoute(b.dataset.route)));

  // =====================
  // Boot
  // =====================
  (async function boot(){
    try{
      await loadAllMasters();
      setRoute("home");
    }catch(err){
      $("#pillText").textContent = "로딩 실패";
      $("#view").innerHTML = `
        <div class="card">
          <h2>로딩 실패</h2>
          <p class="sub">${escapeHtml(err?.message ?? err)}</p>
          <div class="notice">
            체크:<br/>
            1) /data/sources.json 경로 맞는지<br/>
            2) vocab_*.json 파일이 실제로 있는지<br/>
            3) JSON 배열 형식인지
          </div>
        </div>
      `;
    }
  })();
})();
