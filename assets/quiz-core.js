(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.QuizCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CATEGORY_ORDER = [
    "安全基础",
    "常见事故预防",
    "季节性劳动安全",
    "专业劳动安全",
    "事故处置",
    "劳防用品与职业健康",
  ];

  const TYPE_ORDER = ["fill", "single", "judge"];
  const TYPE_LABELS = {
    fill: "填空题",
    single: "单选题",
    judge: "判断题",
  };
  const TYPE_SECTIONS = {
    fill: { start: 1, end: 30, label: "填空题" },
    single: { start: 31, end: 90, label: "单选题" },
    judge: { start: 91, end: 150, label: "判断题" },
  };

  const BLUEPRINTS = {
    A: {
      安全基础: { fill: 2, single: 3, judge: 3 },
      常见事故预防: { fill: 12, single: 37, judge: 26 },
      季节性劳动安全: { fill: 3, single: 5, judge: 7 },
      专业劳动安全: { fill: 10, single: 7, judge: 13 },
      事故处置: { fill: 2, single: 2, judge: 3 },
      劳防用品与职业健康: { fill: 1, single: 6, judge: 8 },
    },
    B: {
      安全基础: { fill: 2, single: 2, judge: 3 },
      常见事故预防: { fill: 12, single: 37, judge: 26 },
      季节性劳动安全: { fill: 3, single: 5, judge: 7 },
      专业劳动安全: { fill: 10, single: 7, judge: 13 },
      事故处置: { fill: 2, single: 3, judge: 3 },
      劳防用品与职业健康: { fill: 1, single: 6, judge: 8 },
    },
  };

  function cloneBlueprint(blueprint) {
    const result = {};
    for (const category of CATEGORY_ORDER) {
      result[category] = { ...blueprint[category] };
    }
    return result;
  }

  function getBlueprint(paperSeq) {
    const key = paperSeq % 2 === 1 ? "A" : "B";
    return { key, matrix: cloneBlueprint(BLUEPRINTS[key]) };
  }

  function blueprintCategoryTotals(matrix) {
    const totals = {};
    for (const category of CATEGORY_ORDER) {
      totals[category] = TYPE_ORDER.reduce(
        (sum, type) => sum + (matrix[category]?.[type] || 0),
        0
      );
    }
    return totals;
  }

  function blueprintTypeTotals(matrix) {
    const totals = {};
    for (const type of TYPE_ORDER) {
      totals[type] = CATEGORY_ORDER.reduce(
        (sum, category) => sum + (matrix[category]?.[type] || 0),
        0
      );
    }
    return totals;
  }

  function mulberry32(seed) {
    let value = seed >>> 0;
    return function () {
      value += 0x6d2b79f5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(items, rng) {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function normalizeAnswer(value) {
    let text = String(value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[～~—–－-]/g, "~")
      .replace(/[\s\u3000]/g, "");
    text = text.replace(/[，,。；;：:、!！?？'"“”‘’`·|\\/（）()\[\]【】{}<>《》_]/g, "");
    return text;
  }

  function getLastSeen(stats, questionId) {
    const item = stats?.[questionId];
    return item && Number.isFinite(item.lastSeen) ? item.lastSeen : 0;
  }

  function getSeenCount(stats, questionId) {
    const item = stats?.[questionId];
    return item && Number.isFinite(item.seenCount) ? item.seenCount : 0;
  }

  function pickLeastRecent(items, count, stats, rng) {
    if (count <= 0) return [];
    if (count >= items.length) return shuffle(items, rng);

    const buckets = new Map();
    for (const item of items) {
      const key = getLastSeen(stats, item.id);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(item);
    }

    const result = [];
    const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
    for (const key of keys) {
      const bucket = shuffle(buckets.get(key), rng);
      for (const item of bucket) {
        if (result.length >= count) break;
        result.push(item);
      }
      if (result.length >= count) break;
    }
    return result;
  }

  function topicMetrics(group, stats) {
    let unseen = 0;
    let oldest = Infinity;
    let newest = -Infinity;
    let sum = 0;
    for (const item of group.items) {
      const lastSeen = getLastSeen(stats, item.id);
      if (lastSeen === 0) unseen += 1;
      oldest = Math.min(oldest, lastSeen);
      newest = Math.max(newest, lastSeen);
      sum += lastSeen;
    }
    return {
      unseen,
      oldest: oldest === Infinity ? 0 : oldest,
      newest: newest === -Infinity ? 0 : newest,
      average: group.items.length ? sum / group.items.length : 0,
    };
  }

  function allocateForCoverage(groups, total, stats, rng) {
    const entries = groups
      .map((group) => ({ group, size: group.items.length }))
      .filter((entry) => entry.size > 0);
    const available = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total >= available) {
      return entries.map((entry) => ({ group: entry.group, count: entry.size }));
    }

    const ranked = entries.slice().sort((a, b) => {
      const am = topicMetrics(a.group, stats);
      const bm = topicMetrics(b.group, stats);
      if ((am.unseen > 0) !== (bm.unseen > 0)) return am.unseen > 0 ? -1 : 1;
      if (am.oldest !== bm.oldest) return am.oldest - bm.oldest;
      if (am.average !== bm.average) return am.average - bm.average;
      if (am.unseen !== bm.unseen) return bm.unseen - am.unseen;
      if (a.size !== b.size) return b.size - a.size;
      return rng() - 0.5;
    });

    const allocations = new Map(entries.map((entry) => [entry.group, 0]));
    let remaining = total;
    for (const entry of ranked) {
      if (remaining <= 0) break;
      allocations.set(entry.group, 1);
      remaining -= 1;
    }

    if (remaining > 0) {
      const capacities = entries
        .map((entry) => {
          const used = allocations.get(entry.group) || 0;
          return {
            group: entry.group,
            capacity: entry.size - used,
            count: 0,
            remainder: 0,
          };
        })
        .filter((item) => item.capacity > 0);
      const capacityTotal = capacities.reduce(
        (sum, item) => sum + item.capacity,
        0
      );
      for (const item of capacities) {
        const exact = (remaining * item.capacity) / capacityTotal;
        item.count = Math.floor(exact);
        item.remainder = exact - item.count;
      }
      let assigned = capacities.reduce((sum, item) => sum + item.count, 0);
      while (assigned < remaining) {
        const candidates = capacities
          .filter((item) => item.count < item.capacity)
          .sort((a, b) => {
            if (b.remainder !== a.remainder) return b.remainder - a.remainder;
            return rng() - 0.5;
          });
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

  function selectForCell(pool, count, stats, rng) {
    if (count <= 0) return [];
    const byTopic = new Map();
    for (const question of pool) {
      const topic = question.topic || "未分类";
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      byTopic.get(topic).push(question);
    }
    const groups = Array.from(byTopic.entries()).map(([topic, items]) => ({
      topic,
      items,
    }));
    const allocations = allocateForCoverage(groups, count, stats, rng);
    const selected = [];
    for (const allocation of allocations) {
      selected.push(
        ...pickLeastRecent(allocation.group.items, allocation.count, stats, rng)
      );
    }
    return selected;
  }

  function makePaperId(paperSeq, rng) {
    const stamp = Date.now().toString(36);
    const random = Math.floor(rng() * 0xffffff)
      .toString(36)
      .padStart(5, "0");
    return `P${paperSeq}-${stamp}-${random}`;
  }

  function buildPaper(bank, options) {
    const opts = options || {};
    const paperSeq = Number.isInteger(opts.paperSeq) ? opts.paperSeq : 1;
    const mode = opts.mode === "practice" ? "practice" : "exam";
    const stats = opts.stats || {};
    const rng = opts.rng || Math.random;
    const { key: templateKey, matrix } = getBlueprint(paperSeq);

    const pools = new Map();
    for (const question of bank.questions) {
      const key = `${question.category}|${question.type}`;
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push(question);
    }

    const shortages = [];
    for (const category of CATEGORY_ORDER) {
      for (const type of TYPE_ORDER) {
        const quota = matrix[category]?.[type] || 0;
        const pool = pools.get(`${category}|${type}`) || [];
        if (pool.length < quota) {
          shortages.push({
            category,
            type,
            required: quota,
            available: pool.length,
          });
        }
      }
    }
    if (shortages.length) {
      return { error: "题库数量不足，无法生成符合配比的试卷。", shortages };
    }

    const selected = [];
    for (const category of CATEGORY_ORDER) {
      for (const type of TYPE_ORDER) {
        const quota = matrix[category]?.[type] || 0;
        if (!quota) continue;
        const pool = pools.get(`${category}|${type}`) || [];
        selected.push(...selectForCell(pool, quota, stats, rng));
      }
    }

    const byType = { fill: [], single: [], judge: [] };
    for (const question of selected) byType[question.type].push(question);
    const ordered = [
      ...shuffle(byType.fill, rng),
      ...shuffle(byType.single, rng),
      ...shuffle(byType.judge, rng),
    ];

    const ids = new Set();
    for (const question of ordered) {
      if (ids.has(question.id)) {
        return { error: "组卷出现重复题，请检查题库与组卷逻辑。" };
      }
      ids.add(question.id);
    }

    const categoryTotals = blueprintCategoryTotals(matrix);
    const typeTotals = blueprintTypeTotals(matrix);
    return {
      id: makePaperId(paperSeq, rng),
      seq: paperSeq,
      template: templateKey,
      mode,
      createdAt: new Date().toISOString(),
      questionIds: ordered.map((question) => question.id),
      blueprint: matrix,
      categoryTotals,
      typeTotals,
      warnings: [],
    };
  }

  function recordPaperStats(stats, paper) {
    const next = { ...(stats || {}) };
    const runSeq = Number.isFinite(paper.runSeq)
      ? paper.runSeq
      : Number.isFinite(paper.seq)
        ? paper.seq
        : 0;
    for (const questionId of paper.questionIds) {
      const previous = next[questionId] || { seenCount: 0, lastSeen: 0 };
      next[questionId] = {
        seenCount: (previous.seenCount || 0) + 1,
        lastSeen: runSeq,
      };
    }
    return next;
  }

  function buildQuestionMap(bank) {
    const map = new Map();
    for (const question of bank.questions) map.set(question.id, question);
    return map;
  }

  function getPaperQuestions(paper, bank) {
    const map = buildQuestionMap(bank);
    return paper.questionIds.map((id) => map.get(id)).filter(Boolean);
  }

  function isFillAnswered(question, answer) {
    const parts = question.answerParts || [];
    const values = Array.isArray(answer) ? answer : [];
    return parts.length > 0 && parts.every((_, index) => normalizeAnswer(values[index]));
  }

  function scoreQuestion(question, answer) {
    if (question.type === "fill") {
      const parts = question.answerParts || [];
      const values = Array.isArray(answer) ? answer : [];
      const partResults = parts.map((expected, index) => {
        const user = values[index] ?? "";
        return {
          expected,
          user,
          correct: normalizeAnswer(user) === normalizeAnswer(expected),
        };
      });
      const answered = isFillAnswered(question, values);
      return {
        answered,
        correct: answered && partResults.every((item) => item.correct),
        expectedText: formatExpected(question),
        userText: formatUserAnswer(question, values),
        partResults,
      };
    }

    if (question.type === "single") {
      const user = typeof answer === "string" ? answer.trim().toUpperCase() : "";
      const answered = Boolean(user);
      return {
        answered,
        correct: answered && user === question.answer,
        expectedText: formatExpected(question),
        userText: formatUserAnswer(question, user),
        partResults: [],
      };
    }

    const user = typeof answer === "string" ? answer : "";
    const answered = Boolean(user);
    return {
      answered,
      correct: answered && user === question.answer,
      expectedText: formatExpected(question),
      userText: formatUserAnswer(question, user),
      partResults: [],
    };
  }

  function isAnswered(question, answer) {
    if (question.type === "fill") return isFillAnswered(question, answer);
    if (question.type === "single") return Boolean(answer);
    return Boolean(answer);
  }

  function formatExpected(question) {
    if (question.type === "fill") {
      const parts = question.answerParts || [];
      const hasRange = (question.segments || []).some(
        (segment) => segment.kind === "range"
      );
      if (hasRange && parts.length === 2) return `${parts[0]}～${parts[1]}`;
      return parts.join("；");
    }
    if (question.type === "single") {
      const index = ["A", "B", "C", "D"].indexOf(question.answer);
      const option = index >= 0 ? question.options[index] : "";
      return `${question.answer}. ${option}`.trim();
    }
    return question.answer === "√" ? "正确" : "错误";
  }

  function formatUserAnswer(question, answer) {
    if (question.type === "fill") {
      const parts = question.answerParts || [];
      const values = Array.isArray(answer) ? answer : [];
      return parts
        .map((_, index) => {
          const value = String(values[index] ?? "").trim();
          return value || "（空）";
        })
        .join("；");
    }
    if (question.type === "single") {
      if (!answer) return "未作答";
      const index = ["A", "B", "C", "D"].indexOf(answer);
      const option = index >= 0 ? question.options[index] : "";
      return `${answer}. ${option}`.trim();
    }
    if (!answer) return "未作答";
    return answer === "√" ? "正确" : "错误";
  }

  function computeResults(paper, bank, answers) {
    const questionMap = buildQuestionMap(bank);
    const rows = [];
    const byCategory = {};
    const byType = {};
    for (const category of CATEGORY_ORDER) {
      byCategory[category] = {
        total: 0,
        answered: 0,
        correct: 0,
        target: paper.categoryTotals?.[category] || 0,
      };
    }
    for (const type of TYPE_ORDER) {
      byType[type] = { total: 0, answered: 0, correct: 0 };
    }

    let correctCount = 0;
    let answeredCount = 0;
    for (let index = 0; index < paper.questionIds.length; index += 1) {
      const question = questionMap.get(paper.questionIds[index]);
      if (!question) continue;
      const answer = answers?.[question.id];
      const score = scoreQuestion(question, answer);
      if (score.answered) answeredCount += 1;
      if (score.correct) correctCount += 1;
      byCategory[question.category].total += 1;
      byType[question.type].total += 1;
      if (score.answered) {
        byCategory[question.category].answered += 1;
        byType[question.type].answered += 1;
      }
      if (score.correct) {
        byCategory[question.category].correct += 1;
        byType[question.type].correct += 1;
      }
      rows.push({
        index: index + 1,
        question,
        answer,
        ...score,
      });
    }

    return {
      total: rows.length,
      score: correctCount,
      correctCount,
      answeredCount,
      unansweredCount: rows.length - answeredCount,
      wrongCount: rows.length - correctCount,
      percent: rows.length ? (correctCount / rows.length) * 100 : 0,
      rows,
      wrongRows: rows.filter((row) => !row.correct),
      byCategory,
      byType,
    };
  }

  function countBank(bank) {
    const counts = {};
    for (const category of CATEGORY_ORDER) {
      counts[category] = { fill: 0, single: 0, judge: 0, total: 0 };
    }
    for (const question of bank.questions || []) {
      if (!counts[question.category]) {
        counts[question.category] = { fill: 0, single: 0, judge: 0, total: 0 };
      }
      counts[question.category][question.type] =
        (counts[question.category][question.type] || 0) + 1;
      counts[question.category].total += 1;
    }
    return counts;
  }

  function validateBank(bank) {
    const errors = [];
    const warnings = [];
    const questions = bank.questions || [];
    if (!questions.length) errors.push("题库为空。");
    if (!Array.isArray(bank.categories)) warnings.push("题库缺少 categories 元数据。");
    const ids = new Set();
    const stems = new Set();
    const seenDisallowedTypes = new Set();

    for (const question of questions) {
      if (!question.id) errors.push(`题目缺少 id: ${question.stem || "?"}`);
      if (ids.has(question.id)) errors.push(`题目 id 重复: ${question.id}`);
      ids.add(question.id);
      const stemKey = `${question.category}|${question.type}|${String(
        question.stem || ""
      ).replace(/\s+/g, "")}`;
      if (stems.has(stemKey)) errors.push(`题目重复: ${question.stem}`);
      stems.add(stemKey);
      if (!TYPE_ORDER.includes(question.type)) {
        seenDisallowedTypes.add(question.type);
        errors.push(`题目类型不允许: ${question.type}`);
      }
      if (question.category === "专业劳动安全" && !String(question.subseries || "").includes("电务")) {
        errors.push(`专业劳动安全出现非电务题: ${question.stem}`);
      }
      if (question.type === "fill") {
        if (!Array.isArray(question.answerParts) || !question.answerParts.length) {
          errors.push(`填空题缺少答案分段: ${question.stem}`);
        }
        if (!Array.isArray(question.segments) || !question.segments.length) {
          errors.push(`填空题缺少渲染分段: ${question.stem}`);
        }
        const referenced = new Set();
        for (const segment of question.segments || []) {
          if (segment.kind === "blank") referenced.add(segment.part);
          if (segment.kind === "range") {
            referenced.add(segment.parts?.[0]);
            referenced.add(segment.parts?.[1]);
          }
        }
        for (let index = 0; index < (question.answerParts || []).length; index += 1) {
          if (!referenced.has(index)) {
            errors.push(`填空题答案空位未使用: ${question.stem}`);
          }
        }
      }
      if (question.type === "single") {
        if (!Array.isArray(question.options) || question.options.length !== 4) {
          errors.push(`单选题选项数量不为 4: ${question.stem}`);
        }
        if (!["A", "B", "C", "D"].includes(question.answer)) {
          errors.push(`单选题答案无效: ${question.stem}`);
        }
      }
      if (question.type === "judge" && !["√", "×"].includes(question.answer)) {
        errors.push(`判断题答案无效: ${question.stem}`);
      }
    }

    const counts = countBank(bank);
    for (const category of CATEGORY_ORDER) {
      if (!counts[category] || counts[category].total === 0) {
        errors.push(`分类无可用题目: ${category}`);
      }
    }

    for (const templateKey of Object.keys(BLUEPRINTS)) {
      const matrix = BLUEPRINTS[templateKey];
      const categoryTotals = blueprintCategoryTotals(matrix);
      const typeTotals = blueprintTypeTotals(matrix);
      if (Object.values(categoryTotals).reduce((a, b) => a + b, 0) !== 150) {
        errors.push(`模板 ${templateKey} 总题量不是 150。`);
      }
      if (typeTotals.fill !== 30 || typeTotals.single !== 60 || typeTotals.judge !== 60) {
        errors.push(`模板 ${templateKey} 题型总数不是 30/60/60。`);
      }
      for (const category of CATEGORY_ORDER) {
        for (const type of TYPE_ORDER) {
          const quota = matrix[category]?.[type] || 0;
          const available = counts[category]?.[type] || 0;
          if (available < quota) {
            errors.push(
              `模板 ${templateKey} 题量不足: ${category}/${TYPE_LABELS[type]} 需要 ${quota}，只有 ${available}`
            );
          }
        }
      }
    }

    if (seenDisallowedTypes.size) {
      warnings.push(`出现不允许的题型: ${Array.from(seenDisallowedTypes).join(", ")}`);
    }
    return { ok: errors.length === 0, errors, warnings, counts };
  }

  return {
    CATEGORY_ORDER,
    TYPE_ORDER,
    TYPE_LABELS,
    TYPE_SECTIONS,
    BLUEPRINTS,
    getBlueprint,
    blueprintCategoryTotals,
    blueprintTypeTotals,
    mulberry32,
    shuffle,
    normalizeAnswer,
    buildPaper,
    recordPaperStats,
    buildQuestionMap,
    getPaperQuestions,
    scoreQuestion,
    isAnswered,
    formatExpected,
    formatUserAnswer,
    computeResults,
    countBank,
    validateBank,
    getLastSeen,
    getSeenCount,
  };
});
