import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFonts } from "expo-font";
import { NotoSansSC_400Regular } from "@expo-google-fonts/noto-sans-sc/400Regular";
import { NotoSansSC_900Black } from "@expo-google-fonts/noto-sans-sc/900Black";

import { api } from "@/src/api";

const babyIcon = require("@/assets/images/onboarding-baby-icon.png");
const parentIcon = require("@/assets/images/onboarding-parent-icon.png");

const CONCERNS = [
  ["sleep", "睡眠"], ["food", "饮食／副食品"], ["emotion", "情绪与哭闹"],
  ["development", "发展与学习"], ["parenting", "教养方式"], ["health", "生病与健康"],
  ["childcare", "托育／幼儿园"], ["family", "家人教养观念不同"], ["unknown", "我不知道从哪开始"], ["other", "其他"],
] as const;
const HELP_PREFS = [["research", "专业研究与知识"], ["experience", "真实家长经验分享"], ["analysis", "一步一步分析原因"], ["actionable", "直接给我可执行的方法"]] as const;
const INFO_SOURCES = [["research", "专业研究／论文"], ["expert", "医师或专家"], ["parents", "其他家长经验"], ["all", "都会参考"]] as const;
const FREQUENCIES = [["daily", "每天一次"], ["weekly_2_3", "每周 2～3 次"], ["weekly", "每周一次"], ["on_demand", "有需要时再推播"]] as const;

const YEARS = Array.from({ length: 9 }, (_, i) => new Date().getFullYear() - i);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export default function Onboarding() {
  const router = useRouter();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const [fontsLoaded] = useFonts({ NotoSansSC_400Regular, NotoSansSC_900Black });
  // 0/1/2 = Figma 注册流程 2/4/5；3–6 = 注册流程 6/6.1/6.2/6.3。
  const [page, setPage] = useState(0);
  const [childName, setChildName] = useState("");
  const [birthYear, setBirthYear] = useState<number | null>(null);
  const [birthMonth, setBirthMonth] = useState<number | null>(null);
  const [nickname, setNickname] = useState("");
  const [city, setCity] = useState("");
  const [concerns, setConcerns] = useState<string[]>([]);
  const [concernOther, setConcernOther] = useState("");
  const [hobbies, setHobbies] = useState("");
  const [helpPref, setHelpPref] = useState("");
  const [infoSource, setInfoSource] = useState("");
  const [frequency, setFrequency] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [existingChild, setExistingChild] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [me, kids] = await Promise.all([api.me(), api.listChildren()]);
        setNickname(me?.nickname || ""); setCity(me?.city || "");
        setConcerns(me?.top_concerns || []); setConcernOther(me?.concern_other || "");
        setHobbies(me?.hobbies || ""); setHelpPref(me?.help_preference || "");
        setInfoSource(me?.info_source || ""); setFrequency(me?.content_frequency || "");
        if (kids?.[0]) {
          const child = kids[0]; const born = new Date(child.birth_date);
          setExistingChild(child); setChildName(child.nickname || "");
          if (!Number.isNaN(born.getTime())) { setBirthYear(born.getFullYear()); setBirthMonth(born.getMonth() + 1); }
        }
      } catch { /* Preview and first-use flows can start blank. */ }
    })();
  }, []);

  const stepNumber = page < 3 ? page + 1 : 4;
  const canNext = page === 0
    ? !!childName.trim() && !!birthYear && !!birthMonth
    : page === 1 ? !!nickname.trim() && !!city.trim() : true;
  const birthLabel = birthYear && birthMonth ? `${birthYear} 年 ${birthMonth} 月` : "请选择孩子的出生年月";

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const child = { nickname: childName.trim(), birth_date: `${birthYear}-${String(birthMonth).padStart(2, "0")}-01`, gender: existingChild?.gender || "other", allergies: existingChild?.allergies || [], notes: existingChild?.notes || "" };
      if (existingChild?.id) await api.updateChild(existingChild.id, child); else await api.addChild(child);
      await api.updateMe({ nickname: nickname.trim(), city: city.trim(), top_concerns: concerns, concern_other: concerns.includes("other") ? concernOther.trim() : "", hobbies: hobbies.trim(), help_preference: helpPref, info_source: infoSource, content_frequency: frequency, onboarding_completed: true });
      router.replace("/(tabs)");
    } finally { setSaving(false); }
  };

  const next = () => page === 6 ? save() : setPage((p) => p + 1);
  const skip = () => page === 2 ? setPage(3) : save();
  const goBack = () => page > 0 && setPage((p) => p - 1);
  const toggleConcern = (key: string) => setConcerns((old) => old.includes(key) ? old.filter((x) => x !== key) : [...old, key]);

  if (!fontsLoaded) return <View style={styles.loading}><ActivityIndicator color="#3A2F5A" /></View>;

  return (
    <LinearGradient colors={["#FFFFFF", "#FFF8FB", "#C0AEF5"]} locations={[0, 0.38, 1]} style={styles.gradient}>
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.safe}>
          <View style={styles.topBar}>
            <Pressable onPress={goBack} hitSlop={12} style={[styles.backButton, page === 0 && styles.hidden]}>
              <Ionicons name="arrow-back" size={23} color="#3A2F5A" />
            </Pressable>
            <Pressable onPress={page >= 2 ? skip : undefined} disabled={page < 2} hitSlop={10}>
              <Text style={styles.progressText}>{stepNumber}/4{page >= 2 ? "  跳过" : ""}</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Hero page={page} />
            <View style={[styles.form, page >= 3 && styles.preferenceForm]}>
              {page === 0 && <ChildPage childName={childName} setChildName={setChildName} birthLabel={birthLabel} openPicker={() => setPickerOpen(true)} />}
              {page === 1 && <ParentPage nickname={nickname} setNickname={setNickname} city={city} setCity={setCity} />}
              {page === 2 && <ConcernPage concerns={concerns} toggle={toggleConcern} other={concernOther} setOther={setConcernOther} />}
              {page === 3 && <TextPage title="了解你的教养方式" subtitle="帮助 NURI 了解你的最佳陪伴方式"><Field label="平常没带小孩时喜欢做的事"><TextInput value={hobbies} onChangeText={setHobbies} placeholder="例如：看剧、健身、和朋友聚会……" placeholderTextColor="rgba(58,47,90,0.6)" style={styles.input} /></Field></TextPage>}
              {page === 4 && <ChoicePage title="遇到教养问题时" subtitle="你希望 NURI 提供什么样的帮助？" options={HELP_PREFS} value={helpPref} onChange={setHelpPref} />}
              {page === 5 && <ChoicePage title="你平常比较信任" subtitle="哪些信息来源？" options={INFO_SOURCES} value={infoSource} onChange={setInfoSource} />}
              {page === 6 && <ChoicePage title="希望多久收到一次" subtitle="育儿知识或有帮助的内容？" options={FREQUENCIES} value={frequency} onChange={setFrequency} />}
              <View style={[styles.ctaRow, page === 2 && styles.concernCta]}>
                <Pressable onPress={next} disabled={!canNext || saving} style={({ pressed }) => [styles.cta, canNext && !saving && styles.ctaReady, pressed && canNext && styles.pressed]} testID="onboarding-next-btn">
                  <Text style={styles.ctaText}>{page === 6 ? (saving ? "保存中..." : "完成") : "下一步"}</Text><Ionicons name="arrow-forward" size={16} color="#3A2F5A" />
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
        {pickerOpen && <BirthPicker year={birthYear} month={birthMonth} setYear={setBirthYear} setMonth={setBirthMonth} close={() => setPickerOpen(false)} />}
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

function Hero({ page }: { page: number }) {
  if (page === 0) return <Image source={babyIcon} style={styles.babyIcon} resizeMode="contain" />;
  if (page === 1) return <Image source={parentIcon} style={styles.parentIcon} resizeMode="contain" />;
  return <View style={styles.choiceIcon}><View style={styles.iconBlockTall} /><View style={styles.iconBlockShort} /><View style={styles.iconBlockShort} /><View style={styles.iconBlockTall} /></View>;
}
function TextPage({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) { return <><Text style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text><View style={styles.pageBody}>{children}</View></>; }
function ChildPage({ childName, setChildName, birthLabel, openPicker }: any) { return <TextPage title="孩子基本信息" subtitle="这些信息只用来给你更个性化的建议，永远不会分享给第三方"><Field label="孩子怎么称呼？"><TextInput value={childName} onChangeText={setChildName} placeholder="例如：小满" placeholderTextColor="rgba(58,47,90,0.6)" style={styles.input} testID="onboarding-child-name" /></Field><Field label="孩子的出生日期"><Pressable onPress={openPicker} style={[styles.input, styles.picker]} testID="onboarding-birth-picker"><Text style={[styles.inputText, !childName && styles.placeholder]}>{birthLabel}</Text><Ionicons name="calendar-outline" size={20} color="#3A2F5A" /></Pressable></Field></TextPage>; }
function ParentPage({ nickname, setNickname, city, setCity }: any) { return <TextPage title="家长基本信息" subtitle="AI 会用这个名字给你打招呼"><Field label="我应该怎么称呼你？"><TextInput value={nickname} onChangeText={setNickname} placeholder="例如：小满妈" placeholderTextColor="rgba(58,47,90,0.6)" style={styles.input} /></Field><Field label="您目前居住在哪里？"><TextInput value={city} onChangeText={setCity} placeholder="例如：San Francisco／多伦多" placeholderTextColor="rgba(58,47,90,0.6)" style={styles.input} /></Field></TextPage>; }
function ConcernPage({ concerns, toggle, other, setOther }: any) { return <TextPage title="目前最想要解决的育儿问题" subtitle="目前最困扰你的事情是什么？（可多选）"><View style={styles.chipWrap}>{CONCERNS.map(([key, label]) => { const active = concerns.includes(key); return <Pressable key={key} onPress={() => toggle(key)} style={[styles.chip, active && styles.chipActive]} testID={`onboarding-concern-${key}`}><Ionicons name={active ? "checkbox" : "square-outline"} size={16} color={active ? "#FFFFFF" : "#3A2F5A"} /><Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text></Pressable>; })}</View>{concerns.includes("other") && <TextInput value={other} onChangeText={setOther} placeholder="请描述你的困扰..." placeholderTextColor="rgba(58,47,90,0.6)" style={[styles.input, { marginTop: 12 }]} />}</TextPage>; }
function ChoicePage({ title, subtitle, options, value, onChange }: any) { return <TextPage title={title} subtitle={subtitle}><View style={styles.choiceList}>{options.map(([key, label]: [string, string]) => <Pressable key={key} onPress={() => onChange(key)} style={[styles.choice, value === key && styles.choiceActive]}><View style={[styles.radio, value === key && styles.radioActive]}>{value === key && <View style={styles.radioDot} />}</View><Text style={[styles.choiceText, value === key && styles.choiceTextActive]}>{label}</Text></Pressable>)}</View></TextPage>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <View style={styles.field}><Text style={styles.label}>{label}</Text>{children}</View>; }
function BirthPicker({ year, month, setYear, setMonth, close }: any) { return <View style={styles.sheetRoot}><Pressable style={StyleSheet.absoluteFill} onPress={close} /><View style={styles.sheet}><View style={styles.sheetHeader}><Text style={styles.sheetTitle}>选择出生年月</Text><Pressable onPress={close}><Text style={styles.done}>确定</Text></Pressable></View><View style={styles.divide} /><View style={styles.pickerCols}><ScrollView style={styles.pickerColumn} showsVerticalScrollIndicator={false}>{YEARS.map((value) => <Pressable key={value} onPress={() => setYear(value)} style={[styles.pickerItem, year === value && styles.pickerItemActive]}><Text style={styles.pickerText}>{value} 年</Text></Pressable>)}</ScrollView><ScrollView style={styles.pickerColumn} showsVerticalScrollIndicator={false}>{MONTHS.map((value) => <Pressable key={value} onPress={() => setMonth(value)} style={[styles.pickerItem, month === value && styles.pickerItemActive]}><Text style={styles.pickerText}>{value} 月</Text></Pressable>)}</ScrollView></View></View></View>; }

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" }, gradient: { flex: 1 }, safe: { flex: 1 },
  phoneCanvas: { alignSelf: "center", flex: 1, overflow: "hidden" },
  topBar: { height: 54, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, backButton: { minWidth: 32, minHeight: 36, justifyContent: "center" }, hidden: { opacity: 0 }, progressText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 12, letterSpacing: 0.48 },
  content: { paddingHorizontal: 16, paddingBottom: 30, flexGrow: 1 }, babyIcon: { alignSelf: "center", width: 44, height: 44, marginTop: 67 }, parentIcon: { alignSelf: "center", width: 37, height: 49, marginTop: 62 },
  choiceIcon: { width: 48, height: 48, alignSelf: "center", marginTop: 62, flexDirection: "row", flexWrap: "wrap", gap: 4 }, iconBlockTall: { width: 22, height: 28, borderRadius: 4, backgroundColor: "#3A2F5A" }, iconBlockShort: { width: 22, height: 16, borderRadius: 4, backgroundColor: "#3A2F5A" },
  form: { marginTop: 159 }, preferenceForm: { marginTop: 132 }, title: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 24 }, subtitle: { color: "#3A2F5A", fontFamily: "NotoSansSC_400Regular", fontSize: 16, lineHeight: 21, marginTop: 4 }, pageBody: { marginTop: 16 },
  field: { marginTop: 12 }, label: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 16, marginBottom: 8 }, input: { height: 48, borderRadius: 12, borderWidth: 1.5, borderColor: "rgba(58,47,90,0.6)", backgroundColor: "rgba(255,255,255,0.18)", paddingHorizontal: 16, color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 12, letterSpacing: 0.48 }, inputText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 12, letterSpacing: 0.48 }, picker: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, placeholder: { color: "rgba(58,47,90,0.6)" },
  ctaRow: { alignItems: "flex-end", marginTop: 62 }, concernCta: { marginTop: 32 }, cta: { width: 148, height: 48, borderRadius: 12, borderWidth: 1, borderColor: "rgba(60,34,45,0.3)", backgroundColor: "rgba(255,255,255,0.6)", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }, ctaReady: { backgroundColor: "rgba(255,255,255,0.9)" }, ctaText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 14 }, pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 }, chip: { height: 41, borderRadius: 12, borderWidth: 1, borderColor: "rgba(58,47,90,0.6)", backgroundColor: "rgba(255,255,255,0.2)", flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 14 }, chipActive: { backgroundColor: "#3A2F5A" }, chipText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 14 }, chipTextActive: { color: "#fff" },
  choiceList: { gap: 10, marginTop: 4 }, choice: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: "rgba(58,47,90,0.6)", backgroundColor: "rgba(255,255,255,0.2)", flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 10 }, choiceActive: { backgroundColor: "#3A2F5A" }, radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: "#3A2F5A", alignItems: "center", justifyContent: "center" }, radioActive: { borderColor: "#fff" }, radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" }, choiceText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 14 }, choiceTextActive: { color: "#fff" },
  sheetRoot: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(58,47,90,0.32)", justifyContent: "flex-end" }, sheet: { backgroundColor: "#FDF9FF", height: 428, borderTopLeftRadius: 24, borderTopRightRadius: 24 }, sheetHeader: { height: 59, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 }, sheetTitle: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 16 }, done: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 16 }, divide: { height: 1, marginHorizontal: 19, backgroundColor: "rgba(58,47,90,0.2)" }, pickerCols: { flex: 1, flexDirection: "row", gap: 10, padding: 12 }, pickerColumn: { flex: 1 }, pickerItem: { height: 46, alignItems: "center", justifyContent: "center", borderRadius: 8 }, pickerItemActive: { backgroundColor: "rgba(58,47,90,0.12)" }, pickerText: { color: "#3A2F5A", fontFamily: "NotoSansSC_400Regular", fontSize: 16 },
});
