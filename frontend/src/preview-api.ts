// Local-only data adapter used by `npm run preview`. It lets designers review
// every route and interaction without starting or changing the backend.

export const isPreviewMode = process.env.EXPO_PUBLIC_PREVIEW_MODE === "1";

let profile = {
  id: "preview-parent",
  email: "preview@nuri.app",
  nickname: "Momo妈妈",
  city: "Toronto",
  onboarding_completed: true,
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
const learningCards: any[] = [
  {
    id: "learn_sleep_routine",
    topic: "sleep",
    topic_label: "睡眠与作息",
    type: "tip",
    type_label: "对话精选",
    publisher: "AAP 美国儿科学会",
    title: "孩子夜醒或入睡困难，可以先从固定睡前节奏开始",
    summary: "把睡前半小时变得可预期，并观察夜醒后的回应方式是否一致。",
    body: "孩子的睡眠很少靠某一个技巧立刻改变。可以先把每天睡前的顺序变得简单、温和、可重复，例如洗漱、调暗灯光、读一本书、拥抱和晚安。连续记录三到七晚，观察入睡时间、夜醒次数、白天小睡和当天是否有明显变化。",
    tags: ["#睡眠", "#夜醒", "#睡前仪式"],
    hook_line: "下面的文章和视频可以帮助你把方法做得更具体。",
    resources: [
      { id: "sleep-aap-article", kind: "article", title: "Toddler Bedtime Trouble: 7 Tips for Parents", publisher: "AAP · HealthyChildren.org", language: "英文文章", description: "美国儿科学会给幼儿家庭的睡前困难应对建议。", url: "https://www.healthychildren.org/English/healthy-living/sleep/Pages/bedtime-trouble.aspx" },
      { id: "sleep-aap-video", kind: "video", title: "Smart Solutions for Safe and Sound Sleep", publisher: "AAP 官方 YouTube 频道", language: "英文视频", description: "儿科专家讲解安全睡眠与常见睡眠问题。", url: "https://www.youtube.com/watch?v=gn1bbzLU2rg" },
    ],
  },
  {
    id: "learn_big_feelings", topic: "emotion", topic_label: "情绪调节", type: "tip", type_label: "对话精选", publisher: "AAP 与 UNICEF",
    title: "孩子有“大情绪”时，先共调节，再教他表达", summary: "把哭闹、生气或害怕看作需要帮助的信号，而不是故意为难大人。",
    body: "幼儿还不能独自完成复杂的情绪调节。先降低声音、靠近并保证安全，再用很短的话替孩子命名感受。共情不等于取消规则，你可以同时理解感受并守住安全边界。",
    tags: ["#情绪", "#共调节", "#亲子沟通"], hook_line: "先理解情绪发生了什么，再选择适合你家的回应。",
    resources: [
      { id: "emotion-aap-article", kind: "article", title: "Helping Little People Manage Big Feelings", publisher: "AAP · HealthyChildren.org", language: "英文文章", description: "帮助幼儿识别和管理强烈情绪的儿科建议。", url: "https://www.healthychildren.org/English/family-life/family-dynamics/Pages/helping-little-people-manage-big-feelings.aspx" },
      { id: "emotion-unicef-video", kind: "video", title: "How to Build Your Baby's Mental Health", publisher: "UNICEF 官方 YouTube 频道", language: "英文视频", description: "介绍照顾者回应如何支持婴幼儿心理健康。", url: "https://www.youtube.com/watch?v=dp2NKV0C7_k" },
    ],
  },
  {
    id: "learn_picky_eating", topic: "food", topic_label: "挑食与营养", type: "tip", type_label: "对话精选", publisher: "AAP 与 UNICEF",
    title: "面对挑食，先减少餐桌压力，再增加接触机会", summary: "新食物可以重复出现，但不把“必须吃一口”变成每餐的冲突。",
    body: "照顾者负责提供规律、相对均衡的选择，孩子决定吃不吃以及吃多少。把熟悉食物和少量新食物放在同一餐里，先允许孩子看、闻、碰，不急着要求吞下。",
    tags: ["#挑食", "#营养", "#餐桌关系"], hook_line: "从可信儿科资源里挑一个最容易执行的改变。",
    resources: [
      { id: "food-aap-article", kind: "article", title: "How Do I Help My Picky Eater Try More Healthy Foods?", publisher: "AAP · HealthyChildren.org", language: "英文文章", description: "关于重复接触、用餐结构和家长分工的实用建议。", url: "https://www.healthychildren.org/english/tips-tools/ask-the-pediatrician/pages/how-do-i-help-my-picky-eater-try-more-foods.aspx" },
      { id: "food-aap-video", kind: "video", title: "Tips for Feeding Picky Eaters", publisher: "AAP 官方 YouTube 频道", language: "英文视频", description: "儿科医生演示如何降低进餐压力。", url: "https://www.youtube.com/watch?v=s1KvNv4Jxqw" },
    ],
  },
  {
    id: "learn_serve_and_return", topic: "connection", topic_label: "亲子互动", type: "tip", type_label: "对话精选", publisher: "哈佛大学儿童发展中心",
    title: "不知道怎么高质量陪伴？试试“发球与回应”", summary: "跟随孩子正在关注的事物回应几轮，短时间也能形成真实连接。",
    body: "孩子看向、指向、发声或提出问题，就像向你发球；你注意到并回应，再等待他的下一次反应，就形成了来回互动。这可以发生在换衣、吃饭、散步或读绘本时。",
    tags: ["#亲子互动", "#陪伴", "#发球与回应"], hook_line: "看一遍示范视频，今天就能在日常里练习。",
    resources: [
      { id: "connection-harvard-article", kind: "article", title: "5 Steps for Brain-Building Serve and Return", publisher: "Harvard Center on the Developing Child", language: "英文 / 西班牙文文章", description: "用五个步骤解释如何形成来回互动。", url: "https://developingchild.harvard.edu/resources/briefs/5-steps-for-brain-building-serve-and-return/" },
      { id: "connection-harvard-video", kind: "video", title: "How-to: 5 Steps for Brain-Building Serve and Return", publisher: "Harvard Center on the Developing Child", language: "英文 / 西班牙文视频", description: "通过画面示范照顾者如何观察、回应并轮流互动。", url: "https://developingchild.harvard.edu/resources/videos/how-to-5-steps-for-brain-building-serve-and-return/" },
    ],
  },
];
const previewLocalizedResources: Record<string, any[]> = {
  learn_sleep_routine: [
    { id: "sleep-zh-cn-article", kind: "article", title: "摇篮曲之一：建立睡眠常规", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "简体中文", locales: ["zh-CN"], description: "说明婴幼儿睡眠周期、夜醒回应及建立睡前常规的方法。", url: "https://www.fhs.gov.hk/sc_chi/health_info/child/13043.html" },
    { id: "sleep-zh-cn-video", kind: "video", title: "建立睡前常规", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "普通话影片 · 简体剧本", locales: ["zh-CN"], description: "示范固定、平静而可重复的睡前步骤。", url: "https://www.fhs.gov.hk/sc_chi/mulit_med/000015.html" },
    { id: "sleep-zh-tw-article", kind: "article", title: "搖籃曲之一：建立睡眠常規", publisher: "香港衞生署家庭健康服務", language: "繁體中文", locales: ["zh-TW"], description: "說明嬰幼兒睡眠週期、夜醒回應及建立睡前常規的方法。", url: "https://www.fhs.gov.hk/tc_chi/health_info/child/13043.html" },
    { id: "sleep-zh-tw-video", kind: "video", title: "建立睡前常規", publisher: "香港衞生署家庭健康服務", language: "粵語影片 · 繁體文字稿", locales: ["zh-TW"], description: "示範固定而可重複的睡前步驟。", url: "https://www.fhs.gov.hk/tc_chi/mulit_med/000015.html" },
  ],
  learn_big_feelings: [
    { id: "emotion-zh-cn-article", kind: "article", title: "培育高“EQ”孩子从零岁开始", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "简体中文", locales: ["zh-CN"], description: "用观察、转换角度和表达同感协助孩子调节情绪。", url: "https://www.fhs.gov.hk/sc_chi/health_info/child/30159.html" },
    { id: "emotion-zh-cn-video", kind: "video", title: "“情绪导航”小秘诀（婴幼儿篇）", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "普通话影片 · 简体剧本", locales: ["zh-CN"], description: "示范如何理解、接纳孩子的情绪并表达同感。", url: "https://www.fhs.gov.hk/sc_chi/mulit_med/000114.html" },
    { id: "emotion-zh-tw-article", kind: "article", title: "培育高「EQ」孩子從零歲開始", publisher: "香港衞生署家庭健康服務", language: "繁體中文", locales: ["zh-TW"], description: "用觀察、轉換角度和表達同感協助孩子調節情緒。", url: "https://www.fhs.gov.hk/tc_chi/health_info/child/30159.html" },
    { id: "emotion-zh-tw-video", kind: "video", title: "「情緒導航」小秘訣（嬰幼兒篇）", publisher: "香港衞生署家庭健康服務", language: "粵語影片 · 繁體文字稿", locales: ["zh-TW"], description: "示範如何理解、接納孩子的情緒並表達同感。", url: "https://www.fhs.gov.hk/tc_chi/mulit_med/000114.html" },
  ],
  learn_picky_eating: [
    { id: "food-zh-cn-article", kind: "article", title: "孩子“偏食”怎么办？", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "简体中文", locales: ["zh-CN"], description: "建议重复提供新食物、不强迫进食。", url: "https://www.fhs.gov.hk/sc_chi/health_info/child/20033.html" },
    { id: "food-zh-cn-video", kind: "video", title: "孩子偏食，应该怎样处理？", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "普通话影片 · 简体剧本", locales: ["zh-CN"], description: "说明如何降低进餐压力并增加接触机会。", url: "https://www.fhs.gov.hk/sc_chi/health_info/faq/child_health/GN1_2_4_2.html" },
    { id: "food-zh-tw-article", kind: "article", title: "孩子「偏食」怎麼辦？", publisher: "香港衞生署家庭健康服務", language: "繁體中文", locales: ["zh-TW"], description: "建議重複提供新食物、不強迫進食。", url: "https://www.fhs.gov.hk/tc_chi/health_info/child/20033.html" },
    { id: "food-zh-tw-video", kind: "video", title: "孩子偏食，應該怎樣處理？", publisher: "香港衞生署家庭健康服務", language: "粵語影片 · 繁體文字稿", locales: ["zh-TW"], description: "說明如何降低進餐壓力並增加接觸機會。", url: "https://www.fhs.gov.hk/tc_chi/health_info/faq/child_health/GN1_2_4_2.html" },
  ],
  learn_serve_and_return: [
    { id: "connection-zh-cn-article", kind: "article", title: "亲子沟通——给一岁前婴儿的家长", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "简体中文", locales: ["zh-CN"], description: "说明如何观察宝宝信号、回应并轮流互动。", url: "https://www.fhs.gov.hk/sc_chi/health_info/child/13046.html" },
    { id: "connection-zh-cn-video", kind: "video", title: "亲子沟通（四至六个月）", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "普通话影片 · 简体剧本", locales: ["zh-CN"], description: "示范观察、回应和来回互动。", url: "https://www.fhs.gov.hk/sc_chi/mulit_med/000025.html" },
    { id: "connection-zh-tw-article", kind: "article", title: "親子溝通——給一歲前嬰兒的家長", publisher: "香港衞生署家庭健康服務", language: "繁體中文", locales: ["zh-TW"], description: "說明如何觀察寶寶訊號、回應並輪流互動。", url: "https://www.fhs.gov.hk/tc_chi/health_info/child/13046.html" },
    { id: "connection-zh-tw-video", kind: "video", title: "親子溝通（四至六個月）", publisher: "香港衞生署家庭健康服務", language: "粵語影片 · 繁體文字稿", locales: ["zh-TW"], description: "示範觀察、回應和來回互動。", url: "https://www.fhs.gov.hk/tc_chi/mulit_med/000025.html" },
  ],
};
for (const learningCard of learningCards) {
  const englishResources = (learningCard.resources || []).map((resource: any) => ({
    ...resource,
    locales: resource.language?.includes("西班牙") ? ["en", "es"] : ["en"],
  }));
  learningCard.resources = [
    ...(previewLocalizedResources[learningCard.id] || []),
    ...englishResources,
  ];
}
function orderPreviewResources(resources: any[], language: string) {
  const preferred = language === "zh" ? "zh-CN" : language;
  const localeOrder = preferred === "zh-TW"
    ? ["zh-TW", "zh-CN", "en"]
    : preferred === "en"
      ? ["en", "zh-CN", "zh-TW"]
      : ["zh-CN", "zh-TW", "en"];
  return resources
    .map((resource, index) => ({ resource, index }))
    .sort((left, right) => {
      const leftRank = Math.min(...left.resource.locales.map((locale: string) => {
        const rank = localeOrder.indexOf(locale);
        return rank < 0 ? localeOrder.length : rank;
      }));
      const rightRank = Math.min(...right.resource.locales.map((locale: string) => {
        const rank = localeOrder.indexOf(locale);
        return rank < 0 ? localeOrder.length : rank;
      }));
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left.resource.kind !== right.resource.kind) return left.resource.kind === "article" ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ resource }) => resource);
}
let favorites: any[] = [card];
let privacy = { allow_history_training: true, daily_push: true, anonymous_community_share: false, language: "zh-CN" };
let sessions = [
  {
    id: "card-chat-1",
    title: "如何帮孩子建立稳定的睡前仪式？",
    source_card_id: "card-1",
    created_at: "2026-07-16T08:30:00.000Z",
  },
  {
    id: "chat-1",
    title: "聊聊小满最近的睡眠",
    source_card_id: null,
    created_at: "2026-07-15T08:30:00.000Z",
  },
];
let messages: Record<string, any[]> = {
  "card-chat-1": [
    {
      id: "card-msg-1",
      session_id: "card-chat-1",
      role: "ai",
      text: "固定的睡前步骤会让孩子更容易预期接下来要发生什么。",
      created_at: "2026-07-16T08:31:00.000Z",
    },
  ],
  "chat-1": [
    {
      id: "msg-1",
      session_id: "chat-1",
      role: "ai",
      text: "早上好，Momo妈妈。昨晚小满睡得怎么样？",
      created_at: "2026-07-15T08:31:00.000Z",
    },
    {
      id: "msg-2",
      session_id: "chat-1",
      role: "user",
      text: "小满昨晚还是醒了两次，我该怎么帮他睡得更安稳？",
      created_at: "2026-07-17T08:32:00.000Z",
    },
    {
      id: "msg-3",
      session_id: "chat-1",
      role: "ai",
      text: "我们可以先从固定夜醒后的回应方式开始，连续观察三晚。",
      created_at: "2026-07-17T08:33:00.000Z",
    },
  ],
};

const bodyOf = (init?: RequestInit): any => {
  try { return init?.body ? JSON.parse(String(init.body)) : {}; } catch { return {}; }
};
let idSequence = 0;
const id = (prefix: string) => `${prefix}-${Date.now()}-${++idSequence}`;
const newest = (items: any[]) =>
  [...items].sort((a, b) =>
    `${a?.created_at || ""}:${a?.id || ""}`.localeCompare(
      `${b?.created_at || ""}:${b?.id || ""}`,
    )
  ).pop() || null;
const previewTaskDeclined = (text: string) =>
  /(?:不要|不用|无需|先别|先別|别|別)\s*(?:再\s*)?(?:(?:给|給)?(?:我|我们|我們)?\s*(?:任务|任務|计划|計劃|待办|待辦)|(?:生成|创建|創建|添加|安排|布置|整理成|转成|轉成|做成).{0,5}(?:任务|任務|计划|計劃|待办|待辦))/i.test(text) ||
  /(?:do not|don't|no need to|without).{0,32}(?:tasks?|task cards?|plans?|checklists?)/i.test(text);
const previewTaskMetaOnly = (text: string) =>
  /(?:列出|分析|评价|比較|讲讲|講講|解释|解釋|介绍|介紹).{0,12}(?:任务|任務|计划|計劃).{0,12}(?:优缺点|優缺點|利弊|详情|詳情|细节|細節|内容|內容)?/i.test(text) ||
  /(?:create|make|give|add).{0,24}(?:summary|information|details?|context|explanation).{0,24}(?:plans?|task cards?)/i.test(text) ||
  /(?:tell me about|explain|describe|summarize|add more detail to).{0,32}(?:plans?|task cards?)/i.test(text);
const previewTaskSafetyBlocked = (text: string) =>
  /(?:喘不上气|喘不過氣|不能呼吸|呼吸困难|呼吸困難|昏迷|叫不醒|抽搐|严重出血|嚴重出血|中毒|自杀|自殺|can(?:not|'t) breathe|choking|unconscious|seizure|suicid)/i.test(text);
const previewTaskRequested = (text: string) =>
  !previewTaskDeclined(text) && !previewTaskMetaOnly(text) && !previewTaskSafetyBlocked(text) && (
    /(?:生成|创建|創建|制定|安排|布置|列成|整理成|转成|轉成|做成|添加|给我|給我|我想要|我要|我需要|帮我做|幫我做).{0,16}(?:任务|任務|任务卡|任務卡|计划|計劃|待办|待辦)/i.test(text) ||
    /(?:make|create|generate|give|turn|organize).{0,28}(?:tasks?|task cards?|plans?|checklists?)/i.test(text)
  );
const previewNeedsActionablePlan = (text: string) =>
  !previewTaskDeclined(text) && !previewTaskSafetyBlocked(text) &&
  /(?:怎么办|怎麼辦|怎么做|怎麼做|如何|给.*建议|給.*建議|方案|what should|how (?:can|should)|advice)/i.test(text);
const previewRequestedTaskCount = (text: string) => {
  const words: Record<string, number> = {
    "一": 1, "一个": 1, "一個": 1, one: 1,
    "二": 2, "两": 2, "兩": 2, "两个": 2, "兩個": 2, two: 2,
    "三": 3, "三个": 3, "三個": 3, three: 3,
    "四": 4, "四个": 4, "四個": 4, four: 4,
  };
  const match = text.toLowerCase().match(/(一个|一個|两个|兩個|三个|三個|四个|四個|一|二|两|兩|三|四|[1-4]|one|two|three|four)\s*(?:个|個|条|條|项|項)?\s*(?:任务|任務|任务卡|任務卡|tasks?|task cards?)/i);
  if (!match) return null;
  return Number(match[1]) || words[match[1]] || null;
};

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
    const source = body.source_message_id != null && body.suggestion_index != null
      ? `NURI 对话:${body.source_message_id}:${body.suggestion_index}`
      : "手动添加";
    const existing = tasks.find((task) => task.source === source && source !== "手动添加");
    if (existing) return existing;
    const next = { id: id("task"), title: body.title || "NURI 建议任务", task_type: body.task_type || "observation", scope: body.scope || "today", progress_done: 0, progress_total: body.progress_total || 1, completed_at: null, due_date: body.due_date || new Date().toISOString().slice(0, 10), description: body.description || "", steps: body.steps || [], source, created_at: new Date().toISOString(), is_favorited: false };
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

  if (path.startsWith("/feed/personalized") && method === "GET") {
    const useConversation = privacy.allow_history_training;
    const items = learningCards.map((item, index) => ({
      ...item,
      personalization_reason: useConversation && index === 0
        ? "因为你最近和 NURI 聊到了“睡眠与作息”"
        : useConversation
          ? "NURI 从可信育儿来源中为你补充精选"
          : "你已关闭对话个性化，这是 NURI 的可信来源精选",
      is_conversation_match: useConversation && index === 0,
      related_session_id: useConversation && index === 0 ? "chat-1" : null,
    }));
    return {
      items,
      personalization_mode: useConversation ? "conversation" : "default_privacy",
      matched_topic: useConversation ? "sleep" : null,
      related_session_id: useConversation ? "chat-1" : null,
      generated_at: new Date().toISOString(),
    };
  }
  if (path.startsWith("/feed/") && path.endsWith("/detail")) {
    const contentId = path.split("/")[2];
    const learningCard = learningCards.find((item) => item.id === contentId);
    if (learningCard) {
      const isSleepMatch = privacy.allow_history_training && learningCard.topic === "sleep";
      return {
        ...learningCard,
        resources: orderPreviewResources(learningCard.resources || [], privacy.language),
        personalization_reason: isSleepMatch
          ? "因为你最近和 NURI 聊到了“睡眠与作息”"
          : privacy.allow_history_training
            ? "NURI 从可信育儿来源中为你补充精选"
            : "你已关闭对话个性化，这是 NURI 的可信来源精选",
        is_conversation_match: isSleepMatch,
        related_session_id: isSleepMatch ? "chat-1" : null,
      };
    }
    return { ...card, id: contentId };
  }
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

  if (path === "/chat/main/preview" && method === "GET") {
    const mainSessions = sessions.filter((session) => !session.source_card_id);
    if (!mainSessions.length) {
      return {
        has_conversation: false,
        session_id: null,
        title: null,
        last_activity_at: null,
        last_user_message: null,
        last_message: null,
      };
    }
    const mainIds = new Set(mainSessions.map((session) => session.id));
    const lastUserMessage = newest(
      Object.values(messages).flat().filter(
        (message) => mainIds.has(message.session_id) && message.role === "user",
      ),
    );
    const session = lastUserMessage
      ? mainSessions.find((item) => item.id === lastUserMessage.session_id)!
      : newest(mainSessions);
    const lastMessage = newest(messages[session.id] || []);
    return {
      has_conversation: true,
      session_id: session.id,
      title: session.title,
      last_activity_at: lastMessage?.created_at || session.created_at,
      last_user_message: lastUserMessage
        ? {
            id: lastUserMessage.id,
            text: lastUserMessage.text || "",
            created_at: lastUserMessage.created_at,
          }
        : null,
      last_message: lastMessage
        ? {
            id: lastMessage.id,
            role: lastMessage.role,
            text: lastMessage.text || "",
            created_at: lastMessage.created_at,
          }
        : null,
    };
  }
  if (path === "/chat/sessions" && method === "GET") return sessions;
  if (path === "/chat/sessions" && method === "POST") {
    const next = { id: id("chat"), title: body.title || "和 NURI 的新对话", source_card_id: body.card_id || null, created_at: new Date().toISOString() };
    sessions = [next, ...sessions]; messages[next.id] = [{ id: id("msg"), session_id: next.id, role: "ai", text: "你好，我在这里。今天想聊聊什么？", created_at: new Date().toISOString() }]; return next;
  }
  if (/^\/chat\/sessions\/[^/]+$/.test(path) && method === "DELETE") { const sessionId = path.split("/").pop()!; sessions = sessions.filter((s) => s.id !== sessionId); delete messages[sessionId]; return {}; }
  if (/^\/chat\/sessions\/[^/]+\/messages$/.test(path) && method === "GET") return messages[path.split("/")[3]] || [];
  if (/^\/chat\/sessions\/[^/]+\/messages$/.test(path) && method === "POST") {
    const sessionId = path.split("/")[3]; const user_message = { id: id("msg"), session_id: sessionId, role: "user", text: body.text || "[图片]", created_at: new Date().toISOString() };
    const taskTrigger = previewTaskRequested(user_message.text)
      ? "explicit_request"
      : previewNeedsActionablePlan(user_message.text)
        ? "actionable_reply"
        : null;
    const requestedCount = taskTrigger === "explicit_request"
      ? (previewRequestedTaskCount(user_message.text) || 2)
      : 2;
    const previewTasks = [
      { title: "尝试一次新方法", task_type: "interaction", scope: "today", description: "今天选一个最容易做到的时机，平静地尝试一次。", steps: ["先说明接下来要做什么", "完成后记录孩子的反应"] },
      { title: "记录一周变化", task_type: "observation", scope: "week", progress_total: 7, description: "连续记录一周，看看什么情境下更容易顺利完成。", steps: ["每天记录一次", "标记有效和困难的地方"] },
      { title: "固定一个练习时机", task_type: "care", scope: "week", progress_total: 7, description: "本周选一个相对轻松的时段，持续练习同一个小步骤。", steps: ["提前约定练习时机", "结束后简单复盘"] },
      { title: "照顾自己的状态", task_type: "selfcare", scope: "today", description: "今天给自己留十分钟恢复精力，再继续陪伴孩子。", steps: ["安排十分钟休息", "记录休息后的感受"] },
    ].slice(0, requestedCount);
    const ai = taskTrigger
      ? {
          id: id("msg"),
          session_id: sessionId,
          role: "ai",
          text: taskTrigger === "explicit_request"
            ? `我把刚才的方案整理成了${requestedCount}张任务卡，你可以选择想尝试的行动。`
            : "可以先从两个低负担的小行动开始：今天试一次，并连续记录一周看看变化。",
          created_at: new Date().toISOString(),
          transition: { kind: "task_suggestion", trigger: taskTrigger, tasks: previewTasks },
        }
      : {
          id: id("msg"),
          session_id: sessionId,
          role: "ai",
          text: "我听见了。这个情况大概持续多久了？",
          created_at: new Date().toISOString(),
          transition: null,
        };
    messages[sessionId] = [...(messages[sessionId] || []), user_message, ai]; return { user_message, ai_messages: [ai] };
  }

  if (path === "/collections" && method === "GET") return [];
  if (path === "/analytics") return {};
  return {};
}
