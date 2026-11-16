// Bot Telegram cho unity-build-server, chạy trên Cloudflare Workers (miễn phí).
// Dán nguyên file này vào trình soạn code của Worker trên dashboard Cloudflare.
//
// Cần cấu hình trong Worker → Settings:
//   KV binding:   DB                  (một KV namespace bất kỳ)
//   Secret:       TELEGRAM_BOT_TOKEN  (token từ @BotFather)
//   Secret:       GH_TOKEN            (GitHub token có quyền Actions: Read and write trên repo build)
//   Variable:     GH_REPO             (vd: namdev26/unity-build-server)
//   Variable:     WEBHOOK_SECRET      (chuỗi ngẫu nhiên bất kỳ, chỉ gồm chữ, số, _ và -)
// Sau đó mở https://<tên-worker>.<tài-khoản>.workers.dev/setup một lần để nối bot với Worker.

const WORKFLOW_FILE = "build-android.yml";
const NAME_RE = /^[a-z0-9_]{2,20}$/;

const HELP = `<b>Unity Build Bot</b>

<b>Khai báo game</b> (một lần mỗi game)
/addgame &lt;tên&gt; &lt;owner/repo&gt; [nhánh] [thư mục project]
vd: <code>/addgame onepunch thanhndsomia/Somia---Ragdoll_One_Punch main</code>
/games – danh sách game
/removegame &lt;tên&gt;

<b>Build</b>
/build – chọn game bằng nút bấm
/build &lt;tên&gt; [nhánh] [debug|release] [apk|aab]
vd: <code>/build onepunch Nam-Dev debug</code>
/status – các lần build gần đây

<b>Quyền dùng bot</b>
/myid – xem chat id
/allow &lt;chat_id&gt; – cho phép người/nhóm khác dùng bot
/disallow &lt;chat_id&gt;`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") return setupWebhook(url, env);

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      try {
        await handleUpdate(update, env);
      } catch (e) {
        const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
        if (chatId) await send(env, chatId, `⚠️ Lỗi bot: ${escapeHtml(String(e.message || e))}`);
      }
      return new Response("ok");
    }

    return new Response("Unity Build Bot đang chạy.");
  },
};

async function setupWebhook(url, env) {
  const missing = ["TELEGRAM_BOT_TOKEN", "GH_TOKEN", "GH_REPO", "WEBHOOK_SECRET"].filter((k) => !env[k]);
  if (!env.DB) missing.push("KV binding DB");
  if (missing.length) return new Response("Thiếu cấu hình: " + missing.join(", "), { status: 500 });

  const hook = `${url.origin}/telegram`;
  const res = await tg(env, "setWebhook", {
    url: hook,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
  await tg(env, "setMyCommands", {
    commands: [
      { command: "build", description: "Build một game" },
      { command: "games", description: "Danh sách game" },
      { command: "addgame", description: "Khai báo game mới" },
      { command: "status", description: "Các lần build gần đây" },
      { command: "help", description: "Hướng dẫn" },
    ],
  });
  return new Response(res.ok ? `Đã nối bot với ${hook}. Mở Telegram và gửi /start cho bot.` : JSON.stringify(res), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// ---------- Xử lý tin nhắn ----------

async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();

  if (cmd === "/myid") return send(env, chatId, `Chat id: <code>${chatId}</code>`);

  // Người đầu tiên gửi /start sẽ thành chủ bot.
  const allowed = await getAllowed(env);
  if (allowed.length === 0 && cmd === "/start") {
    await env.DB.put("allowed", JSON.stringify([String(chatId)]));
    return send(env, chatId, `✅ Bạn là chủ bot (chat id <code>${chatId}</code>).\n\n${HELP}`);
  }
  if (!allowed.includes(String(chatId))) {
    return send(env, chatId, `⛔ Chat này chưa được phép dùng bot.\nNhờ chủ bot gửi: <code>/allow ${chatId}</code>`);
  }

  switch (cmd) {
    case "/start":
    case "/help":
      return send(env, chatId, HELP);
    case "/allow":
      return changeAllowed(env, chatId, args[0], true);
    case "/disallow":
      return changeAllowed(env, chatId, args[0], false);
    case "/addgame":
      return addGame(env, chatId, args);
    case "/removegame":
      return removeGame(env, chatId, args[0]);
    case "/games":
      return listGames(env, chatId);
    case "/build":
      return args.length ? buildFromArgs(env, chatId, args, msg.from) : pickGame(env, chatId);
    case "/status":
      return showStatus(env, chatId);
    default:
      return send(env, chatId, "Không hiểu lệnh. Gửi /help để xem hướng dẫn.");
  }
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const allowed = await getAllowed(env);
  if (!allowed.includes(String(chatId))) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Chat này chưa được phép dùng bot." });
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });

  const [kind, name, type, exportType] = cb.data.split("|");
  if (kind === "g") return pickType(env, chatId, name);
  if (kind === "b") {
    const game = await getGame(env, name);
    if (!game) return send(env, chatId, `Không có game <b>${escapeHtml(name)}</b>.`);
    return dispatchBuild(env, chatId, name, game, game.branch, type, exportType, cb.from);
  }
}

// ---------- Quyền ----------

async function getAllowed(env) {
  return JSON.parse((await env.DB.get("allowed")) || "[]");
}

async function changeAllowed(env, chatId, target, add) {
  if (!target || !/^-?\d+$/.test(target)) return send(env, chatId, "Cú pháp: /allow &lt;chat_id&gt; (lấy bằng /myid)");
  const list = await getAllowed(env);
  if (add && !list.includes(target)) list.push(target);
  if (!add) {
    if (target === String(chatId)) return send(env, chatId, "Không thể tự xoá chính mình.");
    const i = list.indexOf(target);
    if (i >= 0) list.splice(i, 1);
  }
  await env.DB.put("allowed", JSON.stringify(list));
  return send(env, chatId, `${add ? "✅ Đã cho phép" : "🚫 Đã bỏ quyền"} <code>${target}</code>.`);
}

// ---------- Game ----------

function parseRepo(input) {
  if (!input) return null;
  const m = input.replace(/\.git$/, "").match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function getGame(env, name) {
  const raw = await env.DB.get(`game:${name}`);
  return raw ? JSON.parse(raw) : null;
}

async function addGame(env, chatId, [name, repoInput, branch, projectPath]) {
  name = (name || "").toLowerCase();
  const repo = parseRepo(repoInput);
  if (!NAME_RE.test(name) || !repo) {
    return send(
      env,
      chatId,
      "Cú pháp: /addgame &lt;tên&gt; &lt;owner/repo&gt; [nhánh] [thư mục project]\n" +
        "Tên chỉ gồm chữ thường, số, dấu _ (2–20 ký tự).\n" +
        "vd: <code>/addgame onepunch thanhndsomia/Somia---Ragdoll_One_Punch main</code>"
    );
  }
  const game = { repo, branch: branch || "main", path: projectPath || "" };
  await env.DB.put(`game:${name}`, JSON.stringify(game));
  return send(
    env,
    chatId,
    `✅ Đã lưu <b>${name}</b>\nRepo: ${repo}\nNhánh mặc định: ${game.branch}` +
      (game.path ? `\nThư mục project: ${escapeHtml(game.path)}` : "") +
      `\n\nBuild ngay: /build ${name}`
  );
}

async function removeGame(env, chatId, name) {
  if (!name) return send(env, chatId, "Cú pháp: /removegame &lt;tên&gt;");
  await env.DB.delete(`game:${name.toLowerCase()}`);
  return send(env, chatId, `🗑 Đã xoá <b>${escapeHtml(name)}</b>.`);
}

async function allGames(env) {
  const list = await env.DB.list({ prefix: "game:" });
  const games = [];
  for (const k of list.keys) {
    const g = await getGame(env, k.name.slice(5));
    if (g) games.push({ name: k.name.slice(5), ...g });
  }
  return games;
}

async function listGames(env, chatId) {
  const games = await allGames(env);
  if (!games.length) return send(env, chatId, "Chưa có game nào. Thêm bằng /addgame");
  const lines = games.map((g) => `• <b>${g.name}</b> – ${g.repo} (${g.branch})${g.path ? " · " + escapeHtml(g.path) : ""}`);
  return send(env, chatId, lines.join("\n"));
}

// ---------- Build ----------

async function pickGame(env, chatId) {
  const games = await allGames(env);
  if (!games.length) return send(env, chatId, "Chưa có game nào. Thêm bằng /addgame");
  const rows = [];
  for (let i = 0; i < games.length; i += 2) {
    rows.push(games.slice(i, i + 2).map((g) => ({ text: g.name, callback_data: `g|${g.name}` })));
  }
  return send(env, chatId, "Chọn game cần build:", { inline_keyboard: rows });
}

async function pickType(env, chatId, name) {
  const game = await getGame(env, name);
  if (!game) return send(env, chatId, `Không có game <b>${escapeHtml(name)}</b>.`);
  return send(env, chatId, `<b>${name}</b> · nhánh ${escapeHtml(game.branch)}\nChọn kiểu build:`, {
    inline_keyboard: [
      [{ text: "Debug APK", callback_data: `b|${name}|debug|apk` }],
      [
        { text: "Release APK", callback_data: `b|${name}|release|apk` },
        { text: "Release AAB", callback_data: `b|${name}|release|aab` },
      ],
    ],
  });
}

async function buildFromArgs(env, chatId, args, from) {
  const name = args[0].toLowerCase();
  const game = await getGame(env, name);
  if (!game) return send(env, chatId, `Không có game <b>${escapeHtml(name)}</b>. Xem /games`);

  let branch = game.branch;
  let type = "debug";
  let exportType = "apk";
  for (const a of args.slice(1)) {
    const v = a.toLowerCase();
    if (v === "debug" || v === "release") type = v;
    else if (v === "apk" || v === "aab") exportType = v;
    else branch = a;
  }
  return dispatchBuild(env, chatId, name, game, branch, type, exportType, from);
}

async function dispatchBuild(env, chatId, name, game, branch, type, exportType, from) {
  const res = await gh(env, `/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      ref: "main",
      inputs: {
        game: name,
        repo: game.repo,
        branch,
        build_type: type,
        export: exportType,
        project_path: game.path || "",
        chat_id: String(chatId),
      },
    }),
  });
  if (res.status !== 204) {
    const body = await res.text();
    return send(env, chatId, `❌ Không gửi được lệnh build (GitHub ${res.status}).\n<code>${escapeHtml(body.slice(0, 300))}</code>`);
  }
  const who = from?.first_name ? ` · bởi ${escapeHtml(from.first_name)}` : "";
  return send(
    env,
    chatId,
    `🚀 Đã gửi lệnh build <b>${name}</b> · ${escapeHtml(branch)} · ${type} · ${exportType}${who}\nBot sẽ báo khi bắt đầu và khi xong.`
  );
}

async function showStatus(env, chatId) {
  const res = await gh(env, `/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5`);
  if (!res.ok) return send(env, chatId, `Không đọc được trạng thái (GitHub ${res.status}).`);
  const data = await res.json();
  if (!data.workflow_runs?.length) return send(env, chatId, "Chưa có lần build nào.");
  const icon = (r) =>
    r.status !== "completed" ? "⏳" : r.conclusion === "success" ? "✅" : r.conclusion === "cancelled" ? "⏹" : "❌";
  const lines = data.workflow_runs.map(
    (r) => `${icon(r)} <a href="${r.html_url}">${escapeHtml(r.display_title)}</a> · ${toVnTime(r.created_at)}`
  );
  return send(env, chatId, lines.join("\n"));
}

// ---------- Tiện ích ----------

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GH_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "unity-build-bot",
      "Content-Type": "application/json",
    },
  });
}

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function send(env, chatId, text, replyMarkup) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toVnTime(iso) {
  return new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}
