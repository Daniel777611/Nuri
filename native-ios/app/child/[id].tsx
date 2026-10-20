import { useEffect, useRef } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { useHeaderHeight } from "@react-navigation/elements";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api, auth, isAuthError } from "@/src/api";
import { ExpiredSessionRecoveryNotice, useExpiredSessionRecovery } from "@/src/authExpiredRecovery";
import {
  compareDateOnly,
  completedAgeMonths,
  isValidDueDate,
  localDateOnly,
  parseDateOnly,
  pregnancyWeeks,
} from "@/src/child-age";
import { CardList, NuriButton, NuriField, NuriText, ChoiceChip, MenuRow } from "@/src/uiux48/Primitives";
import { StateCard } from "@/src/uiux48/StateCard";
import ConfirmDialog from "@/src/components/ConfirmDialog";
import { colors, radius, spacing, type } from "@/src/theme";
import { useT, translate } from "@/src/i18n";

const GENDERS: { key: "boy" | "girl" | "other"; label: string }[] = [
  { key: "boy", label: "男孩" },
  { key: "girl", label: "女孩" },
  { key: "other", label: "不愿透露" },
];

export default function ChildEdit() {
  const { capture, current } = useAccountScope();
  const { t, locale } = useT();
  const [confirmDelete,setConfirmDelete]=useState(false);
  const router = useRouter();
  const recovery = useExpiredSessionRecovery(() => router.replace("/login"));
  const recoverExpiredCredentials = recovery.recover;
  const headerHeight = useHeaderHeight();
  const [pageHeaderHeight, setPageHeaderHeight] = useState(0);
  const goBack = () => router.canGoBack() ? router.back() : router.replace("/(tabs)/profile");
  const { id, uiState } = useLocalSearchParams<{ id: string; uiState?: string }>();
  const isNew = id === "new";
  const editing = isNew || uiState === "edit";
  const [loaded,setLoaded]=useState(false);
  const [saved,setSaved]=useState(false);
  const [reload,setReload]=useState(0);
  const mutation=useRef(false);

  const [nickname, setNickname] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [expecting, setExpecting] = useState(false);
  const [gender, setGender] = useState<"boy" | "girl" | "other">("other");
  const [allergies, setAllergies] = useState("");
  const [notes, setNotes] = useState("");
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ticket = capture();
    if (ticket === null) return;
    let cancelled = false;
    setLoaded(false);setLoadError("");
    (async () => {
      if (isNew) return;
      const requestToken = await auth.getToken();
      try {
        if (cancelled || !current(ticket)) return;
        const list = await api.listChildren();
        if (cancelled || await auth.getToken() !== requestToken || !current(ticket)) return;
        const c = list.find((x: any) => x.id === id);
        if (!c) {
          setLoadError(t("没有找到这份孩子资料，请返回后重试。"));
          return;
        }
        setNickname(c.nickname);
        setBirthDate(c.birth_date || "");
        setExpecting(isValidDueDate(c.birth_date || ""));
        setGender(c.gender);
        setAllergies((c.allergies || []).join(", "));
        setNotes(c.notes || "");
        setLoaded(true);
      } catch (error) {
        if (cancelled || !current(ticket)) return;
        if (isAuthError(error)) {
          await recoverExpiredCredentials(error, requestToken);
          return;
        }
        setLoadError(t("孩子资料加载失败，请检查网络后重试。"));
      }
    })();
    return () => { cancelled = true; };
  }, [id, isNew, reload, router, t, recoverExpiredCredentials, capture, current, setLoadError, setNickname, setBirthDate, setExpecting, setGender, setAllergies, setNotes, setLoaded]);

  const parsedBirthDate = parseDateOnly(birthDate);
  const birthDateError = !birthDate
    ? expecting ? t("请输入预产期") : t("请输入孩子的出生日期")
    : !parsedBirthDate
      ? t("请按 YYYY-MM-DD 填写有效日期")
      : expecting
        ? isValidDueDate(birthDate) ? "" : t("预产期要在今天之后的 40 周内")
        : compareDateOnly(parsedBirthDate, localDateOnly()) > 0
        ? t("出生日期不能晚于今天")
        : "";
  const ageMonths = completedAgeMonths(birthDate);
  const weeks = pregnancyWeeks(birthDate);
  const stageLabel = isValidDueDate(birthDate)
    ? t("尚未出生，预计孕周约 {weeks} 周", { weeks: weeks! })
    : ageMonths === null ? t("请先填写有效的出生日期") : t("{months} 个月", { months: ageMonths });
  const canSave = !!nickname.trim() && !birthDateError;

  const save = async () => {
    const ticket = capture();
    if (ticket === null) return;
    if (!canSave || saving || mutation.current) return;
    mutation.current=true;
    setSaving(true);
    setSaveError("");
    const body = {
      nickname: nickname.trim(),
      birth_date: birthDate,
      gender,
      allergies: allergies
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      notes: notes.trim(),
    };
    let requestToken: string | null = null;
    try {
      requestToken=await auth.getToken();if(!current(ticket))return;
      const saved: any = isNew
        ? await api.addChild(body)
        : await api.updateChild(id as string, body);
      if (saved?.birth_date !== body.birth_date) {
        throw new Error("The saved birthday did not match the submitted value");
      }
      if (await auth.getToken() !== requestToken || !current(ticket)) return;
      setSaved(true);
    } catch (error) {
      if (!current(ticket)) return;
      if (isAuthError(error)) {
        await recoverExpiredCredentials(error, requestToken);
        return;
      }
      setSaveError(t("保存失败，这次修改尚未写入。请检查网络后重试。"));
    } finally {
      mutation.current=false;
      setSaving(false);
    }
  };

  const remove = async () => {
    const ticket = capture();
    if (ticket === null) return;
    if (isNew || !id || saving || mutation.current) return;
    mutation.current=true;
    setSaving(true);
    setSaveError("");
    let requestToken: string | null = null;
    try {
      requestToken=await auth.getToken();if(!current(ticket))return;
      await api.deleteChild(id as string);
      if (await auth.getToken() !== requestToken || !current(ticket)) return;
      goBack();
    } catch (error) {
      if (!current(ticket)) return;
      if (isAuthError(error)) {
        await recoverExpiredCredentials(error, requestToken);
        return;
      }
      setSaveError(t("删除失败，孩子资料仍然保留。请稍后重试。"));
    } finally {
      mutation.current=false;
      setSaving(false);
    }
  };

  if (recovery.blocked) return <ExpiredSessionRecoveryNotice pending={recovery.pending} onRetry={recoverExpiredCredentials} />;

  if(saved) return <StateCard testID="child-saved" message={locale==="en"?"Changes saved.":translate(locale, "修改已保存。")} primary={{label:locale==="en"?"Done":translate(locale, "完成"),onPress:goBack}} />;
  if(!editing) return <View style={{flex:1}}><CardList testID="child-detail-card">
    {loadError?<><NuriText>{loadError}</NuriText><NuriButton secondary label={locale==="en"?"Retry":translate(locale, "重试")} onPress={()=>setReload(v=>v+1)} /></>:!loaded?<NuriText secondary>{locale==="en"?"Loading…":translate(locale, "正在读取…")}</NuriText>:<>
      <MenuRow label={t("昵称")} detail={nickname} onPress={()=>router.setParams({uiState:"edit"})} />
      <MenuRow label={isValidDueDate(birthDate)?t("预产期"):t("出生日期")} detail={`${birthDate} · ${stageLabel}`} onPress={()=>router.setParams({uiState:"edit"})} testID="child-detail-date" />
      <MenuRow label={locale==="en"?"Allergies & notes":translate(locale, "过敏信息与备注")} detail={[allergies,notes].filter(Boolean).join(" · ")} onPress={()=>router.setParams({uiState:"edit"})} />
      <NuriButton label={locale==="en"?"Edit profile":translate(locale, "编辑资料")} onPress={()=>router.setParams({uiState:"edit"})} testID="child-detail-edit" />
      <NuriButton secondary label={locale==="en"?"Delete child profile":translate(locale, "删除孩子资料")} onPress={()=>setConfirmDelete(true)} testID="child-detail-delete" />
      {saveError?<NuriText>{saveError}</NuriText>:null}
    </>}
  </CardList><ConfirmDialog visible={confirmDelete} title={locale==="en"?"Delete this child profile?":translate(locale, "删除这份孩子资料？")} message={locale==="en"?"This removes the profile from your shared cloud account, not only this device.":translate(locale, "将从共用云端账号移除此资料，不仅是本机。")} confirmText={locale==="en"?"Delete profile":translate(locale, "删除资料")} danger onConfirm={()=>void remove()} onCancel={()=>setConfirmDelete(false)} /></View>;

  return <View style={{flex:1}}><KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":"height"} keyboardVerticalOffset={headerHeight}><CardList>
    <NuriText style={{fontSize:20,fontWeight:"500"}}>{isNew?t("添加孩子"):t("编辑信息")}</NuriText>
    {loadError?<NuriText>{loadError}</NuriText>:null}{saveError?<NuriText>{saveError}</NuriText>:null}
    <NuriField label={t("昵称")} value={nickname} onChangeText={setNickname} editable={!saving&&!loadError} testID="child-nickname" />
    <NuriText secondary>{t("宝宝出生了吗？")}</NuriText>
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:10}}>{([false,true] as const).map(value=><ChoiceChip key={String(value)} label={value?t("还在肚子里"):t("已出生")} selected={expecting===value} disabled={saving||!!loadError} onPress={()=>{if(value!==expecting){setExpecting(value);setBirthDate("");}}} testID={value?"child-expecting":"child-born"} />)}</View>
    <NuriField label={expecting?t("预产期"):t("出生日期")} value={birthDate} onChangeText={setBirthDate} autoCapitalize="none" autoCorrect={false} placeholder="YYYY-MM-DD" maxLength={10} editable={!saving&&!loadError} testID="child-birth-date" />
    <NuriText secondary style={{fontSize:12}}>{birthDateError||(expecting?t("根据预产期估算孕周，不代表医学检查结果"):t("保存完整生日，用于准确计算月龄"))}</NuriText>
    <NuriText testID="child-months">{!birthDateError?stageLabel:expecting?t("请先填写有效的预产期"):t("请先填写有效的出生日期")}</NuriText>
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:10}}>{GENDERS.map(g=><ChoiceChip key={g.key} label={t(g.label)} selected={gender===g.key} onPress={()=>setGender(g.key)} />)}</View>
    <NuriField label={t("过敏史")} value={allergies} onChangeText={setAllergies} editable={!saving&&!loadError} testID="child-allergies" />
    <NuriField label={t("特殊注意事项")} value={notes} onChangeText={setNotes} multiline editable={!saving&&!loadError} style={{height:96,paddingTop:14}} testID="child-notes" />
    <NuriButton label={saving?t("保存中..."):t("保存")} busy={saving} disabled={!canSave||saving||!!loadError} onPress={()=>void save()} testID="child-save-btn" />
    {!isNew?<NuriButton secondary label={t("删除此孩子")} disabled={saving||!!loadError} onPress={()=>setConfirmDelete(true)} testID="child-delete-btn" />:null}
  </CardList></KeyboardAvoidingView><ConfirmDialog visible={confirmDelete} title={locale==="en"?"Delete this child profile?":translate(locale, "删除这份孩子资料？")} message={locale==="en"?"This removes the profile from your shared cloud account, not only this device.":translate(locale, "将从共用云端账号移除此资料，不仅是本机。")} confirmText={locale==="en"?"Delete profile":translate(locale, "删除资料")} danger onConfirm={()=>void remove()} onCancel={()=>setConfirmDelete(false)} /></View>;
}
