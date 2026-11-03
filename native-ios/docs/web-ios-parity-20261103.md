# NURI 网页前端交接

分支：`web-ios-parity-20261103-1027`。起点是 `main` 的固定提交 `13da662851f3cd589f5be0a9315a8164a7aff60d`，移植 UI 对齐 TestFlight `0.3.0 (1027)`。本分支不合并到 main，不发布 App Store 1017，也不修改共享后端。

## 网页入口与构建

当前 main 的 Vercel 网页入口已经是 `native-ios` 中的 Expo Web，旧 `frontend` 目录不是本次改版入口。沿用这套入口可保留网页登录、账单与记忆 API 适配器、字体和现有 `/api` 路由。

使用 Node 20+、pnpm 11.25.0，在 `native-ios` 中执行：

```sh
pnpm install --frozen-lockfile
pnpm run web:ios-parity
pnpm run build:web:ios-parity
pnpm exec tsc --noEmit
node scripts/test-web-ios-parity.mjs
```

导出目录为 `native-ios/dist`。根 `vercel.json` 只更换 `buildCommand` 以使用本分支构建脚本，保留原有重写、函数和 cron 配置；没有更改云端项目设置或环境变量。

构建脚本显式设置：`EXPO_PUBLIC_BACKEND_URL=`、`EXPO_PUBLIC_PREVIEW_MODE=0`、`EXPO_PUBLIC_FLOW_PROTOTYPE=1`、`EXPO_PUBLIC_UIUX48_GALLERY=0`、`NURI_RELEASE_CHANNEL=web-local-prototype`。空 backend override 使网页使用同源 `/api`，不直接跨域指向生产域名；真实 API 模式保持开启，仅 Community 加载本地原型。

## 已移植的界面与接口边界

首页、Nuri 对话和附件草稿、推荐详情、设置、多孩 onboarding、日期选择、社区页面和暖色自定义键盘沿用这版 iOS UI。按钮的半透明底色在背景模糊之后合成，禁用状态不会把整组文字及模糊层一起变透明。当前仅有日间设计。

Nuri 登录、账号、聊天、通知历史及偏好继续使用 main 既有接口和鉴权。没有新增、部署或迁移后端；预览部署的 API 环境是否已具备，需与部署负责人核对。不要用全局 `PREVIEW_MODE=1` 代替真实接口验收。

当前已核实的 Nuri 发送契约支持文本或单图。多图、视频的选择、预览、播放、移除与草稿已具备，但实际发送保留明确的未接通提示，不会默默只发第一张。此结论限于上述固定 main 源码，不代表其他历史网页版从未支持视频。

浏览器没有本分支新增的 OS Web Push 服务。网页保留真实通知历史和服务端偏好；原生 APNs、系统权限、后台行为仍需在各平台分别验收，不能用浏览器截图替代。

## Community 后端接线

Community 的 42 个设计状态可本地交互测试，包括提问、回复、推荐筛选、联系邀请、收件箱、家长对话、双方 AI 同意展示及安全设置。当前写操作只改变内存状态，账号切换会重建原型；刷新不持久化。示例未读、姓名、距离、发送动画和成功页不是服务器回执。

完整接口交接已放在 Figma 的 [Prototype 页面右侧文档](https://www.figma.com/design/AdHDK7uLqyzvgbzm1FlM6F?node-id=216-13472)，标题为“Community 后端接口交接”。其中逐页映射 42 状态，分开标注已有 main 契约和 `PROPOSED` 能力；后端工程师应先确认 DTO、权限、幂等、分页、错误、双方 AI 授权、媒体及删除保留规则，再实现正式 OpenAPI。

不要把现有 Nuri 单人私聊接口用作家长 P2P 聊天，也不要把 `POST /notifications/{id}/open` 用作纯社区导航：它具有创建或复用 Nuri 私聊并写入消息的业务副作用。公开资料不能直接使用本人 `/auth/me` 的整份 DTO。

## 验收范围

本地导出、类型与回归测试，以及浏览器本地社区流程检查，分别记录；它们不代表尚未实现的 Community 后端、多账号多设备同步、真实媒体发送或原生性能已经通过。接入后端后需补真实鉴权、跨账号隔离、未知发送结果重试、撤权竞态和媒体生命周期验收。
