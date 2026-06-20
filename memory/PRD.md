# 北美华人育儿AI Agent - 产品需求文档

## 产品定位
面向北美华人家庭（孩子0-5岁）的育儿AI Agent，本期是高保真可点击原型，用于测试用户流程与内容吸引力。

## 核心功能
1. **首页信息流**：三类卡片（科普 / 热点 / 推荐），每张卡都有"问问AI"CTA，下拉刷新洗牌
2. **AI对话**：多轮预设脚本（4 条路径：tip_food / news_bilingual / product_monitor / image_emergency / free），打字动画，快捷回复，图片上传，过渡卡片（任务生成 / 医院信息），社群入口
3. **任务清单**：今日/本周 segmented control，打勾动画，弹出反思 BottomSheet（😊😐😣 + 文字），insight 横幅
4. **家庭档案**：孩子CRUD，**隐私 toggle**（历史训练 / 推送 / 匿名社群分享）、清空所有数据、语言切换
5. **埋点**：曝光 / 问问AI点击 / 滚动深度 → `/api/analytics` (mock)

## 技术
- 后端：FastAPI + MongoDB；预留 emergentintegrations LlmChat（`USE_REAL_LLM=false`）。
- 前端：Expo Router 文件路由（tabs + onboarding + chat/[id] + child/[id] + community）。
- 设计：珊瑚橙 `#FF7A59`，12px 圆角，无阴影，Ionicons outline。

## 开放接口
- `/api/feed`, `/api/children`, `/api/chat/sessions`, `/api/chat/sessions/{id}/messages`, `/api/tasks`, `/api/privacy`, `/api/analytics`

## 已 MOCK
- AI 回复（按 script_key 走预设脚本，1s 假思考延迟）
- 图片上传（用一张内嵌 base64 占位图模拟相机）
- 社群（静态 mock）
