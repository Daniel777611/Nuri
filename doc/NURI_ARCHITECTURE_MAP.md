# NURI Architecture Map v1

本文件是全仓库的**唯一结构索引**：入口、模块、调用方向、数据落点、AI 请求怎么形成、
哪些是 legacy、哪些代码现在没人调用。

范围：`D:\projects\Family-Growth-Radar`，分支 `main`。初版写于 2026-08-21；
最近一次同步 2026-08-25；本次同步覆盖旧入口清理、首页关心式开场、router 轻量回合短路与成本观测修复。
`doc/four_model_architecture.md` 只讲 `nuri_core` 四大子系统的内部设计，本文件讲**整个系统**；
`doc/main_py_decomposition.md` 记录 main.py 的拆分账。两者是本文的下钻文档，不是替代。

> 维护规则见仓库根目录 `CLAUDE.md`：**任何跨模块修改必须同步本文件。**

---

## 1. 入口在哪里

| 入口 | 文件 | 说明 |
|---|---|---|
| **生产 HTTP 入口** | `api/backend.py` | 只有一行 `from backend.main import app`。Vercel Python Serverless Function，`maxDuration 300`（`vercel.json`）。 |
| **真正的应用对象** | `backend/main.py` | FastAPI `app`。6,239 行，全系统唯一的 HTTP 层。 |
| **本地开发** | `start.bat` | 起 `uvicorn backend.main:app --port 8000` + `npx expo start`。 |
| **前端入口** | `frontend/app/index.tsx` + expo-router（`package.json` 里 `main = expo-router/entry`） | 文件路由；`npm run build:web` 输出 `frontend/dist`。 |
| **前端 API 客户端** | `frontend/src/api.ts` | 所有后端调用的唯一出口。`API = ${backendUrl}/api`（`src/theme.ts:54`）。 |
| **离线/演示入口** | `frontend/src/preview-api.ts` | `EXPO_PUBLIC_PREVIEW_MODE=1` 时拦截 `req()`，返回假数据，不打后端。 |
| **命令行入口（非服务）** | `backend/evals/*.py`、`backend/scripts/*.py`、`backend/golden_agent/*.py` | 各自 `__main__`，只在本地跑，不参与请求路径。 |

**路由分发**（`vercel.json` rewrites）：`/api/*`、`/health`、`/admin/*` → Python function；
`/admin/logs` 与其余全部 → `index.html`（SPA）。`/admin/logs` 必须显式排除，否则会被 Python function 抢走。

---

## 2. 核心模块

### 2.1 HTTP 与应用层

| 模块 | 职责 |
|---|---|
| `backend/main.py` | 全部 60 条显式路由、Pydantic 模型、turn 编排（`_prepare_turn` → `_reply_context` → `_persist_ai_turn` → `_after_turn`）、admin 后台。分节见文件内的 `# ── XXX ──` 注释。聊天路径现在**对存储 fail closed**（`_require_chat_storage()` 拿不到 Supabase 就 503），并用「确定性消息 ID + 生成租约」保证重投幂等，见 §3.2。另有一组**外部测试面**：`GET /api/version`，以及聊天响应里附加的 `request_id` / `events` / `version`（由 `_turn_envelope()` 统一组装）。存在的理由是外部多轮测试要能断言产品行为——升级、任务、卡片——而不是去正文里搜关键词。所有错误响应另外统一带 `{code, message, retryable, retry_after_ms}` 信封与 `request_id`，`detail` 原样保留（admin 页面在读它）。 |
| `backend/runtime.py` | 进程级配置、OpenAI / Supabase 客户端、时钟。**不 import 后端任何其他模块**——这是防 import 环的根规则。main.py 再导出这些名字，老的 `from backend.main import OPENAI_TIMEOUT_S` 仍能用。`JWT_SECRET` 在 `VERCEL_ENV=preview/production` 下必须 ≥32 字符且不能是本地默认值，否则**导入期直接抛 `RuntimeError`**，见 §8.8。 |
| `backend/stores.py` | 「不属于任何子系统」的持久化：feed cards、feed mode、privacy、推荐快照、收藏。统一 try-Supabase / fallback-memstore，**privacy 例外：失败即抛**（不能把家长关掉的开关静默打开）。 |
| `backend/memstore.py` | 无 Supabase 时的进程内兜底存储。**禁止 rebind 模块级名字**，只能原地改（`x[:] = ...`、`.clear()`）。 |
| `backend/llm_usage.py` | 每次 provider 调用记一行，按 call_site 分组。同步实现（`content_research` 在 worker 线程里调），`arecord` 是异步薄包装。任何异常都自吞。 |
| `backend/locales.py` | 资源语言偏好，feed 与 privacy 共用。 |

### 2.2 `backend/nuri_core/` — 四大核心系统（对话主链路）

| # | 决策层（纯/可测） | 持久化或生成层 | 拥有的东西 |
|---|---|---|---|
| 1 家庭模型 | `family.py` | `family_store.py` | users / children / user_memories / follow_ups / normalized_inputs |
| 2 知识与决策 | `knowledge.py` | `knowledge_store.py` + `backend/websearch.py` | internal 向量命名空间、pdf 命名空间、外部网页 |
| 3 对话与主动 | `dialogue.py` | `dialogue_reply.py`、`exemplars.py` | directives、persona、JSON 契约、所有回复生成调用 |
| 4 结果学习 | `outcome.py` | `outcome_store.py` | nuri_turn_outcomes、recommendation_events |

`family_store.py` 除了持久化，还是**儿童身份信息的收敛点**：
`redact_child_profile_text/_history`（喂给检索与路由前脱敏）、
`reconcile_context_with_child_profile`（用已确认档案纠正过期的记忆／摘要事实）、
`safe_normalized_input_context` 与 `safe_child_recommendation_context`（只放年龄，不放姓名生日）。
`load_profile` 读不到档案时抛 `ProfileStorageUnavailable`，**绝不返回空档案**——
main.py 注册了对应的 exception handler，把它变成显式错误，而不是「这家没有孩子」。

横切两层（不在链条里，在旁边）：

- `safety.py` —— 风险分级与其后果。**探测器本身留在 `dialogue_reply.py`**（几百行调好的双语正则），这里只管 policy。
- `provenance.py` —— 每回合 trace，落 `chat_turn_logs` 扁平列 + `nuri_turn_traces` 结构化行。

支撑件：

- `orchestrator.py` —— 唯一入口 `run_turn_context`，三波并发。**永不抛异常**：任何子系统失败就「贡献为空」并记进 trace。
- `contracts.py` —— 子系统之间的边（`FamilyState` / `EvidenceDecision` / `DialoguePlan` / `LearnedPolicy` / `Directive` / `TurnBundle`），全是 frozen dataclass。
- `ports.py` —— `CorePorts`，main.py 注入的能力面。**`nuri_core` 绝不 import main.py。**
- `context_budget.py` —— prompt 里放什么、什么顺序、各占多少 token。顺序即缓存机制。
- `state_store.py` —— 单个 session 的滚动摘要，存在 `chat_sessions.state_summary`。
- `temporal.py` —— 一次 turn 的**唯一时钟快照**。校验客户端送来的 IANA 时区，冻结一次服务器 UTC 读数，
  把「今天 / 昨天 / 前几天」渲染成可信的绝对时间标注。存储永远是 UTC，这里只负责渲染，
  且**不从 locale 或城市推断时区**。被 `family.py`、`family_store.py`、`state_store.py`、
  `dialogue_reply.py`、`main.py` 共用同一个 `TemporalContext` 实例。
- `image_input.py` —— 用户上传图片的校验与模型格式化。data URI 白名单（jpeg/png/webp）、
  magic bytes 必须与声明格式一致、Pillow 验帧防解压炸弹、2.5 MB / 16 MP / 4096 px 三重上限。
  **服务端把 data URI 当不可信输入**——客户端已经压过一遍不作数。

### 2.3 `backend/feed/` + 内容层 — 首页推荐（不属于四大系统）

| 模块 | 职责 |
|---|---|
| `feed/signals.py` | 纯文本分析：从最近对话里区分真实育儿关切 / 客套 / 抱怨 / 请求，抽 topic，给内容库排序。**无 I/O**。 |
| `feed/delivery.py` | 把排序结果变成可展示的卡：分类配对、locale、权威门槛、ready vs preparing 判定。import `signals`，反向没有。 |
| `content_library.py` | 人工审核过的兜底内容 + 来源域名信任表。 |
| `content_research.py` | 对话感知的实时网页研究（Responses API + web search）。**默认暂停**，见 §6。 |
| `recommendation_snapshots.py` | 稳定的 `recommendation_id`，detail 链接不泄露会话内容。 |
| `recommendation_feedback.py` | 隐私安全的排序反馈归一化（不存会话文本、标题、用户标识）。 |

### 2.4 路由与搜索

- `backend/router.py` —— 对有实质内容的回合调用一次小模型，决定 (a) 要不要外部来源、搜什么 (b) 要不要出任务卡；问候、致谢和确认类短消息走显式 allow-list，直接返回 `NO_ROUTE`，但「发烧怎么办」这类短而实质的问题仍会调用。永不抛、永不超 `ROUTER_TIMEOUT_S`。
  **进出两端都脱敏**：喂进去的历史先过 `family_store.redact_child_profile_history`，吐出来的
  `search_query` / `topic` / `reason` 再过 `redact_child_profile_text`——模型会复述 prompt 里的
  姓名生日，而这些字段会流向外部搜索和落库的 turn 指标。为此 `router.py` 单向 import 了
  `nuri_core/family_store.py`，见 §3.1。
- `backend/websearch.py` —— provider 抽象、信任分层、结果排序。默认 provider 是 `null`。
- `backend/search_tavily.py` —— 唯一的厂商特定代码，按需加载。

### 2.5 前端

```
frontend/app/          expo-router 文件路由
  (tabs)/index|chats|tasks|profile.tsx   四个主 tab
  chat/[id].tsx  detail/[id].tsx  child/[id].tsx  task/[id].tsx
  login|register|onboarding|community|admin.tsx   admin/logs.tsx
frontend/src/
  api.ts                 唯一后端出口（导出 auth 与 api 两个对象）
  preview-api.ts         preview 模式假数据
  chatClientContext.ts   组装聊天 payload：client_message_id + 时区/locale/本地时间
  chatImageInput.ts      相册/相机取图 → 压到 ≤1600px 的 JPEG data URI；web 端直接开系统选择器
  feedPreparation.ts     /feed/research/prepare 的客户端编排
  recommendationPresentation.ts / recommendationDetailHandoff.ts / cardText.ts
  i18n/  theme.ts  taskMeta.ts  child-age.ts  utils/storage/
  components/  CheckinSheet HeroCarousel TaskCard Toast ConfirmDialog
frontend/public/homepage/   Figma 版首页的图标资源（导航四件套、每日卡片、nuri-mark）
frontend/assets/images/homepage/mascot.png
```

图片能力依赖 `expo-image-picker` + `expo-image-manipulator`（权限文案写在 `app.json` 的 plugins 里）。

---

## 3. 模块之间怎么调用

### 3.1 允许的依赖方向（硬规则）

```
runtime.py            ← 谁都能 import 它；它谁都不 import
memstore.py           ← stores.py 用它兜底
nuri_core/*           ← 绝不 import main.py；只通过 CorePorts 拿能力
nuri_core/dialogue_reply.py → nuri_core/dialogue.py（单向）
                        只为共用 HEADINGS 与 ALWAYS_ADVISORY_LIMIT——must/advisory
                        两个标题必须两条 pipeline 一字不差；反向 import 会成环
feed/signals.py       ← feed/delivery.py 单向 import；反向禁止
feed/*                → stores.py、nuri_core/outcome_store.py（单向）
router.py             → nuri_core/family_store.py（单向，只为脱敏；nuri_core 不回头 import router）
main.py               → 以上全部（唯一被允许 import 一切的地方）
```

破坏这六条中任何一条，就属于必须更新本文件的那类修改。

### 3.2 一次聊天 turn 的完整链路

```
frontend/app/chat/[id].tsx
  ├─ src/chatImageInput.ts    prepareChatImage()        取图 → ≤1600px 的 JPEG data URI
  ├─ src/chatClientContext.ts buildChatMessagePayload() client_message_id + timezone
  └─ src/api.ts  postMessageStream() / postMessage()（同一份 payload；流式不可用时可安全重投）
       └─ POST /api/chat/sessions/{id}/messages[/stream]   main.py:4754 / :4850
            ├─ _prepare_turn()      main.py:4010
            │    _require_chat_storage()      没有 Supabase 直接 503，**绝不落进程内存**
            │    _load_owned_session()        user_id 必须精确匹配，否则 404（不是 403）
            │    temporal.build_context()     冻结这一回合的时钟，往下全程共用
            │    _user_message_id() / _ai_message_id()   由 session + client_message_id 决定
            │    _acquire_generation_claim()  往 chat_messages 插一条占位 AI 行（180s 租约）
            │      已完成 → 直接回放那一轮；仍在生成 → 等 2s；租约过期 → 接管
            │    写 chat_messages（含 image_base64）+ normalized_inputs（**不含图片字节**）
            ├─ 分支 A: #fix         _fix_reply()  → dialogue_reply 蒸馏成 nuri_style_rules 一行
            ├─ 分支 B: 无 oai       _scripted_reply()  写死脚本
            └─ 分支 C: 正常         _reply_context()   main.py:4529
                 │  NURI_PIPELINE == "four_model"（默认）
                 └─ _reply_context_four_model() → nuri_core.run_turn_context()
                      wave 0  family.core()      profile 已在手，同步零 I/O
                              safety.assess()    急症在任何往返之前就定级
                      wave 1  并发 6 路：
                              family.enrich          memories + follow_ups，带 fingerprint 缓存
                              outcome.policy         directive 权重 + 负面话题
                              dialogue.load_directives   nuri_directives + nuri_style_rules
                              _card                  只在从卡片进来时
                              _state                 chat_sessions.state_summary
                              knowledge.decide  ├─ router.route_turn()                 小模型
                                                │    只拿 child_age_context（脱敏后的年龄）
                                                ├─ knowledge_store.internal_rules_ctx() 向量
                                                └─ websearch.search_sources()           外网
                      wave 2  dialogue.plan()   纯函数 → DialoguePlan
                      收尾    reconcile_context_with_child_profile()
                              memory / follow_up 在 family.enrich 里纠正，
                              state_summary 在 orchestrator 收 gather 之后纠正——
                              已确认的档案永远压过旧记忆里的过期事实
                 ↓ TurnBundle
            ├─ _plan_prompt(rc)   已渲染好的 system prompt（含 CACHE_SEAM）
            ├─ dialogue_reply.nuri_reply_sync() / 流式版（传 temporal_context；
            │    窗口里最新那张图作为多模态 content 一起发，并前置 IMAGE_SAFETY_GUARD）
            ├─ _cited_sources()  +  _task_suggestion(allow=plan.allow_task_cards)
            ├─ _persist_ai_turn() → _complete_generation_claim() 把占位行原地改成真回复
            └─ BackgroundTasks：
                 metrics.flush     → chat_turn_logs
                 _after_turn()     → outcome.record + provenance.persist
                 family.extract_and_upsert_memories → user_memories / follow_ups
                                     （同样带 temporal_context，抽出来的记忆才有绝对时间）
```

任何一次失败都会 `_release_generation_claim()` 把占位行删掉，不留幽灵消息。
`GET /messages` 与 prompt 组装都走 `_visible_chat_messages()`，占位行与脚本状态键不会外泄。

首页 NURI 卡另走只读 `GET /api/chat/main/preview`：返回账号的 canonical session，并从已经由
`chat.memory_extract` 写入的到期 `follow_ups.note` 生成一句简短关心式 `check_in_text`。首页不再引用或
展示家长旧消息（例如「你前几天聊的……」），也不会为了 Home focus 再新增一次模型调用；没有到期
follow-up 但已有对话/记忆时，前端显示通用的「最近怎么样？」开场。

### 3.3 首页推荐链路

```
(tabs)/index.tsx
 ├─ GET  /api/feed/personalized      main.py:1224
 │        feed/signals   读最近对话 → topic → 给 content_library 排序
 │        feed/delivery  组卡 → stores.persist_snapshots → recommendation_id
 │        outcome_store  记 impression
 └─ POST /api/feed/research/prepare  main.py:1421（src/feedPreparation.ts 编排，110s 超时）
          content_research（**默认暂停** → 退回 reviewed library）

detail/[id].tsx
 └─ GET  /api/feed/{card_id}/detail  main.py:1954  经 recommendation_snapshots 还原上下文

事件回流：POST /api/recommendations/events → outcome_store（表或 app_settings 兜底）
```

---

## 4. 数据存在哪里

### 4.1 Supabase（唯一真数据库）

> 本地 `.env` 直连**生产** Supabase，没有 staging。跑 eval / sweep 必须 `owner_uid=None` + `LLM_USAGE_LOGGING=0`。

| 表 | 归属 | 写入方 |
|---|---|---|
| `users`、`children` | 1 家庭模型 | `family_store.py` |
| `user_memories`、`follow_ups`、`normalized_inputs` | 1 家庭模型 | `family_store.py`。`normalized_inputs.raw_image_base64` **不再写入**——图片的唯一持久副本在 `chat_messages`，这里只留文本 |
| `chat_sessions`（含 `state_summary` / `state_covered_tokens` / `state_updated_at`） | 3 对话 | `main.py`、`state_store.py`。一个账号一行（`one_session_per_user_migration.sql` 强制）；历史遗留的重复行由 `_canonical_session_for()`（main.py:3632）统一收敛，客户端不再自己挑 |
| `chat_messages` | 3 对话 | `main.py`。`image_base64` 存整张图的 data URI（唯一持久副本，读回时由 `_bound_chat_history_images` 限量）；`transition` 列**复用为生成占位/租约**（`kind = _nuri_generation_claim`）与脚本状态，出库前必须过 `_public_chat_message()` |
| `nuri_style_rules` | 3 对话（legacy 形态的 directive 源） | `dialogue.py` 读；`main.py` admin 与 `#fix` 写。`active=true` **不等于**进 prompt：`mode`（must/advisory）、`priority`、`applies_when` 决定这一轮进不进、进哪一段，见 `nuri_style_rules_selection.sql`。`#fix` 新写的行默认 advisory / priority 50 |
| `nuri_directives` | 3 对话（directive 正式表） | `dialogue.py` 读 |
| `rag_chunks`（`SUPABASE_VECTOR_TABLE`） | 2 知识 | `knowledge_store.py`。两个命名空间：`internal`（必须遵守）、`pdf`（仅供参考） |
| `books`、`source_domains` | 2 知识 | admin 路由 / `websearch.py` |
| `nuri_turn_outcomes` | 4 结果学习 | `outcome.py` |
| `recommendation_events` | 4 结果学习 | `outcome_store.py`；**表不存在时退回 `app_settings` 行** |
| `chat_turn_logs`、`llm_call_logs` | 观测 | `main.py` metrics、`llm_usage.py`。两张表共用 `request_id`（一次用户动作扇出的所有 provider 调用同一个 id），一个 id 即可同时定位回合指标与它花掉的每一次调用。`metrics.flush` 插入失败时会**读错误里的列名、丢掉该列再试**——缺迁移只丢那一列，不会整表静默不记 |
| `nuri_turn_traces` | 观测 | `provenance.py`（表不存在则静默跳过） |
| `tasks`、`favorites`、`feed_cards`、`fix_reviewers`、`email_logs` | 应用层 | `main.py` / `stores.py`。数据库里遗留的 `collections` 表本次不删表，只删除了无入口代码 |
| `app_settings` | 万能兜底（代码里 24 处引用） | feed mode、privacy、快照、推荐事件 |

迁移脚本在 `supabase/*.sql`，**不会自动执行**，需要人工在 Supabase SQL editor 里跑。

### 4.2 非数据库存储

- `internelDatabase/0701/`、`0728/` —— internal 命名空间的 PDF 语料（17 份），由 `backend/scripts/ingest_internal_docs.py` 灌进 `rag_chunks`。
- `data/*.pdf` —— 早期 RAG demo 用的教科书，走 `pdf` 命名空间。
- 前端：`expo-secure-store`（token）+ `AsyncStorage`（onboarding 标记），封装在 `src/utils/storage/`。
- `backend/memstore.py` —— 进程内、按 worker 隔离，仅开发与降级用。
- `backend/evals/out/`、`Nuri_Test/`、`test_reports/` —— 跑出来的结果文件，非运行时数据。

---

## 5. AI 请求怎么形成

### 5.1 prompt 的三段式与缓存

`dialogue_reply.nuri_messages()` → `_assemble()` 产出的消息序列，**顺序即缓存策略**
（OpenAI 自动缓存最长相同前缀，唯一杠杆就是「什么排前面」）：

```
system #1   persona + JSON 契约 + must-follow style rules  ← 全站流量共享同一前缀
            (+ exemplars.guard_for 的语言/语域护栏；没命中范例时是 ceiling_rule_for)
[few-shot]  exemplars 选中的（家长问 / NURI 答）成对消息，按 (语言, 话题) 取
system #2   per-family：child profile → conversation state
system #3   per-turn：long-term memory → card → 命中的条件规则 → advisory 规则
            → internal rules → fetched sources
            + temporal.prompt_block()：本回合冻结的服务器 UTC 与家长本地时间
[system]    IMAGE_SAFETY_GUARD —— 只有窗口里确实带图时才插入
user/assistant × N   最近消息窗（默认 8 条 / 3000 token，见 context_budget）
            每条前面带 temporal.annotate_message() 的可信发送时间标注
user        本回合问题（带图时是 [text, image_url] 的多模态 content）
```

四模型分支下这三段由 `DialoguePlan.system_parts()` 渲染，用 `CACHE_SEAM`（`\x1e\x1e`）
拼成一个字符串传给 `nuri_messages`，后者再劈回来——所以两条 pipeline 只在 system message 上有差别。

时间与图片都挂在**靠后的位置**：时钟块并进 system #3、时间标注进消息窗、图片进最后一条 user
消息。前两段 system 因此仍然逐字稳定，缓存前缀不受影响。

**style rules 分两段，不是一段。** `dialogue.plan()` 按 `mode` 把规则劈成 must 与 advisory：
must 的少数几条挂在 system #1（`HEADINGS["always"]`，措辞仍是「必须遵守」），advisory 的挂在
system #3（`HEADINGS["advisory"]`，措辞是「只挑用得上的一两条，冲突时以上面为准」），
并被 `ALWAYS_ADVISORY_LIMIT` / `CONDITIONAL_ADVISORY_LIMIT` 各截前 3 条。
advisory 放在缓存缝**之后**是因为其中一半由本回合的 facts（`risk_tier` / `topic` /
`has_sources` / `turns` / `age_months` / `locale`）选出，本来就每轮不同；把它放前面会把
system #1 的前缀一起打掉。截断只作用于 advisory——conditional 那一桶里还有 outcome 模型的
负面话题闸门，会被挤掉的闸门不叫闸门。

这段的由来：19 条规则整段以「必须遵守」注入时，模型是逐条去满足的，于是只需要问一句
「宝宝多大」的回合也会带回编号问题清单 + 条列 + 数字 + emoji。测量见
`evals/rule_ablation.py`，逐行处置见 `supabase/migrations/20260831010000_nuri_style_rules_selection.sql`。

**语域是范例扛的，不是规则扛的，而范例按语言分桶。** `exemplars.CORPUS` 有 `lang`
字段（`zh` / `en`），`select()` 既不跨话题也不跨语言，默认范例表 `_DEFAULT_IDS` 的键是
`(语言, 话题)`。语言由 `language_of()` 判定：有汉字就是 `zh`，否则有拉丁字母才是 `en`，
两边都没证据（空串、纯 emoji）落回 `zh`。护栏也跟着分：`guard_for()` 给英文回合发
`GUARD_EN`（英文写的，另外点名「不要写成宣传单」那一路 clinical 措辞）与英文语言子句，
长度上限是 `MAX_CHARS_EN`（500 字符）而不是 `MAX_CHARS`（150 字）——同一个语域，
不同计量单位。

在英文语料存在之前，`topic_of()` 对任何英文句子都返回 ""，所以英文回合**一条范例都没有**，
语域只剩 persona 一个人撑——这就是「英文和简体像在做诊断」的机制层原因。简繁仍共用同一套
繁体语料，简体回合永远是一次转换，`_SCRIPT_CLAUSE["zhs"]` 因此额外要求「换字不换语气」。

一次请求最多重发**一张**图——窗口里最新的那张（`_assemble()` 的 `latest_image_index`）。
更早的图只保留 `[图片]` 文本，避免每一轮都为整个相册付费。图片里的一切（包括 OCR 出来的
文字和二维码指令）在 `IMAGE_SAFETY_GUARD` 里被明确定义为**不可信用户内容**：不能覆盖 system
指令，不能授权搜索、任务、记忆或任何外部动作。

### 5.2 全部 LLM 调用点（按 call_site）

| call_site | 模型 | 触发处 |
|---|---|---|
| `chat.reply` / `chat.reply_stream` | gpt-5.5 | `dialogue_reply.py` — 主回复 |
| `chat.router` | gpt-5-mini | `router.py` — 实质回合的搜索/任务卡决策；问候/确认类不调用 |
| `chat.state_summary` | gpt-5.4-mini | `state_store.py` — 滚动摘要，每几千 token 一次 |
| `chat.memory_extract` | gpt-5.4-mini | `family_store.py` — 回复后台抽记忆 |
| `chat.fix_distill` | gpt-5.4-mini | `dialogue_reply.py` — `#fix` 蒸馏成规则 |
| `chat.tasks_fallback` | gpt-5.5 | `dialogue_reply.py` |
| `rag.embed_query` / `rag.embed_batch` | text-embedding-3-large | `knowledge_store.py` |
| `content_research.prepare` / `_repair` / `.reserve` | `OPENAI_CONTENT_RESEARCH_MODEL` | `content_research.py` — **默认暂停** |
| `feed.gen_cards` | gpt-5.5 | `main.py` — 仅暂停中的每日推送仍保留调用点；**`KNOWLEDGE_CARDS_ENABLED` 默认 off** |
| `push.keywords` / `push.follow_up` | gpt-4.1-mini / gpt-5.5 | 每日推送 — **`DAILY_PUSH_ENABLED` 默认 off** |
| `eval.coherence_judge` | 见 evals | 只在本地 eval |

一次普通 turn 实际会打的：`chat.router` + `rag.embed_query`（命中时）+ `chat.reply`，
后台再加 `chat.memory_extract`，偶尔 `chat.state_summary`。首条消息不再为内部 session title 单独调用模型。

**图片不新增 call_site**：它作为多模态 content 并进 `chat.reply` / `chat.reply_stream` 的同一次调用，
所以带图的 turn 在 `llm_call_logs` 里只表现为这一行的 token 数变大。

成本观测有两条必须保持的契约：`_TurnMetrics.record_prompt()` 会把所有连续的 leading system
messages 合计为 `system_chars`，再单独切 few-shot 与真实 history；`/admin/llm-usage/summary` 用
PostgREST `.range()` 分页读取（每页最多 1000），并返回 `available_calls`、`sampled_calls` 与可信的
`truncated`。否则 system #2/#3 会被误算成 few-shot/history，或统计静默只看最近 1000 行。

### 5.3 影响 prompt 的关键开关

| 变量 | 默认 | 作用 |
|---|---|---|
| `NURI_PIPELINE` | `four_model` | 设为 `linear` 切回旧的单 gather 路径 |
| `CONTEXT_RECENT_MESSAGES` / `_TOKEN_LIMIT` | 8 / 3000 | 最近窗大小 |
| `CONTEXT_STATE_TOKEN_LIMIT` / `_REFRESH_TOKENS` | 600 / 3500 | 摘要上限与刷新触发点 |
| `FEWSHOT_EXEMPLARS` / `_COUNT` / `_STICKY_TURNS` | 1 / 2 / 3 | few-shot 范例 |
| `FEWSHOT_MAX_CHARS` / `_MAX_CHARS_EN` | 150 / 500 | 回复长度上限，中英各一个。两个数不同不是笔误：150 个汉字≈90 个英文单词 |
| `INTERNAL_MIN_SIMILARITY` | 0.5 | internal 命中门槛（实测只有 13% 的 turn 命中，见 `evals/internal_recall.py`） |
| `REPLY_REASONING_EFFORT` | `low` | 22.2s → 12.5s，输出结构不变 |
| `WEB_SEARCH_PROVIDER` | `null` | 不设就完全没有外部来源 |
| `client_context.timezone`（**请求字段，不是环境变量**） | `UTC` | 决定 prompt 里的时钟块与每条消息的时间标注。服务端只信这个时区名；客户端送来的 `local_datetime` / `utc_offset_minutes` 只作诊断，不参与任何日期运算 |
| `dialogue.ALWAYS_ADVISORY_LIMIT` / `CONDITIONAL_ADVISORY_LIMIT`（**代码常量，不是环境变量**） | 3 / 3 | 一次进 prompt 的 advisory 规则条数。调大就是往回走——19 条全进正是要修的那个状态 |
| `nuri_style_rules` 行上的 `mode` / `priority` / `applies_when`（**数据，不是开关**） | advisory / 50 / `{}` | 不用发版就能改语气：admin 页与 `PATCH /admin/style-rules/{id}` 都能写。降一条规则用 `active=false` 或降 `priority`，收窄一条用 `applies_when` |

---

## 6. 哪些是 legacy

| 位置 | 状态 | 说明 |
|---|---|---|
| 旧 RAG demo HTTP 面 | **已删除** | `/index`、`/ask`、`_generate_rag_answer` 以及 Vercel rewrites 已移除。`/api/index-from-url` 不是死代码：`admin.tsx` 上传 PDF 后调用它，现已保留并修复 router 挂载顺序。 |
| `backend/auth.py` | **已删除** | 全仓 0 处 import；main.py 现有 auth helpers 是唯一实现。 |
| `.github/copilot-instructions.md` | **严重过期** | 描述的是 Streamlit + ChromaDB 的 RAG demo，引用的 `app.py` / `ingest_pdf.py` / `rag_store.py` / `rag_query.py` **全部不存在**。会主动误导任何读它的 agent。 |
| `.vercelignore` | 过期 | 忽略的 `app.py` 和 `.streamlit/` 都已不存在。 |
| `nuri_style_rules` 表 | 过渡形态，但已不再是「整段注入」 | `dialogue.py` 仍写着「keep as a directive source until the rows are migrated into nuri_directives」。原本 19 行全部以「必须遵守」进 prompt，其中 5 行直接造成「一次问 3-5 个问题 + 长列表」的体裁（`evals/rule_ablation.py`）。`nuri_style_rules_selection.sql` 已给每行补上 mode/priority/applies_when 并重写了其中 5 条文案——是**改判处置**，不是删除：那 5 条的原意（一次收齐情况、给可执行的量）保留成了例外条款。 |
| `_reply_context` 的 linear 分支（`main.py:4536` 起） | 保留待比较 | 只有 `NURI_PIPELINE=linear` 才会走。存在的理由是 A/B，不是兜底。 |
| `supabase/message_sources_migration.sql`、`fewshot_metrics_migration.sql`、`turn_routing_metrics_migration.sql`、`privacy_settings_migration.sql`、`remove_render_migration.sql` | 迁移在，代码不再引用对应表 | 前两个在 main.py 里只剩「arrive with 这个迁移」的注释。 |
| `doc/codex_mac_handoff.md`、`ordash_family_growth_handoff_2026-05-30.md`、`project_handoff_zh.md`、`family_growth_radar_prd_v0_1.*` | 历史交接文档 | 2026-07-02 之后没动过，描述的是早期形态。 |
| `README.md` | 空壳 | 内容是「# Here are your Instructions」。 |
| `replacements.txt` | 一行 sk- 脱敏正则 | 无人引用。 |
| `data/*.pdf` | 早期 RAG 语料 | 和 `internelDatabase/` 的 NURI 自有语料不是一回事。 |

---

## 7. 哪些代码目前实际上没有被调用

### 7.1 真·无引用

| 目标 | 证据 |
|---|---|
| `memstore.clear_all()` | 定义处之外 0 引用，连测试都没用。 |
| `provenance.compare()` | 只有 `backend/tests/test_nuri_core.py:475` 调，无运行时调用者。 |
| 旧 feed / collections / 收藏保存入口 | **本次已删除**：`/api/feed`、`/feed/alt`、`/feed/search`、`/feed/generate`、`/collections/*`、`/favorites/save`，连同 `api.ts`、preview 假接口、stores/memstore 与过期测试。首页继续走 `/feed/personalized`；收藏继续走 `/favorites` + `/favorites/toggle`。 |
| 旧 RAG 与会话删除入口 | **本次已删除**：`/index`、`/ask`、`DELETE /api/chat/sessions/{id}`。账号只有一段持久对话，删除全部历史只允许走 privacy wipe。 |
| `/admin/books`、`/admin/memories`、`/admin/discover` | 没有前端管理页入口，但保留为运维/透明度接口，暂不把「没有 UI」等同于「没有用途」。 |
| `/api/analytics`、`/api/favorites/toggle`、`/api/index-from-url`、`/admin/fix-reviewers` | **都有前端调用，必须保留**。旧版结构图曾误判；详情页调用 analytics 与 favorite toggle，管理页调用 index-from-url 与 fix-reviewers。 |
| `tests/__init__.py`、`frontend/tests/__init__.py` | 两个空目录，没有任何测试文件（真正的后端测试在 `backend/tests/`，41 个文件）。 |

### 7.2 因开关默认关闭而不执行（是**暂停**，不是死代码——设环境变量即恢复）

| 子系统 | 开关 | 关闭时的行为 |
|---|---|---|
| 卡片实时研究 `content_research.py` | `KNOWLEDGE_CARDS_ENABLED=0` | `runtime.content_research_oai is None`，delivery 走已审核内容库；`_gen_feed_cards_sync` 返回 `[]`。旧 `/api/feed/generate` 已删除，但暂停中的 daily push 仍引用生成器，所以函数保留。**不打 provider**（`tests/test_paused_subsystems.py` 钉住了这点）。 |
| 每日邮件推送 | `DAILY_PUSH_ENABLED=0` | `push.keywords` / `push.follow_up` 不发生。 |
| 外部网页搜索 | `WEB_SEARCH_PROVIDER=null` | `websearch` 返回空，回复无引用。`stub` 只能显式选，绝不作为 fallback。 |
| `nuri_directives` / `nuri_turn_traces` / `recommendation_events` | 迁移未跑 | 各自退化：directives 只剩 style rules；trace 静默不落；事件回退 `app_settings`。 |

### 7.3 只在本地跑、不在请求路径上

`backend/evals/`（8 个）、`backend/scripts/`（4 个）、`backend/golden_agent/`（3 个）、
`frontend/scripts/`、`frontend/e2e/`。

`evals/language_register.py` 是新加的那个：同一个场景跑繁中／简中／英文三遍，报告
是否以「先接住家长」开场、有没有掉进说明书语域、长度与提问数。语域是范例扛的，
而范例按语言分桶，所以「英文读起来冷」这类问题只有这个脚本能证伪。

其中 `backend/scripts/recover_account_history.py` 是**运维工具，不是接口**：在账号之间保守地
复制 children / chat_sessions / chat_messages / normalized_inputs / user_memories。默认 dry-run
并写一份本地 JSON 备份，`--apply` 才真的写；插入的 ID 是 UUIDv5，重跑幂等，永不改写源行，
也不迁移任务、推荐、收藏、权限、隐私设置和凭据。

---

## 8. 已知的坑（改动前先看）

1. **`app.include_router(api)` 必须放在最后一条 `@api.*` 之后。** FastAPI 在 include 时复制 router
   的现有路由；此前 `/api/index-from-url` 定义在 include 之后，实际路由表中不存在。本次已移动挂载点，
   新增 API 路由不要再写到它后面。
2. **`nuri_core` 不许 import `main.py`**。需要什么就加到 `ports.CorePorts`，并在 `_core_ports()`（`main.py:4412`）里接线。
3. **`memstore` 的模块级名字只能原地改**，rebind 会让其他模块留在旧对象上。
4. **安全探测器（`urgent_task_suppressed` / `crisis_detected`）在 `dialogue_reply.py`，policy 在 `safety.py`**——
   改判定逻辑和改后果是两个文件。
5. **本地 `.env` 指向生产库**，无 staging。
6. **`supabase/*.sql` 不会自动执行**。加了迁移必须同时说明「谁去 Supabase 跑」。
7. 生产只从 `origin/main` 部署；只推 `backend` 分支等于没部署。
8. **`JWT_SECRET` 在部署环境是硬要求**：`VERCEL_ENV` 为 `preview` 或 `production` 时，缺省、
   沿用本地默认值或不足 32 字符，都会在 **import 期**抛 `RuntimeError`，整个 function 起不来。
   本地保留旧的默认值，所以「本地能跑」不能证明部署能起。
9. **聊天路径不再有内存兜底**。`_require_chat_storage()` 拿不到 Supabase 就 503。别为了本地
   方便把它改回 memstore——Vercel 实例是一次性的，那等于把丢数据伪装成「已保存」。
10. **`chat_messages` 里有不该给人看的行**：生成占位（`transition.kind == "_nuri_generation_claim"`）
    和内部脚本状态键。任何新的读路径都必须走 `_public_chat_message()` / `_visible_chat_messages()`，
    否则占位行会漏进前端气泡或 prompt。
11. **喂给检索和路由的上下文必须脱敏**。`FamilyState.search_context()` 现在返回的是
    `child_age_context`（只有年龄），不再是 `profile_block`。新增任何把上下文送去搜索、
    送去外部 provider、或落进指标表的路径，都要先过 `family_store.redact_child_profile_*`。
12. **`risk_tier` 不是「有没有危险」，`elevated` 只表示这家有 constraint**。`safety.assess`
    看到 `family.constraints` 非空（一条过敏就够）就升到 `elevated`。所以给规则写
    `applies_when: {"risk_tier": ["none"]}` 会把它对所有登记过过敏的家庭静默关掉——
    要「非医疗回合」就写 `["none","elevated"]`。
13. **改了 style rule 的文案就要重跑 `evals/rule_ablation.py`**。这些行是数据不是代码，
    没有测试会因为它们变差而变红；唯一的证据是评测输出。
14. **加了一个话题闸门，就要同时加中英两套**。`exemplars._DEFAULT_IDS` 的键是
    `(语言, 话题)`，只补一边会让另一种语言在那个话题上退回「零范例」——而零范例正是
    英文之前读起来像说明书的原因。`test_both_languages_cover_every_gate` 会拦住这件事。
15. **英文范例是本仓库自己写的，没有母语育儿工作者审过**。中文那十二条出自一份真实咨询
    记录，英文十二条是照着同场景、同三拍重写的。要改语气先改英文这一套，别只改 persona。
14. **新依赖有两份 requirements 要改**：`Pillow`（图片校验）和 `tzdata`（Linux 上 zoneinfo 需要）。
    根目录的 `requirements.txt` 是 Vercel 实际安装的那份，`backend/requirements.txt` 是本地那份，
    只改一份会在部署或本地其中一边炸。
