# 北美华人育儿AI Agent - 产品需求文档

## 产品定位
面向北美华人家庭（孩子0-5岁）的育儿AI Agent，本期是高保真可点击原型，用于测试用户流程与内容吸引力。

## 核心功能
0. **账号注册（邮箱+密码单步）+ 登录**：bcrypt 哈希 + JWT；注册成功后进入 4 步「基础信息收集流程」(/onboarding)：① 孩子称呼+出生年月(年月滚轮选择, 必填) ② 家长称呼+城市(必填) ③ 育儿困扰 10 项多选+其他填空(可跳过) ④ 教养方式: 爱好填空/希望提供的帮助单选/信任信息来源单选/推送频率单选(可跳过)；完成后写 `onboarding_completed=true`。登录/启动时按 `onboarding_completed` 路由（老用户下次登录也要补填, 已有数据会预填充）；profile 页登出与"清空所有数据"都会清 token 并跳回登录/注册
1. **Nuri 主页（无底部导航栏，复刻高保真稿）**：全产品无 Tab Bar（(tabs)/_layout 为 Stack），所有跳转经主页模块卡。顶栏 logo(assets/images/nuri-logo.png)+欢迎语(真实昵称)+头像(→个人设置页)；内容推荐轮播3张(蓝紫渐变#4B6FE8→#7B5CE7，浏览详情→外部链接，分页点)；今日任务卡(#DCE8F8：打卡17天mock+真实待办前2条+件数+开启提醒toast，点卡→任务页)；Nuri的家(橙粉渐变#F5A855→#F07A9A：记忆摘要mock+继续对话→聊天页)；知识图书馆/社区中心/我的家→统一"待开发"bottom sheet。旧信息流首页已替换（detail/[id] 保留无入口）
1.5 **内容详情页 `/detail/[id]`**：小红书风格科普长文（300-500字 + 配图 + 话题标签），顶部 ★/↗ 状态与首页同步，悬浮底部"问问AI"按钮，跳转 chat 时携带文章上下文
2. **Nuri 永续对话（微信式单一会话，后端存储）**：渐变背景(粉#F5E6F0→紫蓝#C5C8F0)、「< 我的对话」极简顶栏、白色AI气泡/紫蓝渐变用户气泡(16px+4px角)、无气泡灰色检索状态提示、三点"正在输入"动效(0.3s+1.5s)、横滑嵌入式任务卡(黄→紫渐变标题栏+添加计划#3D2F8F→已添加+成功提示，写入任务模块并持久标记)、pill输入框(⊕图片上传占位sheet/🎤语音toast/输入时出现发送箭头)、图片消息+lightbox渲染支持；无新建对话/会话列表/历史管理；首页卡片"问问AI"→openTopic切换脚本追加开场白进入同一对话；脚本逐条用户触发(tip_food/news_bilingual/product_monitor/free)，走完轮换兜底
3. **任务模块（三层结构，后端存储，紫色主题 #6B5CE7 复刻设计稿）**：
   - 清单页：返回+「我的任务」标题、filter（全部/亲子互动/发展观察/照顾陪伴，selfcare 仅在全部下显示）、日期行（MM / DD + 您有N项任务待办）、卡片=类型前缀标题（亲子/观察/照顾/自我：）+频率小字+紫色进度条+截止日期，底部垃圾桶 icon + 立刻打卡浅紫按钮；已过期卡粉底红左边框+补全打卡红按钮；已完成折叠区（浅紫底删除线简化卡）；清空已完成任务（红色确认 dialog，已收藏保留）

   - 隐藏 debug：长按标题切换清理阈值 7天↔30分钟
   - 详情页 /task/[id]：返回「任务卡」、大标题+紫色类型 pill、三栏信息行(开始/结束日期 MM / DD、任务频率)、当前进度条+N/总数、任务介绍、指引数字步骤、底部固定 导出icon+紫色"打卡完成"
   - 记录感想 bottom sheet：按类型鼓励语 + "记录这次任务体验" + 3 emoji(有待改进/还不错/非常棒！点击0.5s自动关)+ 跳过；评价后 toast "已记录你的感受 ✓"；完成卡淡出下移归档
   - 归档清理：完成超7天且未收藏不显示；已收藏永久保留
   - 6 张演示卡片每用户原子性 seed 一次（find_one_and_update 抢占 flag，并发安全）；聊天生成的任务带 user_id 进入同一模型
   - 注意：本环境 RN-web Modal 有高度塌陷 bug，所有弹层用内联绝对定位 overlay 实现
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
