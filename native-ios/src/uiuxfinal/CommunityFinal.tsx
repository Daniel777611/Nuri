import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useT, translate } from "@/src/i18n";
import { registerNativeNavigationGuard } from "@/src/components/nativeNavigation";
import { IconAction, NuriKeyboardFrame } from "@/src/uiux48/Primitives";
import { NuriComposer } from "@/src/uiux48/Composer";
import { VoiceInputBar } from "@/src/uiux48/VoiceInputBar";
import { FinalButton, FinalDivider, FinalSurface, FinalText, FINAL_COLOR } from "./Primitives";
import { SettingsPage, SettingsRow, SettingsToggle, SettingsButton, SettingsSpacer, SettingsField } from "./Settings";
import { createFinalCommunity, finalCommunityReducer, isFinalCommunityScreen, selectedFinalQuestion, selectedQuestionText, PARENT_FIXTURES, type FinalCommunityScreen, type FixtureParent, type FixtureQuestion } from "./communityModel";
const ANSWERS = [["我们也哭了好几周。固定、简短的告别仪式很有帮助，我们也不会偷偷离开。", "We had tears for weeks too. A short, consistent goodbye helped; we never slipped away."], ["大约第三周开始好转。带一件熟悉的安抚物，让告别容易了一些。", "Things improved around week three. A familiar comfort item made goodbyes easier."]] as const;
const TITLE: Partial<Record<FinalCommunityScreen, readonly [string, string]>> = {
  hub: ["社区", "Community"],
  friends: ["社区", "Community"],
  inbox: ["社区", "Community"],
  contacts: ["好友列表", "Friends"],
  invitations: ["新的联系", "New connections"],
  intent: ["交友需求", "What brings you here?"],
  profile: ["我的档案", "My profile"],
  suggestions: ["可能聊得来的家长", "Parents you may connect with"],
  parent: ["家长资料", "Parent profile"],
  compose: ["发一个漂流瓶", "Send a bottle"],
  original: ["发一个漂流瓶", "Send a bottle"],
  polished: ["发一个漂流瓶", "Send a bottle"],
  preview: ["发送前，确认一下", "Review before sending"],
  myQuestions: ["我的问题", "My questions"],
  selection: ["我的问题", "My questions"],
  replies: ["漂流瓶回复", "Bottle replies"],
  replyDetail: ["回复Maya", "Reply to Maya"],
  replyExpanded: ["回复所有人", "Reply to everyone"],
  comments: ["漂流瓶回复", "Bottle replies"],
  received: ["收到的问题", "Received questions"],
  receivedReplied: ["收到的问题", "Received questions"],
  receivedLocked: ["收到的问题", "Received questions"],
  respond: ["分享经验", "Share your experience"]
};
function SampleAvatar({
  size = 40
}: {
  size?: number;
}) {
  return <View style={{
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: "#FAE2E0",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "flex-end"
  }}><Image source={require("@/assets/final-flow-20261101/parent-avatar.png")} contentFit="contain" style={{
      width: size,
      height: size * .875
    }} /></View>;
}
function Search({
  value,
  onChange,
  placeholder
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return <TextInput testID="final-community-search" value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor="#918896" style={{
    height: 36,
    borderRadius: 24,
    paddingHorizontal: 20,
    backgroundColor: "rgba(255,255,255,.85)",
    color: FINAL_COLOR.ink,
    fontSize: 14
  }} />;
}
function DemoLabel({
  en
}: {
  en: boolean;
}) {
  return <FinalText size={10} secondary testID="final-community-demo-label" style={{
    position: "absolute",
    top: 0,
    right: 24,
    zIndex: 2
  }}>{en ? "Flow preview · sample data" : "流程预览 · 示例数据"}</FinalText>;
}
/** Current Figma's presentation graph. The Metro alias excludes it from
 * ordinary App Store builds; all writes below are reducer-only fixture writes. */
export default function CommunityFinal() {
  const {
    uiState
  } = useLocalSearchParams<{
    uiState?: string;
  }>();
  const [state, dispatch] = useReducer(finalCommunityReducer, isFinalCommunityScreen(uiState) ? uiState : "hub", createFinalCommunity);
  const [width, setWidth] = useState(0),
    [pagerHeight, setPagerHeight] = useState(0),
    [search, setSearch] = useState(""),
    [voice, setVoice] = useState(false),
    [attachment, setAttachment] = useState(false),
    [filter, setFilter] = useState<"gender" | "distance" | null>(null),
    [profileEditing,setProfileEditing]=useState(false);
  const {
    locale
  } = useT();
  const en = locale === "en";
  const router = useRouter(),
    path = usePathname();
  const pager = useRef<ScrollView>(null),
    messages = useRef<ScrollView>(null),
    latest = useRef(state);
  latest.current = state;
  const c = (cn: string, english: string) => en ? english : translate(locale, cn);
  const go = (screen: FinalCommunityScreen) => dispatch({
    type: "go",
    screen
  });
  const home = state.screen === "hub" || state.screen === "friends";
  const parentChat = ["chat", "chatOn", "consent"].includes(state.screen);
  const bottle = !["hub", "friends", "inbox", "contacts", "invitations", "preferences", "blocked", "blockedEmpty", "parentSettings", "safetyConfirm"].includes(state.screen) && !parentChat;
  const title = parentChat ? state.person : state.screen === "replyDetail" || state.screen === "replyKeyboard" ? c("回复", "Reply to ") + (state.replyTarget === "anonymous" ? c("匿名家长", "Anonymous parent") : state.replyTarget) : TITLE[state.screen] ? c(...TITLE[state.screen]!) : c("社区", "Community");
  useFocusEffect(useCallback(() => {
    router.setParams({
      flowTitle: title,
      communityBackdrop: ["preferences", "blocked", "blockedEmpty", "parentSettings", "safetyConfirm"].includes(state.screen) ? "settings" : parentChat ? "plain" : bottle ? "final-bottle" : "final-unified",
      communityHideTabs: home || ["inbox", "contacts", "invitations"].includes(state.screen) ? "0" : "1",
      communityHideBack: home ? "1" : "0"
    });
    return registerNativeNavigationGuard(path, action => {
      if (action === "back" && latest.current.history.length) {
        dispatch({
          type: "back"
        });
        return;
      }
      const routes = {
        home: "/(tabs)",
        chat: "/(tabs)/chats",
        community: "/community",
        notifications: "/notifications",
        profile: "/(tabs)/profile"
      } as const;
      if (action === "back") router.dismissTo("/(tabs)");else router.navigate(routes[action]);
    });
  }, [router, path, title, parentChat, bottle, home, state.screen]));
  useEffect(() => {
    if (home && width) pager.current?.scrollTo({
      x: width * state.page,
      animated: false
    });
  }, [home, width, state.page]);
  useEffect(() => {
    setVoice(false);
    setAttachment(false);
    setFilter(null);
    setSearch("");
    setProfileEditing(false);
  }, [state.screen, state.person]);
  // The progress state is an honest local simulation, not an upload receipt.
  useEffect(() => {
    if (state.screen !== "sending") return;
    const timer = setTimeout(() => dispatch({
      type: "finishSend"
    }), 650);
    return () => clearTimeout(timer);
  }, [state.screen]);
  const draft = (slot: string) => state.drafts[slot] ?? "";
  const setDraft = (slot: string, text: string) => dispatch({
    type: "draft",
    slot,
    text
  });
  const receipt = state.localReceipt ? <FinalText size={12} secondary testID="final-local-receipt">{c("仅保存在本次演示，没有发送到服务器。", "Saved in this preview only. Nothing was sent to a server.")}</FinalText> : null;
  const question = selectedFinalQuestion(state) ?? state.questions[0];
  const selectedDraft = state.questionVersion === "polished" ? "polished" : "question";
  const answerIndex = state.replyTarget === "anonymous" ? 1 : 0;
  const incomingQuestion = state.incoming.find(q => q.id === state.questionID);
  const responseFixtures = question?.categoryEN === "Sleep routines" ? [["固定睡前的几件小事帮助了我们。我们会先读一本短绘本，再轻声道晚安。", "A consistent bedtime ritual helped us: a short picture book, then a quiet goodnight."], ["我们试着提前开始睡前准备，给孩子多一些平静下来的时间。", "We started winding down earlier to give our child time to settle."]] : question?.categoryEN === "Family time" ? [["我们喜欢去附近公园找不同颜色的树叶，慢慢走就很开心。", "We look for different coloured leaves in a nearby park and take our time."], ["带上水和简单的小点心去散步，很适合我们。", "A walk with water and a simple snack works well for us."]] : question?.categoryEN === "Eating habits" ? [["我们会准备容易拿的小块食物，让孩子按自己的节奏试。", "We offer easy-to-hold food and let our child practise at their own pace."], ["多留一点时间，不急着帮忙，对我们很有用。", "Leaving extra time and not rushing to help worked for us."]] : ANSWERS;
  const answerRows = incomingQuestion ? incomingQuestion.answer ? [[incomingQuestion.answer, incomingQuestion.answer] as const] : [] : question?.replies ? responseFixtures.slice(0, question.replies) : [];
  const filterLabels = {
    gender: [c("不限", "Any"), c("妈妈", "Mothers"), c("爸爸", "Fathers")],
    distance: [c("不限", "Any"), c("1英里以内", "Within 1 mile"), c("3英里以内", "Within 3 miles")]
  };
  const suggestions = PARENT_FIXTURES.slice(0, 8).filter((p, i) => !state.blocked.includes(p) && (!state.filters.gender || i % 2 === state.filters.gender - 1) && (!state.filters.distance || i % 3 < state.filters.distance));
  const settingsScreen = ["preferences", "blocked", "blockedEmpty", "parentSettings", "safetyConfirm"].includes(state.screen);
  const questionText = (q: FixtureQuestion) => en ? q.en : q.cn;
  const questionCard = (q: FixtureQuestion, onPress?: () => void) => <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? "button" : undefined}><FinalSurface contentStyle={{
      padding: 20,
      gap: 12
    }}><FinalText size={12} secondary>{en ? q.categoryEN : q.categoryCN}</FinalText><FinalText size={18} style={{
        fontWeight: "500"
      }}>{questionText(q)}</FinalText></FinalSurface></Pressable>;
  function page(body: ReactNode, actions?: ReactNode, fill = false) {
    return <NuriKeyboardFrame><DemoLabel en={en} /><View style={s.main}><FinalSurface fill={fill} testID={`final-community-${state.screen}`}><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} style={{
            flexShrink: 1,
            ...(fill ? {
              flex: 1
            } : {})
          }} contentContainerStyle={s.body}>{receipt}{body}</ScrollView></FinalSurface>{actions ? <View style={s.actions}>{actions}</View> : null}</View></NuriKeyboardFrame>;
  }
  const personRow = (person: FixtureParent, detail: string, onPress: () => void) => <Pressable key={person} testID={`final-parent-${person}`} onPress={onPress} accessibilityRole="button" style={s.personRow}><SampleAvatar /><View style={{
      flex: 1,
      gap: 3
    }}><FinalText>{person}</FinalText><FinalText size={14} secondary numberOfLines={2}>{detail}</FinalText></View><FinalText style={{
      color: FINAL_COLOR.accent
    }}>›</FinalText></Pressable>;
  const localVoice = (slot: string) => voice ? <VoiceInputBar previewOnly phase="recording" seconds={8} metered={false} level={() => null} onCancel={() => setVoice(false)} onStop={() => {
    setDraft(slot, draft(slot) || c("这是用于测试流程的示例文字。", "This is sample text for flow testing."));
    setVoice(false);
  }} onSend={() => {
    setDraft(slot, draft(slot) || c("这是用于测试流程的示例文字。", "This is sample text for flow testing."));
    dispatch({
      type: slot==="question"||slot==="polished" ? "previewQuestion" : slot.startsWith("chat:") ? "sendMessage" : slot.startsWith("answer:") ? "sendResponse" : "sendComment"
    });
    setVoice(false);
  }} /> : null;
  const editor = (slot: string, placeholder: string) => <View style={{
    gap: 8
  }}>
      {question?.closed ? <FinalText size={12} secondary>{c("此问题已关闭，不能继续回复。", "This question is closed; replies are disabled.")}</FinalText> : null}
      <TextInput testID={`final-input-${slot}`} editable={!question?.closed} multiline value={draft(slot)} onChangeText={text => setDraft(slot, text)} placeholder={placeholder} placeholderTextColor="#918896" style={s.editor} />
      <View style={{
      flexDirection: "row",
      alignItems: "center",
      gap: 8
    }}>
        <IconAction name="mic" disabled={question?.closed} label={c("语音流程预览", "Preview voice flow")} onPress={() => setVoice(v => !v)} />
        <View style={{
        flex: 1
      }} /><FinalButton small label={c("发送", "Send")} disabled={question?.closed || !draft(slot).trim()} onPress={() => dispatch({
        type: slot.startsWith("answer:") ? "sendResponse" : "sendComment"
      })} />
      </View>{!question?.closed ? localVoice(slot) : null}
    </View>;
  if (settingsScreen) return <><DemoLabel en={en} /><SettingsPage testID={`final-community-${state.screen}`}>
      {receipt}
      {state.screen === "preferences" ? <>
        <SettingsRow label={c("交友资料与筛选", "Friend profile & filters")} detail={c("仅本次演示", "This preview only")} onPress={() => go("profile")} />
        <FinalDivider />
        {([["discoverable", c("家长消息通知", "Parent message notifications")], ["nearby", c("隐藏我的资料", "Hide my profile")], ["showAge", c("消息自动翻译", "Translate messages automatically")]] as const).map(([key, label]) => <SettingsToggle key={key} label={label} value={state.preferences[key]} onChange={value => dispatch({
          type: "preference",
          key,
          value
        })} />)}
        <SettingsRow label={c("屏蔽的家长", "Blocked parents")} onPress={() => go(state.blocked.length ? "blocked" : "blockedEmpty")} testID="final-open-blocked" />
      </> : state.screen === "blocked" || state.screen === "blockedEmpty" ? <>
        {state.blocked.length ? state.blocked.map(person => <View key={person} style={s.personRow}><SampleAvatar /><FinalText style={{
            flex: 1
          }}>{person}</FinalText><Pressable style={s.textTarget} onPress={() => {
            dispatch({type:"safety",action:"unblock",person});
          }}><FinalText style={{
              color: FINAL_COLOR.accent
            }}>{c("取消屏蔽", "Unblock")}</FinalText></Pressable></View>) : <FinalText secondary>{c("还没有屏蔽的家长。", "No blocked parents.")}</FinalText>}
      </> : state.screen === "parentSettings" ? <>
        <SettingsRow label={c("查看家长资料", "View parent profile")} onPress={() => go("parent")} />
        <SettingsRow label={c("屏蔽这位家长", "Block this parent")} danger onPress={() => dispatch({
          type: "safety",
          action: "block"
        })} testID="final-block-parent" />
        <SettingsRow label={c("解除联系", "Disconnect")} danger onPress={() => dispatch({
          type: "safety",
          action: "disconnect"
        })} />
      </> : <>
        <FinalText size={20}>{state.safetyAction === "unblock" ? c("取消屏蔽这位家长？", "Unblock this parent?") : state.safetyAction === "block" ? c("屏蔽这位家长？", "Block this parent?") : c("解除联系？", "Disconnect?")}</FinalText>
        <FinalText secondary>{c("操作仅影响本地演示，不更改真实账号或联系。", "This affects the local preview only, not real accounts or connections.")}</FinalText><SettingsSpacer />
        <SettingsButton label={c("确认", "Confirm")} onPress={() => dispatch({
          type: "confirmSafety"
        })} testID="final-confirm-safety" />
        <SettingsButton secondary label={c("取消", "Cancel")} onPress={() => dispatch({
          type: "back"
        })} />
      </>}
      <FinalText size={12} secondary>{c("社区服务尚未接入；以上为本地演示设置。", "Community service is not connected; these are local preview settings.")}</FinalText>
    </SettingsPage></>;
  if (home) return <View style={{
    flex: 1,
    minHeight: 0
  }}><DemoLabel en={en} /><View style={{
      flex: 1,
      minHeight: 0,
      paddingTop: 16
    }} onLayout={e => setWidth(e.nativeEvent.layout.width)}><ScrollView ref={pager} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onLayout={e => setPagerHeight(e.nativeEvent.layout.height)} onMomentumScrollEnd={e => {
        if (width) dispatch({
          type: "page",
          page: e.nativeEvent.contentOffset.x > width / 2 ? 1 : 0
        });
      }} style={{
        flex: 1
      }} testID="final-community-pager">
    {[0, 1].map(mode => <View key={mode} style={{
          width: width || 1,
          height: pagerHeight || undefined,
          paddingHorizontal: 12,
          paddingBottom: 4
        }}><FinalSurface fill testID={`final-community-page-${mode}`}><ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{
              paddingHorizontal: 24,
              paddingTop: 88,
              paddingBottom: 16,
              gap: 12
            }}>
      <View style={{
                height: mode ? 240 : 260,
                gap: mode ? 8 : 28,
                alignItems: "center"
              }}><View style={{
                  height: 180,
                  width: "100%",
                  alignItems: "center",
                  justifyContent: "center"
                }}>{mode ? <View style={{
                    width: 200.136,
                    height: 169.003,
                    overflow: "hidden"
                  }}><Image source={require("@/assets/final-flow-20261101/parent-friends.png")} contentFit="fill" style={{
                      position: "absolute",
                      left: 0,
                      top: -.12,
                      width: 200.136,
                      height: 187.02
                    }} /></View> : <Image source={require("@/assets/final-flow-20261101/question-mascot.svg")} style={{
                    width: 146,
                    height: 181
                  }} contentFit="contain" />}</View><FinalText size={18} style={{
                  textAlign: "center"
                }}>{mode ? c("认识聊得来的家长", "Meet parents you connect with") : c("把问题交给有经历的人", "Ask parents who've been there")}</FinalText></View>
      <FinalButton label={mode ? c("寻找育儿好友", "Find parent friends") : c("向家长提问", "Ask parents")} onPress={() => mode ? go("intent") : dispatch({
                type: "newQuestion"
              })} testID={`final-hub-primary-${mode}`} /><FinalDivider />
      {mode ? <><View style={{
                  flexDirection: "row",
                  alignItems: "center"
                }}><Pressable accessibilityRole="button" onPress={() => go("inbox")} style={{
                    flex: 1,
                    minHeight: 44,
                    justifyContent: "center"
                  }} testID="final-open-inbox"><FinalText>{c("我的消息", "My messages")}⌃</FinalText></Pressable><Pressable accessibilityRole="button" accessibilityLabel={c("通讯录", "Address book")} onPress={() => go("contacts")} style={{
                    width: 44,
                    height: 44,
                    alignItems: "center",
                    justifyContent: "center"
                  }} testID="final-open-contacts"><Image source={require("@/assets/final-flow-20261101/address-book.svg")} style={{
                      width: 24,
                      height: 24
                    }} /></Pressable></View>{(["Maya", "Ray"] as const).filter(p=>!state.blocked.includes(p)&&!state.disconnected.includes(p)).map(p => personRow(p, p === "Maya" ? c("好啊！下次我们一起去！", "Sure! Let's go together next time!") : c("周末有空一起去读书角活动吗？", "Free for the reading corner this weekend?"), () => dispatch({
                  type: "person",
                  person: p,
                  screen: "chat"
                })))}</> : <>{([["myQuestions", c("我的问题", "My questions"), c("托育告别总是哭，怎么办？", "Tears at daycare drop-off?"), c("Maya分享了经验", "Maya shared an experience")], ["received", c("收到问题", "Received questions"), c("Dean想听听你的意见", "Dean would like your thoughts"), ""]] as const).map(([screen, label, detail, status], i) => <Pressable key={screen} testID={i ? "final-open-received" : "final-open-my-questions"} accessibilityRole="button" onPress={() => go(screen)} style={s.personRow}><Image source={i ? require("@/assets/final-flow-20261101/received-questions.svg") : require("@/assets/final-flow-20261101/my-questions.svg")} style={{
                    width: 40,
                    height: 40
                  }} contentFit="contain" /><View style={{
                    flex: 1,
                    gap: 3
                  }}><FinalText>{label}</FinalText><FinalText size={14} secondary>{detail}</FinalText>{status ? <FinalText size={12} secondary>{status}</FinalText> : null}</View><FinalText style={{
                    color: FINAL_COLOR.accent
                  }}>›</FinalText></Pressable>)}</>}
    </ScrollView></FinalSurface></View>)}
  </ScrollView><View style={s.dots}>{([0, 1] as const).map(i => <Pressable key={i} accessibilityRole="button" accessibilityLabel={i ? c("育儿好友", "Parent friends") : c("漂流瓶", "Questions")} onPress={() => dispatch({
          type: "page",
          page: i
        })} style={s.dotTarget}><View style={{
            width: 9,
            height: 9,
            borderRadius: 5,
            backgroundColor: state.page === i ? FINAL_COLOR.coral : "rgba(255,255,255,.8)"
          }} /></Pressable>)}</View></View></View>;
  if (["compose", "original", "polished"].includes(state.screen)) return page(<>
        <FinalText size={12} secondary>{c("我的问题", "My question")}</FinalText>
        {(state.screen === "compose" ? ["question"] as const : ["question", "polished"] as const).map(slot => <View key={slot} style={{
      gap: 8
    }}>
          {state.screen !== "compose" ? <Pressable accessibilityRole="radio" accessibilityState={{
        selected: slot === "question" === (state.questionVersion === "original")
      }} onPress={() => dispatch({
        type: "version",
        version: slot === "question" ? "original" : "polished"
      })} testID={slot === "polished" ? "final-question-version" : "final-question-original"} style={s.textTarget}>
            <FinalText style={{
          color: FINAL_COLOR.accent
        }}>{slot === "question" ? c("选择原版", "Use original") : c("选择Nuri润色版", "Use Nuri version")} {slot === "question" === (state.questionVersion === "original") ? "✓" : ""}</FinalText>
          </Pressable> : null}
          <TextInput testID={slot === "question" ? "final-question-input" : "final-polished-input"} multiline value={draft(slot)} onChangeText={text => setDraft(slot, text)} placeholder={c("写下你的问题…", "Write your question…")} placeholderTextColor="#918896" style={[s.editor, {
        height: state.screen === "compose" ? 176 : 128,
        borderColor: slot === "question" === (state.questionVersion === "original") ? FINAL_COLOR.selected : "#DDD2DE"
      }]} />
        </View>)}
        <IconAction name="mic" label={c("语音流程预览", "Preview voice flow")} onPress={() => setVoice(v => !v)} />{localVoice(selectedDraft)}
        {state.screen === "compose" ? <FinalButton secondary label={c("需要润色吗？", "Refine your wording?")} onPress={() => {
      setDraft("polished", draft("question"));
      dispatch({
        type: "version",
        version: "polished"
      });
    }} testID="final-refine-question" /> : <FinalText size={12} secondary>{c("版本选择演示；可编辑两版，不调用AI或声称完成隐私处理。", "Version-selection preview: both drafts are editable; no AI or privacy processing is performed.")}</FinalText>}
        <FinalDivider /><View style={{
      flexDirection: "row",
      gap: 16,
      flexWrap: "wrap"
    }}>{(["showAge", "anonymous"] as const).map(key => <View key={key} style={{
        flexDirection: "row",
        gap: 8,
        alignItems: "center"
      }}><FinalText size={12} secondary>{key === "showAge" ? c("显示孩子年龄", "Show child's age") : c("匿名", "Anonymous")}</FinalText><Switch value={state[key]} onValueChange={() => dispatch({
          type: "toggle",
          key
        })} trackColor={{
          true: FINAL_COLOR.coral,
          false: "#DDD8DF"
        }} /></View>)}</View>
      </>, <FinalButton label={c("预览问题", "Preview question")} disabled={!selectedQuestionText(state)} onPress={() => dispatch({
    type: "previewQuestion"
  })} testID="final-preview-question" />);
  if (state.screen === "preview") return page(<>{questionCard({
      ...question,
      cn: state.questionVersion === "polished" ? draft("polished") || draft("question") : draft("question"),
      en: state.questionVersion === "polished" ? draft("polished") || draft("question") : draft("question")
    })}<View style={s.personRow}><SampleAvatar /><View><FinalText>{c(state.anonymous ? "匿名家长" : "示例家长", state.anonymous ? "Anonymous parent" : "Sample parent")}</FinalText>{state.showAge ? <FinalText size={12} secondary>{c("孩子年龄：示例", "Child's age: sample")}</FinalText> : null}</View></View></>, <View style={s.actionRow}><FinalButton small secondary label={c("返回编辑", "Edit")} onPress={() => go("compose")} /><FinalButton small label={c("发送漂流瓶", "Send bottle")} onPress={() => dispatch({
      type: "sendQuestion"
    })} testID="final-send-question" /></View>);
  if (state.screen === "sending" || state.screen === "sent" || state.screen === "responseSent" || state.screen === "connected" || state.screen === "noMatches") return page(<View style={{
    alignItems: "center",
    gap: 24,
    paddingVertical: 36
  }}>{state.screen === "sending" ? <ActivityIndicator /> : <Image source={require("@/assets/final-flow-20261101/question-mascot.svg")} style={{
      width: 146,
      height: 181
    }} />}<FinalText size={20} style={{
      textAlign: "center"
    }}>{state.screen === "sending" ? c("正在演示发送…", "Simulating send…") : state.screen === "connected" ? c("你们已建立联系", "You're connected in this preview") : state.screen === "noMatches" ? c("暂时没有合适的家长", "No matching parents yet") : c("已在演示中送达", "Shared in this preview")}</FinalText><FinalText secondary>{c("这是本地流程预览，没有向真实家长发送任何内容。", "This is a local flow preview. Nothing was sent to a real parent.")}</FinalText></View>, state.screen === "sending" ? undefined : <FinalButton label={c("继续", "Continue")} onPress={() => go(state.screen === "connected" ? "contacts" : state.screen === "noMatches" ? "suggestions" : state.screen === "responseSent" ? "receivedReplied" : "myQuestions")} />);
  if (state.screen === "myQuestions" || state.screen === "selection" || state.screen === "close" || state.screen === "delete") return <NuriKeyboardFrame><DemoLabel en={en} /><View style={s.main}><View style={s.actionRow}><View style={{
          flex: 1
        }}><Search value={search} onChange={setSearch} placeholder={c("搜索", "Search")} /></View><Pressable accessibilityRole="button" style={s.textTarget} onPress={() => go(state.screen === "selection" ? "myQuestions" : "selection")}><FinalText size={14}>{state.screen === "selection" ? c("取消", "Cancel") : c("选择", "Select")}</FinalText></Pressable></View><FinalText size={12} secondary>{state.questions.length} {c("个漂流瓶", "bottles")}</FinalText><ScrollView testID="final-my-questions-scroll" showsVerticalScrollIndicator={false} contentContainerStyle={{
        gap: 16,
        paddingBottom: 20
      }} style={{
        flex: 1,
        minHeight: 0
      }}>{state.questions.filter(q => questionText(q).toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(q => <View key={q.id}>{state.screen === "selection" ? <Pressable accessibilityRole="checkbox" accessibilityState={{
            checked: state.selected.includes(q.id)
          }} onPress={() => dispatch({
            type: "select",
            id: q.id
          })} style={{
            padding: 4,
            borderRadius: 28,
            borderWidth: state.selected.includes(q.id) ? 2 : 0,
            borderColor: FINAL_COLOR.selected
          }} testID={`final-select-${q.id}`}>{questionCard(q)}</Pressable> : questionCard(q, () => dispatch({
            type: "openQuestion",
            id: q.id
          }))}<FinalText size={12} secondary style={{
            paddingHorizontal: 20,
            marginTop: 8
          }}>{q.closed ? c("已关闭", "Closed") : `${q.replies} ${c("条回复 · 示例", "replies · sample")}`}</FinalText></View>)}</ScrollView>{state.screen === "selection" ? <View style={s.actionRow}><FinalButton small secondary disabled={!state.selected.length} label={c("关闭", "Close")} onPress={() => go("close")} /><FinalButton small disabled={!state.selected.length} label={c("删除", "Delete")} onPress={() => go("delete")} /></View> : null}</View>{state.screen === "close" || state.screen === "delete" ? <Modal transparent animationType="fade" onRequestClose={() => dispatch({
      type: "back"
    })}><BlurView tint="light" intensity={35} style={s.modal}><FinalSurface contentStyle={{
          padding: 24,
          gap: 16
        }}><FinalText size={20}>{state.screen === "close" ? c("关闭这些漂流瓶？", "Close these bottles?") : c("删除这些漂流瓶？", "Delete these bottles?")}</FinalText><FinalText secondary>{c("只影响本次演示中的选中记录，不修改真实数据。", "Only selected records in this preview are affected; no real data is changed.")}</FinalText><View style={s.actionRow}><FinalButton small secondary label={c("取消", "Cancel")} onPress={() => dispatch({
              type: "back"
            })} /><FinalButton small label={c("确认", "Confirm")} onPress={() => dispatch({
              type: "confirmQuestions",
              action: state.screen === "close" ? "close" : "delete"
            })} testID="final-confirm-questions" /></View></FinalSurface></BlurView></Modal> : null}</NuriKeyboardFrame>;
  if (["received", "receivedReplied", "receivedLocked"].includes(state.screen)) return <NuriKeyboardFrame><DemoLabel en={en} /><View style={s.main}><View style={s.segment}>{(["waiting", "replied", "locked"] as const).map((tab, i) => <Pressable key={tab} onPress={() => dispatch({
          type: "receivedTab",
          tab
        })} accessibilityRole="tab" accessibilityState={{
          selected: state.receivedTab === tab
        }} testID={`final-received-${tab}`} style={{
          flex: 1,
          minHeight: 44,
          borderRadius: 24,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: state.receivedTab === tab ? FINAL_COLOR.selected : "transparent"
        }}><FinalText style={{
            color: state.receivedTab === tab ? "white" : FINAL_COLOR.secondary
          }}>{c(["待回复", "已回复", "已锁定"][i], ["To reply", "Replied", "Locked"][i])}</FinalText></Pressable>)}</View><ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{
        gap: 12,
        paddingBottom: 20
      }}>{state.incoming.filter(q => q.status === state.receivedTab).map((q, i) => <FinalSurface key={q.id} contentStyle={{
          padding: 12,
          gap: 12
        }}><View style={s.personRow}><SampleAvatar size={32} /><View style={{
              flex: 1
            }}><FinalText>{i ? "Maya" : c("匿名家长", "Anonymous parent")}</FinalText><FinalText size={12} secondary>{c("孩子年龄：示例", "Child's age: sample")}</FinalText></View><Pressable style={s.textTarget} onPress={() => {
              dispatch({
                type: "openReceived",
                id: q.id
              });
            }}><FinalText size={12} secondary>{c("查看", "View")}</FinalText></Pressable></View>{questionCard(q, () => {
            dispatch({
              type: "openReceived",
              id: q.id
            });
          })}</FinalSurface>)}</ScrollView></View></NuriKeyboardFrame>;
  if (["replies", "comments", "replyExpanded", "replyDetail", "replyKeyboard", "respond"].includes(state.screen)) {
    const responding = state.screen === "respond",
      detail = state.screen === "replyDetail" || state.screen === "replyKeyboard" || state.screen === "replyExpanded",
      slot = responding ? `answer:${state.questionID}` : `comment:${state.questionID}:${state.replyTarget}`;
    return <NuriKeyboardFrame><DemoLabel en={en} /><View style={s.main}>{!detail && question ? questionCard(question) : null}<FinalSurface fill={!["replyDetail", "replyKeyboard", "respond"].includes(state.screen)} contentStyle={{
          padding: 20,
          gap: 12
        }} testID={`final-community-${state.screen}`}><ScrollView style={{
            flexShrink: 1
          }} contentContainerStyle={{
            gap: 16
          }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">{receipt}{responding ? <FinalText size={12} secondary>{c("我的经验", "My experience")}</FinalText> : <><FinalText size={12} secondary>{incomingQuestion ? c("我的经验", "My experience") : detail ? c("家长的经验", "A parent’s experience") : c("收到家长的经验", "Experiences from sample parents")}</FinalText>{(detail ? answerRows.slice(answerIndex, answerIndex + 1) : answerRows).map((answer, i) => <View key={i} style={{
                gap: 12
              }}><View style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8
                }}><SampleAvatar size={36} /><FinalText style={{
                    flex: 1
                  }}>{incomingQuestion ? c("我的回复", "My reply") : (detail ? answerIndex : i) ? c("匿名家长", "Anonymous parent") : "Maya"}</FinalText>{!detail && !question?.closed && !incomingQuestion ? <Pressable style={s.textTarget} onPress={() => dispatch({
                    type: "replyTarget",
                    target: i ? "anonymous" : "Maya"
                  })}><FinalText size={12} secondary>{c("回复 ›", "Reply ›")}</FinalText></Pressable> : null}</View><FinalText>{c(answer[0], answer[1])}</FinalText><FinalDivider /></View>)}</>}{state.comments.filter(comment => comment.questionID === state.questionID).map((comment, i) => <View key={i} style={{
              gap: 8
            }}><FinalText size={12} secondary>{c("你的演示回复", "Your preview reply")}</FinalText><FinalText>{comment.text}</FinalText></View>)}</ScrollView>{detail || responding ? editor(slot, c("写下你的回复…", "Write your reply…")) : <><View style={s.actionRow}><FinalText size={12} secondary style={{
                flex: 1
              }}>{question?.closed ? c("此问题已关闭", "This question is closed") : c("回复所有人", "Reply to everyone")}</FinalText><IconAction name="expand" disabled={question?.closed} label={c("展开回复", "Expand reply")} onPress={() => dispatch({
                type: "replyTarget",
                target: "all",
                expanded: true
              })} /></View><NuriComposer disabled={question?.closed} value={draft(slot)} onChangeText={text => setDraft(slot, text)} onSend={() => dispatch({
              type: "sendComment"
            })} onAttach={() => setAttachment(true)} onMic={() => setVoice(v => !v)} placeholder={c("写下回复…", "Write a reply…")} testID="final-comment" />{localVoice(slot)}</>}</FinalSurface></View>{attachment ? <Modal transparent onRequestClose={() => setAttachment(false)}><BlurView intensity={30} tint="light" style={s.modal}><FinalSurface contentStyle={s.body}><FinalText>{c("图片流程预览", "Image flow preview")}</FinalText><FinalText secondary>{c("仅展示附件流程，不读取相册、不上传图片。", "Attachment preview only. No photos are read or uploaded.")}</FinalText><FinalButton label={c("返回草稿", "Return to draft")} onPress={() => setAttachment(false)} /></FinalSurface></BlurView></Modal> : null}</NuriKeyboardFrame>;
  }
  if (state.screen === "inbox" || state.screen === "contacts" || state.screen === "invitations") return page(<><Search value={search} onChange={setSearch} placeholder={c("搜索", "Search")} />{state.screen === "contacts" ? <><Pressable onPress={() => go("invitations")} accessibilityRole="button" style={s.personRow} testID="final-new-connections"><View style={{
          flex: 1
        }}><FinalText>{c("新的联系", "New connections")} ⁴</FinalText><FinalText size={12} secondary>{c("查看请求与回应", "View requests and responses")}</FinalText></View><FinalText>›</FinalText></Pressable><FinalDivider /></> : state.screen === "inbox" ? <View style={s.actionRow}><FinalText style={{
        flex: 1
      }}>{c("我的消息", "My messages")}</FinalText><IconAction name="person" label={c("好友列表", "Friends")} onPress={() => go("contacts")} /></View> : null}{(state.screen === "invitations" ? ["Sonya", "Robin", "Dean", "Maya", "Maria"] as const : state.screen === "contacts" ? state.contacts : ["Maya", "Ray", "Dean", "Robin", "Maria", "Zoe"] as const).filter(p => !state.blocked.includes(p) && !state.disconnected.includes(p) && p.toLowerCase().includes(search.toLowerCase())).map((p, i) => <View key={p}>{state.screen === "invitations" && (i === 0 || i === 2 || i === 3) ? <FinalText size={14}>{i === 0 ? c("收到的邀请 2", "Received invitations 2") : i === 2 ? c("发出的邀请 1", "Sent invitations 1") : c("已建立联系 2", "Connected 2")}</FinalText> : null}{personRow(p, state.screen === "invitations" ? i < 2 ? c("邀请你建立联系 · 待你通过", "Invited you · Awaiting your response") : i === 2 ? c("邀请已发出 · 等待通过", "Invitation sent · Pending") : c("已建立联系", "Connected") : c("好啊！下次我们一起去！", "Sure! Let's go together next time!"), () => dispatch({
        type: "person",
        person: p,
        screen: state.screen === "invitations" ? "parent" : "chat"
      }))}<FinalDivider /></View>)}</>, undefined, true);
  if (state.screen === "intent") return page(<><Pressable accessibilityRole="button" style={[s.textTarget, {
      alignSelf: "flex-end"
    }]} onPress={() => go("profile")}><FinalText size={14} secondary>{c("跳过", "Skip")}</FinalText></Pressable><FinalText style={{
      textAlign: "center",
      marginBottom: 32
    }}>{c("你希望和新朋友一起", "With new friends, you'd like to…")}</FinalText>{[["交流育儿智慧", "Share parenting ideas"], ["聊聊育儿心事", "Talk about parenting"], ["与我经历相似", "Meet someone with similar experiences"], ["和我一起遛娃", "Enjoy outings with children"], ["在我附近", "Meet nearby parents"], ["随便聊聊", "Have a chat"]].map(([cn, english], i) => <Pressable key={i} onPress={() => dispatch({
      type: "intent",
      index: i
    })} accessibilityRole="checkbox" accessibilityState={{
      checked: state.intents.includes(i)
    }} style={{
      minHeight: 48,
      borderRadius: 24,
      width: 248,
      maxWidth: "100%",
      alignSelf: "center",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: state.intents.includes(i) ? FINAL_COLOR.selected : "rgba(255,248,242,.75)",
      paddingHorizontal: 12,
      boxShadow: "0px 1px 4px rgba(0,0,0,.15)"
    }}><FinalText size={14} style={{
        color: state.intents.includes(i) ? "white" : FINAL_COLOR.ink,
        textAlign: "center"
      }}>{c(cn, english)}</FinalText></Pressable>)}<FinalText size={12} secondary style={{
      textAlign: "center"
    }}>{c("多选", "Choose any that fit")}</FinalText></>, <FinalButton label={c("下一步", "Next")} onPress={() => go("profile")} />);
  if(state.screen==="profile"&&profileEditing)return page(<>
    <SettingsField label={c("称呼","Name")} value={state.drafts["profile:name"]??"Nina"} onChangeText={text=>setDraft("profile:name",text)} testID="final-profile-name"/>
    <SettingsField label={c("居住城市","City")} value={state.drafts["profile:city"]??"Savannah, GA, 31401"} onChangeText={text=>setDraft("profile:city",text)}/>
    <SettingsField label={c("关于我","About me")} multiline style={{height:120,paddingTop:14}} value={draft("profile:about")} onChangeText={text=>setDraft("profile:about",text)}/>
    <FinalText size={12} secondary>{c("编辑示例档案，不修改真实个人资料。","Edit the sample profile only, not real personal information.")}</FinalText>
  </>,<FinalButton label={c("保存","Save")} disabled={!(state.drafts["profile:name"]??"Nina").trim()} onPress={()=>setProfileEditing(false)} testID="final-profile-save"/>);
  if (state.screen === "profile" || state.screen === "parent") return page(<>
    {state.screen==="profile"?<Pressable accessibilityRole="button" style={[s.textTarget,{alignSelf:"flex-end"}]} onPress={()=>setProfileEditing(true)} testID="final-profile-edit"><FinalText size={12} secondary>{c("编辑","Edit")}</FinalText></Pressable>:null}<View style={s.personRow}><SampleAvatar size={104} /><View style={{
        flex: 1,
        gap: 4
      }}><FinalText size={32} style={{
          lineHeight: 42,
          fontWeight: "500"
        }}>{state.screen === "profile" ? draft("profile:name")||"Nina" : state.person}</FinalText><FinalText size={14} secondary>{state.screen === "profile" ? draft("profile:city")||"Savannah, GA, 31401" : c("约1.5英里", "About 1.5 miles")}</FinalText><FinalText size={14} secondary>{c("喜欢散步、绘本和亲子活动", "Walks, picture books and family activities")}</FinalText></View></View><FinalDivider /><FinalText size={20}>{state.screen === "profile" ? c("我的生活", "My life") : c("你们的共同点", "What you have in common")}</FinalText><View style={s.actionRow}><View style={{
        flex: 1
      }}><FinalText>{c("孩子年龄相近", "Children of similar ages")}</FinalText><FinalText size={12} secondary>{c("正在经历学龄前阶段", "At the preschool stage")}</FinalText></View><View style={{
        flex: 1
      }}><FinalText>{c("周末节奏相似", "Similar weekends")}</FinalText><FinalText size={12} secondary>{c("喜欢安静的周末活动", "Relaxed weekend activities")}</FinalText></View></View><FinalDivider /><FinalText>{state.screen === "profile" ? c("关于我", "About me") : c("关于对方", "About this parent")}</FinalText><FinalText>{state.screen==="profile"&&draft("profile:about")?draft("profile:about"):c("希望认识附近的家长，周末可以一起带孩子散步。", "I'd like to meet nearby parents for weekend walks with our children.")}</FinalText>{state.screen === "parent" ? <><FinalButton disabled={state.blocked.includes(state.person)} label={c("建立联系", "Connect")} onPress={() => dispatch({
        type: "connect"
      })} /><FinalButton secondary label={c("稍后再说", "Maybe later")} onPress={() => dispatch({
        type: "back"
      })} /></> : null}</>, state.screen === "profile" ? <FinalButton label={c("下一步", "Next")} onPress={() => go("suggestions")} /> : undefined);
  if (state.screen === "suggestions") return <NuriKeyboardFrame><DemoLabel en={en} /><View style={s.main}>
      <View style={s.actionRow}>{(["gender", "distance"] as const).map(key => <Pressable key={key} accessibilityRole="button" onPress={() => setFilter(filter === key ? null : key)} style={[s.textTarget, {
          backgroundColor: "rgba(255,255,255,.6)",
          borderRadius: 24,
          paddingHorizontal: 16
        }]}><FinalText size={12} secondary>{key === "gender" ? c("性别", "Gender") : c("距离", "Distance")} · {filterLabels[key][state.filters[key]]} ⌄</FinalText></Pressable>)}</View>
      {filter ? <FinalSurface contentStyle={s.body}>{filterLabels[filter].map((label, index) => <Pressable key={label} accessibilityRole="radio" accessibilityState={{
          selected: state.filters[filter] === index
        }} onPress={() => {
          dispatch({
            type: "filter",
            key: filter,
            index
          });
          setFilter(null);
        }} style={s.textTarget}><FinalText>{label}{state.filters[filter] === index ? " ✓" : ""}</FinalText></Pressable>)}</FinalSurface> : null}
      <FinalSurface fill><ScrollView style={{
          flex: 1
        }} contentContainerStyle={{
          padding: 12,
          gap: 12
        }} showsVerticalScrollIndicator={false}>
        {suggestions.map(p => <Pressable key={p} onPress={() => dispatch({
            type: "person",
            person: p,
            screen: "parent"
          })} testID={`final-suggestion-${p}`}><FinalSurface contentStyle={{
              padding: 12,
              flexDirection: "row",
              gap: 16,
              alignItems: "center"
            }}><SampleAvatar size={112} /><View style={{
                flex: 1,
                gap: 10
              }}><FinalText size={18}>{p}</FinalText><FinalText>{c("孩子同龄，周末合拍", "Similar child ages and weekends")}</FinalText><FinalText size={12} secondary>{c("你们都喜欢 / 咖啡、徒步", "Shared interests / Coffee, hiking")}</FinalText></View></FinalSurface></Pressable>)}
        {!suggestions.length ? <FinalText secondary>{c("暂时没有合适的家长", "No matching parents yet")}</FinalText> : null}
        <FinalButton secondary label={c("查看无匹配状态", "Preview no-match state")} onPress={() => go("noMatches")} />
      </ScrollView></FinalSurface>
    </View></NuriKeyboardFrame>;
  const chatSlot = `chat:${state.person}`;
  return <NuriKeyboardFrame><DemoLabel en={en} /><View style={{
      paddingHorizontal: 24,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 16,
      minHeight: 44
    }}><IconAction name="settings" label={c("对话设置", "Conversation settings")} onPress={() => go("parentSettings")} testID="final-parent-settings" /><FinalText size={12} secondary>{state.ai[state.person] ? c("Nuri参与中（演示）", "Nuri participating (preview)") : c("Nuri未参与", "Nuri not participating")}</FinalText><Switch testID="final-parent-ai-toggle" value={!!state.ai[state.person]} onValueChange={value => dispatch({
        type: value ? "requestConsent" : "disableAI"
      })} trackColor={{
        true: FINAL_COLOR.coral,
        false: "#DFDCE5"
      }} /></View><ScrollView ref={messages} onContentSizeChange={() => messages.current?.scrollToEnd({
      animated: false
    })} onLayout={() => messages.current?.scrollToEnd({
      animated: false
    })} keyboardShouldPersistTaps="handled" style={{
      flex: 1,
      minHeight: 0
    }} contentContainerStyle={{
      padding: 24,
      gap: 20
    }} testID="final-parent-chat-scroll">{[c("刚才我们聊到宝宝的睡眠。最近有什么新的变化吗？", "We were talking about your child's sleep. Has anything changed?"), c("最近哄睡要一个多小时，放下后也容易醒。", "Settling takes over an hour, and they wake after being put down."), c("听起来，这几晚你也很辛苦。可以说说昨晚是怎么哄睡的吗？", "That sounds exhausting. What was settling like last night?")].map((text, i) => <View key={i} style={{
        flexDirection: i % 2 ? "row-reverse" : "row",
        gap: 8,
        alignItems: "flex-end"
      }}><SampleAvatar size={32} /><FinalSurface style={{
          maxWidth: "84%"
        }} contentStyle={{
          padding: 16,
          backgroundColor: i % 2 ? "rgba(235,129,131,.15)" : "transparent"
        }}><FinalText>{text}</FinalText></FinalSurface></View>)}{state.messages.filter(m => m.person === state.person).map((m, i) => <FinalSurface key={i} style={{
        alignSelf: "flex-end",
        maxWidth: "84%"
      }} contentStyle={{
        padding: 16,
        backgroundColor: "rgba(235,129,131,.15)"
      }}><FinalText>{m.text}</FinalText></FinalSurface>)}{receipt}</ScrollView><View style={{
      padding: 24,
      paddingTop: 8,
      gap: 8
    }}>{attachment ? <FinalSurface contentStyle={{
        padding: 16,
        gap: 12
      }}><FinalText size={12} secondary>{c("示例附件 · 不读取相册、不上传", "Sample attachment · No photo access or upload")}</FinalText><FinalButton secondary label={c("移除附件", "Remove attachment")} onPress={() => setAttachment(false)} /></FinalSurface> : null}{voice ? localVoice(chatSlot) : <NuriComposer disabled={state.blocked.includes(state.person)||state.disconnected.includes(state.person)} value={draft(chatSlot)} onChangeText={text => setDraft(chatSlot, text)} onSend={() => dispatch({
        type: "sendMessage"
      })} onAttach={() => setAttachment(true)} onMic={() => setVoice(true)} placeholder={c("聊聊最近的活动吧…", "Talk about recent activities…")} testID="final-parent" />}</View>{state.screen === "consent" ? <Modal transparent animationType="fade" onRequestClose={() => dispatch({
      type: "confirmConsent",
      allowed: false
    })}><BlurView intensity={35} tint="light" style={s.modal}><FinalSurface contentStyle={{
          padding: 24,
          gap: 16
        }}><FinalText size={20}>{c("允许Nurry记录本次对话？", "Allow Nurry to record this conversation?")}</FinalText><FinalText size={14} secondary>{c("对方邀请Nurry记录这次对话。同意后，Nurry会记录聊天内容，并整理对话要点。双方都可以随时关闭记录。", "The other parent invited Nurry to record this conversation and organise its key points. Either person can turn it off at any time.")}</FinalText><FinalText size={12} secondary>{c("本次为同意流程演示，不保存真实同意、不启动记录。", "Consent-flow preview only. No real consent is saved and recording does not start.")}</FinalText><View style={s.actionRow}><FinalButton small secondary label={c("暂不同意", "Not now")} onPress={() => dispatch({
              type: "confirmConsent",
              allowed: false
            })} /><FinalButton small label={c("同意开启", "Allow")} onPress={() => dispatch({
              type: "confirmConsent",
              allowed: true
            })} testID="final-parent-consent-agree" /></View></FinalSurface></BlurView></Modal> : null}</NuriKeyboardFrame>;
}
const s = StyleSheet.create({
  main: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 16
  },
  body: {
    padding: 24,
    gap: 16
  },
  actions: {
    marginTop: "auto",
    paddingTop: 16,
    paddingBottom: 8,
    gap: 12
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12
  },
  personRow: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingVertical: 8
  },
  dots: {
    height: 28,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center"
  },
  dotTarget: {
    minWidth: 44,
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center"
  },
  editor: {
    height: 144,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#DDD2DE",
    padding: 16,
    paddingTop: 16,
    fontSize: 16,
    lineHeight: 24,
    color: FINAL_COLOR.ink,
    backgroundColor: "rgba(255,250,244,.6)",
    textAlignVertical: "top"
  },
  textTarget: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center"
  },
  segment: {
    flexDirection: "row",
    borderRadius: 24,
    padding: 4,
    backgroundColor: "rgba(255,255,255,.7)"
  },
  modal: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(255,250,244,.15)"
  }
});
