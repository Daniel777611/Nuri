# 北美华人育儿AI Agent - 产品需求文档

## 产品定位
面向北美华人家庭（孩子0-5岁）的育儿AI Agent，本期是高保真可点击原型，用于测试用户流程与内容吸引力。

## 核心功能
1. **首页信息流**：三类卡片（科普 / 热点 / 推荐），卡片底部一排 icon 行（★收藏 / ↗分享 / ⟳单卡换一条），点击卡片主体跳详情页；不再有"问问AI"按钮；下拉刷新洗牌
1.5 **内容详情页 `/detail/[id]`**：小红书风格科普长文（300-500字 + 配图 + 话题标签），顶部 ★/↗ 状态与首页同步，悬浮底部"问问AI"按钮，跳转 chat 时携带文章上下文
2. **AI对话**：4 套预设脚本（tip_food / news_bilingual / product_monitor / image_emergency / free），打字动画、快捷回复、过渡卡片、图片上传、社群入口
3. **任务清单**：今日/本周、打勾 + 反思 BottomSheet (😊😐😣)、insight 横幅、本周任务进度条
4. **家庭档案**：孩子 CRUD、**我的收藏列表**、隐私 toggle、清空所有数据、语言切换

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
