// What NURI has kept from the conversation (GET /memories). Every row shapes
// replies and the daily cards, so the parent can see each one and make NURI
// forget it. Ported from the web app's /memories page into the profile.
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { api } from "@/src/api";
import ConfirmDialog from "@/src/components/ConfirmDialog";
import { useT, translate } from "@/src/i18n";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { InlineState, NuriText } from "@/src/uiux48/Primitives";
import { useNuriTheme } from "@/src/uiux48/Theme";

type Memory = Awaited<ReturnType<typeof api.listMemories>>[number];

export default function MemoriesSection() {
  const theme = useNuriTheme();
  const { locale } = useT();
  const copy = (cn: string, en: string) => locale === "en" ? en : translate(locale, cn);
  const { capture, current } = useAccountScope();
  const [memories, setMemories] = useAccountState<Memory[]>([]);
  const [state, setState] = useAccountState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useAccountState("");
  const [pendingForget, setPendingForget] = useState<Memory | null>(null);

  const load = useCallback(async () => {
    const ticket = capture();
    if (ticket === null) return;
    setState("loading");
    try {
      const rows = await api.listMemories();
      if (!current(ticket)) return;
      setMemories(rows);
      setState("ready");
    } catch {
      if (current(ticket)) setState("error");
    }
  }, [capture, current, setMemories, setState]);

  useEffect(() => { void load(); }, [load]);

  const forget = async () => {
    const memory = pendingForget;
    setPendingForget(null);
    const ticket = capture();
    if (!memory || ticket === null) return;
    const before = memories;
    setMemories(rows => rows.filter(m => m.id !== memory.id));
    setNotice("");
    try {
      await api.forgetMemory(memory.id);
      if (current(ticket)) setNotice(copy("NURI 已经忘记这一条", "NURI has forgotten this."));
    } catch {
      if (!current(ticket)) return;
      setMemories(before);
      setNotice(copy("删除失败，请重试", "Couldn't delete it. Please try again."));
    }
  };

  const group = (title: string, hint: string, items: Memory[]) => items.length ? <View style={{ gap: 8 }}>
    <NuriText style={{ fontSize: 17, fontWeight: "500" }}>{title}</NuriText>
    <NuriText secondary style={{ fontSize: 12, lineHeight: 18 }}>{hint}</NuriText>
    {items.map(m => <View key={m.id} testID={`memory-${m.id}`} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.outline }}>
      <NuriText style={{ flex: 1 }}>{m.text}</NuriText>
      <Pressable onPress={() => setPendingForget(m)} accessibilityRole="button" hitSlop={8} testID={`memory-forget-${m.id}`}>
        <NuriText style={{ color: "#a25563", fontSize: 14 }}>{copy("忘记", "Forget")}</NuriText>
      </Pressable>
    </View>)}
  </View> : null;

  return <>
    <NuriText secondary style={{ fontSize: 12, lineHeight: 18 }}>{copy("这些是 NURI 从你们的对话里记下的家庭情况，用来让回复和每日精选更贴合你家。觉得不对或不想被记住的，可以直接删除。", "These are things NURI picked up about your family from your conversations. They make replies and daily picks fit your family. Delete anything that's wrong or that you'd rather NURI didn't keep.")}</NuriText>
    {state === "loading" ? <InlineState busy message={copy("正在读取…", "Loading…")} />
      : state === "error" ? <InlineState message={copy("没能加载。", "Couldn't load.")} action={copy("重试", "Retry")} onPress={() => void load()} />
      : !memories.length ? <NuriText secondary testID="memories-empty">{copy("NURI 还没有记下什么。多聊几次，它会慢慢了解你家。", "NURI hasn't noted anything yet. It gets to know your family as you talk.")}</NuriText>
      : <>
        {group(copy("每次都会遵守", "Always followed"), copy("例如过敏、饮食限制。NURI 的每一次回复和推荐都会照顾到这些。", "Such as allergies or dietary limits. Every reply and recommendation respects these."), memories.filter(m => m.standing))}
        {group(copy("聊天时参考", "Used in conversation"), copy("NURI 了解到的近况，和你聊相关话题时会想起来。", "Recent things NURI learned, recalled when you talk about related topics."), memories.filter(m => !m.standing))}
      </>}
    {notice ? <NuriText secondary accessibilityLiveRegion="polite" testID="memories-notice">{notice}</NuriText> : null}
    <ConfirmDialog visible={!!pendingForget} title={copy("让 NURI 忘记这一条？", "Make NURI forget this?")} message={pendingForget?.text || ""} confirmText={copy("忘记", "Forget")} cancelText={copy("取消", "Cancel")} danger onConfirm={() => void forget()} onCancel={() => setPendingForget(null)} />
  </>;
}
