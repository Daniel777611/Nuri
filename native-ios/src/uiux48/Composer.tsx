import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { InputAccessoryView, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useT, translate } from "@/src/i18n";
import { useNuriTheme } from "./Theme";
import { NuriText } from "./Primitives";
import { compactComposerTextWidth, composerLayout } from "./composerLayout";
import { FinalSurface, FinalText } from "@/src/uiuxfinal/Primitives";

const composerAssets = {
  plus: require("@/assets/final-flow-20261101/plus.svg"),
  mic: require("@/assets/final-flow-20261101/microphone.svg"),
  send: require("@/assets/final-flow-20261101/send.svg"),
  expand: require("@/assets/final-flow-20261101/composer-expand-20.svg"),
  collapse: require("@/assets/final-flow-20261101/composer-collapse-20.svg"),
  emptyPlus: require("@/assets/final-flow-20261101/composer-plus-24.svg"),
  emptyMic: require("@/assets/final-flow-20261101/composer-microphone-24.svg"),
};
/** Artwork retains its exported20/24pt root;44pt is the interaction target. */
function ComposerAction({name,label,onPress,disabled,testID,empty=false}:{name:"plus"|"mic"|"expand"|"collapse";label:string;onPress:()=>void;disabled?:boolean;testID:string;empty?:boolean}) {
  const size=empty?24:20;
  const source=empty&&name==="plus"?composerAssets.emptyPlus:empty&&name==="mic"?composerAssets.emptyMic:composerAssets[name];
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled:!!disabled}} onPress={onPress} disabled={disabled} testID={testID} style={({pressed})=>[s.actionTarget,{opacity:disabled?.4:pressed?.6:1}]}><Image source={source} style={{width:size,height:size}} contentFit="contain" accessible={false} accessibilityElementsHidden /></Pressable>;
}

export function NuriComposer({ value, onChangeText, onSend, onAttach, onMic, disabled, busy, recording, inputRef, onFocus, onBlur, testID = "chat", placeholder, hasAttachment = false, availableHeight }: { value: string; onChangeText: (s:string)=>void; onSend:()=>void; onAttach:()=>void; onMic:()=>void; disabled?:boolean; busy?:boolean; recording?:boolean; inputRef?:RefObject<TextInput|null>; onFocus?:()=>void; onBlur?:()=>void; testID?:string; placeholder?:string; hasAttachment?:boolean; availableHeight?:number }) {
  const [height,setHeight] = useState(24);
  const [roomy,setRoomy] = useState(false);
  const [width,setWidth] = useState(0);
  const [textMeasure,setTextMeasure] = useState<{value:string;width:number;fontScale:number;wraps:boolean}|null>(null);
  const currentMeasure = useRef({value:"",width:0,fontScale:1});
  const [modalKeyboardVisible,setModalKeyboardVisible] = useState(false);
  const wrapLength = useRef<number|null>(null);
  const [expanded,setExpanded] = useState(false);
  const [focused,setFocused] = useState(false);
  const localInput = useRef<TextInput>(null);
  const compactRef = inputRef ?? localInput;
  const expandedInput = useRef<TextInput>(null);
  const dismissAfterModal = useRef(false);
  const pendingMedia = useRef<(() => void) | null>(null);
  const mediaDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const t=useNuriTheme(); const {locale}=useT(); const safe=useSafeAreaInsets(); const en=locale==="en";
  const window = useWindowDimensions();
  const fontScale=Number.isFinite(window.fontScale)&&window.fontScale>0?window.fontScale:1;
  const layout=composerLayout(fontScale,availableHeight??Math.max(0,window.height-safe.top-safe.bottom));
  const minInputHeight=layout.lineHeight;
  // RN-web has no onTextLayout implementation; keep its working input-size
  // path, and use this independent native measurement only for iOS.
  const measureWidth=Platform.OS==="ios"?compactComposerTextWidth(width,!!value.trim()||hasAttachment):0;
  currentMeasure.current={value,width:measureWidth,fontScale};
  const measuredWrap=textMeasure?.value===value&&textMeasure.width===measureWidth&&textMeasure.fontScale===fontScale?textMeasure.wraps:null;
  const automaticPanel=!!value.length&&layout.roomyAllowed&&(value.includes("\n")||(measuredWrap??(roomy||height>minInputHeight+1)));
  const sendVisible=!!value.trim()||hasAttachment;
  const emptyMode=!value.length&&!hasAttachment;
  const compactHeight=automaticPanel?layout.roomyInputHeight:minInputHeight;
  const compactFrameHeight=Math.max(60,minInputHeight+16);
  const accessoryId=`nuri-composer-${useId()}`;
  const resetAutomatic=()=>{wrapLength.current=null;setRoomy(false);setHeight(minInputHeight);setTextMeasure(null);};
  useEffect(()=>{
    if(!value.length||(!measureWidth&&wrapLength.current!==null&&value.length<wrapLength.current&&!value.includes("\n")))resetAutomatic();
  },[value,minInputHeight,measureWidth]);
  useEffect(()=>{
    if(!expanded||Platform.OS==="web")return;
    setModalKeyboardVisible(Keyboard.isVisible());
    const show=()=>setModalKeyboardVisible(true),hide=()=>setModalKeyboardVisible(false);
    const listeners=[Keyboard.addListener("keyboardWillShow",show),Keyboard.addListener("keyboardDidShow",show),Keyboard.addListener("keyboardWillHide",hide),Keyboard.addListener("keyboardDidHide",hide)];
    return()=>listeners.forEach(listener=>listener.remove());
  },[expanded]);
  const changeText=(next:string)=>{
    if(!next.length||(!measureWidth&&wrapLength.current!==null&&next.length<wrapLength.current&&!next.includes("\n")))resetAutomatic();
    onChangeText(next);
  };
  const expand=()=>{dismissAfterModal.current=false;setExpanded(true);};
  const blurAndDismiss=()=>{compactRef.current?.blur();expandedInput.current?.blur();Keyboard.dismiss();};
  const done=()=>{dismissAfterModal.current=expanded;blurAndDismiss();setExpanded(false);setFocused(false);};
  const onExpandedDismiss=()=>{
    // iOS restores the presenting field's focus when its Modal disappears.
    // Honour Done again after that restoration, without clearing the draft.
    if(dismissAfterModal.current){dismissAfterModal.current=false;blurAndDismiss();setFocused(false);}
    const action=pendingMedia.current;
    pendingMedia.current=null;
    if(mediaDismissTimer.current){clearTimeout(mediaDismissTimer.current);mediaDismissTimer.current=null;}
    action?.();
  };
  useEffect(()=>()=>{if(mediaDismissTimer.current)clearTimeout(mediaDismissTimer.current);pendingMedia.current=null;},[]);
  const openMedia=(action:()=>void,large:boolean)=>{
    if(disabled||busy)return;
    if(!large){action();return;}
    if(pendingMedia.current)return;
    // Close the expanded native Modal before presenting the system photo
    // picker or starting inline dictation on the underlying conversation.
    pendingMedia.current=action;
    blurAndDismiss();setFocused(false);setExpanded(false);
    if(Platform.OS==="web")onExpandedDismiss(); // Preserve the browser user gesture.
    else if(Platform.OS==="android")mediaDismissTimer.current=setTimeout(onExpandedDismiss,350);
  };
  const send=()=>{if(disabled||busy||recording||(!value.trim()&&!hasAttachment))return false;onSend();return true;};
  const input=(large=false)=><TextInput
    ref={large?expandedInput:compactRef} value={value} onChangeText={changeText}
    // Keep UIKit's caret scrolling enabled even before the asynchronous JS
    // content-size measurement arrives. Disabling it for short drafts can
    // strand the second line outside a still-one-line native viewport.
    multiline scrollEnabled editable={!disabled&&!busy}
    keyboardAppearance={t.keyboard.appearance}
    placeholder={placeholder??(en?"Say something to Nuri…":translate(locale, "和 Nuri 说点什么…"))}
    placeholderTextColor={t.secondary}
    onFocus={()=>{setFocused(true);onFocus?.();}} onBlur={()=>{setFocused(false);onBlur?.();}}
    // The expanded field fills its own keyboard-safe viewport; its measurements must
    // not change the compact field when the modal is collapsed.
    onContentSizeChange={large?undefined:e=>{
      if(measuredWrap!==null)return; // Native Text layout is authoritative.
      const measured=e.nativeEvent.contentSize.height;
      if(Number.isFinite(measured)&&measured>0){
        setHeight(Math.ceil(measured));
        if(value.length&&measured>minInputHeight+1&&!roomy){wrapLength.current=value.length;setRoomy(true);}
      }
    }}
    inputAccessoryViewID={Platform.OS==="ios"?(large?accessoryId+"-expanded":accessoryId):undefined}
    style={[s.input,{height:large?undefined:compactHeight,color:t.ink,fontFamily:locale==="zh-CN"?"NotoSansSC_400Regular":undefined,fontWeight:"400",textAlignVertical:large||automaticPanel?"top":"center",...(Platform.OS==="web"?{outlineWidth:0,outlineStyle:"solid" as const,outlineColor:"transparent"}:{})},large?s.fullInput:null]}
    testID={`${testID}-${large?"expanded-":""}input`} accessibilityLabel={en?"Message to Nuri":translate(locale, "给 Nuri 的消息")}
    accessibilityActions={[{name:"expand",label:en?"Expand composer":translate(locale,"展开输入")}]} onAccessibilityAction={e=>{if(e.nativeEvent.actionName==="expand"&&!large)expand();}}
  />;
  const controls=(large=false)=>{
    const prefix=`${testID}${large?"-expanded":""}`;
    const panel=large||automaticPanel;
    return <>
      {panel?<ComposerAction name="plus" label={en?"Camera or upload photo":translate(locale, "拍照或上传图片")} onPress={()=>openMedia(onAttach,large)} disabled={disabled||busy} testID={`${prefix}-attach`} />:null}
      <ComposerAction name="mic" empty={!panel&&emptyMode} label={recording?(en?"Stop recording":translate(locale, "停止录音")):(en?"Record a voice message":translate(locale, "录音"))} onPress={()=>openMedia(onMic,large)} disabled={disabled||busy} testID={`${prefix}-mic`} />
      {panel?<View pointerEvents="none" style={{flex:1}} />:null}
      {sendVisible?<Pressable onPress={()=>{if(send()&&large)setExpanded(false);}} disabled={disabled||busy||recording} style={({pressed})=>[s.send,{opacity:disabled||busy||recording?.4:pressed?.6:1}]} testID={`${prefix}-send-btn`} accessibilityRole="button" accessibilityState={{disabled:!!(disabled||busy||recording),busy:!!busy}} accessibilityLabel={en?"Send":translate(locale, "发送")}>
        {busy?<NuriText>…</NuriText>:<Image source={composerAssets.send} style={{width:20,height:20}} contentFit="contain" accessible={false} accessibilityElementsHidden />}
      </Pressable>:null}
    </>;
  };
  const keyboardAccessory=(large=false)=>{
    const id=large?accessoryId+"-expanded":accessoryId;
    const content=<View style={[s.accessory,{width:window.width}]} testID={`${testID}-${large?"expanded-":""}keyboard-panel`}>
      <Pressable onPress={done} style={s.doneTarget} accessibilityRole="button" accessibilityLabel={en?"Done":translate(locale, "完成")} testID={`${testID}-${large?"expanded-":""}keyboard-done`}>
        <NuriText style={{fontSize:15,lineHeight:22,fontWeight:"600",color:t.keyboard.ink}}>{en?"Done":translate(locale, "完成")}</NuriText>
      </Pressable>
    </View>;
    // The shell supplies one continuous panel behind this accessory and the
    // system keyboard, using the real keyboard frame rather than an overlay
    // drawn over native keys or predictive suggestions.
    return <InputAccessoryView nativeID={id}>{content}</InputAccessoryView>;
  };
  return <View style={s.container} onLayout={e=>{const next=e.nativeEvent.layout.width;if(Number.isFinite(next)&&next>0)setWidth(old=>old===next?old:next);}}>
    <View style={automaticPanel?undefined:{flexDirection:"row",gap:emptyMode?14:16,alignItems:"center",...(emptyMode?{marginLeft:3,marginRight:5}:null)}}>
    {!automaticPanel?<FinalSurface radius={999} surfaceColor="rgba(255,250,242,.64)" style={{width:60,height:60,flexShrink:0}} contentStyle={{height:60,alignItems:"center",justifyContent:"center"}}><ComposerAction name="plus" empty={emptyMode} label={en?"Camera or upload photo":translate(locale, "拍照或上传图片")} onPress={()=>openMedia(onAttach,false)} disabled={disabled||busy} testID={`${testID}-attach`} /></FinalSurface>:null}
    <FinalSurface radius={automaticPanel?24:999} surfaceColor="rgba(255,250,242,.64)" style={[s.surface,automaticPanel?null:{flex:1,minWidth:0}]} contentStyle={[s.compactCard,automaticPanel?s.roomyCard:null]} testID={`${testID}-composer`}>
      {automaticPanel?<View style={s.editorHeader} testID={`${testID}-editor-header`}><View pointerEvents="none" style={{flex:1}}/><ComposerAction name="expand" label={en?"Expand composer":translate(locale,"展开输入")} onPress={expand} testID={`${testID}-expand`} /></View>:null}
      <View testID={`${testID}-editor-region`} style={[s.editor,automaticPanel?s.roomyEditor:{height:compactFrameHeight,paddingLeft:emptyMode?22:20,paddingRight:sendVisible?108:50}]}>
        {input()}
      </View>
      <View pointerEvents="box-none" style={[s.actions,automaticPanel?null:[s.inlineActions,{left:undefined,right:emptyMode?6:8,gap:sendVisible?6:0}]]} testID={`${testID}-actions`}>{controls()}</View>
    </FinalSurface>
    </View>
    {measureWidth>0&&value.length>0?<Text
      // Fabric iOS emits TextInput content-size changes during layout, not
      // reliably on each edit of a fixed-height scrolling input. Measure the
      // same draft with native Text instead; never estimate from characters.
      key={`${fontScale}:${measureWidth}:${value}`} testID={`${testID}-wrap-measure`}
      pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      numberOfLines={2} ellipsizeMode="clip" style={[s.measure,{width:measureWidth,fontFamily:locale==="zh-CN"?"NotoSansSC_400Regular":undefined,fontWeight:"400"}]}
      onTextLayout={e=>{
        const current=currentMeasure.current;
        if(current.value!==value||current.width!==measureWidth||current.fontScale!==fontScale||!e.nativeEvent.lines.length)return;
        const wraps=value.includes("\n")||e.nativeEvent.lines.length>1;
        setTextMeasure(old=>old?.value===value&&old.width===measureWidth&&old.fontScale===fontScale&&old.wraps===wraps?old:{value,width:measureWidth,fontScale,wraps});
        setRoomy(wraps);setHeight(wraps?2*minInputHeight:minInputHeight);wrapLength.current=wraps?value.length:null;
      }}
    >{value}</Text>:null}
    <Modal visible={expanded} transparent animationType="slide" onRequestClose={done} onDismiss={onExpandedDismiss} onShow={()=>expandedInput.current?.focus()}>
      <KeyboardAvoidingView behavior={Platform.OS==="ios"?"padding":"height"} style={[s.modal,{paddingTop:Platform.OS==="web"?62:safe.top}]}>
       <View style={[s.modalViewport,{paddingBottom:modalKeyboardVisible?12:Math.max(safe.bottom,27)}]} testID={`${testID}-expanded-viewport`}>
        <FinalSurface fill radius={24} surfaceColor="rgba(255,250,242,.64)" contentStyle={s.expandedCard} style={{width:"100%",maxWidth:600,alignSelf:"center",flex:1,minHeight:0}} testID={`${testID}-expanded-composer`}>
          <View style={s.editorHeader} testID={`${testID}-expanded-header`}><FinalText size={16} style={{flex:1}}>{en?"Edit message":translate(locale,"编辑消息")}</FinalText><ComposerAction name="collapse" label={en?"Collapse composer":translate(locale,"收起输入")} onPress={()=>setExpanded(false)} testID={`${testID}-expanded-done`} /></View>
          <View style={s.expandedText}>
            {input(true)}
          </View>
          <View style={s.actions}>{controls(true)}</View>
        </FinalSurface>
       </View>
      </KeyboardAvoidingView>
      {Platform.OS==="ios"&&expanded?keyboardAccessory(true):null}
    </Modal>
    {Platform.OS==="ios"&&!expanded?keyboardAccessory():null}
  </View>;
}
const inputTypography={fontSize:16,lineHeight:24,paddingVertical:0,paddingHorizontal:0};
const s=StyleSheet.create({
  container:{flexShrink:0},
  surface:{flexShrink:0},
  compactCard:{padding:0,flexShrink:0},
  roomyCard:{paddingHorizontal:16,paddingVertical:12,gap:8},
  editorHeader:{height:44,flexShrink:0,flexDirection:"row",alignItems:"center",width:"100%"},
  editor:{minHeight:44,justifyContent:"center"},
  roomyEditor:{minHeight:0,position:"relative"},
  actions:{height:44,flexShrink:0,flexDirection:"row",alignItems:"center"},
  inlineActions:{position:"absolute",top:"50%",transform:[{translateY:-22}]},
  input:{...inputTypography,width:"100%",flexShrink:0,textAlignVertical:"top",includeFontPadding:false,minWidth:0},
  measure:{...inputTypography,position:"absolute",top:0,left:0,opacity:0},
  fullInput:{flex:1,minHeight:0,flexShrink:1},
  actionTarget:{width:44,height:44,alignItems:"center",justifyContent:"center",flexShrink:0},
  send:{width:44,height:44,borderRadius:22,backgroundColor:"#EB8183",alignItems:"center",justifyContent:"center",flexShrink:0},
  modal:{flex:1,paddingHorizontal:24},
  modalViewport:{flex:1,minHeight:0},
  expandedCard:{flex:1,minHeight:0,paddingHorizontal:16,paddingVertical:12,gap:8},
  expandedText:{flex:1,minHeight:0,position:"relative"},
  accessory:{height:44,alignItems:"flex-end",justifyContent:"center",paddingRight:12},
  doneTarget:{minWidth:64,height:44,alignItems:"center",justifyContent:"center"},
});
