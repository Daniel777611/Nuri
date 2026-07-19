// Local-only data adapter used by `npm run preview`. It lets designers review
// every route and interaction without starting or changing the backend.

export const isPreviewMode = process.env.EXPO_PUBLIC_PREVIEW_MODE === "1";

let profile = {
  id: "preview-parent",
  email: "preview@nuri.app",
  nickname: "Momo妈妈",
  city: "Toronto",
  onboarding_completed: false,
  top_concerns: ["sleep"],
};

let children = [
  { id: "child-1", nickname: "小满", birth_date: "2024-03-01", gender: "other", allergies: [], notes: "" },
];

let tasks = [
  {
    id: "task-1", title: "今天给自己留30分钟独处", task_type: "selfcare", scope: "today",
    progress_done: 0, progress_total: 1, completed_at: null, due_date: "2026-07-15",
    description: "给自己一点不被打扰的时间，充电后再继续照顾家人。", steps: ["找一个舒服的角落", "做一件能让你放松的小事"],
    source: "NURI 建议", created_at: "2026-07-15T09:00:00.000Z", is_favorited: false,
  },
  {
    id: "task-2", title: "每日户外活动20分钟", task_type: "interaction", scope: "week",
    progress_done: 2, progress_total: 5, completed_at: null, due_date: "2026-07-19",
    description: "一起出门走走，观察身边的新鲜事物。", steps: ["选择安全的步行路线", "让孩子选一个想看的东西"],
    source: "NURI 建议", created_at: "2026-07-14T09:00:00.000Z", is_favorited: false,
  },
  {
    id: "task-3", title: "记录一次孩子的新表达", task_type: "observation", scope: "today",
    progress_done: 1, progress_total: 1, completed_at: "2026-07-14T18:30:00.000Z", due_date: "2026-07-14",
    description: "写下一句让你印象深刻的话。", steps: ["记录原话", "记下当时的情境"],
    source: "NURI 建议", created_at: "2026-07-14T09:00:00.000Z", is_favorited: false,
  },
];

const card = {
  id: "card-1", type: "tip", type_label: "育儿小贴士", title: "如何帮孩子建立稳定的睡前仪式？",
  body: "固定而温柔的睡前步骤，能让孩子知道一天即将结束。可以从洗漱、读一本书、说一句晚安开始，不需要复杂，关键是每天大致一致。",
  tags: ["睡眠", "亲子互动", "日常习惯"], hook_line: "从今晚开始，试试只保留一个最容易坚持的步骤。",
};
let favorites: any[] = [card];
let privacy = { allow_history_training: true, daily_push: true, anonymous_community_share: false, language: "zh" };
let sessions = [{ id: "chat-1", title: "聊聊小满最近的睡眠", created_at: "2026-07-15T08:30:00.000Z" }];
let messages: Record<string, any[]> = {
  "chat-1": [
    { id: "msg-1", role: "ai", text: "早上好，Momo妈妈。昨晚小满睡得怎么样？", quick_replies: ["入睡有点困难", "睡得不错", "想聊聊别的问题"] },
  ],
};

const bodyOf = (init?: RequestInit): any => {
  try { return init?.body ? JSON.parse(String(init.body)) : {}; } catch { return {}; }
};
const id = (prefix: string) => `${prefix}-${Date.now()}`;

export async function previewRequest(path: string, init?: RequestInit): Promise<any> {
  const method = init?.method || "GET";
  const body = bodyOf(init);

  if (path === "/auth/register" || path === "/auth/login") {
    profile = { ...profile, email: body.email || profile.email };
    return { access_token: "preview-token", user: profile };
  }
  if (path === "/auth/me" && method === "PUT") return (profile = { ...profile, ...body });
  if (path === "/auth/me") return profile;

  if (path === "/children" && method === "GET") return children;
  if (path === "/children" && method === "POST") {
    const next = { ...body, id: id("child") }; children = [...children, next]; return next;
  }
  if (path.startsWith("/children/") && method === "PUT") {
    const childId = path.split("/").pop()!; children = children.map((c) => c.id === childId ? { ...c, ...body } : c); return children.find((c) => c.id === childId);
  }
  if (path.startsWith("/children/") && method === "DELETE") { children = children.filter((c) => c.id !== path.split("/").pop()); return {}; }

  if (path.startsWith("/tasks") && method === "GET") return tasks;
  if (path === "/tasks" && method === "POST") {
    const next = { id: id("task"), title: body.title || "NURI 建议任务", task_type: body.task_type || "observation", scope: body.scope || "today", progress_done: 0, progress_total: body.progress_total || 1, completed_at: null, due_date: body.due_date || new Date().toISOString().slice(0, 10), description: body.description || "", steps: body.steps || [], source: "NURI 对话", created_at: new Date().toISOString(), is_favorited: false };
    tasks = [next, ...tasks]; return next;
  }
  if (path.startsWith("/tasks/") && method === "PATCH") {
    const taskId = path.split("/").pop()!;
    tasks = tasks.map((t) => t.id === taskId ? {
      ...t, ...body,
      progress_done: body.done ? Math.min(t.progress_total, t.progress_done + 1) : t.progress_done,
      completed_at: body.done && (!t.scope || t.scope === "today" || t.progress_done + 1 >= t.progress_total) ? new Date().toISOString() : t.completed_at,
      reflection: body.mood ? { mood: body.mood } : (t as any).reflection,
    } : t);
    return tasks.find((t) => t.id === taskId);
  }
  if (path.startsWith("/tasks/") && method === "DELETE") { tasks = tasks.filter((t) => t.id !== path.split("/").pop()); return {}; }
  if (path === "/tasks/clear-completed") { tasks = tasks.filter((t) => !t.completed_at); return {}; }
  if (path === "/tasks/insights") return { streak_days: 17 };

  if (path.startsWith("/feed/") && path.endsWith("/detail")) return { ...card, id: path.split("/")[2] };
  if (path === "/feed" || path.startsWith("/feed?")) return [card];
  if (path.startsWith("/feed/search") || path.startsWith("/feed/alt")) return [card];
  if (path === "/feed/generate") return [card];
  if (path === "/favorites" && method === "GET") return favorites;
  if (path === "/favorites/toggle") {
    const cardId = body.card_id; const exists = favorites.some((f) => f.id === cardId);
    favorites = exists ? favorites.filter((f) => f.id !== cardId) : [...favorites, { ...card, id: cardId }];
    return { favorited: !exists };
  }
  if (path === "/favorites/save") return {};

  if (path === "/privacy" && method === "GET") return privacy;
  if (path === "/privacy" && method === "PUT") return (privacy = { ...privacy, ...body });
  if (path === "/privacy/wipe") return {};

  if (path === "/chat/sessions" && method === "GET") return sessions;
  if (path === "/chat/sessions" && method === "POST") {
    const next = { id: id("chat"), title: body.title || "和 NURI 的新对话", created_at: new Date().toISOString() };
    sessions = [next, ...sessions]; messages[next.id] = [{ id: id("msg"), role: "ai", text: "你好，我在这里。今天想聊聊什么？" }]; return next;
  }
  if (/^\/chat\/sessions\/[^/]+$/.test(path) && method === "DELETE") { const sessionId = path.split("/").pop()!; sessions = sessions.filter((s) => s.id !== sessionId); delete messages[sessionId]; return {}; }
  if (/^\/chat\/sessions\/[^/]+\/messages$/.test(path) && method === "GET") return messages[path.split("/")[3]] || [];
  if (/^\/chat\/sessions\/[^/]+\/messages$/.test(path) && method === "POST") {
    const sessionId = path.split("/")[3]; const user_message = { id: id("msg"), role: "user", text: body.text || "[图片]" };
    const ai = { id: id("msg"), role: "ai", text: "NURI 为你整理出了 2 条辅助计划，是否加入您的任务日志？", transition: { kind: "task_suggestion", tasks: [
      { title: "尝试鲜虾并观察宝宝食欲", task_type: "observation", scope: "today", description: "从少量开始尝试，观察孩子的接受度与身体反应。", steps: ["鲜虾处理干净，少量尝试", "记录宝宝的食欲与反应"] },
      { title: "记录一周饮食偏好", task_type: "observation", scope: "week", progress_total: 7, description: "连续记录一周，寻找孩子更容易接受的食物与用餐节奏。", steps: ["每天记录一餐", "标记愿意尝试的新食物"] },
    ] } };
    messages[sessionId] = [...(messages[sessionId] || []), user_message, ai]; return { user_message, ai_messages: [ai] };
  }

  if (path === "/collections" && method === "GET") return [];
  if (path === "/analytics") return {};
  return {};
}
