(function () {
  "use strict";

  const core = globalThis.QuizCore;
  const bank = globalThis.QUESTION_BANK;
  const STORAGE_KEY = "smhmx_quiz_v1";
  const APP_VERSION = 1;
  const MAX_HISTORY = 100;

  const CATEGORY_CLASS = {
    安全基础: "cat-safety",
    常见事故预防: "cat-common",
    季节性劳动安全: "cat-seasonal",
    专业劳动安全: "cat-professional",
    事故处置: "cat-accident",
    劳防用品与职业健康: "cat-ppe",
  };

  let state = null;
  let questionMap = new Map();
  let activeSession = null;
  let currentView = "home";
  let timerInterval = null;
  let timerStartedAt = 0;
  let timerBase = 0;
  let saveTimer = null;
  let storageWarned = false;
  let deferredInstallPrompt = null;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const views = {
    home: $("#homeView"),
    paper: $("#paperView"),
    result: $("#resultView"),
    wrong: $("#wrongView"),
    data: $("#dataView"),
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => {
      const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return map[character];
    });
  }

  function defaultState() {
    return {
      version: APP_VERSION,
      settings: { mode: "exam" },
      paperSeq: 0,
      runSeq: 0,
      questionStats: {},
      activePaper: null,
      history: [],
      wrongBook: {},
      lastSession: null,
      training: {
        types: ["fill", "single", "judge"],
        category: "all",
        count: "30",
        order: "random",
      },
      updatedAt: null,
    };
  }

  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== "object") return base;
    const savedTrainingTypes = Array.isArray(raw.training?.types)
      ? raw.training.types.filter((type) => core.TYPE_ORDER.includes(type))
      : [];
    const result = {
      ...base,
      ...raw,
      settings: {
        ...base.settings,
        ...(raw.settings && typeof raw.settings === "object" ? raw.settings : {}),
      },
      paperSeq: Number.isInteger(raw.paperSeq) ? raw.paperSeq : 0,
      runSeq: Number.isInteger(raw.runSeq) ? raw.runSeq : 0,
      questionStats:
        raw.questionStats && typeof raw.questionStats === "object"
          ? raw.questionStats
          : {},
      history: Array.isArray(raw.history)
        ? raw.history.filter(Boolean).slice(0, MAX_HISTORY)
        : [],
      wrongBook:
        raw.wrongBook && typeof raw.wrongBook === "object" ? raw.wrongBook : {},
      activePaper: raw.activePaper && raw.activePaper.paper ? raw.activePaper : null,
      lastSession:
        raw.lastSession && raw.lastSession.paper ? raw.lastSession : null,
      training: {
        types: savedTrainingTypes.length
          ? savedTrainingTypes
          : ["fill", "single", "judge"],
        category:
          raw.training?.category &&
          (raw.training.category === "all" ||
            core.CATEGORY_ORDER.includes(raw.training.category))
            ? raw.training.category
            : "all",
        count: ["20", "30", "50", "100", "all"].includes(raw.training?.count)
          ? raw.training.count
          : "30",
        order: raw.training?.order === "sequential" ? "sequential" : "random",
      },
    };
    result.settings.mode = result.settings.mode === "practice" ? "practice" : "exam";
    const historyMaxSeq = result.history.reduce(
      (max, item) => Math.max(max, Number(item.seq) || 0),
      0
    );
    result.paperSeq = Math.max(result.paperSeq, historyMaxSeq);
    const statsMaxSeq = Object.values(result.questionStats).reduce(
      (max, item) => Math.max(max, Number(item.lastSeen) || 0),
      0
    );
    result.runSeq = Math.max(result.runSeq, result.paperSeq, statsMaxSeq);
    if (result.activePaper) {
      result.activePaper.answers = result.activePaper.answers || {};
      result.activePaper.flags = result.activePaper.flags || {};
      result.activePaper.checked = result.activePaper.checked || {};
      result.activePaper.revealed = result.activePaper.revealed || {};
      result.activePaper.currentIndex = Number.isInteger(
        result.activePaper.currentIndex
      )
        ? result.activePaper.currentIndex
        : 0;
      result.activePaper.elapsedSec = Number.isFinite(
        result.activePaper.elapsedSec
      )
        ? result.activePaper.elapsedSec
        : 0;
      result.paperSeq = Math.max(
        result.paperSeq,
        Number(result.activePaper.paper.seq) || 0
      );
      result.runSeq = Math.max(
        result.runSeq,
        Number(result.activePaper.paper.runSeq) || 0,
        Number(result.activePaper.paper.seq) || 0
      );
      const size = result.activePaper.paper.questionIds?.length || 0;
      if (result.activePaper.currentIndex < 0) result.activePaper.currentIndex = 0;
      if (size && result.activePaper.currentIndex >= size) {
        result.activePaper.currentIndex = size - 1;
      }
    }
    return result;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      console.warn("Failed to load saved quiz data", error);
      return defaultState();
    }
  }

  function saveState(options) {
    const opts = options || {};
    state.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageWarned = false;
    } catch (error) {
      console.warn("Failed to save quiz data", error);
      if (!storageWarned && !opts.silent) {
        storageWarned = true;
        showToast("浏览器本地存储不可用，当前进度可能无法保存。", "error");
      }
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveState({ silent: true });
    }, 220);
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
        2,
        "0"
      )}:${String(secs).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatPercent(value) {
    return `${Number(value || 0).toFixed(1)}%`;
  }

  function categoryClass(category) {
    return CATEGORY_CLASS[category] || "cat-safety";
  }

  function categoryChip(category) {
    return `<span class="chip chip-category ${categoryClass(
      category
    )}">${escapeHtml(category)}</span>`;
  }

  function typeChip(type) {
    return `<span class="chip chip-type">${escapeHtml(
      core.TYPE_LABELS[type] || type
    )}</span>`;
  }

  function modeLabel(mode) {
    const labels = {
      exam: "模拟考试",
      practice: "练习模式",
      special: "专项练习",
      study: "背题模式",
    };
    return labels[mode] || "模拟考试";
  }

  function isPracticeMode(paper) {
    return paper.mode === "practice" || paper.mode === "special";
  }

  function isTrainingPaper(paper) {
    return paper.kind === "special" || paper.mode === "study";
  }

  function isStandaloneMode() {
    return (
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      window.navigator.standalone === true
    );
  }

  async function showInstallHelp() {
    if (window.AndroidBridge) {
      alertDialog("已经安装", "当前使用的是 Android 安装版，可以直接从桌面打开。");
      return;
    }
    if (deferredInstallPrompt) {
      const prompt = deferredInstallPrompt;
      deferredInstallPrompt = null;
      prompt.prompt();
      await prompt.userChoice;
      return;
    }
    const userAgent = navigator.userAgent || "";
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
    const isWeChat = /MicroMessenger/i.test(userAgent);
    const instructions = isIOS
      ? `<p>请使用 iPhone 自带的 <strong>Safari</strong> 打开本页。</p>
         <p>点击 Safari 底部工具栏的“分享”按钮，然后选择“添加到主屏幕”。</p>
         <p>添加后从主屏幕图标打开，首次加载完成后可以离线使用。</p>
         ${
           isWeChat
             ? "<p>微信内置浏览器不能直接安装，请点击右上角菜单选择“在 Safari 中打开”。</p>"
             : ""
         }`
      : `<p>请使用 Chrome 或 Edge 打开本页。</p>
         <p>点击浏览器菜单中的“安装应用”或“添加到主屏幕”。</p>
         <p>安装后可以从桌面直接打开，安装包会缓存题库并支持离线使用。</p>`;
    showModal({
      title: "安装到手机",
      body: instructions,
      actions: [{ label: "知道了", className: "button button-primary" }],
    });
  }

  function showView(name) {
    currentView = name;
    for (const [key, view] of Object.entries(views)) {
      view.hidden = key !== name;
    }
    $("#homeHeader").hidden = name !== "home";
    if (name === "home") renderHome();
    if (name === "wrong") renderWrongBook();
    if (name === "data") renderData();
    window.scrollTo(0, 0);
  }

  function showToast(message, type) {
    const root = $("#toastRoot");
    const toast = document.createElement("div");
    toast.className = `toast ${type === "error" ? "error" : ""}`;
    toast.textContent = message;
    root.appendChild(toast);
    window.setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(6px)";
      toast.style.transition = "opacity .2s ease, transform .2s ease";
      window.setTimeout(() => toast.remove(), 220);
    }, 2600);
  }

  function showModal(options) {
    const root = $("#modalRoot");
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    const title = document.createElement("h3");
    title.textContent = options.title || "";
    const body = document.createElement("div");
    body.className = "modal-body";
    if (typeof options.body === "string") {
      body.innerHTML = options.body;
    } else if (options.body) {
      body.appendChild(options.body);
    }
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (options.onClose) options.onClose();
    }
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    }
    for (const action of options.actions || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.className || "button button-secondary";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        if (action.onClick) action.onClick();
        if (action.close !== false) close();
      });
      actions.appendChild(button);
    }
    card.append(title, body, actions);
    overlay.appendChild(card);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    root.appendChild(overlay);
    return { close };
  }

  function confirmDialog(title, message, confirmLabel, danger) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const modal = showModal({
        title,
        body: `<p>${escapeHtml(message)}</p>`,
        onClose: () => finish(false),
        actions: [
          {
            label: "取消",
            className: "button button-ghost",
            onClick: () => finish(false),
          },
          {
            label: confirmLabel || "确定",
            className: danger ? "button button-danger" : "button button-primary",
            onClick: () => finish(true),
          },
        ],
      });
      return modal;
    });
  }

  function alertDialog(title, message) {
    showModal({
      title,
      body: `<p>${escapeHtml(message)}</p>`,
      actions: [{ label: "知道了", className: "button button-primary" }],
    });
  }

  function getQuestions(session) {
    return core.getPaperQuestions(session.paper, bank);
  }

  function getAnsweredCount(questions, answers) {
    return questions.filter((question) =>
      core.isAnswered(question, answers?.[question.id])
    ).length;
  }

  function updateWrongBadge() {
    const count = Object.keys(state.wrongBook || {}).length;
    $("#wrongBadge").textContent = String(count);
  }

  function renderHome() {
    const counts = core.countBank(bank);
    $("#statTotal").textContent = String(bank.total || 0);
    $("#statPapers").textContent = String(state.history.length);
    const last = state.history[0];
    $("#statLastScore").textContent = last
      ? `最近一次 ${last.score}/${last.total}`
      : "还没有完成记录";
    const generated = bank.generatedAt
      ? `题库 ${bank.total} 题 · ${formatDateTime(bank.generatedAt)}`
      : `题库 ${bank.total} 题`;
    $("#bankVersion").textContent = generated;
    updateWrongBadge();
    renderResumePanel();
    renderModeCards();
    renderBlueprint();
    renderTrainingPanel();
    renderHistory();
    renderLastResultPanel();
  }

  function renderResumePanel() {
    const panel = $("#resumePanel");
    const session = state.activePaper;
    if (!session) {
      panel.hidden = true;
      return;
    }
    const questions = getQuestions(session);
    if (!questions.length) {
      panel.hidden = true;
      return;
    }
    const isStudy = session.paper.mode === "study";
    const count = isStudy
      ? questions.filter((question) => session.revealed?.[question.id]).length
      : getAnsweredCount(questions, session.answers);
    const prefix =
      session.paper.kind === "special" || isStudy
        ? modeLabel(session.paper.mode)
        : `第 ${session.paper.seq} 套`;
    $("#resumeSummary").textContent = `${prefix} · ${
      isStudy ? "已看" : "已答"
    } ${count} / ${questions.length} · 用时 ${formatDuration(
      session.elapsedSec
    )}`;
    panel.hidden = false;
  }

  function renderModeCards() {
    $$(".mode-card").forEach((card) => {
      const selected = card.dataset.mode === state.settings.mode;
      card.classList.toggle("selected", selected);
      card.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function ensureTrainingCategoryOptions() {
    const select = $("#trainingCategory");
    if (select.options.length > 1) return;
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "全部分类";
    select.appendChild(all);
    for (const category of core.CATEGORY_ORDER) {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      select.appendChild(option);
    }
  }

  function trainingPool() {
    const types = new Set(state.training.types || []);
    const category = state.training.category || "all";
    return bank.questions.filter(
      (question) =>
        types.has(question.type) &&
        (category === "all" || question.category === category)
    );
  }

  function trainingTypeCount(type) {
    const category = state.training.category || "all";
    return bank.questions.filter(
      (question) =>
        question.type === type &&
        (category === "all" || question.category === category)
    ).length;
  }

  function allocateTrainingCounts(groups, total) {
    const entries = groups
      .map((group) => ({ group, size: group.items.length }))
      .filter((entry) => entry.size > 0);
    const available = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total >= available) {
      return entries.map((entry) => ({ group: entry.group, count: entry.size }));
    }
    const allocations = new Map(entries.map((entry) => [entry.group, 0]));
    let remaining = total;
    if (total >= entries.length) {
      for (const entry of entries) {
        allocations.set(entry.group, 1);
        remaining -= 1;
      }
    }
    const capacities = entries
      .map((entry) => ({
        group: entry.group,
        capacity: entry.size - (allocations.get(entry.group) || 0),
        count: 0,
        remainder: 0,
      }))
      .filter((entry) => entry.capacity > 0);
    const capacityTotal = capacities.reduce((sum, item) => sum + item.capacity, 0);
    if (remaining > 0 && capacityTotal > 0) {
      for (const item of capacities) {
        const exact = (remaining * item.capacity) / capacityTotal;
        item.count = Math.floor(exact);
        item.remainder = exact - item.count;
      }
      let assigned = capacities.reduce((sum, item) => sum + item.count, 0);
      while (assigned < remaining) {
        const candidates = capacities.filter((item) => item.count < item.capacity);
        candidates.sort((a, b) => b.remainder - a.remainder);
        if (!candidates.length) break;
        candidates[0].count += 1;
        candidates[0].remainder = 0;
        assigned += 1;
      }
      for (const item of capacities) {
        allocations.set(item.group, (allocations.get(item.group) || 0) + item.count);
      }
    }
    return entries.map((entry) => ({
      group: entry.group,
      count: allocations.get(entry.group) || 0,
    }));
  }

  function selectTrainingQuestions(pool, limit, nextRunSeq) {
    if (state.training.order === "sequential") {
      const categoryIndex = new Map(
        core.CATEGORY_ORDER.map((category, index) => [category, index])
      );
      const typeIndex = new Map(
        core.TYPE_ORDER.map((type, index) => [type, index])
      );
      const ordered = pool.slice().sort((a, b) => {
        const categoryDiff =
          (categoryIndex.get(a.category) || 0) -
          (categoryIndex.get(b.category) || 0);
        if (categoryDiff) return categoryDiff;
        const typeDiff = (typeIndex.get(a.type) || 0) - (typeIndex.get(b.type) || 0);
        if (typeDiff) return typeDiff;
        const sourceDiff = String(a.source?.file || "").localeCompare(
          String(b.source?.file || ""),
          "zh-CN"
        );
        if (sourceDiff) return sourceDiff;
        return (Number(a.number) || 0) - (Number(b.number) || 0);
      });
      const offset = ordered.length ? nextRunSeq % ordered.length : 0;
      return ordered
        .slice(offset)
        .concat(ordered.slice(0, offset))
        .slice(0, limit);
    }

    if (limit >= pool.length) return core.shuffle(pool, Math.random);
    const groups = new Map();
    for (const question of pool) {
      const key = `${question.category}|${question.type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(question);
    }
    const groupList = Array.from(groups.entries()).map(([key, items]) => ({
      key,
      items,
    }));
    const allocations = allocateTrainingCounts(groupList, limit);
    const selected = [];
    for (const allocation of allocations) {
      const items = allocation.group.items.slice().sort((a, b) => {
        const lastDiff =
          (state.questionStats[a.id]?.lastSeen || 0) -
          (state.questionStats[b.id]?.lastSeen || 0);
        if (lastDiff) return lastDiff;
        return Math.random() - 0.5;
      });
      selected.push(...items.slice(0, allocation.count));
    }
    return core.shuffle(selected, Math.random);
  }

  function renderTrainingPanel() {
    ensureTrainingCategoryOptions();
    $("#trainingCategory").value = state.training.category;
    $("#trainingCount").value = state.training.count;
    $("#trainingOrder").value = state.training.order;
    $("#trainingTypes").innerHTML = core.TYPE_ORDER.map((type) => {
      const selected = state.training.types.includes(type);
      return `<button class="type-toggle ${selected ? "selected" : ""}" type="button"
        data-training-type="${type}" aria-pressed="${selected ? "true" : "false"}">
        ${core.TYPE_LABELS[type]}
        <span class="type-count">${trainingTypeCount(type)}</span>
      </button>`;
    }).join("");
    $("#trainingTypes")
      .querySelectorAll("[data-training-type]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const type = button.dataset.trainingType;
          const selected = new Set(state.training.types);
          if (selected.has(type)) selected.delete(type);
          else selected.add(type);
          state.training.types = core.TYPE_ORDER.filter((item) =>
            selected.has(item)
          );
          saveState({ silent: true });
          renderTrainingPanel();
        });
      });
    updateTrainingPool();
  }

  function updateTrainingPool() {
    const pool = trainingPool();
    const requested =
      state.training.count === "all"
        ? pool.length
        : Number(state.training.count) || 0;
    const effective = Math.min(requested, pool.length);
    $("#trainingPoolCount").textContent = `可选 ${pool.length} 题`;
    let hint = "";
    if (!state.training.types.length) {
      hint = "请至少选择一种题型。";
    } else if (!pool.length) {
      hint = "当前筛选没有可用题目。";
    } else if (requested > pool.length) {
      hint = `当前筛选只有 ${pool.length} 题，将全部抽取。`;
    } else {
      hint = `将抽取 ${effective} 题。`;
    }
    $("#trainingHint").textContent = hint;
    const disabled = !pool.length;
    $("#startSpecialButton").disabled = disabled;
    $("#startStudyButton").disabled = disabled;
  }

  async function buildTrainingSession(mode) {
    const pool = trainingPool();
    if (!pool.length) {
      showToast("当前筛选没有可用题目。", "error");
      return;
    }
    if (state.activePaper) {
      const ok = await confirmDialog(
        "开始专项训练？",
        "当前还有未完成的任务，开始专项训练会放弃当前进度。",
        "放弃并开始",
        true
      );
      if (!ok) return;
      stopTimer(false);
      state.activePaper = null;
      activeSession = null;
    }
    const requested =
      state.training.count === "all"
        ? pool.length
        : Number(state.training.count) || 0;
    const limit = Math.min(requested, pool.length);
    const nextRunSeq = state.runSeq + 1;
    const selected = selectTrainingQuestions(pool, limit, nextRunSeq);
    if (!selected.length) {
      showToast("没有抽到题目，请调整筛选条件。", "error");
      return;
    }
    const categoryTotals = Object.fromEntries(
      core.CATEGORY_ORDER.map((category) => [category, 0])
    );
    const typeTotals = Object.fromEntries(
      core.TYPE_ORDER.map((type) => [type, 0])
    );
    for (const question of selected) {
      categoryTotals[question.category] += 1;
      typeTotals[question.type] += 1;
    }
    const kind = mode === "study" ? "study" : "special";
    const paper = {
      id: `${kind === "study" ? "S" : "T"}-${Date.now().toString(36)}-${Math.floor(
        Math.random() * 0xffffff
      ).toString(36)}`,
      kind,
      seq: null,
      runSeq: nextRunSeq,
      mode,
      createdAt: new Date().toISOString(),
      questionIds: selected.map((question) => question.id),
      categoryTotals,
      typeTotals,
      training: {
        types: state.training.types.slice(),
        category: state.training.category,
        count: state.training.count,
        order: state.training.order,
      },
    };
    state.runSeq = nextRunSeq;
    state.questionStats = core.recordPaperStats(state.questionStats, paper);
    state.activePaper = {
      paper,
      answers: {},
      flags: {},
      checked: {},
      revealed: {},
      currentIndex: 0,
      elapsedSec: 0,
      startedAt: new Date().toISOString(),
    };
    saveState();
    startPaperSession();
  }

  function startSpecialSession(trainingSnapshot) {
    if (trainingSnapshot) {
      state.training = {
        ...state.training,
        ...trainingSnapshot,
        types: (trainingSnapshot.types || state.training.types).filter((type) =>
          core.TYPE_ORDER.includes(type)
        ),
      };
    }
    buildTrainingSession("special");
  }

  function startStudySession() {
    buildTrainingSession("study");
  }

  function renderBlueprint() {
    const nextSeq = state.paperSeq + 1;
    const blueprint = core.getBlueprint(nextSeq);
    const matrix = blueprint.matrix;
    const categoryTotals = core.blueprintCategoryTotals(matrix);
    const typeTotals = core.blueprintTypeTotals(matrix);
    $("#templateLabel").textContent = `模板 ${blueprint.key}`;
    const body = $("#blueprintBody");
    body.innerHTML = core.CATEGORY_ORDER.map((category) => {
      const row = matrix[category];
      return `<tr>
        <td>${escapeHtml(category)}</td>
        <td>${categoryTotals[category]}</td>
        <td>${row.fill}</td>
        <td>${row.single}</td>
        <td>${row.judge}</td>
      </tr>`;
    }).join("");
    const table = body.closest("table");
    let foot = table.querySelector("tfoot");
    if (!foot) {
      foot = document.createElement("tfoot");
      table.appendChild(foot);
    }
    foot.innerHTML = `<tr>
      <td>合计</td>
      <td>150</td>
      <td>${typeTotals.fill}</td>
      <td>${typeTotals.single}</td>
      <td>${typeTotals.judge}</td>
    </tr>`;
    const safety = categoryTotals["安全基础"];
    const accident = categoryTotals["事故处置"];
    $("#roundingNote").textContent =
      `5% 对应 7.5 题，无法同时取整。本套安全基础 ${safety} 题、事故处置 ${accident} 题，` +
      `下一套自动交换 8/7，长期平均正好 5% / 5%。`;
    renderHeroBars(categoryTotals);
  }

  function renderHeroBars(categoryTotals) {
    const rows = [
      ["常见事故预防", 75],
      ["专业劳动安全", 30],
      ["劳防用品与职业健康", 15],
    ];
    $("#heroBars").innerHTML = rows
      .map(([category, scale]) => {
        const count = categoryTotals[category] || 0;
        const width = Math.max(7, Math.min(100, (count / scale) * 100));
        return `<div class="hero-bar-row">
          <span>${escapeHtml(category)}</span>
          <span class="hero-bar-track"><span class="hero-bar-fill" style="width:${width}%"></span></span>
          <span>${count}</span>
        </div>`;
      })
      .join("");
  }

  function renderHistory() {
    const list = $("#historyList");
    if (!state.history.length) {
      list.innerHTML = `<div class="empty-state">
        <div><strong>还没有完成记录</strong>开始一套 150 题或专项练习，成绩会保存在这里。</div>
      </div>`;
      return;
    }
    list.innerHTML = state.history
      .slice(0, 6)
      .map((item) => {
        const isSpecial = item.kind === "special";
        const title = isSpecial
          ? "专项练习"
          : `第 ${item.seq} 套 · ${modeLabel(item.mode)}`;
        return `<div class="history-row">
          <div class="history-seq">${isSpecial ? "专" : item.seq}</div>
          <div class="history-main">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(formatDateTime(item.submittedAt))}</span>
          </div>
          <div class="history-score">${item.score}<span> / ${item.total}</span></div>
          <div class="history-rate">${formatPercent(item.percent)}</div>
        </div>`;
      })
      .join("");
  }

  function renderLastResultPanel() {
    const panel = $("#lastResultPanel");
    if (!state.lastSession) {
      panel.hidden = true;
      return;
    }
    const completed = state.history[0];
    if (!completed) {
      panel.hidden = true;
      return;
    }
    const prefix =
      completed.kind === "special"
        ? "专项练习"
        : `第 ${completed.seq} 套 · ${modeLabel(completed.mode)}`;
    $("#lastResultSummary").textContent = `${prefix} · ${completed.score}/${
      completed.total
    } · 正确率 ${formatPercent(
      completed.percent
    )} · 用时 ${formatDuration(completed.durationSec)}`;
    panel.hidden = false;
  }

  function startTimer() {
    clearInterval(timerInterval);
    timerBase = activeSession?.elapsedSec || 0;
    timerStartedAt = Date.now();
    updateTimerDisplay(timerBase);
    timerInterval = setInterval(() => {
      if (!activeSession) return;
      const elapsed = timerBase + Math.floor((Date.now() - timerStartedAt) / 1000);
      updateTimerDisplay(elapsed);
      if (elapsed > 0 && elapsed % 5 === 0) {
        activeSession.elapsedSec = elapsed;
        saveState({ silent: true });
      }
    }, 1000);
  }

  function getElapsedSeconds() {
    if (!activeSession) return timerBase;
    return timerBase + Math.floor((Date.now() - timerStartedAt) / 1000);
  }

  function stopTimer(save) {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (save && activeSession) {
      activeSession.elapsedSec = getElapsedSeconds();
      saveState({ silent: true });
    }
  }

  function updateTimerDisplay(seconds) {
    $("#paperTimer").textContent = formatDuration(seconds);
  }

  function ensureSessionQuestions() {
    if (!activeSession) return [];
    const questions = getQuestions(activeSession);
    if (questions.length !== activeSession.paper.questionIds.length) {
      alertDialog("试卷数据不完整", "题库文件可能已更新，当前未完成试卷无法继续。");
      state.activePaper = null;
      activeSession = null;
      saveState();
      showView("home");
      return [];
    }
    return questions;
  }

  function startPaperSession() {
    activeSession = state.activePaper;
    const questions = ensureSessionQuestions();
    if (!questions.length) return;
    renderPaper();
    showView("paper");
    startTimer();
  }

  async function startNewPaper() {
    if (state.activePaper) {
      const ok = await confirmDialog(
        "开始新一套？",
        "当前还有一套未完成试卷，开始新一套会放弃当前进度。",
        "放弃并开始",
        true
      );
      if (!ok) return;
      stopTimer(false);
      state.activePaper = null;
      activeSession = null;
    }
    const mode = state.settings.mode;
    const paperSeq = state.paperSeq + 1;
    const paper = core.buildPaper(bank, {
      paperSeq,
      mode,
      stats: state.questionStats,
      rng: Math.random,
    });
    if (paper.error) {
      const details = (paper.shortages || [])
        .map(
          (item) =>
            `${item.category}/${core.TYPE_LABELS[item.type]}：需要 ${item.required}，可用 ${item.available}`
        )
        .join("；");
      alertDialog("无法生成试卷", `${paper.error}${details ? ` ${details}` : ""}`);
      return;
    }
    state.paperSeq = paperSeq;
    state.runSeq += 1;
    paper.runSeq = state.runSeq;
    state.questionStats = core.recordPaperStats(state.questionStats, paper);
    state.activePaper = {
      paper,
      answers: {},
      flags: {},
      checked: {},
      revealed: {},
      currentIndex: 0,
      elapsedSec: 0,
      startedAt: new Date().toISOString(),
    };
    saveState();
    startPaperSession();
  }

  function resumePaper() {
    if (!state.activePaper) {
      showToast("没有可继续的试卷。", "error");
      return;
    }
    startPaperSession();
  }

  async function discardActivePaper() {
    const ok = await confirmDialog(
      "放弃本套？",
      "当前未完成试卷会被清除，已经记录到抽题历史中的题目不会回退。",
      "放弃",
      true
    );
    if (!ok) return;
    stopTimer(false);
    state.activePaper = null;
    activeSession = null;
    saveState();
    renderHome();
  }

  function pausePaper() {
    stopTimer(true);
    activeSession = null;
    showView("home");
  }

  function renderPaper() {
    if (!activeSession) return;
    const paper = activeSession.paper;
    const modeBadge = $("#paperModeBadge");
    modeBadge.textContent = modeLabel(paper.mode);
    modeBadge.classList.toggle("practice", isPracticeMode(paper));
    modeBadge.classList.toggle("study", paper.mode === "study");
    const total = paper.questionIds.length;
    if (paper.mode === "study") {
      $("#paperSeqLabel").textContent = `专项背题 · ${total} 题`;
    } else if (paper.kind === "special") {
      $("#paperSeqLabel").textContent = `共 ${total} 题`;
    } else {
      $("#paperSeqLabel").textContent = `第 ${paper.seq} 套 · 模板 ${paper.template}`;
    }
    $("#submitPaperButton").textContent =
      paper.mode === "study" ? "结束背题" : "交卷";
    $("#paperTimer").hidden = paper.mode === "study";
    $("#sheetLegend").innerHTML =
      paper.mode === "study"
        ? `<span><i class="legend-dot answered"></i>已看</span>
           <span><i class="legend-dot current"></i>当前</span>`
        : `<span><i class="legend-dot answered"></i>已答</span>
           <span><i class="legend-dot current"></i>当前</span>
           <span><i class="legend-dot flagged"></i>标记</span>`;
    updatePaperProgress();
    renderQuestion();
    renderAnswerSheet();
  }

  function updatePaperProgress() {
    if (!activeSession) return;
    const questions = getQuestions(activeSession);
    const count =
      activeSession.paper.mode === "study"
        ? questions.filter((question) => activeSession.revealed?.[question.id])
            .length
        : getAnsweredCount(questions, activeSession.answers);
    const percent = questions.length ? (count / questions.length) * 100 : 0;
    $("#paperProgressBar").style.width = `${percent}%`;
    $("#paperProgressText").textContent = `${count} / ${questions.length}`;
    updateSheetState(questions);
  }

  function renderQuestion() {
    if (!activeSession) return;
    const questions = getQuestions(activeSession);
    const index = Math.max(
      0,
      Math.min(activeSession.currentIndex, questions.length - 1)
    );
    activeSession.currentIndex = index;
    const question = questions[index];
    const answer = activeSession.answers[question.id];
    if (activeSession.paper.mode === "study") {
      renderStudyQuestion(question, index, questions);
      return;
    }
    const card = $("#questionCard");
    card.innerHTML = `
      <div class="question-head">
        <div class="question-index">第 <strong>${index + 1}</strong> 题 <span>/ ${
          questions.length
        }</span></div>
        ${categoryChip(question.category)}
        ${typeChip(question.type)}
        <span class="chip chip-topic">${escapeHtml(question.topic)}</span>
      </div>
      <div class="question-stem" id="stemArea"></div>
      <div class="answer-area" id="answerArea"></div>
      <div class="feedback" id="feedbackArea" hidden></div>
    `;
    const stemArea = $("#stemArea");
    if (question.type === "fill") {
      renderFillStem(stemArea, question, answer);
    } else {
      stemArea.textContent = question.stem;
    }
    renderAnswerArea(question, answer);
    renderFeedback(question, answer);
    renderQuestionFooter(question);
  }

  function renderStudyQuestion(question, index, questions) {
    const revealed = Boolean(activeSession.revealed?.[question.id]);
    const card = $("#questionCard");
    let answerPreview = "";
    if (question.type === "fill") {
      answerPreview = `<div class="fill-hint">先回忆每个空的内容，再点“显示答案”核对。</div>`;
    } else if (question.type === "single") {
      answerPreview = `<div class="options">${question.options
        .map((option, optionIndex) => {
          const letter = ["A", "B", "C", "D"][optionIndex];
          const correct = revealed && letter === question.answer;
          return `<div class="option-button study-option ${
            correct ? "correct" : ""
          }">
            <span class="option-letter">${letter}</span>
            <span class="option-text">${escapeHtml(option)}</span>
          </div>`;
        })
        .join("")}</div>`;
    } else {
      answerPreview = `<div class="judge-options">
        <div class="judge-button study-option ${
          revealed && question.answer === "√" ? "correct" : ""
        }"><span class="judge-symbol">√</span><span>正确</span></div>
        <div class="judge-button study-option ${
          revealed && question.answer === "×" ? "correct" : ""
        }"><span class="judge-symbol">×</span><span>错误</span></div>
      </div>`;
    }
    card.innerHTML = `
      <div class="question-head">
        <div class="question-index">第 <strong>${index + 1}</strong> 题 <span>/ ${
          questions.length
        }</span></div>
        ${categoryChip(question.category)}
        ${typeChip(question.type)}
        <span class="chip chip-topic">${escapeHtml(question.topic)}</span>
      </div>
      <div class="question-stem">${escapeHtml(question.stem)}</div>
      <div class="answer-area">${answerPreview}</div>
      <div class="study-answer ${revealed ? "revealed" : ""}">
        <div class="study-answer-head">
          <strong>${revealed ? "答案与解析" : "先回忆，再核对"}</strong>
          <button class="button ${
            revealed ? "button-ghost" : "button-primary"
          } button-compact" type="button" data-study-action="toggle">
            ${revealed ? "收起答案" : "显示答案"}
          </button>
        </div>
        ${
          revealed
            ? `<div class="study-answer-content">
              <div class="study-answer-text">${escapeHtml(
                core.formatExpected(question)
              )}</div>
              ${
                question.explanation
                  ? `<div class="study-answer-explanation">解析：${escapeHtml(
                      question.explanation
                    )}</div>`
                  : ""
              }
            </div>`
            : ""
        }
      </div>
    `;
    card
      .querySelector('[data-study-action="toggle"]')
      ?.addEventListener("click", () => toggleReveal(question));
    renderQuestionFooter(question);
  }

  function toggleReveal(question) {
    activeSession.revealed[question.id] = !activeSession.revealed[question.id];
    saveState({ silent: true });
    renderQuestion();
    updatePaperProgress();
  }

  function renderFillStem(container, question, answer) {
    const values = Array.isArray(answer) ? answer : [];
    const fragment = document.createDocumentFragment();
    for (const segment of question.segments || []) {
      if (segment.kind === "text") {
        fragment.appendChild(document.createTextNode(segment.text || ""));
      } else if (segment.kind === "blank") {
        fragment.appendChild(
          createBlankWrap([segment.part], values[segment.part] || "")
        );
      } else if (segment.kind === "range") {
        fragment.appendChild(
          createRangeWrap(segment.parts, values)
        );
      }
    }
    container.appendChild(fragment);
    const inputs = Array.from(container.querySelectorAll(".blank-input"));
    for (const input of inputs) {
      input.addEventListener("input", () => {
        const nextValues = [];
        container.querySelectorAll(".blank-input").forEach((item) => {
          nextValues[Number(item.dataset.part)] = item.value;
        });
        activeSession.answers[question.id] = nextValues;
        activeSession.checked[question.id] = false;
        clearQuestionFeedback();
        updatePaperProgress();
        scheduleSave();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const currentIndex = inputs.indexOf(input);
        if (currentIndex >= 0 && currentIndex < inputs.length - 1) {
          inputs[currentIndex + 1].focus();
        } else {
          goToQuestion(activeSession.currentIndex + 1);
        }
      });
    }
    if (inputs.length && window.innerWidth >= 980) {
      const firstEmpty =
        inputs.find((input) => !String(input.value || "").trim()) || inputs[0];
      window.setTimeout(() => firstEmpty.focus({ preventScroll: true }), 30);
    }
  }

  function createBlankWrap(parts, value) {
    const wrap = document.createElement("span");
    wrap.className = "blank-wrap";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "blank-input";
    input.dataset.part = String(parts[0]);
    input.value = value || "";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", `第 ${Number(parts[0]) + 1} 空`);
    input.placeholder = "填写";
    wrap.appendChild(input);
    return wrap;
  }

  function createRangeWrap(parts, values) {
    const wrap = document.createElement("span");
    wrap.className = "range-wrap";
    wrap.appendChild(createBlankWrap([parts[0]], values[parts[0]] || ""));
    const separator = document.createElement("span");
    separator.className = "range-sep";
    separator.textContent = "～";
    wrap.appendChild(separator);
    wrap.appendChild(createBlankWrap([parts[1]], values[parts[1]] || ""));
    return wrap;
  }

  function renderAnswerArea(question, answer) {
    const area = $("#answerArea");
    if (!area) return;
    if (question.type === "fill") {
      const count = question.answerParts?.length || 0;
      area.innerHTML = `<div class="fill-hint">本题共 ${count} 空，请在题干空格中填写；填完后点击下方“检查”。</div>`;
      return;
    }
    if (question.type === "single") {
      area.innerHTML = `<div class="options">${question.options
        .map(
          (option, index) => `<button class="option-button ${
            answer === ["A", "B", "C", "D"][index] ? "selected" : ""
          }" type="button" data-option="${["A", "B", "C", "D"][index]}">
            <span class="option-letter">${["A", "B", "C", "D"][index]}</span>
            <span class="option-text">${escapeHtml(option)}</span>
          </button>`
        )
        .join("")}</div>`;
      area.querySelectorAll(".option-button").forEach((button) => {
        button.addEventListener("click", () => {
          setSimpleAnswer(question, button.dataset.option);
        });
      });
      return;
    }
    area.innerHTML = `<div class="judge-options">
      <button class="judge-button ${answer === "√" ? "selected" : ""}" type="button" data-judge="√">
        <span class="judge-symbol">√</span><span>正确</span>
      </button>
      <button class="judge-button ${answer === "×" ? "selected" : ""}" type="button" data-judge="×">
        <span class="judge-symbol">×</span><span>错误</span>
      </button>
    </div>`;
    area.querySelectorAll(".judge-button").forEach((button) => {
      button.addEventListener("click", () => {
        setSimpleAnswer(question, button.dataset.judge);
      });
    });
  }

  function setSimpleAnswer(question, value) {
    activeSession.answers[question.id] = value;
    activeSession.checked[question.id] = false;
    saveState({ silent: true });
    renderQuestion();
    updatePaperProgress();
  }

  function renderFeedback(question, answer) {
    const area = $("#feedbackArea");
    if (!area || !activeSession) return;
    if (
      !isPracticeMode(activeSession.paper) ||
      !activeSession.checked[question.id]
    ) {
      area.hidden = true;
      return;
    }
    const score = core.scoreQuestion(question, answer);
    area.hidden = false;
    area.className = `feedback ${score.correct ? "correct" : "wrong"}`;
    let detail = "";
    if (question.type === "fill" && score.partResults?.length) {
      detail = `<div class="feedback-body">
        ${score.partResults
          .map(
            (part, index) =>
              `<div>第 ${index + 1} 空：你的答案 <strong>${escapeHtml(
                part.user || "（空）"
              )}</strong> · 正确答案 <strong>${escapeHtml(part.expected)}</strong> · ${
                part.correct ? "正确" : "错误"
              }</div>`
          )
          .join("")}
      </div>`;
    } else {
      detail = `<div class="feedback-body">
        <div>你的答案：<strong>${escapeHtml(
          core.formatUserAnswer(question, answer)
        )}</strong></div>
        <div>正确答案：<strong>${escapeHtml(
          core.formatExpected(question)
        )}</strong></div>
      </div>`;
    }
    area.innerHTML = `<div class="feedback-head">${
      score.correct ? "回答正确" : "回答错误"
    }</div>${detail}${
      question.explanation
        ? `<div class="feedback-explanation">解析：${escapeHtml(
            question.explanation
          )}</div>`
        : ""
    }`;

    if (question.type === "fill") {
      const inputs = $$("#stemArea .blank-input");
      inputs.forEach((input) => {
        const index = Number(input.dataset.part);
        const result = score.partResults?.[index];
        if (!result) return;
        input.classList.toggle("correct", result.correct);
        input.classList.toggle("wrong", !result.correct);
      });
    }
  }

  function clearQuestionFeedback() {
    const area = $("#feedbackArea");
    if (area) {
      area.hidden = true;
      area.className = "feedback";
    }
    $$("#stemArea .blank-input").forEach((input) => {
      input.classList.remove("correct", "wrong");
    });
  }

  function renderQuestionFooter(question) {
    const footer = $("#questionFooter");
    const index = activeSession.currentIndex;
    const total = activeSession.paper.questionIds.length;
    const isLast = index >= total - 1;
    if (activeSession.paper.mode === "study") {
      const revealed = Boolean(activeSession.revealed[question.id]);
      footer.innerHTML = `
        <button class="button button-secondary" type="button" data-footer-action="prev" ${
          index === 0 ? "disabled" : ""
        }>上一题</button>
        <button class="button ${
          revealed ? "button-ghost" : "button-primary"
        }" type="button" data-footer-action="reveal">${
        revealed ? "收起答案" : "显示答案"
      }</button>
        <span class="spacer"></span>
        ${
          isLast
            ? `<button class="button button-secondary" type="button" data-footer-action="end-study">结束背题</button>`
            : `<button class="button button-primary" type="button" data-footer-action="next">下一题 →</button>`
        }
      `;
      footer
        .querySelector('[data-footer-action="prev"]')
        ?.addEventListener("click", () => goToQuestion(index - 1));
      footer
        .querySelector('[data-footer-action="reveal"]')
        ?.addEventListener("click", () => toggleReveal(question));
      footer
        .querySelector('[data-footer-action="next"]')
        ?.addEventListener("click", () => goToQuestion(index + 1));
      footer
        .querySelector('[data-footer-action="end-study"]')
        ?.addEventListener("click", askSubmit);
      return;
    }
    const flagged = Boolean(activeSession.flags[question.id]);
    const checked = Boolean(activeSession.checked[question.id]);
    footer.innerHTML = `
      <button class="button button-secondary" type="button" data-footer-action="prev" ${
        index === 0 ? "disabled" : ""
      }>上一题</button>
      <button class="button button-ghost flag-button ${
        flagged ? "active" : ""
      }" type="button" data-footer-action="flag">${
      flagged ? "已标记" : "标记"
    }</button>
      <button class="button button-ghost" type="button" data-footer-action="clear">清空</button>
      <span class="spacer"></span>
      ${
        isPracticeMode(activeSession.paper)
          ? `<button class="button button-secondary" type="button" data-footer-action="check">${
              checked ? "再检查" : "检查"
            }</button>`
          : ""
      }
      ${
        isLast
          ? `<button class="button button-primary" type="button" data-footer-action="submit">${
              activeSession.paper.kind === "special" ? "完成练习" : "交卷"
            }</button>`
          : `<button class="button button-primary" type="button" data-footer-action="next">下一题 →</button>`
      }
    `;
    footer
      .querySelector('[data-footer-action="prev"]')
      ?.addEventListener("click", () => goToQuestion(index - 1));
    footer
      .querySelector('[data-footer-action="flag"]')
      ?.addEventListener("click", () => toggleFlag(question));
    footer
      .querySelector('[data-footer-action="clear"]')
      ?.addEventListener("click", () => clearAnswer(question));
    footer
      .querySelector('[data-footer-action="check"]')
      ?.addEventListener("click", checkCurrent);
    footer
      .querySelector('[data-footer-action="next"]')
      ?.addEventListener("click", () => goToQuestion(index + 1));
    footer
      .querySelector('[data-footer-action="submit"]')
      ?.addEventListener("click", askSubmit);
  }

  function goToQuestion(index) {
    if (!activeSession) return;
    const questions = getQuestions(activeSession);
    const next = Math.max(0, Math.min(index, questions.length - 1));
    activeSession.currentIndex = next;
    saveState({ silent: true });
    renderQuestion();
    renderAnswerSheet();
    closeSheet();
    if (window.innerWidth < 980) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function toggleFlag(question) {
    activeSession.flags[question.id] = !activeSession.flags[question.id];
    saveState({ silent: true });
    renderQuestion();
    updatePaperProgress();
  }

  function clearAnswer(question) {
    delete activeSession.answers[question.id];
    delete activeSession.checked[question.id];
    saveState({ silent: true });
    renderQuestion();
    updatePaperProgress();
  }

  function checkCurrent() {
    if (!activeSession || !isPracticeMode(activeSession.paper)) return;
    const question = getQuestions(activeSession)[activeSession.currentIndex];
    if (!question) return;
    if (!core.isAnswered(question, activeSession.answers[question.id])) {
      showToast("请先填写或选择答案，再进行检查。", "error");
      return;
    }
    activeSession.checked[question.id] = true;
    saveState({ silent: true });
    renderQuestion();
    updatePaperProgress();
  }

  function getSheetGroups(questions) {
    return core.TYPE_ORDER.map((type) => {
      const items = [];
      questions.forEach((question, index) => {
        if (question.type === type) items.push({ question, index });
      });
      return { type, items };
    }).filter((group) => group.items.length);
  }

  function isSheetDone(question) {
    if (activeSession.paper.mode === "study") {
      return Boolean(activeSession.revealed?.[question.id]);
    }
    return core.isAnswered(question, activeSession.answers[question.id]);
  }

  function sheetGroupLabel(group) {
    if (activeSession.paper.kind === "exam") {
      return `${core.TYPE_LABELS[group.type]} · ${group.items[0].index + 1}-${
        group.items[group.items.length - 1].index + 1
      }`;
    }
    return `${core.TYPE_LABELS[group.type]} · 共 ${group.items.length} 题`;
  }

  function renderAnswerSheet() {
    if (!activeSession) return;
    const questions = getQuestions(activeSession);
    const sheet = $("#answerSheet");
    const groups = getSheetGroups(questions);
    sheet.innerHTML = groups
      .map((group) => {
        const items = group.items.map(({ question, index }) => {
          const answered = isSheetDone(question);
          const current = index === activeSession.currentIndex;
          const flagged = Boolean(activeSession.flags[question.id]);
          const score =
            activeSession.checked[question.id] &&
            isPracticeMode(activeSession.paper)
              ? core.scoreQuestion(question, activeSession.answers[question.id])
              : null;
          return `<button class="sheet-number ${answered ? "answered" : ""} ${
            current ? "current" : ""
          } ${flagged ? "flagged" : ""} ${
            score ? (score.correct ? "correct" : "wrong") : ""
          }" type="button" data-index="${index}">${index + 1}</button>`;
        });
        const doneCount = group.items.filter(({ question }) =>
          isSheetDone(question)
        ).length;
        return `<div class="sheet-group">
          <div class="sheet-group-head">
            <span>${sheetGroupLabel(group)}</span>
            <span data-sheet-count="${group.type}">${doneCount} / ${
          group.items.length
        }</span>
          </div>
          <div class="sheet-grid">${items.join("")}</div>
        </div>`;
      })
      .join("");
    sheet.querySelectorAll(".sheet-number").forEach((button) => {
      button.addEventListener("click", () => {
        goToQuestion(Number(button.dataset.index));
      });
    });
  }

  function updateSheetState(questions) {
    const sheet = $("#answerSheet");
    if (!sheet) return;
    sheet.querySelectorAll(".sheet-number").forEach((button) => {
      const index = Number(button.dataset.index);
      const question = questions[index];
      if (!question) return;
      const answered = isSheetDone(question);
      const current = index === activeSession.currentIndex;
      const flagged = Boolean(activeSession.flags[question.id]);
      const score =
        activeSession.checked[question.id] &&
        isPracticeMode(activeSession.paper)
          ? core.scoreQuestion(question, activeSession.answers[question.id])
          : null;
      button.classList.toggle("answered", answered);
      button.classList.toggle("current", current);
      button.classList.toggle("flagged", flagged);
      button.classList.toggle("correct", Boolean(score?.correct));
      button.classList.toggle("wrong", Boolean(score && !score.correct));
    });
    for (const group of getSheetGroups(questions)) {
      const done = group.items.filter(({ question }) => isSheetDone(question)).length;
      const target = sheet.querySelector(`[data-sheet-count="${group.type}"]`);
      if (target) target.textContent = `${done} / ${group.items.length}`;
    }
  }

  function openSheet() {
    $("#answerSheetPanel").classList.add("open");
  }

  function closeSheet() {
    $("#answerSheetPanel").classList.remove("open");
  }

  async function askSubmit() {
    if (!activeSession) return;
    const questions = getQuestions(activeSession);
    if (activeSession.paper.mode === "study") {
      const revealed = questions.filter(
        (question) => activeSession.revealed?.[question.id]
      ).length;
      const ok = await confirmDialog(
        "结束背题？",
        `已看 ${revealed} 题，共 ${questions.length} 题。结束后本次背题进度会被清除。`,
        "结束背题"
      );
      if (!ok) return;
      finishStudy();
      return;
    }
    const answered = getAnsweredCount(questions, activeSession.answers);
    const unanswered = questions.length - answered;
    const message =
      `已答 ${answered} 题，未答 ${unanswered} 题。` +
      (isPracticeMode(activeSession.paper)
        ? activeSession.paper.kind === "special"
          ? "专项练习也会记录本次成绩。"
          : "练习模式也会记录本次成绩。"
        : "交卷后将立即评分并显示错题。");
    const ok = await confirmDialog(
      activeSession.paper.kind === "special" ? "完成专项练习？" : "确认交卷？",
      message,
      activeSession.paper.kind === "special" ? "完成练习" : "确认交卷"
    );
    if (!ok) return;
    finishPaper();
  }

  function finishStudy() {
    if (!activeSession) return;
    stopTimer(false);
    state.activePaper = null;
    activeSession = null;
    saveState();
    showView("home");
    showToast("本次背题已结束。");
  }

  function finishPaper() {
    if (!activeSession) return;
    const durationSec = getElapsedSeconds();
    activeSession.elapsedSec = durationSec;
    stopTimer(false);
    const results = core.computeResults(
      activeSession.paper,
      bank,
      activeSession.answers
    );
    const record = {
      id: activeSession.paper.id,
      seq: activeSession.paper.seq,
      mode: activeSession.paper.mode,
      kind: activeSession.paper.kind || "exam",
      score: results.score,
      total: results.total,
      percent: results.percent,
      durationSec,
      submittedAt: new Date().toISOString(),
      template: activeSession.paper.template,
      training: activeSession.paper.training || null,
    };
    state.history.unshift(record);
    state.history = state.history.slice(0, MAX_HISTORY);
    for (const row of results.wrongRows) {
      if (!row.answered) continue;
      const previous = state.wrongBook[row.question.id] || {
        wrongCount: 0,
      };
      state.wrongBook[row.question.id] = {
        wrongCount: (previous.wrongCount || 0) + 1,
        lastWrongAt: new Date().toISOString(),
        lastPaperId: activeSession.paper.id,
        lastUserAnswer: row.userText,
        wasAnswered: row.answered,
      };
    }
    state.lastSession = {
      paper: activeSession.paper,
      answers: JSON.parse(JSON.stringify(activeSession.answers)),
    };
    state.activePaper = null;
    activeSession = null;
    saveState();
    renderResultView(results);
    showView("result");
    updateWrongBadge();
  }

  function renderResultView(providedResults) {
    const content = $("#resultContent");
    if (!state.lastSession) {
      content.innerHTML = `<div class="empty-state"><div><strong>还没有成绩</strong>完成一套试卷后，这里会显示成绩和错题分析。</div></div>`;
      return;
    }
    const results =
      providedResults ||
      core.computeResults(
        state.lastSession.paper,
        bank,
        state.lastSession.answers
      );
    const record = state.history.find(
      (item) => item.id === state.lastSession.paper.id
    ) || {
      durationSec: 0,
      mode: state.lastSession.paper.mode,
    };
    const paper = state.lastSession.paper;
    const isSpecial = paper.kind === "special";
    const resultTitle = $("#resultView .section-topbar-title");
    if (resultTitle) resultTitle.textContent = isSpecial ? "专项成绩" : "本套成绩";
    const categoryList = isSpecial
      ? core.CATEGORY_ORDER.filter(
          (category) => results.byCategory[category].total > 0
        )
      : core.CATEGORY_ORDER;
    const typeList = isSpecial
      ? core.TYPE_ORDER.filter((type) => results.byType[type].total > 0)
      : core.TYPE_ORDER;
    const categoryRows = categoryList.map((category) => {
      const item = results.byCategory[category];
      return `<tr>
        <td>${escapeHtml(category)}</td>
        <td>${item.total}</td>
        <td>${item.correct}</td>
        <td class="rate-cell">${
          item.total ? formatPercent((item.correct / item.total) * 100) : "—"
        }</td>
      </tr>`;
    }).join("");
    const typeRows = typeList.map((type) => {
      const item = results.byType[type];
      return `<tr>
        <td>${core.TYPE_LABELS[type]}</td>
        <td>${item.total}</td>
        <td>${item.correct}</td>
        <td class="rate-cell">${
          item.total ? formatPercent((item.correct / item.total) * 100) : "—"
        }</td>
      </tr>`;
    }).join("");
    const wrongHtml = results.wrongRows.length
      ? results.wrongRows.map(renderResultWrongItem).join("")
      : `<div class="empty-state"><div><strong>${
          isSpecial ? "这一组全部答对" : "这一套全部答对"
        }</strong>没有需要复习的错题，继续保持。</div></div>`;
    const answeredWrongCount = results.wrongRows.filter(
      (row) => row.answered
    ).length;
    content.innerHTML = `
      <div class="result-hero">
        <section class="score-card">
          <div class="score-kicker">FINAL SCORE · ${
            isSpecial ? "专项练习" : `第 ${paper.seq} 套`
          }</div>
          <div class="score-main"><strong>${results.score}</strong><span>/ ${
      results.total
    }</span></div>
          <div class="score-sub">
            <span>正确率 <strong>${formatPercent(results.percent)}</strong></span>
            <span>答对 <strong>${results.correctCount}</strong> 题</span>
            <span>未答 <strong>${results.unansweredCount}</strong> 题</span>
            <span>用时 <strong>${formatDuration(record.durationSec)}</strong></span>
          </div>
        </section>
        <div class="result-summary">
          <div class="summary-card">
            <span class="summary-label">模式</span>
            <strong>${escapeHtml(modeLabel(paper.mode))}</strong>
            <span>${
              isSpecial
                ? `共 ${paper.questionIds.length} 题 · 每题 1 分`
                : `模板 ${paper.template} · 每题 1 分`
            }</span>
          </div>
          <div class="summary-card">
            <span class="summary-label">已答错</span>
            <strong>${answeredWrongCount}</strong>
            <span>已自动加入错题本</span>
          </div>
        </div>
      </div>
      <div class="breakdown-grid">
        <section class="panel breakdown-panel">
          <h2>分类得分</h2>
          <table class="breakdown-table">
            <thead><tr><th>分类</th><th>题量</th><th>答对</th><th>正确率</th></tr></thead>
            <tbody>${categoryRows}</tbody>
          </table>
        </section>
        <section class="panel breakdown-panel">
          <h2>题型得分</h2>
          <table class="breakdown-table">
            <thead><tr><th>题型</th><th>题量</th><th>答对</th><th>正确率</th></tr></thead>
            <tbody>${typeRows}</tbody>
          </table>
        </section>
      </div>
      <div class="result-actions">
        <button class="button button-primary" type="button" data-result-action="new">${
          isSpecial ? "再练一组" : "再刷一套"
        }</button>
        <button class="button button-secondary" type="button" data-result-action="wrong">查看错题本</button>
        <button class="button button-ghost" type="button" data-result-action="home">返回首页</button>
      </div>
      <section class="panel result-wrong-panel">
        <div class="panel-heading">
          <div><div class="panel-kicker">REVIEW</div><h2>${
            isSpecial ? "本组错题" : "本套错题"
          }${
            results.unansweredCount ? "（含未答）" : ""
          }</h2></div>
          <span class="panel-meta">${results.wrongRows.length} 题</span>
        </div>
        <div class="result-wrong-list">${wrongHtml}</div>
      </section>
    `;
    content
      .querySelector('[data-result-action="new"]')
      ?.addEventListener("click", () =>
        isSpecial ? startSpecialSession(paper.training) : startNewPaper()
      );
    content
      .querySelector('[data-result-action="wrong"]')
      ?.addEventListener("click", () => showView("wrong"));
    content
      .querySelector('[data-result-action="home"]')
      ?.addEventListener("click", () => showView("home"));
  }

  function renderResultWrongItem(row) {
    const question = row.question;
    let partDetail = "";
    if (question.type === "fill" && row.partResults?.length) {
      partDetail = `<div class="result-explanation">${row.partResults
        .map(
          (part, index) =>
            `第 ${index + 1} 空：${part.correct ? "正确" : "错误"}，正确答案 ${escapeHtml(
              part.expected
            )}`
        )
        .join("；")}</div>`;
    }
    return `<div class="result-wrong-item">
      <div class="result-wrong-head">
        <span class="wrong-number">第 ${row.index} 题</span>
        ${categoryChip(question.category)}
        ${typeChip(question.type)}
      </div>
      <p class="result-wrong-stem">${escapeHtml(question.stem)}</p>
      <div class="answer-compare">
        <div class="answer-box user-answer"><span>你的答案</span><strong>${escapeHtml(
          row.userText
        )}</strong></div>
        <div class="answer-box correct-answer"><span>正确答案</span><strong>${escapeHtml(
          row.expectedText
        )}</strong></div>
      </div>
      ${partDetail}
      ${
        question.explanation
          ? `<div class="result-explanation">解析：${escapeHtml(
              question.explanation
            )}</div>`
          : ""
      }
    </div>`;
  }

  function ensureWrongCategoryOptions() {
    const select = $("#wrongCategoryFilter");
    if (select.options.length > 1) return;
    for (const category of core.CATEGORY_ORDER) {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      select.appendChild(option);
    }
  }

  function renderWrongBook() {
    ensureWrongCategoryOptions();
    const query = $("#wrongSearchInput").value.trim().toLowerCase();
    const category = $("#wrongCategoryFilter").value;
    const list = $("#wrongList");
    const entries = Object.entries(state.wrongBook)
      .map(([id, meta]) => ({ id, meta, question: questionMap.get(id) }))
      .filter((item) => item.question)
      .filter((item) => {
        if (category && item.question.category !== category) return false;
        if (!query) return true;
        return (
          item.question.stem.toLowerCase().includes(query) ||
          item.question.category.toLowerCase().includes(query) ||
          (item.question.topic || "").toLowerCase().includes(query)
        );
      })
      .sort((a, b) => {
        const at = new Date(a.meta.lastWrongAt || 0).getTime();
        const bt = new Date(b.meta.lastWrongAt || 0).getTime();
        return bt - at;
      });
    updateWrongBadge();
    if (!entries.length) {
      list.innerHTML = `<div class="empty-state">
        <div><strong>${
          query || category ? "没有匹配的错题" : "错题本还是空的"
        }</strong>${
          query || category
            ? "换个筛选条件试试。"
            : "完成一套试卷后，答错的题会自动收进这里。"
        }</div>
      </div>`;
      return;
    }
    list.innerHTML = entries
      .map(({ id, meta, question }) => {
        const expected = core.formatExpected(question);
        return `<article class="wrong-item">
          <div class="wrong-item-head">
            ${categoryChip(question.category)}
            ${typeChip(question.type)}
            <span class="chip chip-topic">${escapeHtml(question.topic)}</span>
            <span class="wrong-count">错 ${meta.wrongCount || 1} 次</span>
          </div>
          <p class="wrong-stem">${escapeHtml(question.stem)}</p>
          <div class="wrong-meta">最近做错：${escapeHtml(
            formatDateTime(meta.lastWrongAt)
          )}${meta.wasAnswered === false ? " · 当时未作答" : ""}</div>
          <details>
            <summary>查看答案与解析</summary>
            <div class="wrong-answer">
              <div><strong>你的答案：</strong>${escapeHtml(
                meta.lastUserAnswer || "未作答"
              )}</div>
              <div><strong>正确答案：</strong>${escapeHtml(expected)}</div>
              ${
                question.explanation
                  ? `<div class="explanation">解析：${escapeHtml(
                      question.explanation
                    )}</div>`
                  : ""
              }
            </div>
          </details>
          <div class="wrong-actions">
            <button class="button button-text danger-text" type="button" data-remove-wrong="${id}">移除</button>
          </div>
        </article>`;
      })
      .join("");
  }

  async function removeWrongQuestion(id) {
    if (!state.wrongBook[id]) return;
    delete state.wrongBook[id];
    saveState();
    renderWrongBook();
    showToast("已从错题本移除。");
  }

  function renderData() {
    const active = state.activePaper ? "有未完成试卷" : "无";
    const statsCount = Object.keys(state.questionStats || {}).length;
    const sizeKb = Math.round(
      new Blob([JSON.stringify(state)]).size / 1024
    );
    $("#storageSummary").innerHTML = `
      <div class="storage-item"><span>已完成试卷</span><strong>${state.history.length}</strong></div>
      <div class="storage-item"><span>错题本题目</span><strong>${Object.keys(
        state.wrongBook
      ).length}</strong></div>
      <div class="storage-item"><span>抽题历史</span><strong>${statsCount}</strong></div>
      <div class="storage-item"><span>未完成试卷</span><strong class="data-active-label">${active}</strong></div>
      <div class="storage-item"><span>本地数据大小</span><strong>${sizeKb} KB</strong></div>
      <div class="storage-item"><span>最后保存</span><strong class="data-updated-label">${escapeHtml(
        formatDateTime(state.updatedAt)
      )}</strong></div>
    `;
  }

  function exportData() {
    const payload = {
      app: "smhmx_quiz",
      ...state,
      exportedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(payload, null, 2);
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[-:T]/g, "");
    const filename = `劳动安全刷题数据_${stamp}.json`;
    if (window.AndroidBridge?.exportData) {
      try {
        window.AndroidBridge.exportData(text, filename);
      } catch (error) {
        showToast("导出失败，请改用网页版导出。", "error");
      }
      return;
    }
    const blob = new Blob([text], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("数据已导出。");
  }

  async function importDataText(text) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("invalid");
      const ok = await confirmDialog(
        "导入数据？",
        "导入会替换本机当前的答题记录、错题本和未完成试卷。",
        "确认导入",
        true
      );
      if (!ok) return;
      stopTimer(false);
      state = normalizeState(parsed);
      activeSession = null;
      saveState();
      renderHome();
      showView("home");
      showToast("数据已导入。");
    } catch (error) {
      alertDialog("导入失败", "文件不是有效的刷题数据备份，或内容已损坏。");
    }
  }

  async function importDataFile(file) {
    if (!file) return;
    try {
      await importDataText(await file.text());
    } finally {
      $("#importFileInput").value = "";
    }
  }

  window.receiveImportedData = (text) => {
    importDataText(text);
  };

  window.handleAndroidBack = () => {
    const modal = document.querySelector(".modal-overlay");
    if (modal) {
      modal.click();
      return true;
    }
    const sheet = $("#answerSheetPanel");
    if (sheet?.classList.contains("open")) {
      closeSheet();
      return true;
    }
    if (currentView === "paper" && activeSession) {
      pausePaper();
      return true;
    }
    if (currentView !== "home") {
      showView("home");
      return true;
    }
    return false;
  };

  async function clearHistory() {
    const ok = await confirmDialog(
      "清空答题记录？",
      "会清除成绩历史和上次成绩，未完成试卷与错题本不受影响。",
      "清空",
      true
    );
    if (!ok) return;
    state.history = [];
    state.lastSession = null;
    saveState();
    renderData();
    showToast("答题记录已清空。");
  }

  async function clearWrongData() {
    const ok = await confirmDialog(
      "清空错题本？",
      "错题本中的所有题目和错误次数都会被清除。",
      "清空",
      true
    );
    if (!ok) return;
    state.wrongBook = {};
    saveState();
    updateWrongBadge();
    renderData();
    showToast("错题本已清空。");
  }

  async function resetAllData() {
    const ok = await confirmDialog(
      "重置全部数据？",
      "会清除所有成绩、错题本、抽题历史和未完成试卷。此操作不可撤销。",
      "全部重置",
      true
    );
    if (!ok) return;
    stopTimer(false);
    state = defaultState();
    activeSession = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn(error);
    }
    saveState();
    renderHome();
    showView("home");
    showToast("全部数据已重置。");
  }

  function handleGlobalKeydown(event) {
    if ($(".modal-overlay")) return;
    if (currentView !== "paper" || !activeSession) return;
    const target = event.target;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.tagName === "BUTTON" ||
        target.tagName === "A")
    ) {
      return;
    }
    const questions = getQuestions(activeSession);
    const question = questions[activeSession.currentIndex];
    if (!question) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goToQuestion(activeSession.currentIndex - 1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      goToQuestion(activeSession.currentIndex + 1);
      return;
    }
    if (activeSession.paper.mode === "study") {
      const key = event.key.toLowerCase();
      if (key === "enter" || key === " " || key === "r") {
        event.preventDefault();
        toggleReveal(question);
      }
      return;
    }
    if (question.type === "single") {
      const letters = ["A", "B", "C", "D"];
      const key = event.key.toUpperCase();
      if (letters.includes(key)) {
        event.preventDefault();
        setSimpleAnswer(question, key);
        return;
      }
      if (["1", "2", "3", "4"].includes(event.key)) {
        event.preventDefault();
        setSimpleAnswer(question, letters[Number(event.key) - 1]);
        return;
      }
    }
    if (question.type === "judge") {
      const key = event.key.toLowerCase();
      if (["1", "t", "√", "对"].includes(key)) {
        event.preventDefault();
        setSimpleAnswer(question, "√");
        return;
      }
      if (["2", "f", "×", "错"].includes(key)) {
        event.preventDefault();
        setSimpleAnswer(question, "×");
        return;
      }
    }
    if (event.key.toLowerCase() === "m") {
      event.preventDefault();
      toggleFlag(question);
      return;
    }
    if (event.key.toLowerCase() === "c" && isPracticeMode(activeSession.paper)) {
      event.preventDefault();
      checkCurrent();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      goToQuestion(activeSession.currentIndex + 1);
    }
  }

  function bindEvents() {
    $("#startPaperButton").addEventListener("click", () => startNewPaper());
    $("#startFromWrongButton")?.addEventListener("click", () => startNewPaper());
    $("#installAppButton").addEventListener("click", showInstallHelp);
    $("#resumeButton").addEventListener("click", resumePaper);
    $("#discardButton").addEventListener("click", discardActivePaper);
    $("#backHomeButton").addEventListener("click", pausePaper);
    $("#submitPaperButton").addEventListener("click", askSubmit);
    $("#sheetToggleButton").addEventListener("click", openSheet);
    $("#sheetCloseButton").addEventListener("click", closeSheet);
    $("#viewLastResultButton").addEventListener("click", () => {
      renderResultView();
      showView("result");
    });

    $$(".mode-card").forEach((card) => {
      card.addEventListener("click", () => {
        state.settings.mode = card.dataset.mode;
        saveState({ silent: true });
        renderModeCards();
      });
    });

    $("#trainingCategory").addEventListener("change", (event) => {
      state.training.category = event.target.value;
      saveState({ silent: true });
      renderTrainingPanel();
    });
    $("#trainingCount").addEventListener("change", (event) => {
      state.training.count = event.target.value;
      saveState({ silent: true });
      updateTrainingPool();
    });
    $("#trainingOrder").addEventListener("change", (event) => {
      state.training.order = event.target.value === "sequential"
        ? "sequential"
        : "random";
      saveState({ silent: true });
      updateTrainingPool();
    });
    $("#startSpecialButton").addEventListener("click", startSpecialSession);
    $("#startStudyButton").addEventListener("click", startStudySession);

    document.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      if (action === "open-wrong") showView("wrong");
      if (action === "open-data") showView("data");
      if (action === "back-home") showView("home");
    });

    $("#wrongList").addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-remove-wrong]");
      if (button) removeWrongQuestion(button.dataset.removeWrong);
    });
    $("#wrongSearchInput").addEventListener("input", renderWrongBook);
    $("#wrongCategoryFilter").addEventListener("change", renderWrongBook);
    $("#clearWrongButton").addEventListener("click", clearWrongData);

    $("#exportButton").addEventListener("click", exportData);
    $("#importButton").addEventListener("click", () => {
      if (window.AndroidBridge?.importData) {
        try {
          window.AndroidBridge.importData();
        } catch (error) {
          showToast("无法打开文件选择器。", "error");
        }
        return;
      }
      $("#importFileInput").click();
    });
    $("#importFileInput").addEventListener("change", (event) => {
      importDataFile(event.target.files?.[0]);
    });
    $("#clearHistoryButton").addEventListener("click", clearHistory);
    $("#clearWrongDataButton").addEventListener("click", clearWrongData);
    $("#resetAllButton").addEventListener("click", resetAllData);
    document.addEventListener("keydown", handleGlobalKeydown);
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
    });
    window.addEventListener("appinstalled", () => {
      showToast("已安装到主屏幕。");
    });
    window.addEventListener("beforeunload", () => {
      stopTimer(true);
      saveState({ silent: true });
    });
  }

  function showFatal(message) {
    const app = $("#app");
    app.innerHTML = `<main class="view" style="width:min(720px,calc(100% - 40px));margin:80px auto;">
      <section class="panel">
        <div class="panel-kicker">DATA ERROR</div>
        <h2>题库加载失败</h2>
        <p class="muted" style="white-space:pre-wrap;margin-top:10px;">${escapeHtml(
          message
        )}</p>
      </section>
    </main>`;
  }

  function init() {
    if (!core || !bank || !Array.isArray(bank.questions)) {
      showFatal("缺少题库文件或组卷核心文件。");
      return;
    }
    const validation = core.validateBank(bank);
    if (!validation.ok) {
      showFatal(validation.errors.join("\n"));
      return;
    }
    questionMap = core.buildQuestionMap(bank);
    state = loadState();
    bindEvents();
    showView("home");
    if (window.AndroidBridge || isStandaloneMode()) {
      $("#installAppButton").hidden = true;
    }
    if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.warn("Service worker registration failed", error);
      });
    }
    const launchTarget = new URLSearchParams(location.search).get("open");
    if (launchTarget === "training") {
      window.setTimeout(() => {
        document
          .querySelector(".training-panel")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 220);
    }
  }

  init();
})();
