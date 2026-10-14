export default {
  // 1. 定时触发器 (Cron Triggers)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleWakeSpaces(env, { isManual: false, force: false }));
  },

  // 2. HTTP 请求与可视化面板路由
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 路由 A：根路径返回可视化 HTML 控制台
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(
        renderDashboardHTML(Boolean(env.SECRET_KEY), Boolean(env.WAKE_KV)),
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    // 统一 API 鉴权校验
    const clientKey =
      request.headers.get("X-Secret-Key") || url.searchParams.get("key") || "";
    if (env.SECRET_KEY && clientKey !== env.SECRET_KEY) {
      return new Response(
        JSON.stringify({ allSuccess: false, error: "🚫 密钥错误或未提供访问密钥 (SECRET_KEY)" }),
        { status: 401, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // 路由 B：获取所有 Space 当前实时状态 + 最近 10 次 KV 历史日志
    if (url.pathname === "/api/status") {
      const [statusResult, historyLogs] = await Promise.all([
        getSpacesStatus(env),
        getWakeHistory(env),
      ]);
      return new Response(
        JSON.stringify({ ...statusResult, kvEnabled: Boolean(env.WAKE_KV), history: historyLogs }, null, 2),
        {
          status: statusResult.ok ? 200 : 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    // 路由 C：清空 KV 历史日志
    if (url.pathname === "/api/logs/clear" && request.method === "POST") {
      if (env.WAKE_KV) {
        await env.WAKE_KV.delete("wake_history");
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 路由 D：唤醒或重启全部 / 指定单个 Space
    if (url.pathname === "/wake") {
      const reason = url.searchParams.get("reason") || "Web 控制台手动操作";
      const user = url.searchParams.get("user") || "WebAdmin";
      const force = url.searchParams.get("force") === "true";
      const targetRepo = url.searchParams.get("repo") || "";

      const result = await handleWakeSpaces(env, {
        isManual: true,
        reason,
        user,
        force,
        targetRepo: targetRepo.trim() || null,
      });

      return new Response(JSON.stringify(result, null, 2), {
        status: result.allSuccess ? 200 : 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return new Response("404 Not Found", { status: 404 });
  },
};

/**
 * 解析多 Token 与 Space 的映射关系
 */
function parseTasks(env) {
  const rawTokens = (env.HF_TOKEN || "").trim();
  const rawSpaces = (env.SPACE_REPO_ID || "").trim();

  if (!rawSpaces) return [];

  const spaceGroups = rawSpaces
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tokens = rawTokens
    .split(/[;\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const tasks = [];

  spaceGroups.forEach((group, index) => {
    if (group.includes(":")) {
      const [inlineToken, reposStr] = group.split(":");
      const token = inlineToken.trim();
      const repos = (reposStr || "")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      repos.forEach((repoId) => {
        if (token) tasks.push({ repoId, token });
      });
    } else {
      const repos = group
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);

      if (tokens.length === spaceGroups.length) {
        const token = tokens[index];
        repos.forEach((repoId) => tasks.push({ repoId, token }));
      } else if (tokens.length > 1 && spaceGroups.length === 1 && tokens.length === repos.length) {
        repos.forEach((repoId, rIdx) => tasks.push({ repoId, token: tokens[rIdx] }));
      } else if (tokens.length >= 1) {
        repos.forEach((repoId) => tasks.push({ repoId, token: tokens[0] }));
      }
    }
  });

  return tasks;
}

/**
 * 统一生成标准请求头
 */
function buildHfHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "huggingface_hub/0.26.0; python/3.11; hf-waker-worker/2.0",
  };
}

/**
 * 仅查询所有 Space 的当前状态
 */
async function getSpacesStatus(env) {
  const tasks = parseTasks(env);
  if (tasks.length === 0) {
    return { ok: false, error: "未配置有效的 HF_TOKEN 或 SPACE_REPO_ID 环境变量" };
  }

  const results = await Promise.all(
    tasks.map(async ({ repoId, token }) => {
      try {
        const res = await fetch(`https://huggingface.co/api/spaces/${repoId}`, {
          method: "GET",
          headers: buildHfHeaders(token),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`HTTP ${res.status}:${errText}`);
        }

        const data = await res.json();
        return {
          repoId,
          ok: true,
          stage: data?.runtime?.stage || "UNKNOWN",
          hardware:
            data?.runtime?.hardware?.current ||
            data?.runtime?.hardware?.requested ||
            "cpu-basic",
          sdk: data?.sdk || "unknown",
          private: Boolean(data?.private),
        };
      } catch (err) {
        return {
          repoId,
          ok: false,
          stage: "FETCH_ERROR",
          error: err.message,
        };
      }
    })
  );

  return {
    ok: true,
    timestamp: getBeijingTime(),
    spaces: results,
  };
}

/**
 * 从 Cloudflare KV 读取最近 10 次唤醒历史记录
 */
async function getWakeHistory(env) {
  if (!env.WAKE_KV) return [];
  try {
    const data = await env.WAKE_KV.get("wake_history", { type: "json" });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("读取 KV 历史记录失败:", err);
    return [];
  }
}

/**
 * 将本次唤醒结果追加到 Cloudflare KV（仅保留最新 10 条）
 */
async function saveWakeHistory(env, record) {
  if (!env.WAKE_KV) return;
  try {
    const history = await getWakeHistory(env);
    history.unshift(record);
    const trimmed = history.slice(0, 10);
    await env.WAKE_KV.put("wake_history", JSON.stringify(trimmed));
  } catch (err) {
    console.error("写入 KV 历史记录失败:", err);
  }
}

/**
 * 核心：先检测状态，按需唤醒，并写入 KV 历史
 */
async function handleWakeSpaces(env, options = {}) {
  let tasks = parseTasks(env);

  if (tasks.length === 0) {
    return { allSuccess: false, error: "错误：未能解析出有效的 HF_TOKEN 和 SPACE_REPO_ID" };
  }

  if (options.targetRepo) {
    tasks = tasks.filter((t) => t.repoId.toLowerCase() === options.targetRepo.toLowerCase());
    if (tasks.length === 0) {
      return { allSuccess: false, error: `未找到指定的 Space: ${options.targetRepo}` };
    }
  }

  const HEALTHY_STAGES = ["RUNNING", "BUILDING", "RUNNING_BUILDING", "APP_STARTING"];

  const results = await Promise.all(
    tasks.map(async ({ repoId, token }) => {
      const headers = buildHfHeaders(token);

      try {
        // 1. 查询当前状态
        const infoRes = await fetch(`https://huggingface.co/api/spaces/${repoId}`, {
          method: "GET",
          headers,
        });

        if (!infoRes.ok) {
          const errText = await infoRes.text();
          throw new Error(`获取状态失败 (HTTP ${infoRes.status}):${errText}`);
        }

        const spaceInfo = await infoRes.json();
        const currentStage = spaceInfo?.runtime?.stage || "UNKNOWN";

        // 2. 判断是否跳过
        if (!options.force && HEALTHY_STAGES.includes(currentStage)) {
          return {
            repoId,
            success: true,
            action: "skipped",
            stage: currentStage,
          };
        }

        // 3. 发送重启请求
        const restartRes = await fetch(`https://huggingface.co/api/spaces/${repoId}/restart`, {
          method: "POST",
          headers,
        });

        if (!restartRes.ok) {
          const errText = await restartRes.text();
          throw new Error(`重启失败 (HTTP ${restartRes.status}):${errText}`);
        }

        return {
          repoId,
          success: true,
          action: "restarted",
          stage: currentStage,
        };
      } catch (error) {
        return {
          repoId,
          success: false,
          action: "failed",
          stage: "ERROR",
          error: error.message,
        };
      }
    })
  );

  const allSuccess = results.every((r) => r.success);
  const timestamp = getBeijingTime();
  const summary = {
    total: results.length,
    restarted: results.filter((r) => r.action === "restarted").length,
    skipped: results.filter((r) => r.action === "skipped").length,
    failed: results.filter((r) => r.action === "failed").length,
  };

  // 保存本次记录到 Cloudflare KV (保留最新 10 条)
  await saveWakeHistory(env, {
    timestamp,
    type: options.isManual ? "manual" : "cron",
    force: Boolean(options.force),
    reason: options.isManual ? options.reason : "Cron 定时自动巡检",
    targetRepo: options.targetRepo || "ALL",
    allSuccess,
    summary,
    results,
  });

  // 发送 Telegram 通知
  if (env.BOT_TOKEN && env.CHAT_ID) {
    const silentWhenAllSkipped = env.SILENT_IF_RUNNING === "true";
    const hasRestartOrFail = results.some((r) => r.action !== "skipped");

    if (!silentWhenAllSkipped || hasRestartOrFail || options.isManual) {
      await sendTelegramNotification(env, results, allSuccess, options, timestamp);
    }
  }

  return {
    allSuccess,
    timestamp,
    summary,
    results,
  };
}

/**
 * 格式化并发送 Telegram 通知
 */
async function sendTelegramNotification(env, results, allSuccess, options, timeStr) {
  const spaceList = results
    .map((r) => {
      if (r.action === "skipped") {
        return ` • ${r.repoId} 🟢 运行中 (${r.stage}，已跳过)`;
      } else if (r.action === "restarted") {
        return ` • ${r.repoId} 🔄 已唤醒 (原状态: ${r.stage})`;
      } else {
        return ` • ${r.repoId} ❌ 失败 (${r.error})`;
      }
    })
    .join("\n");

  const stats = `📊 统计：唤醒 ${results.filter((r) => r.action === "restarted").length} 个 | 跳过 ${ results.filter((r) => r.action === "skipped").length } 个 \vert{} 失败 ${results.filter((r) => r.action === "failed").length} 个`;

  const message = options.isManual
    ? [
        `🖐 HF Space 手动保活${options.force ? " (强制重启)" : ""}`,
        ``,
        `👤 触发人: ${options.user}`,
        `📝 原因: ${options.reason}`,
        `⏰ 北京时间 ${timeStr}`,
        `🛰 Space 状态明细：`,
        spaceList,
        ``,
        stats,
        allSuccess ? `✅ 操作 完成 🎉` : `⚠️ 部分或全部处理 失败 ❌`,
      ].join("\n")
    : [
        `🤖 HF Space 自动巡检保活`,
        ``,
        `⏰ 北京时间 ${timeStr}`,
        `🛰 Space 状态明细：`,
        spaceList,
        ``,
        stats,
        allSuccess ? `✅ 巡检保活 完成 🎉` : `⚠️ 部分或全部处理 失败 ❌`,
      ].join("\n");

  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.CHAT_ID.trim(),
        text: message,
      }),
    });
  } catch (err) {
    console.error("Telegram 通知发送失败:", err);
  }
}

/**
 * 获取当前北京时间 (YYYY-MM-DD HH:mm:ss)
 */
function getBeijingTime() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatter.format(now).replace(/\//g, "-");
}

/**
 * 渲染可视化 Web 控制台 HTML (含 KV 历史记录面板)
 */
function renderDashboardHTML(requireKey, kvConfigured) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HF-Waker 控制台 | Hugging Face Spaces 保活面板</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans selection:bg-indigo-500 selection:text-white">
  <div class="max-w-6xl mx-auto px-4 py-8">
    
    <!-- 顶部导航与鉴权栏 -->
    <header class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-6 border-b border-slate-800">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-2xl shadow-inner">
          🤗
        </div>
        <div>
          <h1 class="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            HF-Waker 控制台
            <span class="text-xs font-normal px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">Cloudflare Worker + KV</span>
          </h1>
          <p class="text-xs text-slate-400 mt-0.5">实时监控 Hugging Face Spaces 状态 · 支持按需智能唤醒、单点强制重启与历史审计</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2.5">
        ${
          requireKey
            ? `<div class="relative">
                <input id="secretKeyInput" type="password" placeholder="输入访问密钥 (SECRET_KEY)" 
                  class="bg-slate-900 border border-slate-700 text-sm rounded-lg px-3 py-2 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-52" />
              </div>`
            : ""
        }
        <input id="reasonInput" type="text" placeholder="操作原因备注 (选填)" 
          class="bg-slate-900 border border-slate-700 text-sm rounded-lg px-3 py-2 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-44" />
      </div>
    </header>

    <!-- 统计概览与全局操作栏 -->
    <section class="mt-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-900/70 border border-slate-800/80 rounded-2xl p-4">
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1">
        <div class="bg-slate-950/60 border border-slate-800/80 rounded-xl px-4 py-2.5">
          <div class="text-xs text-slate-400">总计 Space</div>
          <div id="statTotal" class="text-xl font-bold text-white mt-0.5">-</div>
        </div>
        <div class="bg-emerald-950/20 border border-emerald-800/40 rounded-xl px-4 py-2.5">
          <div class="text-xs text-emerald-400">运行/构建中</div>
          <div id="statRunning" class="text-xl font-bold text-emerald-400 mt-0.5">-</div>
        </div>
        <div class="bg-amber-950/20 border border-amber-800/40 rounded-xl px-4 py-2.5">
          <div class="text-xs text-amber-400">休眠/已暂停</div>
          <div id="statSleeping" class="text-xl font-bold text-amber-400 mt-0.5">-</div>
        </div>
        <div class="bg-rose-950/20 border border-rose-800/40 rounded-xl px-4 py-2.5">
          <div class="text-xs text-rose-400">异常/报错</div>
          <div id="statError" class="text-xl font-bold text-rose-400 mt-0.5">-</div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2.5">
        <button onclick="fetchStatus()" id="btnRefresh"
          class="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition flex items-center gap-1.5">
          <span>🔍 刷新状态</span>
        </button>
        <button onclick="triggerWake(null, false)" id="btnWakeAll"
          class="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition flex items-center gap-1.5 shadow-lg shadow-indigo-600/20">
          <span>⚡ 智能唤醒全部</span>
        </button>
        <button onclick="triggerWake(null, true)" id="btnForceAll"
          class="px-4 py-2.5 rounded-xl bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 text-sm font-medium transition flex items-center gap-1.5">
          <span>🔄 全部强制重启</span>
        </button>
      </div>
    </section>

    <!-- 状态提示条 -->
    <div id="toastBanner" class="hidden mt-4 px-4 py-3 rounded-xl border text-sm flex items-center justify-between"></div>

    <!-- Space 卡片网格 -->
    <main id="spacesGrid" class="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <!-- 动态渲染卡片 -->
    </main>

    <!-- 最近 10 次唤醒历史记录 (Cloudflare KV) -->
    <section class="mt-10 bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-800">
        <div>
          <h2 class="text-base font-bold text-white flex items-center gap-2">
            <span>📜 最近 10 次保活执行历史</span>
            ${
              kvConfigured
                ? `<span class="text-xs font-normal px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">WAKE_KV 已连接</span>`
                : `<span class="text-xs font-normal px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">未绑定 WAKE_KV 命名空间</span>`
            }
          </h2>
          <p class="text-xs text-slate-400 mt-0.5">记录每次 Cron 定时巡检与 Web 手动触发的执行明细</p>
        </div>
        ${
          kvConfigured
            ? `<button onclick="clearHistoryLogs()" class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/60 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-700/50 transition self-start sm:self-auto">
                🗑️ 清空历史记录
              </button>`
            : ""
        }
      </div>

      <div id="historyContainer" class="mt-4 space-y-2.5">
        <!-- 动态渲染历史记录 -->
      </div>
    </section>

    <footer class="mt-12 text-center text-xs text-slate-500 border-t border-slate-900 pt-6">
      最后更新时间：<span id="lastUpdated">-</span> · Powered by Cloudflare Workers & KV Storage
    </footer>
  </div>

  <script>
    const keyInput = document.getElementById('secretKeyInput');
    const reasonInput = document.getElementById('reasonInput');

    if (keyInput) {
      keyInput.value = localStorage.getItem('hf_waker_key') || '';
      keyInput.addEventListener('input', () => {
        localStorage.setItem('hf_waker_key', keyInput.value.trim());
      });
    }

    function getHeaders() {
      const headers = { 'Content-Type': 'application/json' };
      if (keyInput && keyInput.value.trim()) {
        headers['X-Secret-Key'] = keyInput.value.trim();
      }
      return headers;
    }

    function showToast(msg, isError = false) {
      const banner = document.getElementById('toastBanner');
      banner.className = \`mt-4 px-4 py-3 rounded-xl border text-sm flex items-center justify-between \${
        isError
          ? 'bg-rose-950/50 border-rose-700/60 text-rose-200'
          : 'bg-indigo-950/50 border-indigo-700/60 text-indigo-200'
      }\`;
      banner.innerHTML = \`<span>\${msg}</span><button onclick="this.parentElement.classList.add('hidden')" class="text-xs opacity-75 hover:opacity-100">✕</button>\`;
    }

    function getStageBadge(stage) {
      const healthy = ['RUNNING'];
      const building = ['BUILDING', 'RUNNING_BUILDING', 'APP_STARTING'];
      const sleeping = ['SLEEPING', 'PAUSED', 'STOPPED'];

      if (healthy.includes(stage)) {
        return \`<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>\${stage}
        </span>\`;
      }
      if (building.includes(stage)) {
        return \`<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-sky-500/15 text-sky-400 border border-sky-500/30">
          <span class="w-2 h-2 rounded-full bg-sky-400 animate-ping"></span>\${stage}
        </span>\`;
      }
      if (sleeping.includes(stage)) {
        return \`<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
          <span class="w-2 h-2 rounded-full bg-amber-400"></span>\${stage}
        </span>\`;
      }
      return \`<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-500/15 text-rose-400 border border-rose-500/30">
        <span class="w-2 h-2 rounded-full bg-rose-400"></span>\${stage}
      </span>\`;
    }

    async function fetchStatus() {
      const grid = document.getElementById('spacesGrid');
      const btnRefresh = document.getElementById('btnRefresh');
      btnRefresh.disabled = true;
      btnRefresh.innerHTML = '⏳ 正在查询...';

      try {
        const res = await fetch('/api/status', { headers: getHeaders() });
        const data = await res.json();

        if (!res.ok || !data.ok) {
          throw new Error(data.error || '获取状态失败');
        }

        document.getElementById('lastUpdated').textContent = data.timestamp;
        renderCards(data.spaces);
        renderHistory(data.history || [], data.kvEnabled);
      } catch (err) {
        showToast(err.message, true);
        grid.innerHTML = \`<div class="col-span-full text-center py-12 text-slate-400 bg-slate-900/40 rounded-2xl border border-slate-800">\${err.message}</div>\`;
      } finally {
        btnRefresh.disabled = false;
        btnRefresh.innerHTML = '🔍 刷新状态';
      }
    }

    function renderCards(spaces) {
      const grid = document.getElementById('spacesGrid');
      const healthyList = ['RUNNING', 'BUILDING', 'RUNNING_BUILDING', 'APP_STARTING'];
      const sleepingList = ['SLEEPING', 'PAUSED', 'STOPPED'];

      let runningCount = 0, sleepingCount = 0, errorCount = 0;

      spaces.forEach(s => {
        if (healthyList.includes(s.stage)) runningCount++;
        else if (sleepingList.includes(s.stage)) sleepingCount++;
        else errorCount++;
      });

      document.getElementById('statTotal').textContent = spaces.length;
      document.getElementById('statRunning').textContent = runningCount;
      document.getElementById('statSleeping').textContent = sleepingCount;
      document.getElementById('statError').textContent = errorCount;

      grid.innerHTML = spaces.map(s => \`
        <div class="bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded-2xl p-5 flex flex-col justify-between transition shadow-sm">
          <div>
            <div class="flex items-start justify-between gap-2">
              <a href="https://huggingface.co/spaces/\${s.repoId}" target="_blank" rel="noopener"
                class="font-semibold text-base text-white hover:text-indigo-400 transition break-all flex items-center gap-1.5">
                <span>\${s.repoId}</span>
                <span class="text-xs text-slate-500">↗</span>
              </a>
              \${getStageBadge(s.stage)}
            </div>

            <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span class="px-2 py-0.5 rounded bg-slate-800 text-slate-300">⚙️ \${s.hardware || 'cpu-basic'}</span>
              \${s.sdk ? \`<span class="px-2 py-0.5 rounded bg-slate-800 text-slate-300">📦 \${s.sdk}</span>\` : ''}
              \${s.private ? \`<span class="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">🔒 Private</span>\` : ''}
            </div>

            \${s.error ? \`<p class="mt-2.5 text-xs text-rose-400 bg-rose-950/40 border border-rose-800/40 rounded-lg p-2 break-all">\${s.error}</p>\` : ''}
          </div>

          <div class="mt-5 pt-4 border-t border-slate-800/80 flex items-center gap-2">
            <button onclick="triggerWake('\${s.repoId}', false)"
              class="flex-1 py-2 px-3 rounded-xl bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 text-xs font-medium transition">
              ⚡ 智能唤醒
            </button>
            <button onclick="triggerWake('\${s.repoId}', true)"
              class="py-2 px-3 rounded-xl bg-slate-800 hover:bg-rose-600/80 text-slate-300 hover:text-white text-xs font-medium transition"
              title="无视当前运行状态，直接强制重启容器">
              🔄 强制重启
            </button>
          </div>
        </div>
      \`).join('');
    }

    function renderHistory(history, kvEnabled) {
      const container = document.getElementById('historyContainer');

      if (!kvEnabled) {
        container.innerHTML = \`
          <div class="text-center py-6 text-xs text-slate-400 bg-slate-950/50 rounded-xl border border-slate-800/70">
            💡 尚未绑定 Cloudflare KV。请在 Worker 设置的 <b>Bindings</b> 中添加变量名为 <code class="text-indigo-300 px-1 py-0.5 bg-slate-800 rounded">WAKE_KV</code> 的 KV 命名空间以开启历史记录。
          </div>\`;
        return;
      }

      if (!history || history.length === 0) {
        container.innerHTML = \`
          <div class="text-center py-6 text-xs text-slate-400 bg-slate-950/50 rounded-xl border border-slate-800/70">
            暂无保活执行记录，点击上方「⚡ 智能唤醒全部」或等待 Cron 定时触发后将在此显示。
          </div>\`;
        return;
      }

      container.innerHTML = history.map((item, idx) => {
        const isCron = item.type === 'cron';
        const typeBadge = isCron
          ? '<span class="px-2 py-0.5 rounded text-xs bg-sky-500/15 text-sky-300 border border-sky-500/30">🤖 定时巡检</span>'
          : \`<span class="px-2 py-0.5 rounded text-xs bg-purple-500/15 text-purple-300 border border-purple-500/30">🖐 手动操作\${item.force ? ' (强制)' : ''}</span>\`;

        const statusDot = item.allSuccess
          ? '<span class="text-emerald-400 text-xs font-medium">✅ 全部成功</span>'
          : '<span class="text-rose-400 text-xs font-medium">⚠️ 存在异常</span>';

        const s = item.summary || { restarted: 0, skipped: 0, failed: 0 };
        const detailsHtml = (item.results || []).map(r => {
          const icon = r.action === 'restarted' ? '🔄 已唤醒' : (r.action === 'skipped' ? '🟢 跳过' : '❌ 失败');
          return \`<span class="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-900 border border-slate-800 text-xs text-slate-300">
            <b>\${r.repoId}</b>: \${icon} (\${r.stage || 'ERROR'})
          </span>\`;
        }).join('');

        return \`
          <details class="group bg-slate-950/60 border border-slate-800/80 rounded-xl overflow-hidden">
            <summary class="px-4 py-3 cursor-pointer hover:bg-slate-900/60 transition flex flex-wrap items-center justify-between gap-2 list-none">
              <div class="flex flex-wrap items-center gap-2.5">
                \${typeBadge}
                <span class="text-xs font-mono text-slate-300">⏰ \${item.timestamp}</span>
                <span class="text-xs text-slate-400">\${item.reason || ''}</span>
              </div>
              <div class="flex items-center gap-3 text-xs">
                <span class="text-indigo-300">唤醒 <b>\${s.restarted}</b></span>
                <span class="text-emerald-400">跳过 <b>\${s.skipped}</b></span>
                \${s.failed > 0 ? \`<span class="text-rose-400">失败 <b>\${s.failed}</b></span>\` : ''}
                \${statusDot}
                <span class="text-slate-500 group-open:rotate-180 transition-transform">▼</span>
              </div>
            </summary>
            <div class="px-4 py-3 bg-slate-950 border-t border-slate-800/60 flex flex-wrap gap-2">
              \${detailsHtml}
            </div>
          </details>
        \`;
      }).join('');
    }

    async function triggerWake(repoId, force) {
      const targetName = repoId ? repoId : '全部 Space';
      const actionName = force ? '强制重启' : '智能唤醒';
      const reason = (reasonInput && reasonInput.value.trim()) || \`Web面板-\${actionName}\`;

      showToast(\`⏳ 正在对 [\${targetName}] 执行\${actionName}...\`, false);

      const params = new URLSearchParams({
        reason,
        user: 'WebDashboard',
        force: force ? 'true' : 'false',
      });
      if (repoId) params.set('repo', repoId);

      try {
        const res = await fetch(\`/wake?\${params.toString()}\`, { headers: getHeaders() });
        const data = await res.json();

        if (!res.ok || data.error) {
          throw new Error(data.error || '操作请求失败');
        }

        const { restarted, skipped, failed } = data.summary || {};
        showToast(
          \`✅ [\${targetName}] 处理完成：已唤醒 \${restarted} 个，运行中跳过 \${skipped} 个，失败 \${failed} 个。\`,
          failed > 0
        );

        await fetchStatus();
      } catch (err) {
        showToast(\`❌ 操作失败：\${err.message}\`, true);
      }
    }

    async function clearHistoryLogs() {
      if (!confirm('确定要清空最近 10 次保活历史记录吗？')) return;
      try {
        const res = await fetch('/api/logs/clear', { method: 'POST', headers: getHeaders() });
        if (!res.ok) throw new Error('清空失败，请检查密钥权限');
        showToast('🗑️ 历史记录已清空');
        await fetchStatus();
      } catch (err) {
        showToast(err.message, true);
      }
    }

    fetchStatus();
  </script>
</body>
</html>`;
}
