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
    { id: "sleep-zh-cn-video", kind: "video", title: "建立睡前常规", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "普通话影片 · 简体剧本", spoken_language: "mandarin", spoken_language_status: "verified", locales: ["zh-CN"], description: "示范固定、平静而可重复的睡前步骤。", url: "https://www.fhs.gov.hk/sc_chi/mulit_med/000015.html" },
    { id: "sleep-zh-tw-article", kind: "article", title: "若要小孩好好睡，睡前儀式很重要", publisher: "臺灣衛生福利部 · 心快活心理健康學習平台", language: "繁體中文 · 台灣", locales: ["zh-TW"], source_region: "TW", description: "依年齡說明睡眠需求，並提供固定時間、固定步驟與安靜活動等睡前儀式建議。", url: "https://wellbeing.mohw.gov.tw/nor/pstunt/1/779" },
    { id: "sleep-zh-tw-video", kind: "video", title: "讓寶貝們好好睡覺", publisher: "臺灣衛生福利部社會及家庭署 · 育兒親職網", language: "華語影音課 · 台灣", locales: ["zh-TW"], source_region: "TW", description: "面向零至二歲照顧者，介紹寶寶作息、哭鬧與建立睡前儀式的方法。", url: "https://babyedu.sfaa.gov.tw/info/10000254?lang=Big5" },
  ],
  learn_big_feelings: [
    { id: "emotion-zh-cn-article", kind: "article", title: "培育高“EQ”孩子从零岁开始", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "简体中文", locales: ["zh-CN"], description: "用观察、转换角度和表达同感协助孩子调节情绪。", url: "https://www.fhs.gov.hk/sc_chi/health_info/child/30159.html" },
    { id: "emotion-zh-cn-video", kind: "video", title: "玩游戏解情绪：帮助宝宝认识与表达自己的情绪", publisher: "台湾卫生福利部社会及家庭署 · 育儿亲职网", language: "普通话影音课 · 台湾繁体页面", spoken_language: "mandarin", spoken_language_status: "verified", locales: ["zh-CN"], description: "用亲子游戏示范情绪觉察、理解、表达与调节。", url: "https://babyedu.sfaa.gov.tw/info/10000213" },
    { id: "emotion-zh-tw-article", kind: "article", title: "一起來想想，我們如何回應孩子的心情？", publisher: "國立臺灣大學醫學院附設醫院臨床心理中心", language: "繁體中文 · 台灣", locales: ["zh-TW"], source_region: "TW", description: "由臨床心理師說明如何注意、命名並回應孩子的感受，逐步支持情緒理解與調節。", url: "https://epaper.ntuh.gov.tw/health/202507/child_1.html" },
    { id: "emotion-zh-tw-video", kind: "video", title: "玩遊戲解情緒：幫助寶寶認識與表達自己的情緒", publisher: "臺灣衛生福利部社會及家庭署 · 育兒親職網", language: "華語影音課 · 台灣", locales: ["zh-TW"], source_region: "TW", description: "以親子遊戲示範情緒覺察、理解、表達與調節，適合零至二歲照顧者。", url: "https://babyedu.sfaa.gov.tw/info/10000213" },
  ],
  learn_picky_eating: [
    { id: "food-zh-cn-article", kind: "article", title: "孩子“偏食”怎么办？", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "简体中文", locales: ["zh-CN"], description: "建议重复提供新食物、不强迫进食。", url: "https://www.fhs.gov.hk/sc_chi/health_info/child/20033.html" },
    { id: "food-zh-cn-video", kind: "video", title: "一岁宝宝本事多：建立良好饮食习惯", publisher: "台湾卫生福利部社会及家庭署 · 育儿亲职网", language: "普通话影音课 · 台湾繁体页面", spoken_language: "mandarin", spoken_language_status: "verified", locales: ["zh-CN"], description: "介绍规律用餐、降低压力并培养幼儿自主进食的方法。", url: "https://babyedu.sfaa.gov.tw/info/10000131?lang=Big5" },
    { id: "food-zh-tw-article", kind: "article", title: "幼兒偏食行為", publisher: "中國醫藥大學附設醫院臨床營養科", language: "繁體中文 · 台灣", locales: ["zh-TW"], source_region: "TW", description: "說明偏食的判定與原因，並提供規律進餐、愉快氣氛、食物多樣化與避免強迫等家庭方法。", url: "https://www.cmuh.org.tw/HealthEdus/Detail?no=5466" },
    { id: "food-zh-tw-video", kind: "video", title: "一歲寶貝本事多", publisher: "臺灣衛生福利部社會及家庭署 · 育兒親職網", language: "華語影音課 · 台灣", locales: ["zh-TW"], source_region: "TW", description: "面向一至二歲家庭，介紹規律用餐、健康飲食與培養孩子自主進食的方法。", url: "https://babyedu.sfaa.gov.tw/info/10000131?lang=Big5" },
  ],
  learn_serve_and_return: [
    { id: "connection-zh-cn-article", kind: "article", title: "亲子沟通——给一岁前婴儿的家长", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "简体中文", locales: ["zh-CN"], description: "说明如何观察宝宝信号、回应并轮流互动。", url: "https://www.fhs.gov.hk/sc_chi/health_info/child/13046.html" },
    { id: "connection-zh-cn-video", kind: "video", title: "亲子沟通（四至六个月）", publisher: "香港特别行政区政府卫生署家庭健康服务", language: "普通话影片 · 简体剧本", spoken_language: "mandarin", spoken_language_status: "verified", locales: ["zh-CN"], description: "示范观察、回应和来回互动。", url: "https://www.fhs.gov.hk/sc_chi/mulit_med/000025.html" },
    { id: "connection-zh-tw-article", kind: "article", title: "用愛說故事，親子共讀從零歲開始", publisher: "臺灣衛生福利部國民健康署", language: "繁體中文 · 台灣", locales: ["zh-TW"], source_region: "TW", description: "說明如何用聲音、表情與對話式共讀形成親子來回互動，促進親密感和語言發展。", url: "https://www.mohw.gov.tw/cp-16-48967-1.html" },
    { id: "connection-zh-tw-video", kind: "video", title: "親子互動秘笈 1：怎麼樣「互動」最好？", publisher: "臺灣衛生福利部社會及家庭署 · 育兒親職網", language: "華語影音課 · 台灣", locales: ["zh-TW"], source_region: "TW", description: "面向零至二歲照顧者，示範互動環境、溝通、感官遊戲與來回回應的原則。", url: "https://babyedu.sfaa.gov.tw/info/10000138?lang=Big5" },
  ],
};
const previewReviewedChineseResources: Record<string, any[]> = {
  learn_sleep_routine: [
    { id: "sleep-parenting-featured-article", kind: "article", content_category: "featured", source_tier: "curated", selection_basis: "expert_and_audience", title: "寶寶多大能睡過夜？醫師教如何訓練、詳解嬰兒睡眠時間", publisher: "親子天下", language: "繁體中文 · 台灣", locales: ["zh-CN", "zh-TW"], description: "由編輯整理兒科醫師與國際醫療來源，說明睡眠節奏、夜醒與睡前儀式。", trust_note: "成熟親子媒體的專業資料整理。", recognition: "專家資料整理 · 家庭實操導向", selection_reason: "把睡前節奏與夜醒問題轉成容易執行的家庭步驟。", url: "https://www.parenting.com.tw/article/5096297" },
    { id: "sleep-huang-featured-video", kind: "video", content_category: "featured", source_tier: "curated", selection_basis: "expert_and_audience", title: "讓寶寶睡好的祕訣是什麼？解答睡眠常見問題！", publisher: "黃瑽寧醫師健康講堂", language: "普通話視頻 · 台灣", locales: ["zh-CN", "zh-TW"], spoken_language: "mandarin", spoken_language_evidence: "已人工聽檢，確認為台灣普通話，未發現粵語。", description: "兒科醫師解答幼兒睡眠常見問題。", trust_note: "兒科醫師本人講解。", recognition: "醫師專業頻道", selection_reason: "資訊密度高且容易看完。", url: "https://www.youtube.com/watch?v=CnYahVdAcm0" },
    { id: "sleep-ptt-parent-case-article", kind: "article", content_category: "case", source_tier: "curated", selection_basis: "lived_experience", title: "[寶寶] 睡眠習慣建立經驗分享（上）", publisher: "PTT BabyMother · 台灣家長", language: "繁體中文 · 台灣", locales: ["zh-CN", "zh-TW"], description: "母親記錄女兒月齡、原始作息與一個月調整過程。", trust_note: "第一人稱家長經驗，不作醫療證據。", recognition: "真實父母經驗", selection_reason: "呈現家庭如何記錄、調整和面對不完美。", url: "https://www.ptt.cc/bbs/BabyMother/M.1632016044.A.AE1.html" },
    { id: "sleep-li-parent-case-video", kind: "video", content_category: "case", source_tier: "curated", selection_basis: "lived_experience", title: "育兒心得分享：寶寶的睡眠作息、喝奶與副食品", publisher: "李佳穎 · 台灣家長", language: "普通話視頻 · 台灣", locales: ["zh-CN", "zh-TW"], spoken_language: "mandarin", spoken_language_evidence: "已人工聽檢，確認為台灣普通話，未發現粵語。", description: "母親分享孩子九個月時的睡眠與餵養作息。", trust_note: "真實家長分享，含商業合作。", recognition: "公開家長頻道", selection_reason: "呈現真實家庭如何安排一天節奏。", url: "https://www.youtube.com/watch?v=yxT5cQ_-qaA" },
  ],
  learn_big_feelings: [
    { id: "emotion-parenting-featured-article", kind: "article", content_category: "featured", source_tier: "curated", selection_basis: "expert_reviewed", title: "小孩崩潰尖叫怎麼辦？四句訣處理幼兒尖叫", publisher: "親子天下 · 羅寶鴻", language: "繁體中文 · 台灣", locales: ["zh-CN", "zh-TW"], description: "用四個步驟處理幼兒尖叫與崩潰。", trust_note: "具幼教與正向教養背景的署名專家文章。", recognition: "專家方法", selection_reason: "把情緒接納、界限和家長能說的話放在同一流程。", url: "https://www.parenting.com.tw/article/5087348" },
    { id: "emotion-parenting-featured-video", kind: "video", content_category: "featured", source_tier: "curated", selection_basis: "expert_and_audience", title: "父母也會有情緒：心理師的情緒控制方法", publisher: "親子天下 · 諮商心理師黃之盈", language: "普通話視頻 · 台灣", locales: ["zh-CN", "zh-TW"], spoken_language: "mandarin", spoken_language_evidence: "已人工聽檢，確認為台灣普通話，未發現粵語。", description: "心理師說明孩子大情緒時如何避免失控升級。", trust_note: "諮商心理師專業講解。", recognition: "親子媒體製作", selection_reason: "先照顧家長情緒，再陪孩子。", url: "https://www.youtube.com/watch?v=mLpWc1mKEUk" },
    { id: "emotion-mamibuy-parent-case-article", kind: "article", content_category: "case", source_tier: "curated", selection_basis: "lived_experience", title: "1Y5M 起：老母學會欣賞你的叛逆", publisher: "MamiBuy · 邱言言媽咪", language: "繁體中文 · 台灣", locales: ["zh-CN", "zh-TW"], description: "母親記錄兩個月調整期與多個鬧情緒場景。", trust_note: "第一人稱母親經驗。", recognition: "真實家庭案例", selection_reason: "看見家長的情緒、試錯與孩子變化。", url: "https://mamibuy.com.tw/talk/article/2876" },
    { id: "emotion-wanling-parent-case-video", kind: "video", content_category: "case", source_tier: "curated", selection_basis: "lived_experience", title: "一到兩歲寶寶：面對鬧脾氣與愛說不要", publisher: "創業系媽媽婉翎", language: "普通話視頻 · 台灣", locales: ["zh-CN", "zh-TW"], spoken_language: "mandarin", spoken_language_evidence: "已人工聽檢，確認為台灣普通話，未發現粵語。", description: "母親以一歲半雙胞胎的真實情境分享家庭做法。", trust_note: "真實母親經驗。", recognition: "長期育兒創作者", selection_reason: "具體呈現衝突場景與家長回應。", url: "https://www.youtube.com/watch?v=Z8EHP_znnVo" },
  ],
  learn_picky_eating: [
    { id: "food-mombaby-featured-article", kind: "article", content_category: "featured", source_tier: "curated", selection_basis: "expert_reviewed", title: "寶寶不愛吃飯的 5 大原因！營養師提供 8 招", publisher: "媽媽寶寶 · 營養師徐裴莉", language: "繁體中文 · 台灣", locales: ["zh-CN", "zh-TW"], description: "醫院營養師說明常見原因和可執行的用餐方法。", trust_note: "專業營養師訪談。", recognition: "營養師受訪", selection_reason: "同時涵蓋原因判斷和家庭方法。", url: "https://www.mombaby.com.tw/articles/5509" },
    { id: "food-huang-featured-video", kind: "video", content_category: "featured", source_tier: "curated", selection_basis: "expert_and_audience", title: "小孩不肯乖乖吃飯：挑食與餐桌衝突", publisher: "黃瑽寧愛+好醫生", language: "普通話視頻 · 台灣", locales: ["zh-CN", "zh-TW"], spoken_language: "mandarin", spoken_language_evidence: "已人工聽檢，確認為台灣普通話，未發現粵語。", description: "兒科醫師討論挑食、生理問題和降低餐桌衝突。", trust_note: "兒科醫師與專業來賓講解。", recognition: "醫師專業頻道", selection_reason: "把需就醫的可能性與一般餐桌衝突分開。", url: "https://www.youtube.com/watch?v=O_djZ-0jfAw" },
    { id: "food-fishball-parent-case-article", kind: "article", content_category: "case", source_tier: "curated", selection_basis: "lived_experience", title: "魚丸醫師的媽媽經：兒醫媽媽對戰挑食寶寶", publisher: "媽媽寶寶 · 魚丸醫師（四寶媽）", language: "繁體中文 · 台灣", locales: ["zh-CN", "zh-TW"], description: "四寶媽記錄孩子成長曲線、餵養焦慮與家庭調整。", trust_note: "兒科醫師兼母親的親身經驗。", recognition: "專業背景家長案例", selection_reason: "呈現專業家長也會焦慮與試錯。", url: "https://www.mombaby.com.tw/articles/9928389" },
    { id: "food-wanling-parent-case-video", kind: "video", content_category: "case", source_tier: "curated", selection_basis: "lived_experience", title: "2～3 歲孩子挑食：十個家庭方法", publisher: "創業系媽媽婉翎", language: "普通話視頻 · 台灣", locales: ["zh-CN", "zh-TW"], spoken_language: "mandarin", spoken_language_evidence: "已人工聽檢，確認為台灣普通話，未發現粵語。", description: "母親整理自家孩子實際用過的方法。", trust_note: "真實家庭經驗。", recognition: "長期育兒創作者", selection_reason: "看見家庭如何逐步調整。", url: "https://www.youtube.com/watch?v=RpYhoFN3dOc" },
  ],
  learn_serve_and_return: [
    { id: "connection-cylaw-featured-article", kind: "article", content_category: "featured", source_tier: "curated", selection_basis: "expert_reviewed", title: "改變世界的躲貓貓遊戲", publisher: "兒少權益網 · 兒福聯盟", language: "繁體中文 · 台灣", locales: ["zh-CN", "zh-TW"], description: "以日常遊戲解釋 Serve and Return。", trust_note: "台灣兒少專業平台導讀。", recognition: "兒少機構導讀", selection_reason: "把回應式互動轉成每天能練習的小片段。", url: "https://www.cylaw.org.tw/about/advocacy/10/566" },
    { id: "connection-wanling-featured-video", kind: "video", content_category: "featured", source_tier: "curated", selection_basis: "expert_and_audience", title: "在家玩什麼？一到六歲孩子發展遊戲", publisher: "創業系媽媽婉翎", language: "普通話視頻 · 台灣", locales: ["zh-CN", "zh-TW"], spoken_language: "mandarin", spoken_language_evidence: "已人工聽檢，確認為台灣普通話，未發現粵語。", description: "用家中物品示範輪流和親子互動遊戲。", trust_note: "長期育兒創作者實作示範。", recognition: "實作型育兒內容", selection_reason: "看完就能挑一個遊戲開始。", url: "https://www.youtube.com/watch?v=6oEc7lrSTeA" },
    { id: "connection-mommycarry-parent-case-article", kind: "article", content_category: "case", source_tier: "curated", selection_basis: "lived_experience", title: "0–1 歲寶寶親子互動遊戲", publisher: "媽咪凱瑞 MommyCarry", language: "繁體中文 · 台灣", locales: ["zh-CN", "zh-TW"], description: "母親按月齡分享自己夫妻與寶寶的家庭互動。", trust_note: "第一人稱家庭經驗。", recognition: "真實新手父母經驗", selection_reason: "把互動放進換尿布和玩耍等日常。", url: "https://www.mommycarry.com/?p=1400" },
    { id: "connection-peter-parent-case-video", kind: "video", content_category: "case", source_tier: "curated", selection_basis: "lived_experience", title: "一歲孩子挑戰背後畫畫遊戲", publisher: "彼得爸與蘇珊媽", language: "普通話視頻 · 台灣", locales: ["zh-CN", "zh-TW"], spoken_language: "mandarin", spoken_language_evidence: "已人工聽檢，確認為台灣普通話，未發現粵語。", description: "一家人實際玩輪流猜圖遊戲。", trust_note: "真實家庭互動。", recognition: "真實家庭頻道", selection_reason: "保留孩子不按腳本反應的真實感。", url: "https://www.youtube.com/watch?v=j50rZljX8XI" },
  ],
};
const previewAuthorityMetadata = {
  source_tier: "authority",
  content_category: "authority",
  selection_basis: "official",
  trust_note: "政府、大学、医院、专业医学组织或其官方频道发布。",
  recognition: "权威机构原始发布",
  selection_reason: "作为事实、发展里程碑和安全建议的基础来源。",
};
const previewCuratedMetadata = {
  publisher: "Raising Children Network（澳大利亚）",
  source_tier: "curated",
  content_category: "featured",
  selection_basis: "expert_reviewed",
  trust_note: "澳大利亚政府支持；网站内容由科学顾问委员会指导，并经至少两名独立专家及专业编辑团队审核。",
  recognition: "专家审核 · 家庭实操导向",
  locales: ["en"],
};
const previewCuratedResources: Record<string, any[]> = {
  learn_sleep_routine: [
    { ...previewCuratedMetadata, id: "sleep-rcn-article", kind: "article", title: "Toddler sleep: what to expect", language: "英文文章", description: "从睡眠时长、白天小睡到固定睡前流程，给出可直接执行的家庭建议。", selection_basis: "expert_and_audience", selection_reason: "结构清楚、步骤具体，适合把作息建议落实为家庭流程。", audience_note: "7.4k 位读者标记有帮助", url: "https://raisingchildren.net.au/toddlers/sleep/understanding-sleep/toddler-sleep" },
    { ...previewCuratedMetadata, id: "sleep-rcn-video", kind: "video", title: "Baby sleep and settling tips", language: "英文视频 · 英文文字稿", description: "由多位家长分享夜醒、安抚和建立适合自己家庭睡眠节奏的经验。", selection_reason: "真实家庭经验配合专业内容审核，适合快速理解不同做法的取舍。", url: "https://raisingchildren.net.au/babies/videos/baby-sleep" },
  ],
  learn_big_feelings: [
    { ...previewCuratedMetadata, id: "emotion-rcn-article", kind: "article", title: "Toddler emotions: learning and play ideas", language: "英文文章", description: "解释幼儿挫败、愤怒等情绪的发展，并提供游戏与陪伴方法。", selection_reason: "把发展原理转成日常可用的互动建议，适合与权威指南交叉阅读。", url: "https://raisingchildren.net.au/toddlers/play-learning/play-toddler-development/emotions-play-toddlers" },
    { ...previewCuratedMetadata, id: "emotion-rcn-video", kind: "video", title: "Helping toddlers learn about feelings", language: "英文视频 · 英文文字稿", description: "用真实情境示范靠近、协助、安抚和为情绪命名。", selection_reason: "三分钟左右即可看完，步骤清晰并有完整文字稿。", url: "https://raisingchildren.net.au/toddlers/videos/supporting-toddler-feelings" },
  ],
  learn_picky_eating: [
    { ...previewCuratedMetadata, id: "food-rcn-article", kind: "article", title: "Fussy eating in children: what to do", language: "英文文章", description: "从用餐环境、食物自主和重复接触三个方向提供挑食应对建议。", selection_reason: "避免强迫进食，方法具体，并明确何时应咨询医生或营养师。", url: "https://raisingchildren.net.au/toddlers/nutrition-fitness/common-concerns/fussy-eating" },
    { ...previewCuratedMetadata, id: "food-rcn-video", kind: "video", title: "Is your child eating enough? How to tell", language: "英文视频 · 英文文字稿", description: "家长分享如何观察一段时间内的整体摄入，而不是纠结单独一餐。", selection_reason: "真实家长经验容易理解，并由专业平台审核内容。", url: "https://raisingchildren.net.au/toddlers/videos/eating-enough" },
  ],
  learn_serve_and_return: [
    { ...previewCuratedMetadata, id: "connection-rcn-article", kind: "article", title: "Baby cues: how to know what babies want", language: "英文文章", description: "通过目光、转头、哭声和疲倦信号帮助照顾者理解宝宝的回应。", selection_reason: "图解式表达直观，能把来回互动落实到观察宝宝信号。", url: "https://raisingchildren.net.au/newborns/connecting-communicating/communicating/baby-toddler-cues" },
    { ...previewCuratedMetadata, id: "connection-rcn-video", kind: "video", title: "Bonding and talking with babies: 0-6 months", language: "英文视频 · 英文文字稿", description: "示范眼神、拥抱、唱歌、阅读和回应声音如何形成来回互动。", selection_reason: "真实互动场景丰富，家长无需额外工具即可练习。", url: "https://raisingchildren.net.au/babies/videos/connecting-communicating-0-6-months" },
  ],
};
for (const learningCard of learningCards) {
  const englishResources = (learningCard.resources || []).map((resource: any) => ({
    ...previewAuthorityMetadata,
    ...resource,
    locales: resource.language?.includes("西班牙") ? ["en", "es"] : ["en"],
  }));
  learningCard.resources = [
    ...(previewLocalizedResources[learningCard.id] || []).map((resource) => ({
      ...previewAuthorityMetadata,
      ...resource,
    })),
    ...(previewReviewedChineseResources[learningCard.id] || []),
    ...englishResources,
    ...(previewCuratedResources[learningCard.id] || []),
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
      const groupOrder = [
        "authority:article",
        "authority:video",
        "featured:article",
        "featured:video",
        "case:article",
        "case:video",
      ];
      const categoryFor = (resource: any) =>
        resource.content_category || (resource.source_tier === "curated" ? "featured" : "authority");
      const leftGroup = groupOrder.indexOf(`${categoryFor(left.resource)}:${left.resource.kind}`);
      const rightGroup = groupOrder.indexOf(`${categoryFor(right.resource)}:${right.resource.kind}`);
      if (leftGroup !== rightGroup) return leftGroup - rightGroup;
      return left.index - right.index;
    })
    .map(({ resource }) => resource);
}

function previewResourceLocale(path: string) {
  const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  const requested = new URLSearchParams(query).get("preferred_locale");
  if (requested === "zh-CN" || requested === "zh-TW" || requested === "en") {
    return requested;
  }
  return privacy.language === "zh" ? "zh-CN" : privacy.language;
}

function previewContentCategory(path: string): "authority" | "featured" | "case" {
  const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  const requested = new URLSearchParams(query).get("content_category");
  return requested === "featured" || requested === "case" ? requested : "authority";
}

function previewResourceCategory(resource: any): "authority" | "featured" | "case" {
  return resource.content_category || (resource.source_tier === "curated" ? "featured" : "authority");
}
let favorites: any[] = [card];
let privacy = { allow_history_training: true, allow_external_content_research: false, daily_push: true, anonymous_community_share: false, language: "zh-CN" };
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
  const routePath = path.split("?")[0];

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
    const preferredLocale = previewResourceLocale(path);
    const baseCard = learningCards[0];
    const categoryMeta = {
      authority: "权威来源",
      featured: "精选内容",
      case: "真实案例",
    } as const;
    const items = (["authority", "featured", "case"] as const).map((category, index) => {
      const pair = orderPreviewResources(baseCard.resources || [], preferredLocale)
        .filter(
          (resource) =>
            resource.locales?.includes(preferredLocale) &&
            previewResourceCategory(resource) === category,
        )
        .filter(
          (resource, resourceIndex, resources) =>
            resources.findIndex((candidate) => candidate.kind === resource.kind) === resourceIndex,
        )
        .slice(0, 2);
      const article = pair.find((resource) => resource.kind === "article");
      return {
        ...baseCard,
        title: article?.title || baseCard.title,
        summary: article?.description || baseCard.summary,
        publisher: article?.publisher || baseCard.publisher,
        content_category: category,
        content_category_label: categoryMeta[category],
        personalization_reason: useConversation
          ? "因为你最近和 NURI 聊到了“睡眠与作息”"
          : "你已关闭对话个性化，这是 NURI 的可信来源精选",
        is_conversation_match: useConversation,
        related_session_id: useConversation ? "chat-1" : null,
        rank: index + 1,
        resource_status: "reviewed",
        resource_summary: {
          preferred_locale: preferredLocale,
          categories: {
            authority: { article: 0, video: 0 },
            featured: { article: 0, video: 0 },
            case: { article: 0, video: 0 },
            [category]: {
              article: pair.some((resource) => resource.kind === "article") ? 1 : 0,
              video: pair.some((resource) => resource.kind === "video") ? 1 : 0,
            },
          },
        },
      };
    });
    return {
      items,
      personalization_mode: useConversation ? "conversation" : "default_privacy",
      matched_topic: useConversation ? "sleep" : null,
      related_session_id: useConversation ? "chat-1" : null,
      generated_at: new Date().toISOString(),
    };
  }
  if (routePath.startsWith("/feed/") && routePath.endsWith("/detail")) {
    const contentId = routePath.split("/")[2];
    const learningCard = learningCards.find((item) => item.id === contentId);
    if (learningCard) {
      const isSleepMatch = privacy.allow_history_training && learningCard.topic === "sleep";
      const preferredLocale = previewResourceLocale(path);
      const contentCategory = previewContentCategory(path);
      const resources = orderPreviewResources(
        learningCard.resources || [],
        preferredLocale,
      )
        .filter(
          (resource) =>
            resource.locales?.includes(preferredLocale) &&
            previewResourceCategory(resource) === contentCategory,
        )
        .filter(
          (resource, resourceIndex, allResources) =>
            allResources.findIndex((candidate) => candidate.kind === resource.kind) === resourceIndex,
        )
        .slice(0, 2);
      return {
        ...learningCard,
        resources,
        content_category: contentCategory,
        content_category_label: {
          authority: "权威来源",
          featured: "精选内容",
          case: "真实案例",
        }[contentCategory],
        preferred_locale: preferredLocale,
        personalization_reason: isSleepMatch
          ? "因为你最近和 NURI 聊到了“睡眠与作息”"
          : privacy.allow_history_training
            ? "NURI 从可信育儿来源中为你补充精选"
            : "你已关闭对话个性化，这是 NURI 的可信来源精选",
        is_conversation_match: isSleepMatch,
        related_session_id: isSleepMatch ? "chat-1" : null,
        research_status:
          isSleepMatch && privacy.allow_external_content_research
            ? "pending"
            : isSleepMatch
              ? "consent_required"
              : "reviewed_fallback",
      };
    }
    return { ...card, id: contentId };
  }
  if (
    routePath.startsWith("/feed/") &&
    routePath.endsWith("/research") &&
    method === "POST"
  ) {
    return {
      research_status: "reviewed_fallback",
      preferred_locale: previewResourceLocale(path),
    };
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
