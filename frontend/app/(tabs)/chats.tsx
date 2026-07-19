import { Redirect } from "expo-router";

// 产品只有一个持续会话；保留该路由只是兼容旧链接与底部入口。
export default function Chats() {
  return <Redirect href="/chat/chat-1" />;
}
