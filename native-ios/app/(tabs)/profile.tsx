import { useCallback, useEffect, useRef, useState } from "react";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { useAIConsent } from "@/src/useAIConsent";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Switch,
  Platform,
  Linking,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { api, auth } from "@/src/api";
import { completedAgeMonths, pregnancyWeeks } from "@/src/child-age";
import ConfirmDialog from "@/src/components/ConfirmDialog";
import { LOCALE_LABELS, LOCALES, useT, translate } from "@/src/i18n";
import { usePurchaseAllowed } from "@/src/nativeShell";
import { openNotificationSettings } from "@/src/nativePush";
import { colors, radius, spacing, type } from "@/src/theme";

import { CardStack, CenteredCard, GlassSurface, NuriText, InlineState } from "@/src/uiux48/Primitives";
import { SettingsPage as CardList, SettingsRow as MenuRow, SettingsToggle as ToggleRow, SettingsButton as NuriButton, SettingsField as NuriField, SettingsChoice as ChoiceChip, SettingsChoices, SettingsFormFooter, SettingsDivider, SettingsAction } from "@/src/uiuxfinal/Settings";
import { FinalText } from "@/src/uiuxfinal/Primitives";
import { UserAvatar } from "@/src/uiuxfinal/UserAvatar";
import { NuriAvatar } from "@/src/uiux48/Scene";
import { useNuriTheme } from "@/src/uiux48/Theme";
import { StateCard } from "@/src/uiux48/StateCard";
import { validCollectionName } from "@/src/collectionActions";
import { isLiveCommunityEnabled } from "@/src/liveCommunityGate";
const FIGMA_FRAME_WIDTH = 402;
const SETTINGS_TRADITIONAL:Record<string,string>={
  "照护者":"照護者","最近想关注什么？":"最近想關注什麼？","家庭习惯":"家庭習慣","例如睡前一起读书":"例如睡前一起讀書","你更需要怎样的支持？":"你更需要怎樣的支持？",
  "允许 AI 陪伴":"允許 AI 陪伴","允许 Nuri 使用你提供的资料与对话生成回应":"允許 Nuri 使用你提供的資料與對話產生回應","许可状态尚未确认，请先查看使用许可。":"許可狀態尚未確認，請先查看使用許可。",
  "打开完整许可说明；此处不会直接授权或撤回。":"開啟完整許可說明；此處不會直接授權或撤回。","查看 AI 使用许可":"查看 AI 使用許可","使用过往对话":"使用過往對話","帮助 Nuri 记住你的偏好":"幫助 Nuri 記住你的偏好",
  "联网搜索":"聯網搜尋","需要时搜索公开资料，提供来源":"需要時搜尋公開資料，提供來源","关闭 AI 后将停止生成新的 AI 回应，已有记录不会自动删除。":"關閉 AI 後將停止產生新的 AI 回應，已有紀錄不會自動刪除。",
  "管理账号与数据":"管理帳號與資料","更多隐私说明":"更多隱私說明","重设密码":"重設密碼","发送重设链接至此邮箱":"發送重設連結至此信箱",
};

export default function Profile() {
  const router = useRouter();
  const params=useLocalSearchParams<{section?:string}>();
  const section=params.section??"main";
  const go=(section:string)=>router.push({pathname:"/(tabs)/profile",params:{section}} as never);
  const theme=useNuriTheme();
  const [me,setMe]=useAccountState<any>(null);
  const [collections,setCollections]=useAccountState<any[]>([]);
  const [loadState,setLoadState]=useAccountState<"loading"|"ready"|"error">("loading");
  const [actionError,setActionError]=useAccountState("");
  const [saving,setSaving]=useAccountState(false);
  const [result,setResult]=useAccountState<"saved"|"language-local"|"cleared"|null>(null);
  const [confirmLogout,setConfirmLogout]=useState(false);
  const confirmIdentity=useRef(auth.getIdentityGeneration());
  const mutation=useRef(false);
  const languageChoicePending=useRef(false);
  const [collectionName,setCollectionName]=useAccountState("");
  const [collectionTarget,setCollectionTarget]=useAccountState<string|null>(null);
  const [collectionDelete,setCollectionDelete]=useAccountState<string|null>(null);
  const [parentName,setParentName]=useAccountState("");
  const [city,setCity]=useAccountState("");
  const [role,setRole]=useAccountState("");
  const [concerns,setConcerns]=useAccountState<string[]>([]);
  const [hobbies,setHobbies]=useAccountState("");
  const [help,setHelp]=useAccountState("");

  const { generation, capture, current, isMounted } = useAccountScope();
  const { t, locale, setLocale,languageMode,chooseLanguage } = useT();
  const {state:aiPermission}=useAIConsent();
  const [privacyDetails,setPrivacyDetails]=useState(false);
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const [children, setChildren] = useAccountState<any[]>([]);
  const [favorites, setFavorites] = useAccountState<any[]>([]);
  const [privacy, setPrivacy] = useAccountState<any>({
    allow_history_training: false,
    allow_external_content_research: false,
    daily_push: false,
    anonymous_community_share: false,
    language: "zh-CN",
  });
  const [privacyUnavailable, setPrivacyUnavailable] = useAccountState(true);
  const [privacyDraft,setPrivacyDraft]=useAccountState({allow_history_training:false,allow_external_content_research:false});
  const [confirmWipe, setConfirmWipe] = useAccountState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signingOutRef = useRef(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [logoutFailureCode, setLogoutFailureCode] = useState("");
  const [policyError, setPolicyError] = useState<string | null>(null);
  const purchaseAllowed = usePurchaseAllowed();
  const logoutOwner = useRef<{ token: string; identity: number } | null>(null);
  const logoutVersion = useRef(0);
  useEffect(() => {
    if(confirmIdentity.current!==auth.getIdentityGeneration()){confirmIdentity.current=auth.getIdentityGeneration();setConfirmLogout(false);}
    if (logoutOwner.current && logoutOwner.current.identity !== auth.getIdentityGeneration()) {
      logoutOwner.current = null;
      logoutVersion.current++;
      signingOutRef.current = false;
      setSigningOut(false); setLogoutError(null); setLogoutFailureCode("");
    }
  }, [generation]);

  const load = useCallback(async () => {
    const ticket = capture();
    if (ticket === null) return;
    const token = await auth.getToken();
    if (!token || !current(ticket)) return;
    setLoadState("loading");
    const [childrenResult, privacyResult, favoritesResult, meResult, collectionsResult] = await Promise.allSettled([
      api.listChildren(),
      api.getPrivacy(),
      api.listFavorites(), api.me(), api.listCollections(),
    ]);
    if (!current(ticket)) return;
    if(meResult.status==="fulfilled"){const m:any=meResult.value;setMe(m);setParentName(m.nickname||"");setCity(m.city||"");setRole(m.parent_role||"");setConcerns(m.top_concerns||[]);setHobbies(m.hobbies||"");setHelp(m.help_preference||"");}
    if(collectionsResult.status==="fulfilled")setCollections(collectionsResult.value);
    setLoadState([childrenResult,privacyResult,favoritesResult,meResult,collectionsResult].some(r=>r.status==="rejected")?"error":"ready");
    if (childrenResult.status === "fulfilled") setChildren(childrenResult.value);
    if (favoritesResult.status === "fulfilled") setFavorites(favoritesResult.value);
    if (privacyResult.status === "fulfilled") {
      setPrivacy(privacyResult.value);
      setPrivacyDraft({allow_history_training:privacyResult.value.allow_history_training===true,allow_external_content_research:privacyResult.value.allow_external_content_research===true});
      setPrivacyUnavailable(false);
    } else {
      setPrivacy((current: any) => ({
        ...current,
        allow_history_training: false,
      }));
      setPrivacyUnavailable(true);
    }
  }, [capture, current, setChildren, setFavorites, setPrivacy, setPrivacyUnavailable]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const updatePrivacy = async (patch: any, localeAlreadySaved=false) => {
    const ticket = capture();
    if (ticket === null || privacyUnavailable || mutation.current) return;
    mutation.current=true;setSaving(true);setActionError("");
    const previous = privacy;
    // `locale` — not `privacy.language` — is what the parent is looking at, so
    // toggling an unrelated switch can't push a stale language back up and undo
    // their choice.
    const next = { ...privacy, language: locale, ...patch };
    setPrivacy(next);
    try {
      if (patch.language&&!localeAlreadySaved) await setLocale(patch.language);
      if (!current(ticket)) return;
      await api.setPrivacy(next);
      if(current(ticket))setResult("saved");
    } catch (failure) {
      if (!current(ticket)) return;
      // A full PrivacySettings PUT preserves existing cloud flags. Its
      // consent guard must not be bypassed or replaced with a partial body
      // (the existing backend fills omitted flags with defaults). Keep the
      // independently saved UI language, without claiming cloud sync or AI
      // permission, when that unchanged full body requires consent.
      if (Object.keys(patch).length === 1 && patch.language) {
        setPrivacy(previous);setResult("language-local");return;
      }
      // Do not leave a privacy toggle visually enabled/disabled when the
      // persisted setting did not actually save.
      setPrivacy(previous);
      setPrivacyDraft({allow_history_training:previous.allow_history_training===true,allow_external_content_research:previous.allow_external_content_research===true});
      if (patch.language) {
        try { await setLocale(locale); } catch { /* Keep the failure explicit; never claim a save. */ }
      }
      setActionError(locale==="en"?"Not saved. Please retry.":translate(locale, "未能保存，请重试。"));
    } finally {mutation.current=false;if(current(ticket))setSaving(false);}
  };

  const finishSignOut = async (identity: number) => {
    const token = await auth.getToken();
    if (isMounted() && identity === auth.getIdentityGeneration() && token === null) router.replace("/login");
  };

  const wipeAll = async () => {
    const ticket = capture();
    if (ticket === null || mutation.current) return;
    const token = await auth.getToken();
    if (!token || !current(ticket)) return;
    mutation.current=true;setSaving(true);
    try {
      const removed=await api.wipe();
      if(removed?.ok!==true)throw new Error("CLOUD_REMOVAL_UNCONFIRMED");
      if (!current(ticket)) return;
      setConfirmWipe(false);
      setResult("cleared");
    } catch {
      if (!current(ticket)) return;
      setLogoutError(locale === "en" ? "Cloud-data removal was not confirmed. Check your connection and retry." : locale === "zh-TW" ? "雲端資料清除尚未確認，請檢查網路後重試。" : "云端数据清除尚未确认，请检查网络后重试。");
    } finally {mutation.current=false;if(current(ticket))setSaving(false);}
  };

  const logout = async (forceLocal = false) => {
    const ticket = capture();
    if (ticket === null || signingOutRef.current) return;
    const identity = auth.getIdentityGeneration();
    const token = await auth.getToken();
    if (!current(ticket)) return;
    const owner = token ? { token, identity } : logoutOwner.current;
    if (!owner || owner.identity !== identity) return;
    logoutOwner.current = owner;
    const version = ++logoutVersion.current;
    signingOutRef.current = true;
    setSigningOut(true);
    setLogoutError(null);
    setLogoutFailureCode("");
    try {
      const cleared = await auth.clearToken({ expectedToken: owner.token, expectedGeneration: ticket, ...(forceLocal ? { forceLocal: true } : {}) });
      if (cleared) await finishSignOut(identity);
    } catch (error) {
      if (!isMounted() || identity !== auth.getIdentityGeneration() || version !== logoutVersion.current) return;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      setLogoutFailureCode(code);
      if (code === "PUSH_CLEANUP_PENDING") {
        setLogoutError(locale === "en"
          ? "The server has not confirmed notification removal, so you are still signed in. Old-account notifications may still arrive. Retry online or turn off NURI notifications in system settings. Local-only sign-out does not confirm server removal."
          : locale === "zh-TW"
            ? "伺服器尚未確認取消通知，現在仍保持登入，也可能收到舊帳號的訊息。請連上網路後重試，或在系統設定關閉 NURI 通知。僅本機登出不代表伺服器已取消通知。"
            : "服务器尚未确认取消通知，现在仍保持登录，也可能收到旧账号的消息。请联网后重试，或在系统设置关闭 NURI 通知。仅本机退出不代表服务器已取消通知。");
      } else if (code === "LOCAL_SIGNOUT_FAILED") {
        setLogoutError(locale === "en" ? "Local credentials could not be cleared. Please retry; the app may still be signed in after a restart." : locale === "zh-TW" ? "本機登入憑據未確認清除，請重試。重新啟動 App 後仍可能保持登入。" : "本机登录凭据未确认清除，请重试。重新启动 App 后仍可能保持登录。");
      } else {
        setLogoutError(locale === "en" ? "Sign-out was not confirmed. Check your connection and retry." : locale === "zh-TW" ? "登出尚未確認，請檢查網路後重試。" : "登出尚未确认，请检查网络后重试。");
      }
    } finally {
      if (isMounted() && version === logoutVersion.current) { signingOutRef.current = false; setSigningOut(false); }
    }
  };


  const en=locale==="en"; const copy=(cn:string,enText:string)=>en?enText:locale==="zh-TW"&&SETTINGS_TRADITIONAL[cn]?SETTINGS_TRADITIONAL[cn]:translate(locale,cn);
  const run=async(fn:()=>Promise<unknown>)=>{const ticket=capture();if(ticket===null||mutation.current)return;mutation.current=true;setSaving(true);setActionError("");try{await fn();if(current(ticket)){await load();if(current(ticket))setResult("saved");}}catch{if(current(ticket))setActionError(copy("操作未确认成功，请重试。","Not confirmed. Please retry."));}finally{mutation.current=false;if(current(ticket))setSaving(false);}};
  const linkPolicy=()=>{setPolicyError(null);void Linking.openURL("https://nurifam.com/privacy").catch(()=>setPolicyError(copy("隐私政策暂时无法打开，请重试。","Could not open the privacy policy. Please retry.")));};
  const titles:Record<string,string>={personal:copy("个人信息","Personal information"),children:copy("孩子信息","Children"),favorites:copy("我的收藏","Favorites"),preferences:copy("家庭偏好","Family preferences"),privacy:copy("隐私与 AI 许可","Privacy & AI permission"),account:copy("账号与安全","Account & security"),language:copy("语言","Language"),collections:copy("收藏分类","Collections")};
  const row=(label:string,target:string,detail?:string)=><MenuRow key={target} label={label} detail={detail} onPress={()=>go(target)} testID={`profile-section-${target}`} />;
  const notice=<>{loadState==="loading"?<InlineState busy message={copy("正在读取…","Loading…")} />:loadState==="error"?<InlineState message={copy("部分资料读取失败。尚未读取的内容不能视为空。","Some information could not be loaded; missing results are not empty data.")} action={copy("重试","Retry")} onPress={()=>void load()} />:null}{actionError?<NuriText testID="profile-action-result" secondary>{actionError}</NuriText>:null}</>;
  if(result==="saved")return <StateCard testID="profile-saved-card" message={copy("修改已保存。","Changes saved.")} primary={{label:copy("完成","Done"),onPress:()=>setResult(null)}} />;
  if(result==="language-local")return <StateCard testID="profile-language-local-card" title={copy("本机语言已更改","Language changed on this device")} message={copy("页面语言已保存在这台设备上。云端语言尚未同步。","The page language is saved on this device. The cloud language has not been synced.")} note={copy("更改本机语言不代表授权 AI。若之后允许相关 AI 功能，可再次选择语言以同步云端偏好。","Changing the device language does not grant AI permission. If you later allow the relevant AI features, select the language again to sync the cloud preference.")} primary={{label:copy("完成","Done"),onPress:()=>setResult(null)}} />;
  if(result==="cleared")return <StateCard testID="profile-cleared-card" title={copy("云端数据已清除","Cloud data cleared")} message={copy("你可以重新设置资料，或退出登录。","You can set up your profile again, or sign out.")} primary={{label:copy("重新设置","Set up again"),onPress:()=>{setResult(null);router.replace("/onboarding");}}} secondary={{label:copy("退出登录","Sign out"),onPress:()=>{setResult(null);setConfirmLogout(true);}}} error={logoutError??undefined} />;
  if(confirmLogout)return <StateCard testID="profile-logout-card" title={copy("退出登录？","Sign out?")} message={copy("随时重新登录，继续自己的对话。","Sign in again anytime to continue your conversations.")} primary={{label:copy("退出登录","Sign out"),onPress:()=>void logout(logoutFailureCode==="LOCAL_SIGNOUT_FAILED")}} secondary={{label:copy("取消","Cancel"),onPress:()=>setConfirmLogout(false)}} busy={signingOut} error={logoutError??undefined}>{logoutFailureCode==="PUSH_CLEANUP_PENDING"?<><NuriButton secondary label={copy("打开系统通知设置","Open notification settings")} onPress={()=>void openNotificationSettings().catch(()=>setLogoutError(copy("系统设置未能打开，请重试。","Could not open system settings.")))} /><NuriButton secondary label={copy("仅本机退出（可能仍收到旧账号通知）","Sign out locally (notifications may continue)")} disabled={signingOut} onPress={()=>void logout(true)} testID="profile-force-local-logout" /></>:null}</StateCard>;
  return <View style={{flex:1}}>
    {section==="main"?<CardList testID="profile-card-stack" contentContainerStyle={{gap:0}}>
      {row(copy("个人信息","Personal information"),"personal")}{row(copy("孩子信息","Children"),"children")}{row(copy("家庭偏好","Family preferences"),"preferences")}
      {isLiveCommunityEnabled()?<MenuRow label={copy("社区偏好","Community preferences")} onPress={()=>router.push({pathname:"/community",params:{uiState:"preferences"}})} testID="profile-community-preferences" />:null}
      {row(copy("我的收藏","Favorites"),"favorites")}
      <View style={{marginVertical:16}}><SettingsDivider/></View>
      <MenuRow label={copy("通知设置","Notification settings")} onPress={()=>router.push("/notification-settings")} />{row(copy("语言","Language"),"language")}{row(copy("隐私与 AI","Privacy & AI"),"privacy")}{row(copy("账号与安全","Account & security"),"account")}
      <View style={{flex:1,minHeight:32}} />
      <SettingsAction label={signingOut?copy("正在退出…","Signing out…"):copy("退出登录","Sign out")} disabled={signingOut} onPress={()=>setConfirmLogout(true)} testID="profile-logout-btn" />
    </CardList>:<CardList>
      {notice}
      {section==="personal"?<>
        <UserAvatar size={56} displayName={parentName} photoURL={me?.avatar_url??me?.photo_url??me?.picture} />
        <NuriField label={copy("称呼","Name")} value={parentName} onChangeText={setParentName} testID="profile-name" />
        <NuriField label={copy("居住城市","City")} value={city} onChangeText={setCity} placeholder={copy("稍后填写","Add later")} />
        <View style={{gap:12}}><FinalText size={18} style={{lineHeight:26,fontWeight:"500",fontFamily:locale==="zh-CN"?"NotoSansSC_500Medium":undefined}}>{copy("照护角色","Caregiving role")}</FinalText><SettingsChoices>{[["mom",copy("妈妈","Mom")],["dad",copy("爸爸","Dad")],["other",copy("照护者","Caregiver")]].map(([key,label])=><ChoiceChip key={key} label={label} selected={role===key} onPress={()=>setRole(key)} />)}</SettingsChoices></View>
        <SettingsFormFooter><NuriButton label={copy("保存","Save")} busy={saving} disabled={saving||!me||loadState!=="ready"} onPress={()=>void run(()=>api.updateMe({nickname:parentName.trim(),city:city.trim(),parent_role:role||undefined}))} /></SettingsFormFooter>
      </>:null}
      {section==="children"?<>{children.map(c=><MenuRow key={c.id} label={c.nickname} detail={(({key,vars})=>t(key,vars))(ageLabel(c.birth_date))} onPress={()=>router.push({pathname:"/child/[id]",params:{id:c.id,uiState:"edit"}})} testID={`profile-child-${c.id}`} />)}{loadState==="ready"&&!children.length?<NuriText secondary>{copy("还没有添加孩子资料。","No child profiles added.")}</NuriText>:null}<NuriButton label={copy("添加孩子","Add a child")} onPress={()=>router.push("/child/new")} testID="profile-add-child" /></>:null}
      {section==="favorites"?<>{favorites.map(f=><MenuRow key={f.id} label={f.title} detail={f.type_label} onPress={()=>router.push(`/saved/${f.id}` as never)} testID={`profile-fav-${f.id}`} />)}{loadState==="ready"&&!favorites.length?<InlineState message={copy("这里还没有收藏。","No saved content yet.")} action={copy("回到首页","Go home")} onPress={()=>router.dismissTo("/(tabs)")} />:null}<MenuRow label={copy("管理收藏分类","Manage collections")} onPress={()=>go("collections")} /></>:null}
      {section==="collections"?<>{collections.map(c=><MenuRow key={c.id} label={c.name} onPress={()=>{setCollectionTarget(c.id);setCollectionName(c.name);}} />)}<NuriField label={collectionTarget?copy("编辑分类","Edit collection"):copy("新建分类","New collection")} value={collectionName} onChangeText={setCollectionName} /><NuriText secondary style={{fontSize:12,lineHeight:16}} testID="profile-collection-name-limit">{copy("分类名称最多 20 个字符。","Collection names can contain up to 20 characters.")}</NuriText><NuriButton label={copy("保存分类","Save collection")} disabled={saving||!validCollectionName(collectionName)||loadState!=="ready"} onPress={()=>{const name=validCollectionName(collectionName);if(!name)return;void run(async()=>{if(collectionTarget)await api.renameCollection(collectionTarget,name);else await api.createCollection(name);setCollectionName("");setCollectionTarget(null);});}} />{collectionTarget?<><NuriButton secondary label={copy("取消编辑","Cancel editing")} onPress={()=>{setCollectionTarget(null);setCollectionName("");}} /><NuriButton secondary label={copy("删除分类","Delete collection")} onPress={()=>setCollectionDelete(collectionTarget)} /></>:null}</>:null}
      {section==="preferences"?<>
        <FinalText style={{fontWeight:"500",fontFamily:locale==="zh-CN"?"NotoSansSC_500Medium":undefined}}>{copy("最近想关注什么？","What would you like to focus on?")}</FinalText><SettingsChoices>{[["sleep",copy("睡眠","Sleep")],["emotion",copy("情绪","Emotions")],["food",copy("饮食","Food")],["parenting",copy("亲子沟通","Communication")]].map(([key,label])=><ChoiceChip key={key} label={label} selected={concerns.includes(key)} onPress={()=>setConcerns(v=>v.includes(key)?v.filter(x=>x!==key):[...v,key])} />)}</SettingsChoices>
        <NuriField label={copy("家庭习惯","Family routines")} value={hobbies} onChangeText={setHobbies} multiline compactMultiline placeholder={copy("例如睡前一起读书","For example, reading together before bed")} /><FinalText size={18} style={{lineHeight:26,fontWeight:"500",fontFamily:locale==="zh-CN"?"NotoSansSC_500Medium":undefined}}>{copy("你更需要怎样的支持？","What kind of support helps you?")}</FinalText><SettingsChoices>{[["empathy",copy("先被理解","Being understood")],["solution",copy("一起想办法","Finding solutions")],["both",copy("两者都需要","Both")]].map(([key,label])=><ChoiceChip key={key} label={label} selected={help===key} onPress={()=>setHelp(key)} />)}</SettingsChoices><SettingsFormFooter><NuriButton label={copy("保存","Save")} disabled={saving||!me||loadState!=="ready"} onPress={()=>void run(()=>api.updateMe({top_concerns:concerns,hobbies,help_preference:help}))} /></SettingsFormFooter>
      </>:null}
      {section==="privacy"?<>
        <ToggleRow label={copy("允许 AI 陪伴","Allow AI support")} detail={["allowed","not_allowed"].includes(aiPermission.status)?copy("允许 Nuri 使用你提供的资料与对话生成回应","Allow Nuri to use your information and conversations to respond"):copy("许可状态尚未确认，请先查看使用许可。","Permission is not confirmed. Review AI permission first.")} value={aiPermission.status==="allowed"} disabled={!["allowed","not_allowed"].includes(aiPermission.status)} onChange={()=>router.push("/ai-permission")} accessibilityHint={copy("打开完整许可说明；此处不会直接授权或撤回。","Opens the full permission explanation; this does not grant or withdraw permission.")} testID="profile-ai-permission" />
        {!["allowed","not_allowed"].includes(aiPermission.status)?<MenuRow label={copy("查看 AI 使用许可","Review AI permission")} onPress={()=>router.push("/ai-permission")} />:null}
        <SettingsDivider/>
        {privacyUnavailable?<NuriText testID="privacy-unavailable-message">{t("隐私设置暂时无法读取。为保护你的隐私，NURI 当前不会使用对话历史；恢复后请重新查看。")}</NuriText>:null}
        <View style={{gap:12}}><ToggleRow label={copy("使用过往对话","Use conversation history")} detail={copy("帮助 Nuri 记住你的偏好","Help Nuri remember your preferences")} value={privacyDraft.allow_history_training} onChange={v=>setPrivacyDraft(v?{...privacyDraft,allow_history_training:true}:{allow_history_training:false,allow_external_content_research:false})} disabled={privacyUnavailable||saving} testID="privacy-toggle-history" />
        <ToggleRow label={copy("联网搜索","Search public sources")} detail={copy("需要时搜索公开资料，提供来源","Search public information and provide sources when needed")} value={privacyDraft.allow_external_content_research} onChange={v=>setPrivacyDraft({...privacyDraft,allow_external_content_research:v})} disabled={privacyUnavailable||saving||!privacyDraft.allow_history_training} testID="privacy-toggle-external-research" /></View>
        <FinalText secondary>{copy("关闭 AI 后将停止生成新的 AI 回应，已有记录不会自动删除。","Turning off AI stops new AI responses. Existing records are not deleted automatically.")}</FinalText>
        <MenuRow label={copy("管理账号与数据","Manage account and data")} onPress={()=>go("account")} testID="privacy-manage-account" />
        <MenuRow label={copy("更多隐私说明","More privacy information")} onPress={()=>setPrivacyDetails(v=>!v)} testID="privacy-more" />
        {privacyDetails?<><NuriText secondary style={{fontSize:12,lineHeight:18}} testID="privacy-policy-card">{t("对话个性化只在 NURI 内部选择相关主题。只有你另外开启“外部内容检索”后，NURI 才会先去除明显身份信息，再把必要的主题与家庭情境用于公开网页检索。我们不会出售对话，也不用于训练公共模型。")}</NuriText><MenuRow label={copy("清除云端数据","Clear cloud data")} danger onPress={()=>setConfirmWipe(true)} testID="privacy-wipe-btn" /><MenuRow label={copy("隐私政策","Privacy policy")} onPress={linkPolicy} testID="profile-privacy-policy" />{policyError?<NuriText>{policyError}</NuriText>:null}</>:null}
        <SettingsFormFooter><NuriButton label={copy("保存设置","Save settings")} disabled={privacyUnavailable||saving} busy={saving} onPress={()=>void updatePrivacy(privacyDraft)} testID="privacy-save" /></SettingsFormFooter>
      </>:null}
      {section==="language"?<>
        {(["system",...LOCALES] as const).map(value=><Pressable key={value} disabled={saving} accessibilityRole="radio" accessibilityState={{selected:languageMode==="system"?value==="system":value===locale}} style={{minHeight:52,flexDirection:"row",alignItems:"center",gap:12}} testID={`profile-language-${value}`} onPress={()=>{if(languageChoicePending.current||mutation.current)return;const owner=capture();if(owner===null)return;languageChoicePending.current=true;setSaving(true);void (async()=>{try{const next=await chooseLanguage(value);if(!current(owner))return;if(privacyUnavailable){setResult("language-local");return;}await updatePrivacy({language:next},true);}catch{if(current(owner))setActionError(copy("本机语言未能保存，请重试。","Could not save the device language. Please retry."));}finally{languageChoicePending.current=false;if(current(owner))setSaving(false);}})();}}>
          <NuriText style={{flex:1}}>{value==="system"?copy("跟随系统","Follow system"):LOCALE_LABELS[value]}</NuriText>{(languageMode==="system"?value==="system":value===locale)?<FinalText size={20} style={{width:20,height:20,lineHeight:20,fontWeight:"500",color:"#735C84",textAlign:"center"}}>✓</FinalText>:null}
        </Pressable>)}
        <NuriText secondary style={{fontSize:12}}>{(privacy.language==="zh"?"zh-CN":privacy.language)===locale?copy("页面与 Nuri 的内容会使用你选择的语言。","Pages and Nuri content will use your selected language."):copy("本机界面已使用所选语言，Nuri 的云端内容语言尚未同步。","Pages use your selected language on this device. Nuri’s cloud content language has not been synced.")}</NuriText>
      </>:null}
      {section==="account"?<>
        <FinalText style={{fontWeight:"500",fontFamily:locale==="zh-CN"?"NotoSansSC_500Medium":undefined}}>{me?.email||"—"}</FinalText>
        <MenuRow label={copy("重设密码","Reset password")} detail={copy("发送重设链接至此邮箱","Send a reset link to this email")} onPress={()=>router.push("/forgot-password")} />
        <SettingsDivider/>
        <MenuRow label={copy("清除云端数据","Clear cloud data")} onPress={()=>setConfirmWipe(true)} />
        <SettingsAction label={copy("删除账号","Delete account")} onPress={()=>router.push("/account-deletion")} danger testID="profile-delete-account" />
        <SettingsDivider/>
        {logoutError?<NuriText testID="profile-logout-error">{logoutError}</NuriText>:null}
        {logoutFailureCode==="PUSH_CLEANUP_PENDING"?<><NuriButton secondary label={copy("打开系统通知设置","Open system notification settings")} onPress={()=>void openNotificationSettings().catch(()=>setLogoutError(copy("系统设置未能打开，请重试。","Could not open system settings.")))} testID="profile-logout-notification-settings" /><NuriButton secondary disabled={signingOut} label={copy("仅本机退出（可能仍收到旧账号通知）","Sign out locally (notifications may continue)")} onPress={()=>void logout(true)} testID="profile-force-local-logout" /></>:null}
        <SettingsAction label={signingOut?copy("正在退出…","Signing out…"):copy("退出登录","Sign out")} disabled={signingOut} onPress={()=>setConfirmLogout(true)} testID="profile-logout-btn" />
      </>:null}
    </CardList>}
    <ConfirmDialog visible={confirmWipe} title={copy("删除此账号的云端数据？","Delete this account's cloud data?")} message={copy("这会删除此共用云端账号的孩子档案、对话、任务与反思，同时影响此应用和原版 NURI。不是仅重置本机应用数据，且不可恢复。","This deletes child profiles, conversations, tasks and reflections for this shared cloud account in both NURI apps, not only this device. It cannot be undone.")} confirmText={copy("删除账号数据","Delete account data")} danger onConfirm={wipeAll} onCancel={()=>setConfirmWipe(false)} />
    <ConfirmDialog visible={!!collectionDelete} title={copy("删除分类？","Delete collection?")} message={copy("此操作会删除这个收藏分类。","This removes the selected collection.")} danger confirmText={copy("删除分类","Delete collection")} onCancel={()=>setCollectionDelete(null)} onConfirm={()=>{const id=collectionDelete;if(id)void run(async()=>{await api.deleteCollection(id);setCollectionDelete(null);setCollectionTarget(null);});}} />
  </View>;
}
function ageLabel(birthDate:string): {key:string;vars?:Record<string,string|number>} {const months=completedAgeMonths(birthDate),weeks=pregnancyWeeks(birthDate);return weeks!==null?{key:"尚未出生，预计孕周约 {weeks} 周",vars:{weeks}}:months===null?{key:"出生日期待确认"}:{key:"{months} 月龄",vars:{months}};}
