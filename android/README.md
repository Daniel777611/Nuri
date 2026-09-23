# NURI Android 壳

安卓版 NURI：一个原生外壳，里面用 WebView 装着线上网站 `https://nurifam.app`。它和 iOS 壳走同一套约定（`private/handoff/NURI_iOS_Push_Handoff_2026-09-10.md` §3）：

- **登录状态只存在网页里。** 外壳不调用任何后端接口。
- 外壳只做三件事：
  1. 把这台手机的 FCM 推送令牌交给网页（`nuri:fcm-token` 事件），由网页去调用 `POST /api/mobile/push-devices` 登记。
  2. 在高重要性通知渠道 `nuri_care` 上显示推送，所以通知会从屏幕顶部弹出（heads-up）。
  3. 用户点通知时打开对应页面（`nuri:open-route` 事件；如果是冷启动，就直接加载那个地址）。

网站更新以后，App 里的内容会跟着更新，不用重新发安装包。只有改了这个文件夹里的原生代码，才需要重新打包。

## 各部分在哪

| 部分 | 位置 |
|---|---|
| 外壳 | `android/`（本文件夹） |
| 网页桥接 | `frontend/src/usePushBridge.ts`：`parseFcmToken` 负责处理 `nuri:fcm-token` 事件 |
| 后端发送 | `backend/push_fcm.py`（FCM HTTP v1 接口，凭据来自 Vercel OIDC）；`backend/push_service.py` 按设备平台选择用 APNs 还是 FCM 发送 |
| 数据库 | `supabase/migrations/20260922020000_push_devices_android.sql`：让 `push_devices.platform` 可以存 `android` |

## 一次性准备

### 1. Firebase 与后端发送凭据（只用来发推送，数据库不迁移）

**App 这边：** 在 Firebase 项目 `nuri-933b9` 里添加 Android 应用，包名填 `com.ordashtech.nuri`，下载 `google-services.json` 放到 `android/app/`。这个文件已经被 `.gitignore` 排除。

**后端这边不使用密钥。** 组织 ordashteches.com 开启了 `iam.disableServiceAccountKeyCreation`，不允许下载服务账号密钥。所以后端用 Vercel 的 OIDC 身份证明换取 Google 令牌（Workload Identity Federation）：

1. **Vercel：** 项目设置 → Security → Secure Backend Access with OIDC Federation，Issuer Mode 选 **Team**，保存。
2. **Google Cloud（项目 nuri-933b9）：** IAM 和管理 → 工作负载身份联合 → 创建池。
   - 池：名称 `Vercel`，ID `vercel`。
   - 提供方：类型 OpenID Connect (OIDC)，ID `vercel`，签发者网址填 `https://oidc.vercel.com/ordashtech`。受众选「允许的受众」，填 `https://vercel.com/ordashtech`。
   - 属性映射：`google.subject` = `assertion.sub`。
   - 属性条件：`assertion.sub == 'owner:ordashtech:project:nuri:environment:production'`。这样只有生产环境能发推送，预览环境发不了（预览环境连的也是生产库）。
3. **专用服务账号：** IAM 和管理 → 服务账号 → 创建，ID 填 `fcm-sender`，项目角色**只给** `Firebase Cloud Messaging API Admin`。
4. **授权 Vercel 使用这个服务账号：** 打开 `fcm-sender` → 权限 → 授予访问权限。主账号填
   `principal://iam.googleapis.com/projects/<项目编号>/locations/global/workloadIdentityPools/vercel/subject/owner:ordashtech:project:nuri:environment:production`，
   角色选 `Workload Identity User`。
5. **启用 API：** IAM Service Account Credentials API、Security Token Service API、Firebase Cloud Messaging API。
6. **Vercel 环境变量（只勾 Production）。** 这些都不是密钥：

   | 变量 | 值 |
   |---|---|
   | `GCP_PROJECT_ID` | `nuri-933b9` |
   | `GCP_PROJECT_NUMBER` | 项目编号（Cloud 控制台首页「项目信息」里能看到） |
   | `GCP_SERVICE_ACCOUNT_EMAIL` | `fcm-sender@nuri-933b9.iam.gserviceaccount.com` |
   | `GCP_WORKLOAD_IDENTITY_POOL_ID` | `vercel` |
   | `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | `vercel` |

注意：如果 Vercel 的团队或项目改了名，身份证明里的 `sub` 也会跟着变，推送会停掉。改名后要同步修改第 2 步的属性条件和第 4 步的主账号。

没有 `google-services.json` 也能打包运行：网页、语音、图片都正常，只是不会注册推送。

### 2. 数据库

在生产库 `cxxidflulsdmcnazrouw` 的 SQL Editor 里执行 `supabase/migrations/20260922020000_push_devices_android.sql`。这个脚本可以重复执行。

### 3. Android Studio

1. 安装 Android Studio（自带 JDK 和 Android SDK）。
2. 选 `File → Open`，打开 **`android/`** 这个文件夹（不是仓库根目录）。第一次同步 Gradle 会自动下载依赖。
3. 手机打开「开发者选项 → USB 调试」，用数据线连上电脑，然后点 ▶ Run，就会装到手机上。

## 打包 APK

- **测试包（debug，可以直接安装）：** `Build → Build App Bundle(s) / APK(s) → Build APK(s)`，生成的文件在 `app/build/outputs/apk/debug/app-debug.apk`。
- **正式包（release）：** 先用 `Build → Generate Signed App Bundle / APK` 生成一个签名密钥（`.jks` 文件）。**密钥要长期保管好，丢了以后就无法升级已经装在用户手机上的 App。** 然后在 `android/keystore.properties` 里写上：

  ```
  storeFile=nuri-release.jks
  storePassword=…
  keyAlias=nuri
  keyPassword=…
  ```

  `keystore.properties` 和 `.jks` 都已经被 `.gitignore` 排除。

- **加载别的地址（例如 Vercel 预览）：** `./gradlew assembleDebug -PnuriOrigin=https://xxx.vercel.app`。注意：预览环境连的也是生产库。

## 验收

1. 装好 App，允许通知，然后登录。
2. 在 Supabase 的 `push_devices` 表里，应该能看到一行 `platform = 'android'`、`is_active = true`。
3. 发一条测试通知（dispatch 接口会发出 `notification_events` 表里已到期的事件）。分三种情况各测一次：App 在前台、App 在后台、App 已被划掉。三种情况下通知都应该从屏幕顶部弹出，点开后进入 `/notifications/<id>` 页面。
4. 在系统设置里关掉 NURI 的通知，再回到 App。这台设备在表里应该变成 `is_active = false`。

## 已知限制

- 选图片走系统的文件选择器；网页里「拍照」的入口在安卓上也会先打开这个选择器，大多数手机的选择器里有相机选项。
- 小米、华为等国产系统默认不允许 App 弹出横幅通知，需要用户在系统的通知设置里手动打开「横幅」或「悬浮通知」。这是系统层面的限制，App 这边改不了。
- 没有 Google Play 服务的手机（国行华为等）收不到 FCM 推送。
