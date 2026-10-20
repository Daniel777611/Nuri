import { useId, useRef, useState, type RefObject } from "react";
import { InputAccessoryView, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "@/src/i18n";
import { useNuriTheme } from "./Theme";
import { GlassSurface, IconAction, NuriIcon, NuriText } from "./Primitives";

export function NuriComposer({ value, onChangeText, onSend, onAttach, onMic, disabled, busy, recording, inputRef, onFocus, onBlur, testID = "chat", placeholder, hasAttachment = false }: { value: string; onChangeText: (s:string)=>void; onSend:()=>void; onAttach:()=>void; onMic:()=>void; disabled?:boolean; busy?:boolean; recording?:boolean; inputRef?:RefObject<TextInput|null>; onFocus?:()=>void; onBlur?:()=>void; testID?:string; placeholder?:string; hasAttachment?:boolean }) {
  const [height,setHeight] = useState(24);
  const [expanded,setExpanded] = useState(false);
  const [focused,setFocused] = useState(false);
  const localInput = useRef<TextInput>(null);
  const compactRef = inputRef ?? localInput;
  const t=useNuriTheme(); const {locale}=useT(); const safe=useSafeAreaInsets(); const en=locale==="en";
  const accessoryId=`nuri-composer-${useId()}`;
  const done=()=>{Keyboard.dismiss();setExpanded(false);setFocused(false);};
  const send=()=>{if(disabled||busy||recording||(!value.trim()&&!hasAttachment))return false;onSend();return true;};
  const input=(large=false)=><TextInput
    ref={large?undefined:compactRef} value={value} onChangeText={onChangeText}
    multiline autoFocus={large} scrollEnabled={large||height>=72} editable={!disabled&&!busy}
    keyboardAppearance={t.keyboard.appearance}
    placeholder={placeholder??(en?"Say something to Nuri…":"和 Nuri 说点什么…")}
    placeholderTextColor={t.secondary}
    onFocus={()=>{setFocused(true);onFocus?.();}} onBlur={()=>{setFocused(false);onBlur?.();}}
    onContentSizeChange={e=>setHeight(Math.max(24,Math.min(72,e.nativeEvent.contentSize.height)))}
    inputAccessoryViewID={Platform.OS==="ios"?(large?accessoryId+"-expanded":accessoryId):undefined}
    style={[s.input,{height:large?132:height,color:t.ink,...(Platform.OS==="web"?{outlineWidth:0,outlineStyle:"solid" as const,outlineColor:"transparent"}:{})},large?{paddingRight:44}:null]}
    testID={`${testID}-${large?"expanded-":""}input`} accessibilityLabel={en?"Message to Nuri":"给 Nuri 的消息"}
  />;
  const controls=(large=false)=>{
    const prefix=`${testID}${large?"-expanded":""}`;
    return <>
      <IconAction name="plus" label={en?"Camera or upload photo":"拍照或上传图片"} onPress={onAttach} disabled={disabled||busy} testID={`${prefix}-attach`} />
      {large?<View style={{flex:1}} />:input()}
      <IconAction name="mic" label={recording?(en?"Stop recording":"停止录音"):(en?"Record a voice message":"录音")} onPress={onMic} disabled={disabled||busy} testID={`${prefix}-mic`} />
      {value.trim()||hasAttachment?<Pressable onPress={()=>{if(send()&&large)setExpanded(false);}} disabled={disabled||busy||recording} style={({pressed})=>[s.send,{opacity:disabled||busy||recording?.4:pressed?.6:1}]} testID={`${prefix}-send-btn`} accessibilityRole="button" accessibilityLabel={en?"Send":"发送"}>
        {busy?<NuriText>…</NuriText>:<NuriIcon name="send" />}
      </Pressable>:null}
    </>;
  };
  const keyboardAccessory=(large=false)=><InputAccessoryView nativeID={large?accessoryId+"-expanded":accessoryId} backgroundColor="transparent">
    <View style={s.accessory} testID={`${testID}-${large?"expanded-":""}keyboard-panel`}>
      {/* The keyboard and accessory are separate native views. Continue the
          panel material behind the keyboard's rounded top corners, rather
          than exposing the room through a second pair of corner cutouts. */}
      <View pointerEvents="none" style={[s.keyboardPanel,{backgroundColor:t.keyboard.surface}]} testID={`${testID}-${large?"expanded-":""}keyboard-material`} />
      <Pressable onPress={done} style={s.doneTarget} accessibilityRole="button" accessibilityLabel={en?"Done":"完成"} testID={`${testID}-${large?"expanded-":""}keyboard-done`}>
        <NuriText style={{fontSize:15,lineHeight:22,fontWeight:"600",color:t.keyboard.ink}}>{en?"Done":"完成"}</NuriText>
      </Pressable>
    </View>
  </InputAccessoryView>;
  return <View>
    {(focused||value.length>0)?<View style={{alignItems:"flex-end"}}><IconAction name="expand" label={en?"Expand composer":"展开输入"} onPress={()=>setExpanded(true)} testID={`${testID}-expand`} /></View>:null}
    <GlassSurface kind="composer" contentStyle={s.row} testID={`${testID}-composer`}>{controls()}</GlassSurface>
    {recording?<NuriText secondary style={{fontSize:12,paddingTop:6}}>{en?"Recording — tap the microphone to finish":"正在录音，再点麦克风结束"}</NuriText>:null}
    <Modal visible={expanded} transparent animationType="slide" onRequestClose={()=>setExpanded(false)}>
      <KeyboardAvoidingView behavior={Platform.OS==="ios"?"padding":"height"} style={[s.modal,{paddingBottom:Math.max(safe.bottom,12)}]}>
        <GlassSurface contentStyle={s.expandedCard} style={{width:"100%",maxWidth:500,alignSelf:"center"}} kind="composer" testID={`${testID}-expanded-composer`}>
          <View style={s.expandedText}>
            {input(true)}
            <View style={{position:"absolute",right:0,top:0}}>
              <IconAction name="collapse" label={en?"Collapse composer":"收起输入"} onPress={()=>setExpanded(false)} testID={`${testID}-expanded-done`} />
            </View>
          </View>
          <View style={s.expandedActions}>{controls(true)}</View>
        </GlassSurface>
      </KeyboardAvoidingView>
      {Platform.OS==="ios"&&expanded?keyboardAccessory(true):null}
    </Modal>
    {Platform.OS==="ios"&&!expanded?keyboardAccessory():null}
  </View>;
}
const s=StyleSheet.create({
  row:{flexDirection:"row",alignItems:"center",padding:2},
  input:{flex:1,fontSize:16,lineHeight:24,paddingVertical:0,textAlignVertical:"top",paddingHorizontal:0,minWidth:0},
  send:{width:44,height:44,alignItems:"center",justifyContent:"center"},
  modal:{flex:1,justifyContent:"flex-end",paddingHorizontal:24},
  expandedCard:{paddingHorizontal:16,paddingVertical:12,gap:8},
  expandedText:{height:132,position:"relative"},
  expandedActions:{height:44,flexDirection:"row",alignItems:"center"},
  accessory:{height:44,alignItems:"flex-end",justifyContent:"center",paddingRight:12},
  keyboardPanel:{position:"absolute",top:0,left:0,right:0,bottom:-28,borderTopLeftRadius:28,borderTopRightRadius:28},
  doneTarget:{minWidth:64,height:44,alignItems:"center",justifyContent:"center"},
});
