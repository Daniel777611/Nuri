# NURI 后端交接材料 — DeepEval 多轮测试

对应交接清单 §8 的 H-01 ～ H-09。2026-08-30。

| 编号 | 材料 | 在哪 |
|---|---|---|
| H-01 | API contract | `NURI_Test_API_Contract.md` |
| H-02 | .env.example | `.env.example` |
| H-03 | staging/test 地址 | 见下 |
| H-04 | 测试账号 | 见下（凭据另行交付） |
| H-05 | 请求/响应样例 | `sample_request_response.json` |
| H-06 | 版本信息 | 见下，也在每条响应里 |
| H-07 | 事件字典 | `event_dictionary.md` |
| H-08 | 测试隔离说明 | 见下 |
| H-09 | 限流/超时说明 | `rate_limits_and_timeouts.md` |
| H-10 | 网页自动化信息 | 不适用 —— API 可用，无需 UI 自动化 |

---

## H-03 测试地址

```
https://nuri-git-nuri-test-1-ordashtech.vercel.app
```

分支别名，永远指向 `nuri-test-1` 分支最新一次部署。**不是**某次构建的一次性
地址，可以长期写进配置。

连通性自检（不需要 token）：

```bash
curl.exe https://nuri-git-nuri-test-1-ordashtech.vercel.app/api/version
```

返回 200 和一段 JSON 即为正常。

## H-04 测试账号

20 个：`automated_test_01@example.com` … `automated_test_20@example.com`，
共用一个密码。**密码通过另行约定的安全渠道交付，不在本文件、不在仓库、不在
聊天记录里。**

一个账号对应一条 dialogue blueprint。理由在 API contract §3：NURI 的产品前提
是「一个账号一段永久对话」，所以二十条并行对话靠二十个账号来隔离，比在一个
账号下开二十个会话更彻底——不同账号之间连记忆和档案都不可能串。

账号可随时作废：告知即可停用，不影响任何真实用户。

## H-06 版本信息

```json
{"model":"gpt-5.5","prompt_version":"p_1d81d78dd2e2",
 "backend_build":"dpl_HbAeLbtSX19VCD3XteZ97dY97A7F",
 "pipeline":"four_model","pipeline_version":"four-model-v1"}
```

`GET /api/version` 可单独取，同时每条聊天响应的 `version` 字段都带着它。

**不提供提示词正文**，`prompt_version` 是提示词稳定部分的内容哈希——persona、
输出契约、运营方 style rules 三者的哈希。它变了就说明提示词变了，两批结果
不能合并。这个值不靠人工维护，所以不会出现"忘了改版本号"的情况。

## H-08 测试隔离说明

**没有 test_mode 开关，隔离是结构性的**：这个部署绑定一个**独立的 Supabase
项目**，里面除了测试数据什么都没有。

- 测试对话进不了真实家庭的记忆、档案或分析 —— 不在同一个数据库里
- 不训练任何模型
- 每日邮件推送、卡片实时研究两个子系统处于关闭状态
- 不会触发真实的推送、短信、邮件、报警或人工升级
- 高风险场景只返回结构化的 escalation 事件，不执行任何真实紧急动作

内部知识库和 style rules 是齐的，所以回复的形态就是产品的形态，不是一个被
削弱的版本。

**验证方法（不需要任何凭据）**：响应里的 `prompt_version` 是含 style rules 的
内容哈希，测试库和生产库算出来必然不同。看到 `p_1d81d78dd2e2` 就说明连的是
测试库。

### 一处必须记录的偏差

测试库注入 **19** 条 style rules，生产注入 **17** 条。差异会让 NURI 比线上
**更倾向于先追问、更常以情绪安抚开场**。

这正好落在本次要评估的两个维度上，所以：**本环境的分数不能直接当作线上
NURI 的分数**。`prompt_version` 会把两者区分开，结果仍然可归因。

## 关于清理

回归结束后告知，我们清空测试库或停用账号。测试数据有独立库承载，不需要你
们做任何清理动作。
