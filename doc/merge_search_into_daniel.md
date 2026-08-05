# 合并交接：把 live-search-line 并入 daniel-test

分支：`merge-search-into-daniel`（从 `origin/daniel-test` 开出）
已完成：`70c2018` —— 零冲突的新文件已经落地，98 个新测试在这个基底上通过。

产品决定：**合成同一套**，不保留两套外部检索。

---

## 1. 两条线各自是什么

| | `daniel-test`（35 commits，+33k 行） | `live-search-line`（19 commits，+5k 行） |
| --- | --- | --- |
| 服务的界面 | 首页三张推荐卡 | 对话回复里的引用 |
| 检索 | `content_research.py`，`gpt-5.4-mini`，预生成 | `websearch.py` + Tavily，回复前实时 |
| 白名单 | `content_library.py` 精确 URL + `doc/content_source_whitelist_v0_9.md` | `source_domains` 表，域名级，运营可改 |
| 交付单位 | 一文一视频，原子发布，冻结快照 | 3 条来源，模型只回编号 |
| 任务卡 | `task_proposals`，主回复同一次调用 | router 判断 + 每话题每日额度 |

两边**都**做了外部检索，只是一个预生成给首页、一个即时给对话。

---

## 2. 已经落地（`70c2018`）

新文件，互不冲突，当前 inert：

```
backend/router.py  websearch.py  search_tavily.py  scripts/check_search.py
backend/tests/test_router.py  test_websearch.py  test_search_tavily.py
frontend/src/i18n/{index.tsx,en.ts,zh-TW.ts}
supabase/{source_domains,turn_routing_metrics,message_sources,
          privacy_settings,follow_ups}_migration.sql
supabase/nuri_style_rules_seed.sql
backend/requirements.txt  (+httpx)
```

验证：`pytest backend/tests/test_router.py test_websearch.py test_search_tavily.py -q` → 98 passed。

---

## 3. 还没做的，按建议顺序

每一步单独 commit、单独跑测试。除了第 5 步，都不该动 `content_research.py`。

### 步骤 1：统一白名单（先做，因为它同时解锁两边）

`content_library.py` 的 `TRUSTED_RESOURCE_HOSTS` 是 Python frozenset；`source_domains`
是数据库表，运营改完即时生效、不用部署。

- 把 frozenset 里的域名灌进 `source_domains`（`developingchild.harvard.edu`、
  `asha.org`、`fhs.gov.hk`、`youtube.com` 等是这边没有的）
- `content_library.is_trusted_resource_url()` 改成读表，保留 frozenset 作为读表失败时的
  兜底 —— 那条路径服务的是已发布内容，不能因为数据库抖动就全部拒绝
- **注意**：`source_domains` 有 tier（authority/good/neutral/blocked）和 lang，
  `TRUSTED_RESOURCE_HOSTS` 没有。灌进去时要人工分层，不能全填 authority

### 步骤 2：把 router + 检索接进 `_reply_context`

参考 `live-search-line` 的 `backend/main.py`：`_route_and_search`、`_ReplyContext`。
他们的 `main.py` 在这一段改动很大，**不要照抄 diff，要重新接**。

要点：
- router 跑在 `asyncio.gather` 里，和其他 context block 并行
- 搜索是 router 的下游，串联，所以只有搜索真正加在首字延迟上
- 两者失败都返回空，绝不能让主回复挂掉

### 步骤 3：引用管线

- `_NURI_RESPONSE_FORMAT` 加 `cited: [int]`，**`text` 必须保持在第一位**（流式先出）
- `_cited_sources()` 用编号索引回后端自己抓的结果 —— 模型永远不写 URL
- `chat_messages.sources` 已有 migration
- **和他们的 `task_proposals` 不冲突**，两个字段并存

### 步骤 4：任务卡 —— 照他的原样合，跳过（已决定 2026-08-04）

产品决定：**用 `daniel-test` 的 `task_proposals`，不动。** 这一步没有工作量。

`live-search-line` 上的每话题每日额度层（`_plan_task_cards`、`TASK_CARDS_BY_TOPIC
= (3,2,1)`、`_same_topic`）**留在那条分支上，不搬过来**。

为什么不顺手加上：它解决的是「一天里卡片出太多次」，而这个问题目前还没有被观测到 ——
他那版刚做完、测试同事还没用过。现在就叠一层节流，万一卡片变少了，会分不清是他的判断
保守还是额度挡掉了。先让频率暴露出来，再决定加不加。

真的要加的时候，前提是有人产生话题标签。届时三选一：

- **A** router 保留 `topic`（不再判 `suggest_tasks`），额度层直接可用
- **B** 从 `task_proposals` 的内容自己推话题，不依赖 router
- **C** 不加

额度层本身值得留着的理由：它替换掉的是「一段对话只给一组卡」，那条规则在首页
复用同一个 session 的前提下等于「永远只给一次」——家长一周后带着新烦恼回来，
再也拿不到卡片。他那版没有跨轮次的频率控制。

### 步骤 5：前端

- `chat/[id].tsx`：加 `RichText`（`**粗体**` + 可点的 `[n]` 引用）和 `SourceChips`。
  他们在这个文件加了 `feed_refresh` nonce 和任务核准追踪，**两边都要保留**
- i18n 包装：在他们的版本上重跑一遍，机械性工作
- 孩子月龄用**他们的** `src/child-age.ts::completedAgeMonths`，比这边的 `monthsOf` 正确
  （处理月末和闰日）

### 步骤 6：`.env.example`

两边各自加了变量，需要合并而不是覆盖：

```
# 这边的
ROUTER_MODEL=gpt-5-mini            ROUTER_TIMEOUT_S=4.5
ROUTER_REASONING_EFFORT=minimal    REPLY_REASONING_EFFORT=low
WEB_SEARCH_PROVIDER=null           WEB_SEARCH_TIMEOUT_S=6.0
WEB_SEARCH_MAX_RESULTS=3           TAVILY_API_KEY=  TAVILY_SEARCH_DEPTH=basic

# 他们的（见 handoff 第 18 节）
OPENAI_CONTENT_RESEARCH_MODEL / _TIMEOUT_S / _CONCURRENCY
CONTENT_RESEARCH_CACHE_TTL_S / _FAILURE_CACHE_TTL_S / _CACHE_MAX_ITEMS
RECOMMENDATION_SNAPSHOT_SECRET
```

---

## 4. 已知的实测数字（别再重新试错）

| | 结论 |
| --- | --- |
| `REPLY_REASONING_EFFORT` | gpt-5.5 默认 22.2s，`low` 12.5s，输出结构完全相同。`minimal` 不被接受 |
| `ROUTER_REASONING_EFFORT` | gpt-5-mini 默认 10.5s，`minimal` 1.65s |
| `WEB_SEARCH_MAX_RESULTS` | Tavily 延迟跟这个走，不跟域名清单走：5 条 ~2.4s，3 条 ~0.74s |
| 开放网络检索 | 「4个月宝宝不吃辅食」返回两条 Instagram + 一个佛州郡政府页。**别开** `WEB_SEARCH_ALLOW_OPEN_WEB` |
| 白名单宽度 | 医疗查询限 5 个域名返回 PDF 和医院微网站；放宽到 13 个返回 AAP 的对应页面。**要宽不要窄** |
| 中文权威 | 港台官方（`fhs.gov.hk`、`hpa.gov.tw`）是「用中文写的 AAP」，繁简都有 |

---

## 5. 两个反复咬人的坑

**router 的判断对象**：判「NURI 接下来要说的话需不需要依据」，不是判「家长这句是不是在提问」。
写成后者的时候，真实咨询里家长多半在回答追问，搜索永远不触发，线上跑了一整天
`needs_search` 全是 false 才被发现。

**失败必须可见**：`route_ok=False` 和「模型判断这轮不用搜」行为一样，但必须在
`chat_turn_logs` 里分得出来。这个项目已经出过一次「功能看起来接好了、实际静默 no-op」
（`nuri_style_rules` 表根本没建）。

---

## 6. 部署前

Migration（都幂等）：`source_domains` / `turn_routing_metrics` / `message_sources` /
`privacy_settings` / `follow_ups` / `nuri_style_rules_seed`。

Vercel 必须手动设的只有两个（其余代码里有默认值）：
`WEB_SEARCH_PROVIDER=tavily` 和 `TAVILY_API_KEY`。

线上先维持 `null`，本机验证过再翻。
