# Community 后端（/api/community/v1）

实现：`backend/community.py`（在 `backend/main.py` 挂载）。迁移：`supabase/migrations/20261105010000_community.sql`。测试：`backend/tests/test_community.py`。

依据：Figma「定稿版本」文件中的“Community 后端接口交接”（AdHDK7uLqyzvgbzm1FlM6F，node 216-13472）。该文档对应 web 分支 `web-ios-parity-20261103-1027` 和 iOS 1027。前端社区目前仍是本地 reducer，**没有调用任何社区接口**，所以下面的路径和字段按交接稿里的 PROPOSED 能力组 P01–P36 实现，前端接线时以本文为准。

## 通用约定

- 鉴权：沿用现有 Bearer JWT（`_req_uid`），每次请求都会重新确认账号存在。请求体里不接受任何 owner/sender 字段，未声明的字段一律返回 422。
- 公开资料：其他家长只能拿到 `{parent_id, display_name, about, city, intents, role, avatar}`。`parent_id` 是独立的 public uuid，不是账号 id。匿名身份为 `{parent_id: null, display_name: "匿名家长", anonymous: true}`。
- 写操作幂等：创建类接口必须带 `client_request_id` 或 `client_message_id`（8–128 字符）。同 key 同内容会返回第一次的结果（HTTP 200，`created: false`）；同 key 不同内容返回 409 `IDEMPOTENCY_CONFLICT`。
- 版本控制：状态变更接口可带 `expected_version`，版本不一致返回 409 `VERSION_CONFLICT`，`context.current_version` 给出当前版本。数据库更新本身是按 version 的 compare-and-set。
- 分页：统一返回 `{items, next_cursor, has_more}`，`page_size` 默认 20、最大 50，游标基于 bigint `seq`，不会因时间戳相同而丢行或重复。
- 错误格式：沿用现有 `{detail, error{code,message,retryable,retry_after_ms}, request_id}`，社区接口额外可能带 `context`。错误码如下：

| code | HTTP | 含义 |
|---|---|---|
| NOT_FOUND_OR_NOT_ACCESSIBLE | 404 | 不存在、不可见、或对方屏蔽了你（三者不加区分） |
| VALIDATION_FAILED | 422 | 字段不合法（含 pydantic 校验错误） |
| QUESTION_CLOSED | 409 | 问题已关闭 |
| DELIVERY_LOCKED | 409 | 已回答、已过期或已不可回答；`context.lock_reason` 给出原因 |
| RELATIONSHIP_NOT_ALLOWED | 403 | 未建立联系 / 无此权限 |
| BLOCKED_OR_DISCONNECTED | 403 | 已断开或已屏蔽（不透露是谁屏蔽了谁） |
| CONSENT_REQUIRED | 403 | 缺少该用途的 AI 授权 |
| CONSENT_REVOKED_OR_CHANGED | 409 | 授权已撤回、轮次（epoch）已变或告知版本已变 |
| IDEMPOTENCY_CONFLICT | 409 | 同 key 不同内容 |
| VERSION_CONFLICT | 409 | 已被其他设备修改 |
| MEDIA_NOT_READY_OR_NOT_OWNED | 422 | 附件未就绪、用途不符或不属于本人 |
| RATE_LIMITED | 429 | 超出每日上限，带 `Retry-After` |
| STORAGE_OR_SERVICE_UNAVAILABLE | 503 | 存储或 AI 不可用（不会伪装成空列表） |

## 接口清单

| 能力 | 方法与路径 | 要点 |
|---|---|---|
| P01 PROFILE_READ | GET /profiles/me | 未建立时返回 `exists:false`，不会回填示例资料 |
| P02 PROFILE_EDIT | PATCH /profiles/me | display_name（首次必填）/about/city/intents/avatar_media_id/clear_avatar/share_location+latitude+longitude/expected_version |
| P03 PUBLIC_PROFILE | GET /parents/{parent_id} | 公开资料 + `relationship{state, relationship_id, invitation_id, conversation_id, allowed_actions}` |
| P04 DISCOVERY | GET /recommendations | `role=any\|mom\|dad`、`distance_miles=1\|3\|5\|10`、`intents=a,b`、cursor/page_size；返回 `distance_miles`（取 0.5 英里整）、`shared_intents` |
| P05 POLISH | POST /question-polishes | `text, language, ai_consent_version, client_request_id`；返回 `{original, polish{id,text}}` |
| P06 Q_CREATE | POST /questions | `body, original_language, version_source, polish_id, anonymous, show_child_age, client_request_id`；返回 `{question, delivery{recipient_count,state}, operation, created}`；首次创建返回 201，重试返回 200 |
| P07 OPERATION_STATUS | GET /operations/{operation_id} | 发布是同步完成的，`question:<id>` 直接返回 succeeded |
| P08 Q_MINE | GET /me/questions | `status=all\|open\|closed`、`q` 正文搜索、分页；返回真实 reply_count |
| P09 Q_DETAIL | GET /questions/{id} | 只有作者和收到该问题的家长可见；收件人视角会附带 `delivery` |
| P10 Q_TRANSITION | POST /questions/batch-transitions | `action=close\|delete, items[{question_id, expected_version}], confirmed:true`；逐项返回结果 |
| P11 Q_RECEIVED | GET /me/question-deliveries | `tab=waiting\|replied\|locked`；到期的条目会先转为 locked |
| P12 RESPONSE | POST /question-deliveries/{delivery_id}/responses | `body, language, anonymous, expected_version, client_request_id`；每条投递只能回答一次 |
| P13 REPLIES_READ | GET /questions/{id}/replies | 提问者看到全部回复，回答者只看到自己的；附带 `all_thread` |
| P14 COMMENTS | GET/POST /questions/{id}/reply-threads/{thread_id}/comments | `thread_id=all` 或 reply_id；POST 需 `body, language, client_message_id` |
| P15 INVITATIONS | GET /invitations（`direction=received\|sent`, `state`）；POST /invitations `{target_parent_id, client_request_id}` | 发出后只是 pending；双方互发会合并成一个联系 |
| P16 INVITATION_DECISION | POST /invitations/{id}/decisions `{decision: accept\|decline, expected_version, client_request_id}` | 只有接收者能处理 |
| P17 RELATION_LIST | GET /me/contacts | `q` 按显示名搜索；返回 relationship_id、conversation_id |
| P18 DISCONNECT | DELETE /relationships/{id}?confirmed=true&expected_version= | 保留历史，并关闭 AI |
| P19 BLOCKS | GET /me/blocks；PUT /me/blocks/{parent_id} `{confirmed:true}`；DELETE /me/blocks/{parent_id}?confirmed=true | 屏蔽会断开联系、取消邀请、锁定等待中的问题并撤回 AI；解除屏蔽什么也不恢复 |
| P20 INBOX | GET /me/inbox | 有消息的会话，带 last_message 和 unread_count；`summary{pending_invitations, waiting_questions, unread_conversations}` |
| P21 P2P_CHAT | POST /conversations `{target_parent_id \| relationship_id, client_request_id}` | 必须已建立联系；AI 默认关闭 |
| P22 P2P_MESSAGES | GET/POST /conversations/{id}/messages | POST 需 `text, media_ids[≤9], language, client_message_id`；`state:"saved"` 只代表已保存，不代表已送达或已读 |
| P23 READ_CURSOR | PUT /conversations/{id}/read-cursor `{last_read_seq}` | 只能前进，并校验该 seq 属于本会话 |
| P24 PREFERENCES | GET/PATCH /preferences | `parent_message_notifications_enabled, profile_hidden, auto_translate_messages, expected_version` |
| P25 AI_CONSENT | POST /conversations/{id}/ai-consent-requests `{purpose: conversation_notes\|translation, notice_version, client_request_id}` | 发起者自动记为同意，对方仍须自己决定 |
| P26 AI_CONSENT_DECISION | PUT /ai-consent-requests/{id}/my-decision `{decision, notice_version, expected_version, client_request_id}` | 只能改本人的决定；双方都 allow 才生效 |
| P27 AI_REVOKE | DELETE /conversations/{id}/ai-participation?purpose= | 任一方可随时关闭；epoch+1，旧请求随之作废 |
| P28 AI_ACTIVITY | GET /conversations/{id}/ai-participation | 双方决定、各用途的 effective/epoch；`operations` 目前固定为空 |
| P29 TRANSLATION | POST /messages/{id}/translations `{target_language, ai_consent_version, client_request_id}` | 译文单独返回，不会覆盖原文 |
| P30 TRANSCRIPTION | POST /transcriptions `{audio_base64, locale, ai_consent_version, client_request_id}` | 复用 /chat/transcribe；只返回草稿文本，不发送 |
| P31 MEDIA（App 使用） | POST /media `{purpose: avatar\|message, data_uri, client_request_id}` | 一张已压缩的图片（data URI），服务端校验真实字节后存入私有桶，直接返回 ready 的 media_id；重试同 key 不会重复存 |
| P31 MEDIA（大文件预留） | POST /media/uploads `{purpose: avatar\|message, mime_type, byte_size, sha256, client_request_id}` | 返回签名上传 URL（PUT，30 分钟） |
| P32 MEDIA_COMPLETE | POST /media/uploads/{id}/complete | 服务端下载真实字节，校验大小、sha256、格式和尺寸 → ready 或 rejected |
| P33 MEDIA_ACCESS | GET /media/{id}/access | 300 秒签名读取 URL；按会话成员 / 头像可见性授权 |
| P34 MEDIA_DELETE | DELETE /media/{id} | 只能删未发送的草稿，已发送的附件不能删 |
| P35 COMMUNITY_NOTIFICATIONS | GET /me/notifications | `notification_events` 里 `data.kind` 以 `community_` 开头的事件，带 `read_at` |
| P36 NOTIFICATION_TARGET | GET /me/notifications/{id}/target；POST /me/notifications/{id}/read | target 按当前权限重新校验，不可访问时返回 `accessible:false` |

现有接口的两处调整：
- `GET /api/notifications/{id}`：社区事件的 `target` 是类型化的应用内引用。
- `POST /api/notifications/{id}/open`：遇到社区事件返回 403 `RELATIONSHIP_NOT_ALLOWED`，不会再往 NURI 私聊写消息（交接稿 E12）。

## 对 20 项问题的做法

2026-11-06 会议已定案的项（来自《Community会议决策表》）标注“会议”，其余仍是保守默认，等待后续决定。

- **D01 公开身份（会议：社区名称可以更改，和系统同步）**：社区名字在编辑档案里可改，改动会同时写入账号昵称（`users.nickname`）；在账号资料里改昵称，也会同步到社区名字。第一次建档案没填名字时，默认用账号昵称。城市不同步。
- **D02 交友意图**：6 个稳定 code，按前端索引 0–5 对应：`share_parenting_ideas, talk_parenting, similar_experiences, outings_with_children, nearby_parents, casual_chat`。
- **D03 推荐与距离（会议：社群 onboarding 增加性别 tag）**：引导页新增自选标签 `gender_tag`（mom / dad / other），推荐里的妈妈/爸爸筛选只看这个标签，不再从 `users.parent_role` 推断；未选的家长在按性别筛选时不出现。公开资料返回 `role`（仅 mom/dad）和 `gender_tag`。距离只在双方都主动分享粗略位置时计算：位置取 2 位小数（约 1 公里），展示时再取 0.5 英里整。不分享位置的家长不能使用距离筛选。
- **D04 问题分发（会议：家庭情况/孩子年龄匹配程度/区域/问题关系度/让 AI 写）**：在最近更新的 200 个可见社区资料里（排除隐藏和任一方向屏蔽），先按规则打分：最小孩子的月龄接近度 40%（相差两年内线性递减）、同一区域 25%（社区城市或账号城市）、家庭关注点 `top_concerns` 重合度 35%。取前 20 名交给 AI，按与问题的相关度重排，最后投递给前 5 人（`COMMUNITY_DELIVERY_FANOUT`）。发给 AI 的只有问题正文、提问者孩子年龄段，以及每位候选人的编号、孩子年龄段、关注点代码、意图代码和是否同区域，不含名字、id 或自我介绍。AI 不可用、超时（8 秒）或出错时，按规则分数投递。`COMMUNITY_AI_MATCHING=0` 可关闭 AI 重排。仍然没有审核流程。
- **D05 匿名与年龄**：匿名只隐藏展示身份，服务端照常记录作者。年龄取发布时最小一个孩子的月龄快照，未出生的不计。
- **D06 锁定（会议：30）**：投递 30 天后过期（`COMMUNITY_DELIVERY_TTL_DAYS`，我按“30 天”理解）；问题关闭或删除、发生屏蔽时也会锁定。每条投递只能回答一次，不能修改。
- **D07 关闭与删除**：批量操作逐项执行，不是整体原子。关闭后仍可阅读，但不能再回复或评论；删除是软删除，所有人都看不到。没有重新打开功能。
- **D08 回复线程**：“回复所有人”线程只有提问者能发，所有回答者能读；单条回复线程只有提问者和该回答者能读写。
- **D09 关系**：只有建立联系后才能聊天；交叉邀请会合并；不能取消已发出的邀请（UI 没有这个功能）。
- **D10 屏蔽**：屏蔽会断开联系、取消待处理邀请、锁定双方之间等待中的问题、撤回 AI。已有消息保留，但会话变为只读。对方看到的结果与“已断开”或“不存在”一样。
- **D11/D12 AI 授权**：按用途分开（`conversation_notes` / `translation`）。告知版本是 `COMMUNITY_AI_NOTICE_VERSION`。（会议 D12：所有内容都可以）双方同意后，授权覆盖整段对话，包括同意之前的消息（`effective_from_seq` 为 0）；告知文案和版本随之更新为 `2026-11-06.1`。撤回、屏蔽、断开都会让 epoch+1。目前没有实际的 AI 记录或整理任务。
- **D13 润色、翻译、转写**：都要求客户端传入与 `NURI_AI_CONSENT_VERSION`（默认 `2026-10-01.1`，即 app 的 aiConsent 版本）一致的值。翻译对方的消息时，还需要该会话 `translation` 用途双方都已同意。
- **D14 媒体（会议：语音是转写）**：语音只做转写：录音转成文字放进输入框，可编辑，不存音频，也不会自动发送。图片只接受 JPEG/PNG/WebP，每张 ≤2.5 MB（App 先压到最长边 1600），App 每条消息发一张，接口允许最多 9 张。暂不支持视频和音频消息。
- **D15 通知**：写入 `notification_events`（type=chat，kind=`community_*`），按业务事件去重。家长关闭“家长消息通知”或屏蔽了对方时不推送。锁屏文案统一为不含内容的泛化提示。
- **D16 分页**：见通用约定。
- **D17 限额**：问题 10 条/天、邀请 20 条/天（可用环境变量调整）。字数上限：问题 1000、回复 2000、评论 1000、消息 2000、about 300、名字 30。目前没有举报功能。
- **D18 删除**：所有社区表都 `on delete cascade` 到 `public.users`，账号删除会一并清掉。但 **community-media 存储桶里的文件不会被级联删除**，还需要补一个清理任务。`privacy/wipe` 不涉及社区数据。

## 需要手动执行（prod）

0. 2026-11-06 起新增：执行 `supabase/migrations/20261106010000_community_gender_tag.sql`（给 `community_profiles` 加 `gender_tag` 列）。**要在部署这版代码之前执行**，否则保存性别标签会报 503。


1. 在 prod Supabase（`cxxidflulsdmcnazrouw`）的 SQL Editor 中执行 `supabase/migrations/20261105010000_community.sql`。文件里的语句都可重复执行（`if not exists` / `on conflict do nothing`），并且会创建私有存储桶 `community-media`。
2. 确认 `storage.buckets` 里有 `community-media`，且 `public = false`。
3. 可选的环境变量（都有默认值）：`COMMUNITY_AI_MODEL`、`COMMUNITY_DELIVERY_FANOUT`、`COMMUNITY_DELIVERY_TTL_DAYS`、`COMMUNITY_QUESTIONS_PER_DAY`、`COMMUNITY_INVITATIONS_PER_DAY`、`COMMUNITY_AI_NOTICE_VERSION`、`NURI_AI_CONSENT_VERSION`、`COMMUNITY_MEDIA_BUCKET`。
